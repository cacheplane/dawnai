import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it, vi } from "vitest"
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

// A route that fails immediately, used to prove the run slot is released on
// the failure path too — not just on normal completion and cancellation.
const BOOM_ROUTE = [
  "export const graph = async () => {",
  "  throw new Error('boom')",
  "}",
  "",
].join("\n")

// A minimal in-memory ThreadsStore whose updateStatus() rejects when asked to
// mark a thread "busy" — used to simulate a setup failure (e.g. a locked or
// corrupted SQLite file) between claiming the run slot and starting the
// stream, to prove the slot is released even then. Plain JS (no imports from
// workspace packages): dawn.config.ts is loaded from a scratch tmp directory
// with no node_modules, so it can only rely on what tsx can transpile inline.
const FAULTY_THREADS_STORE_CONFIG = [
  "const threads = new Map()",
  "function nowIso() { return new Date().toISOString() }",
  "const store = {",
  "  async createThread(input) {",
  "    const threadId = input.thread_id ?? ('t-' + Math.random().toString(36).slice(2))",
  "    const thread = {",
  "      thread_id: threadId,",
  "      created_at: nowIso(),",
  "      updated_at: nowIso(),",
  "      metadata: input.metadata ?? {},",
  "      status: 'idle',",
  "    }",
  "    threads.set(threadId, thread)",
  "    return thread",
  "  },",
  "  async getThread(threadId) { return threads.get(threadId) },",
  "  async deleteThread(threadId) { threads.delete(threadId) },",
  "  async listThreads() { return [...threads.values()] },",
  "  async updateStatus(threadId, status) {",
  "    if (status === 'busy') throw new Error('simulated updateStatus failure')",
  "    const thread = threads.get(threadId)",
  "    if (thread) { thread.status = status; thread.updated_at = nowIso() }",
  "  },",
  "  async updateMetadata(threadId, patch) {",
  "    const thread = threads.get(threadId)",
  "    if (thread) { thread.metadata = { ...thread.metadata, ...patch }; thread.updated_at = nowIso() }",
  "  },",
  "}",
  "export default { threadsStore: store }",
  "",
].join("\n")

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
    "src/app/boom/index.ts": BOOM_ROUTE,
    "src/app/other/index.ts": OTHER_ROUTE,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  // Short drain deadline: these fixtures deliberately leave a route running
  // after cancellation (that is the property under test), and close() now waits
  // for in-flight runs. Without a bound, afterEach cleanup would block for the
  // full 30s default on every cancellation test.
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
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

/**
 * A handler whose ThreadsStore rejects every "busy" status write — simulates
 * a setup failure (locked/corrupted DB, disk error) between claiming the run
 * slot and starting the stream. No blocking/started/release files: the run
 * never gets far enough to need them.
 */
async function setupFaultyThreadsStore() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-run-cancellation-faulty-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))

  const files: Record<string, string> = {
    "dawn.config.ts": FAULTY_THREADS_STORE_CONFIG,
    "package.json": '{ "name": "run-cancellation-faulty-fixture", "type": "module" }\n',
    "src/app/other/index.ts": OTHER_ROUTE,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  // Short drain deadline: these fixtures deliberately leave a route running
  // after cancellation (that is the property under test), and close() now waits
  // for in-flight runs. Without a bound, afterEach cleanup would block for the
  // full 30s default on every cancellation test.
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
  cleanup.push(() => handler.close())

  return { appRoot, handler }
}

function otherRunRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input: {}, route: "/other#graph" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function agUiRunRequest(threadId: string, route = "/other#graph"): Request {
  return new Request(`http://localhost/agui/${encodeURIComponent(route)}`, {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ id: "1", role: "user", content: "hello" }],
      runId: `agui-${threadId}`,
      state: {},
      threadId,
      tools: [],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
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

function runWaitRequest(
  threadId: string,
  startedFile: string,
  releaseFile: string,
  route = "/blocking#graph",
): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/wait`, {
    body: JSON.stringify({
      input: { releaseFile, startedFile },
      route,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

// ---------------------------------------------------------------------------
// Fixture: a thread parked on a real (checkpointer-backed) HITL interrupt, for
// exercising /resume. The checkpointer is faked via dawn.config.ts — the same
// mechanism packages/cli/test/resume-endpoint.test.ts uses to seed a pending
// __interrupt__ — so readPendingInterrupts() sees a genuine pending interrupt
// without needing a live agent-mode graph to produce one. The resumed route
// itself is the same blocking pattern as BLOCKING_ROUTE above, except the
// resume endpoint always invokes it with `input: {}`, so the started/release
// file paths are baked into the generated source as literals instead of being
// threaded through the request body.
// ---------------------------------------------------------------------------

const RESUME_INTERRUPT_ID = "perm-1"

const RESUME_CHECKPOINTER_CONFIG = [
  "export default {",
  "  checkpointer: {",
  "    getTuple: async () => ({",
  "      pendingWrites: [[",
  '        "33a12321-3ec2-56a7-b4d7-0337886c4386",',
  '        "__interrupt__",',
  "        {",
  '          id: "3336d0e0a2d4f198ef9aecd09cd7ac27",',
  `          value: { interruptId: ${JSON.stringify(RESUME_INTERRUPT_ID)} },`,
  "        },",
  "      ]],",
  "    }),",
  "  },",
  "};",
  "",
].join("\n")

function resumeBlockingRoute(startedFile: string, releaseFile: string): string {
  return [
    'import { readFile, writeFile } from "node:fs/promises"',
    `const STARTED_FILE = ${JSON.stringify(startedFile)}`,
    `const RELEASE_FILE = ${JSON.stringify(releaseFile)}`,
    "export const graph = async (",
    "  _input: unknown,",
    "  _ctx: { signal: AbortSignal },",
    ") => {",
    "  await writeFile(STARTED_FILE, 'started')",
    "  const deadline = Date.now() + 15000",
    "  while (Date.now() < deadline) {",
    "    try { await readFile(RELEASE_FILE, 'utf8'); break } catch {}",
    "    await new Promise((r) => setTimeout(r, 25))",
    "  }",
    "  return { ok: true }",
    "}",
    "",
  ].join("\n")
}

async function setupResumeInterrupt() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-run-cancellation-resume-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))

  const startedFile = join(appRoot, "resume-started.json")
  const releaseFile = join(appRoot, "resume-release.json")

  const files: Record<string, string> = {
    "dawn.config.ts": RESUME_CHECKPOINTER_CONFIG,
    "package.json": '{ "name": "run-cancellation-resume-fixture", "type": "module" }\n',
    "src/app/resume-blocking/index.ts": resumeBlockingRoute(startedFile, releaseFile),
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  // Short drain deadline: these fixtures deliberately leave a route running
  // after cancellation (that is the property under test), and close() now waits
  // for in-flight runs. Without a bound, afterEach cleanup would block for the
  // full 30s default on every cancellation test.
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
  cleanup.push(() => handler.close())

  return {
    appRoot,
    handler,
    releaseFile,
    releaseRoute: () => writeFile(releaseFile, "release"),
    startedFile,
  }
}

function resumeRequest(threadId: string, route = "/resume-blocking#graph"): Request {
  return new Request(`http://localhost/threads/${threadId}/resume`, {
    body: JSON.stringify({
      resume: [{ interruptId: RESUME_INTERRUPT_ID, payload: "once", status: "resolved" }],
      route,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
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

  it("shares the concurrency gate with AG-UI requests", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()
    cleanup.push(releaseRoute)
    const threadId = "t-ap-agui-409"

    const apResponse = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(apResponse.status).toBe(200)
    await waitForFile(startedFile)

    const agUiResponse = await handler.fetch(agUiRunRequest(threadId))
    expect(agUiResponse.status).toBe(409)
    const body = (await agUiResponse.json()) as {
      error: { details?: { code?: string } }
    }
    expect(body.error.details?.code).toBe("run_in_flight")

    await releaseRoute()
    await drain(apResponse)
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

    // The blocking route ignores ctx.signal and keeps running past
    // cancellation until told to release — the run slot is held until it
    // genuinely stops, so the route must be released before a new run can be
    // admitted. See "holds the run slot until a cancelled stream's route
    // genuinely stops" below for the intermediate 409 this implies.
    await releaseRoute()
    let admitted: Response | undefined
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const attempt = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
      if (attempt.status === 200) {
        admitted = attempt
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!admitted) throw new Error("run slot was never freed after cancelling")

    await drain(admitted)
  }, 30_000)
})

