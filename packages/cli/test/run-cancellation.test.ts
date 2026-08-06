import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture: a route that blocks until released, so a run can be held in
// flight while a second request arrives to probe the concurrency gate. It
// deliberately ignores its `ctx.signal` — a later task (per-run cancellation)
// relies on that — and self-releases after 15s so a bug here can never hang
// the suite forever.
// ---------------------------------------------------------------------------

const BLOCKING_ROUTE = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "export const graph = async (",
  "  input: { startedFile?: string; releaseFile?: string } | undefined,",
  "  _ctx: { signal: AbortSignal },",
  ") => {",
  "  if (input?.startedFile) await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 15000",
  "  while (Date.now() < deadline) {",
  "    if (!input?.releaseFile) break",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return { ok: true }",
  "}",
  "",
].join("\n")

// A trivial second route, used only to prove that a route recorded in thread
// metadata by a REJECTED request (one that lost the concurrency gate) is not
// the one actually running.
const OTHER_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

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

async function setupBlockingRoute() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-run-cancellation-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))

  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "run-cancellation-fixture", "type": "module" }\n',
    "src/app/blocking/index.ts": BLOCKING_ROUTE,
    "src/app/other/index.ts": OTHER_ROUTE,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  const handler = await createRuntimeFetchHandler({ appRoot })
  cleanup.push(() => handler.close())

  // Unique per setup() call (appRoot itself is unique per mkdtemp), so
  // multiple tests never cross-talk through a shared file.
  const startedFile = join(appRoot, "started.json")
  const releaseFile = join(appRoot, "release.json")

  return {
    appRoot,
    handler,
    releaseFile,
    releaseRoute: () => writeFile(releaseFile, "release"),
    startedFile,
  }
}

function runStreamRequest(
  threadId: string,
  startedFile: string,
  releaseFile: string,
  route = "/blocking#graph",
): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({
      input: { releaseFile, startedFile },
      route,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

/** Reads the response body to completion so the run finishes and close() can drain cleanly. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

/** Reads the response body to completion, returning it as decoded SSE text. */
async function readSseText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
}

function cancelRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AP concurrency gate", () => {
  it("returns 409 for a second concurrent run on the same thread", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()

    const response1 = await handler.fetch(runStreamRequest("t-409", startedFile, releaseFile))
    expect(response1.status).toBe(200)

    await waitForFile(startedFile)

    const response2 = await handler.fetch(runStreamRequest("t-409", startedFile, releaseFile))
    expect(response2.status).toBe(409)
    const body = (await response2.json()) as {
      error: { message: string; details?: { code?: string } }
    }
    expect(body.error.message).toContain("already in flight")
    expect(body.error.details?.code).toBe("run_in_flight")

    await releaseRoute()
    await drain(response1)
  }, 30_000)

  it("a rejected concurrent run does not clobber the thread's recorded route", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()
    const threadId = "t-route-clobber"

    const response1 = await handler.fetch(
      runStreamRequest(threadId, startedFile, releaseFile, "/blocking#graph"),
    )
    expect(response1.status).toBe(200)

    await waitForFile(startedFile)

    const response2 = await handler.fetch(
      runStreamRequest(threadId, startedFile, releaseFile, "/other#graph"),
    )
    expect(response2.status).toBe(409)

    const threadResponse = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
    expect(threadResponse.status).toBe(200)
    const thread = (await threadResponse.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata.route).toBe("/blocking#graph")

    await releaseRoute()
    await drain(response1)
  }, 30_000)

  it("allows concurrent runs on different threads", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()

    const response1 = await handler.fetch(runStreamRequest("thread-a", startedFile, releaseFile))
    expect(response1.status).toBe(200)

    await waitForFile(startedFile)

    const response2 = await handler.fetch(runStreamRequest("thread-b", startedFile, releaseFile))
    expect(response2.status).toBe(200)

    await releaseRoute()
    await drain(response1)
    await drain(response2)
  }, 30_000)

  it("allows a new run after the previous one completes", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()

    const response1 = await handler.fetch(runStreamRequest("t-reuse", startedFile, releaseFile))
    expect(response1.status).toBe(200)

    await waitForFile(startedFile)
    await releaseRoute()
    await drain(response1)

    const response2 = await handler.fetch(runStreamRequest("t-reuse", startedFile, releaseFile))
    expect(response2.status).toBe(200)
    await drain(response2)
  }, 30_000)

  it("does not 409 when the thread is stale-busy in SQLite but no run is in flight", async () => {
    // Simulates a process that crashed mid-run: "busy" persisted, registry
    // empty (a fresh handler, in this test's case, but the point holds for
    // any process restart). The gate must read the in-memory registry, never
    // the persisted status column, or this thread would be bricked forever.
    const { handler, appRoot, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()

    const store = createThreadsStore({ path: join(appRoot, ".dawn/threads.sqlite") })
    await store.createThread({ thread_id: "stale-thread" })
    await store.updateStatus("stale-thread", "busy")

    const response = await handler.fetch(runStreamRequest("stale-thread", startedFile, releaseFile))
    expect(response.status).toBe(200)

    await releaseRoute()
    await drain(response)
  }, 30_000)
})

