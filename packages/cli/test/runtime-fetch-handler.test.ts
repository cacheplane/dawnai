import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-fetch-handler-"))
  // maxRetries handles the ENOTEMPTY race where an aborted run's SQLite WAL
  // flush lands in .dawn/ between readdir and rmdir (same pattern as
  // test/harness/packaged-app.ts) — the abort test kills a run mid-flight by
  // design, so under full-suite load the flush can lose the race with cleanup.
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "fetch-handler-fixture", "type": "module" }\n',
    // `src/app` must exist for findDawnApp() to recognize this as a Dawn app,
    // even for tests that only exercise routes with no app-defined handlers.
    "src/app/.gitkeep": "",
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Fixture app with a `#agent` route — needed for incremental SSE streaming
 * (non-agent routes execute once and emit a single `done` chunk; only agent
 * routes stream token-by-token). */
async function agentFixtureApp(): Promise<string> {
  return fixtureApp({
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
  })
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock instance for the
 * duration of the test, restoring the previous env afterward. */
async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
}

// ---------------------------------------------------------------------------
// Task 3 checklist items 1-3: JSON route, unknown path, shutdown guard.
//
// NOTE: AP-disconnect behavior, the bounded drain deadline, and Node-adapter
// host robustness are already covered by runtime-fetch-parity.test.ts — not
// duplicated here.
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — JSON routes, 404, shutdown", () => {
  it("POST /threads with {} creates a thread", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(
      new Request("http://localhost/threads", { body: "{}", method: "POST" }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { thread_id?: string }
    expect(body).toHaveProperty("thread_id")
    expect(typeof body.thread_id).toBe("string")
  })

  it("GET /nope returns 404 with the standard not-found body", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(new Request("http://localhost/nope"))

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { kind: string; message: string } }
    expect(body.error.kind).toBe("request_error")
    expect(body.error.message).toBe("Not found")
  })

  it("rejects with 503 'Server is shutting down' after close()", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })

    await handler.close()

    const response = await handler.fetch(
      new Request("http://localhost/threads", { body: "{}", method: "POST" }),
    )

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { kind: string; message: string } }
    expect(body.error.kind).toBe("request_error")
    expect(body.error.message).toBe("Server is shutting down")
  })
})

// ---------------------------------------------------------------------------
// Task 3 checklist item 4: incremental SSE — chunks reach the reader before
// the stream closes, proving the fetch core does not buffer to completion.
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — incremental SSE", () => {
  it("delivers the first SSE frame while the run is still in flight", async () => {
    const appRoot = await agentFixtureApp()
    await withAimock(script().user("hello").replies("Hi there, friend!").build())

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const routeKey = encodeURIComponent("/chat#agent")
    const response = await handler.fetch(
      new Request(`http://localhost/agui/${routeKey}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello" }],
          runId: "rn1",
          state: {},
          threadId: "th-incremental",
          tools: [],
        }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
      }),
    )

    expect(response.status).toBe(200)
    // Header parity with the AG-UI/AP SSE sites.
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache")

    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected a streaming response body")

    // The first frame (RUN_STARTED) is enqueued before the model call even
    // starts, so it must be readable while the run is still counted active —
    // proof the handler streams progressively rather than buffering the
    // whole run to completion before returning any bytes.
    const first = await reader.read()
    expect(first.done).toBe(false)
    const firstFrame = new TextDecoder().decode(first.value)
    expect(firstFrame).toContain("RUN_STARTED")
    expect(handler.state.activeRequests).toBe(1)

    // Drain the rest of the stream.
    let sawMoreFrames = false
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      sawMoreFrames = true
    }
    expect(sawMoreFrames).toBe(true)

    // Once the body has fully settled, the in-flight slot is released.
    await expect.poll(() => handler.state.activeRequests).toBe(0)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Task 3 checklist item 5: abort mid-stream on the AG-UI endpoint (the one
// endpoint that retains abort-on-disconnect behavior).
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — abort mid-stream", () => {
  it("aborting the Request's signal mid-stream ends the run and settles activeRequests", async () => {
    const appRoot = await agentFixtureApp()
    await withAimock(script().user("hello").replies("Hi there, friend!").build())

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const routeKey = encodeURIComponent("/chat#agent")
    const controller = new AbortController()
    const response = await handler.fetch(
      new Request(`http://localhost/agui/${routeKey}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello" }],
          runId: "rn2",
          state: {},
          threadId: "th-abort",
          tools: [],
        }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      }),
    )

    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected a streaming response body")

    // Read the first frame before aborting, to prove this is a genuine
    // mid-stream abort rather than an abort-before-start.
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(handler.state.activeRequests).toBe(1)

    controller.abort()

    // The stream ends — either a graceful close or an error teardown are
    // both acceptable outcomes of an abort; either way reading must settle
    // (not hang), and the in-flight slot must release either way.
    await expect(
      (async () => {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) return
          }
        } catch {
          // Errored teardown is an acceptable abort outcome too.
        }
      })(),
    ).resolves.toBeUndefined()

    await expect.poll(() => handler.state.activeRequests).toBe(0)
  }, 30_000)
})