describe("AP run slot held until a cancelled route genuinely stops", () => {
  it("holds the run slot until a cancelled stream's route genuinely stops", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()
    const threadId = "t-stream-cancel-holds-slot"

    const runResponse = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
    expect(runResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)

    // The client's stream must still end promptly with the cancelled chunk,
    // even though the route itself (which ignores ctx.signal) is still
    // running — response lifetime and run lifetime are deliberately
    // different.
    const text = await readSseText(runResponse)
    expect(text).toBe('event: done\ndata: {"output":{"cancelled":true}}\n\n')

    // The blocking route is still executing at this point (never told to
    // release) — a new run on the same thread must still be rejected, or a
    // second run would start interleaving checkpoint writes with the first.
    const stillBlockedResponse = await handler.fetch(
      runStreamRequest(threadId, startedFile, releaseFile),
    )
    expect(stillBlockedResponse.status).toBe(409)
    const stillBlockedBody = (await stillBlockedResponse.json()) as {
      error: { details?: { code?: string } }
    }
    expect(stillBlockedBody.error.details?.code).toBe("run_in_flight")

    // Once the route actually finishes, the slot frees and a new run is
    // admitted — proving the hold is temporary, not a leak.
    await releaseRoute()
    let admitted: Response | undefined
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const attempt = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
      if (attempt.status === 200) {
        admitted = attempt
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!admitted) throw new Error("run slot was never freed after the blocking route released")

    await releaseRoute()
    await drain(admitted)
  }, 15_000)
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

describe("AP run failure", () => {
  it("frees the run slot after a run fails", async () => {
    const { handler } = await setupBlockingRoute()
    const threadId = "t-boom-frees-slot"

    const failingResponse = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/stream`, {
        body: JSON.stringify({ input: {}, route: "/boom#graph" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(failingResponse.status).toBe(200)

    // The terminal chunk must carry the error shape, not the cancelled shape
    // — proving the cancelled/failed discrimination added for cancellation
    // didn't regress the ordinary failure path.
    const text = await readSseText(failingResponse)
    expect(text).toBe('event: done\ndata: {"output":{"error":"boom"}}\n\n')

    // The failed run's slot must be released — not just the cancelled-run's
    // and the completed-run's, both already covered above — so a follow-up
    // run on the same thread is admitted rather than 409ing.
    const followUp = await handler.fetch(otherRunRequest(threadId))
    expect(followUp.status).toBe(200)
    await drain(followUp)
  }, 10_000)
})

describe("run slot release on setup failure", () => {
  it("releases the run slot when updateStatus('busy') throws before the stream starts", async () => {
    const { handler } = await setupFaultyThreadsStore()
    const threadId = "t-setup-throws"

    const response1 = await handler.fetch(otherRunRequest(threadId))
    expect(response1.status).toBe(500)

    // If the slot leaked, this would return 200 "interrupted" for a run that
    // never actually started streaming — the exact phantom-slot bug this
    // guard exists to prevent (a leaked slot would also 409 every future run
    // on this thread for the rest of the process's life).
    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(409)
    const cancelBody = (await cancelResponse.json()) as { error: { details?: { code?: string } } }
    expect(cancelBody.error.details?.code).toBe("no_run_in_flight")

    // A second run attempt must fail for the same setup reason, not because
    // the concurrency gate still thinks a run is in flight.
    const response2 = await handler.fetch(otherRunRequest(threadId))
    expect(response2.status).toBe(500)
    const body2 = (await response2.json()) as { error: { details?: { code?: string } } }
    expect(body2.error.details?.code).not.toBe("run_in_flight")
  }, 10_000)
})

describe("/runs/wait cancellation", () => {
  it("returns 409 run_cancelled when the in-flight run is cancelled", async () => {
    const { handler, startedFile, releaseFile } = await setupBlockingRoute()
    const threadId = "t-wait-cancelled"

    const waitPromise = handler.fetch(runWaitRequest(threadId, startedFile, releaseFile))
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)

    const waitResponse = await waitPromise
    expect(waitResponse.status).toBe(409)
    const body = (await waitResponse.json()) as {
      error: { message: string; details?: { code?: string } }
    }
    expect(body.error.message).toContain("cancelled")
    expect(body.error.details?.code).toBe("run_cancelled")
  }, 10_000)

  it("marks the thread interrupted after a cancelled wait", async () => {
    const { handler, startedFile, releaseFile } = await setupBlockingRoute()
    const threadId = "t-wait-cancelled-interrupted"

    const waitPromise = handler.fetch(runWaitRequest(threadId, startedFile, releaseFile))
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)
    await waitPromise

    const threadResponse = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
    expect(threadResponse.status).toBe(200)
    const thread = (await threadResponse.json()) as { status: string }
    expect(thread.status).toBe("interrupted")
  }, 10_000)

  it("holds the run slot until an abandoned wait genuinely settles, then frees it", async () => {
    // The blocking fixture deliberately ignores ctx.signal, so cancelling
    // /runs/wait only detaches it (raceRequestAgainstShutdown never stops the
    // route — there is no abortable iterator here like /runs/stream has).
    // The slot must stay held while that abandoned route is still running,
    // or a newly admitted run on the same thread would interleave checkpoint
    // writes with it. This replaces the old "frees the run slot after a
    // cancelled wait" test: under the corrected behavior, the slot is
    // deliberately NOT free immediately after cancellation.
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()
    const threadId = "t-wait-cancelled-holds-slot"

    const waitPromise = handler.fetch(runWaitRequest(threadId, startedFile, releaseFile))
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)

    const waitResponse = await waitPromise
    expect(waitResponse.status).toBe(409)
    const waitBody = (await waitResponse.json()) as {
      error: { message: string; details?: { code?: string } }
    }
    expect(waitBody.error.details?.code).toBe("run_cancelled")

    // The abandoned route is still running at this point — a new run on the
    // same thread must still be rejected.
    const stillBlockedResponse = await handler.fetch(
      runStreamRequest(threadId, startedFile, releaseFile),
    )
    expect(stillBlockedResponse.status).toBe(409)
    const stillBlockedBody = (await stillBlockedResponse.json()) as {
      error: { details?: { code?: string } }
    }
    expect(stillBlockedBody.error.details?.code).toBe("run_in_flight")

    // Once the abandoned route actually finishes, the slot frees and a new
    // run is admitted — proving the hold is temporary, not a leak.
    await releaseRoute()
    let admitted: Response | undefined
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const attempt = await handler.fetch(runStreamRequest(threadId, startedFile, releaseFile))
      if (attempt.status === 200) {
        admitted = attempt
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!admitted) throw new Error("run slot was never freed after the abandoned route released")

    await drain(admitted)
  }, 15_000)

  it("close() drains an abandoned wait's run before releasing sandboxes", async () => {
    // A cancelled /runs/wait answers with plain JSON, so the fetch wrapper —
    // which only holds an in-flight slot for text/event-stream bodies — has
    // already decremented activeRequests by the time close() runs. Draining on
    // activeRequests alone would therefore call sandboxManager.releaseAll()
    // while the abandoned route is still executing against its sandbox, yanking
    // it mid-tool-call. close() must drain on in-flight RUNS as well.
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute()
    const threadId = "t-close-waits-for-abandoned-wait"

    const waitPromise = handler.fetch(runWaitRequest(threadId, startedFile, releaseFile))
    await waitForFile(startedFile)

    expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)
    expect((await waitPromise).status).toBe(409)

    // The HTTP side has fully settled...
    expect(handler.state.activeRequests).toBe(0)

    // ...but the run has not, so close() must NOT treat this as drained. The
    // fixture's 250ms deadline bounds the wait; hitting it (and warning about
    // runs) is the observable proof that close() waited on the run rather than
    // returning immediately, which is what it did before this fix.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await handler.close()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("run(s) still")
    } finally {
      warn.mockRestore()
    }

    await releaseRoute()
  }, 15_000)
})

describe("/resume cancellation", () => {
  it("terminates a cancelled resume stream with cancelled:true", async () => {
    const { handler, startedFile, releaseFile } = await setupResumeInterrupt()
    const threadId = "t-resume-cancelled"

    const resumeResponse = await handler.fetch(resumeRequest(threadId))
    expect(resumeResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)

    // Reads to completion — if the wrapper didn't stop the stream, this would
    // hang until the fixture's 15s self-release (well past this test's 10s
    // timeout, so a regression fails fast rather than passing slowly).
    const text = await readSseText(resumeResponse)
    expect(text).toBe('event: done\ndata: {"output":{"cancelled":true}}\n\n')

    // The route itself is still blocked (never told to release) — proves the
    // wrapper, not route cooperation, is what stopped the stream.
    await expect(readFile(releaseFile, "utf8")).rejects.toThrow()
  }, 10_000)

  it("holds the run slot until a cancelled resume's route genuinely stops, then frees it", async () => {
    // Same defect and fix as the /runs/stream test above, exercised through
    // /resume instead: the resumed route ignores ctx.signal, so cancellation
    // only stops abortableAsyncIterable from CONSUMING it, not the route
    // itself. The slot must stay held until the route genuinely unwinds, or a
    // newly admitted run on this thread would interleave checkpoint writes
    // with the still-running resumed one.
    const { handler, startedFile, releaseRoute } = await setupResumeInterrupt()
    const threadId = "t-resume-cancelled-holds-slot"

    const resumeResponse = await handler.fetch(resumeRequest(threadId))
    expect(resumeResponse.status).toBe(200)
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)
    await drain(resumeResponse)

    // The resumed route is still running at this point (never told to
    // release) — a new run on the same thread must still be rejected.
    const stillBlockedResponse = await handler.fetch(resumeRequest(threadId))
    expect(stillBlockedResponse.status).toBe(409)
    const stillBlockedBody = (await stillBlockedResponse.json()) as {
      error: { details?: { code?: string } }
    }
    expect(stillBlockedBody.error.details?.code).toBe("resume_in_progress")

    // Once the resumed route actually finishes, the slot frees and a new
    // resume is admitted — proving the hold is temporary, not a leak.
    await releaseRoute()
    let admitted: Response | undefined
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const attempt = await handler.fetch(resumeRequest(threadId))
      if (attempt.status === 200) {
        admitted = attempt
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!admitted) throw new Error("run slot was never freed after the resumed route released")

    // releaseFile already exists from the releaseRoute() call above, so the
    // newly admitted resume's route sees it immediately and returns without
    // needing a second release.
    await drain(admitted)
  }, 30_000)
})