describe("POST /threads/:id/cancel", () => {
  it("404s for an unknown thread", async () => {
    const { handler } = await setupBlockingRoute()

    // Never referenced by any run or POST /threads call in this test.
    const response = await handler.fetch(cancelRequest("never-seen-thread"))
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("thread_not_found")
  }, 30_000)

  it("409s when the thread exists but no run is in flight", async () => {
    const { handler } = await setupBlockingRoute()

    const createResponse = await handler.fetch(
      new Request("http://localhost/threads", { method: "POST" }),
    )
    expect(createResponse.status).toBe(200)
    const thread = (await createResponse.json()) as { thread_id: string }

    const response = await handler.fetch(cancelRequest(thread.thread_id))
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("no_run_in_flight")
  }, 30_000)

  it("cancels an in-flight run and reports interrupted", async () => {
    const { handler, startedFile, releaseFile } = await setupBlockingRoute()
    const threadId = "t-cancel-reports-interrupted"

    const runResponse = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(runResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)
    const body = await cancelResponse.json()
    expect(body).toEqual({ status: "interrupted", thread_id: threadId })

    await drain(runResponse)
  }, 10_000)

  it("frees the run slot so a new run is admitted after cancelling", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()
    const threadId = "t-cancel-frees-slot"

    const runResponse = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(runResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)
    await drain(runResponse)

    const response2 = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(response2.status).toBe(200)

    await releaseRoute()
    await drain(response2)
  }, 30_000)
})

describe("AP per-run abort", () => {
  it("stops a route that ignores ctx.signal", async () => {
    const { handler, startedFile, releaseFile } = await setupBlockingRoute()
    const threadId = "t-abort-ignores-signal"

    const runResponse = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(runResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)

    // Reads to completion — if the wrapper didn't stop the stream, this would
    // hang until the fixture's 15s self-release (well past this test's 10s
    // timeout, so a regression fails fast rather than passing slowly).
    const text = await readSseText(runResponse)
    expect(text).toBe('event: done\ndata: {"output":{"cancelled":true}}\n\n')

    // The route itself is still blocked (never told to release) — proves the
    // wrapper, not route cooperation, is what stopped the stream.
    await expect(readFile(releaseFile, "utf8")).rejects.toThrow()
  }, 10_000)

  it("marks the thread interrupted after cancellation", async () => {
    const { handler, startedFile, releaseFile } = await setupBlockingRoute()
    const threadId = "t-abort-marks-interrupted"

    const runResponse = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(runResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)
    await drain(runResponse)

    const threadResponse = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
    expect(threadResponse.status).toBe(200)
    const thread = (await threadResponse.json()) as { status: string }
    expect(thread.status).toBe("interrupted")
  }, 10_000)
})
