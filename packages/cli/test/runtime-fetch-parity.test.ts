import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import type { IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, test, vi } from "vitest"
import { handleAgUiFetchRequest } from "../src/lib/dev/agui-handler.js"
import { headersToRecord } from "../src/lib/dev/middleware.js"
import { toWebRequest } from "../src/lib/dev/node-web-adapter.js"
import { createPendingResumeClaims } from "../src/lib/dev/pending-interrupts.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import type { RuntimeRegistry } from "../src/lib/dev/runtime-registry.js"
import { statusResponse } from "../src/lib/dev/status-response.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// headersToRecord — repeated set-cookie (FIX: middleware header parity)
// ---------------------------------------------------------------------------

describe("headersToRecord", () => {
  test("joins repeated set-cookie values with ', ' like the old parseHeaders", () => {
    const headers = new Headers()
    headers.append("set-cookie", "a=1")
    headers.append("set-cookie", "b=2")
    headers.append("x-scope", "read")
    headers.append("x-scope", "write")
    headers.set("authorization", "Bearer tok")

    const record = headersToRecord(headers)
    expect(record["set-cookie"]).toBe("a=1, b=2")
    expect(record["x-scope"]).toBe("read, write")
    expect(record.authorization).toBe("Bearer tok")
  })

  test("keeps a single set-cookie value as-is", () => {
    const headers = new Headers()
    headers.append("set-cookie", "a=1")
    expect(headersToRecord(headers)["set-cookie"]).toBe("a=1")
  })
})

// ---------------------------------------------------------------------------
// statusResponse — middleware rejects with unusual statuses
// ---------------------------------------------------------------------------

describe("statusResponse", () => {
  test("204 and 304 drop the body but keep the JSON content-type (old sendJson parity)", () => {
    for (const status of [204, 304]) {
      const response = statusResponse(status, { error: "x" })
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
      expect(response.headers.get("content-type")).toBe("application/json")
    }
  })

  test("205 drops the body (documented divergence: old Node sent it)", () => {
    const response = statusResponse(205, { error: "x" })
    expect(response.status).toBe(205)
    expect(response.body).toBeNull()
  })

  test("normal statuses carry the JSON body", async () => {
    const response = statusResponse(418, { error: "teapot" })
    expect(response.status).toBe(418)
    expect(await response.json()).toEqual({ error: "teapot" })
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("statuses a Response cannot express become the standard 500", async () => {
    for (const status of [99, 150, 700, 1000]) {
      const response = statusResponse(status, { error: "x" })
      expect(response.status).toBe(500)
      const body = (await response.json()) as {
        error: { kind: string; message: string }
      }
      expect(body.error.kind).toBe("execution_error")
      expect(body.error.message).toBe("Unexpected runtime server failure")
    }
  })
})

// ---------------------------------------------------------------------------
// AG-UI middleware reject with a null-body status (real reject site)
// ---------------------------------------------------------------------------

describe("AG-UI middleware reject", () => {
  test("a 304 reject produces a body-less 304, not a 500", async () => {
    const registry: RuntimeRegistry = {
      appRoot: "/unused",
      entries: [],
      lookup: () => ({
        assistantId: "/chat#agent",
        mode: "agent",
        routeFile: "/unused/src/app/chat/index.ts",
        routeId: "/chat",
        routePath: "src/app/chat/index.ts",
      }),
    }

    const response = await handleAgUiFetchRequest({
      appRoot: "/unused",
      checkpointer: {
        getTuple: async () => undefined,
      } as unknown as BaseCheckpointSaver,
      middleware: async () => ({
        action: "reject",
        body: { error: "not modified" },
        status: 304,
      }),
      registry,
      resumeClaims: createPendingResumeClaims(),
      request: new Request("http://localhost/agui/chat", {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [],
          runId: "rn1",
          state: {},
          threadId: "th1",
          tools: [],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      routeKey: "/chat#agent",
      signal: new AbortController().signal,
      threadsStore: {} as unknown as ThreadsStore, // never reached on reject
    })

    expect(response.status).toBe(304)
    expect(response.body).toBeNull()
    expect(response.headers.get("content-type")).toBe("application/json")
  })
})

// ---------------------------------------------------------------------------
// Fetch-handler parity — AP disconnect behavior + activeRequests accounting
// ---------------------------------------------------------------------------

function fakeReq(init: {
  method?: string
  url?: string
  headers?: Record<string, string>
}): IncomingMessage {
  const stream = new PassThrough()
  stream.end()
  const req = stream as unknown as IncomingMessage
  Object.assign(req, {
    headers: init.headers ?? {},
    method: init.method ?? "GET",
    url: init.url ?? "/",
  })
  return req
}

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-fetch-parity-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "fetch-parity-fixture", "type": "module" }\n',
    // A slow non-agent route that records, at completion, whether its run
    // signal was aborted — the probe for disconnect-abort behavior.
    "src/app/noop/index.ts": [
      'import { writeFile } from "node:fs/promises"',
      "export const graph = async (",
      "  input: { probeFile?: string } | undefined,",
      "  ctx: { signal: AbortSignal },",
      ") => {",
      "  await new Promise((resolve) => setTimeout(resolve, 150))",
      "  if (input?.probeFile) {",
      "    await writeFile(input.probeFile, JSON.stringify({ aborted: ctx.signal.aborted }))",
      "  }",
      "  return { ok: true }",
      "}",
      "",
    ].join("\n"),
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

function streamRequest(threadId: string, probeFile?: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({
      input: probeFile ? { probeFile } : {},
      route: "/noop#graph",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, "utf8")
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`probe file never appeared: ${path}`)
}

describe("runtime fetch handler parity", () => {
  // Not merely legacy parity: continuing on disconnect is the documented
  // decision for the durable AP surface. Explicit stop is POST /threads/:id/cancel.
  // See docs/superpowers/specs/2026-08-06-ap-run-cancellation.md
  it("AP stream: client disconnect does not abort the run (deliberate)", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const probeFile = join(appRoot, "probe-disconnect.json")
    const response = await handler.fetch(streamRequest("t-disconnect", probeFile))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")

    // Simulate the client disconnecting without reading anything.
    await response.body?.cancel()

    // The in-flight slot settles on cancellation...
    expect(handler.state.activeRequests).toBe(0)

    // ...but the run itself keeps going and completes un-aborted.
    const probe = JSON.parse(await waitForFile(probeFile)) as {
      aborted: boolean
    }
    expect(probe.aborted).toBe(false)

    // With no active requests, close() resolves promptly.
    await handler.close()
  }, 30_000)

  it("close() with an entirely unread SSE body warns after the drain deadline and proceeds", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({
      appRoot,
      drainDeadlineMs: 250,
    })

    const probeFile = join(appRoot, "probe-unread.json")
    const response = await handler.fetch(streamRequest("t-unread", probeFile))
    expect(response.status).toBe(200)

    // Wait for the run to finish so shutdown has no background work — the
    // body is still entirely unread, so the in-flight slot is still held.
    await waitForFile(probeFile)
    expect(handler.state.activeRequests).toBe(1)

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await handler.close() // must resolve (bounded drain), not hang
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("request(s) still active")
      expect(String(warn.mock.calls[0]?.[0])).toContain("proceeding with shutdown")
    } finally {
      warn.mockRestore()
    }

    await response.body?.cancel().catch(() => undefined)
  }, 30_000)

  it("answers /healthz through the Node adapter despite a malformed Host header", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(
      toWebRequest(fakeReq({ headers: { host: "not a host" }, url: "/healthz" })),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
  }, 30_000)
})
