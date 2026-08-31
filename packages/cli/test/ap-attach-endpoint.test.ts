import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Plain graph route: completes immediately, never parks, never checkpoints. */
const ECHO_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

/** Agent route with no gating: every tool it discovers under `tools/` runs
 * immediately. Used to give the live-producer tests a real checkpointer-backed
 * turn (agent routes checkpoint; plain graph routes never do) that a blocking
 * tool can hold open long enough to attach mid-run. */
const CHAT_ROUTE = [
  'import { agent } from "@dawn-ai/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  "})",
  "",
].join("\n")

/** Agent route whose `deployProd` tool requires human approval, so the first
 * call to it parks the turn on a real checkpointer-backed HITL interrupt. */
const PARK_ROUTE = [
  'import { agent } from "@dawn-ai/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  '  tools: { approve: ["deployProd"] },',
  "})",
  "",
].join("\n")

/** Ungated tool that blocks until a release file appears, so a live turn can
 * be held open deterministically. Modeled on the identical fixture in
 * run-cancellation.test.ts / pending-interrupts-endpoint.test.ts. Self-releases
 * after 15s so a bug here can never hang the suite forever. */
const SLOW_PING_TOOL = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "/** Ping a host, slowly. */",
  "export default async function slowPing(input: {",
  "  startedFile: string",
  "  releaseFile: string",
  "}): Promise<string> {",
  "  await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 15000",
  "  while (Date.now() < deadline) {",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return 'pong'",
  "}",
  "",
].join("\n")

/** The approve-gated tool itself, made to block AFTER approval so the
 * resume-attach test can attach while the resumed turn is actually
 * executing. */
const BLOCKING_DEPLOY_TOOL = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "/** Deploy to an environment, slowly. */",
  "export default async function deployProd(input: {",
  "  env: string",
  "  startedFile: string",
  "  releaseFile: string",
  "}): Promise<string> {",
  "  await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 15000",
  "  while (Date.now() < deadline) {",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return 'deployed to ' + input.env",
  "}",
  "",
].join("\n")

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-ap-attach-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "ap-attach-fixture", "type": "module" }\n',
    "src/app/echo/index.ts": ECHO_ROUTE,
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test,
 * restoring the previous env afterward. Call BEFORE creating the handler. */
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

async function createHandler(appRoot: string) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

function runStreamRequest(threadId: string, route: string, input: unknown = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input, route }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function attachRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`)
}

function chatRunRequest(threadId: string, message: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({
      input: { messages: [{ content: message, role: "user" }] },
      route: "/chat#agent",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function chatAguiRequest(threadId: string, message: string): Request {
  return new Request(`http://localhost/agui/${encodeURIComponent("/chat#agent")}`, {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ id: "m1", role: "user", content: message }],
      runId: `run-${threadId}`,
      state: {},
      threadId,
      tools: [],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function parkRunRequest(threadId: string, message: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({
      input: { messages: [{ content: message, role: "user" }] },
      route: "/park#agent",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function resumeRequest(threadId: string, interruptId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/resume`, {
    body: JSON.stringify({
      resume: [{ interruptId, payload: "once", status: "resolved" }],
      route: "/park#agent",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

interface PendingInterruptsBody {
  readonly interrupts: ReadonlyArray<{
    readonly interruptId: string
    readonly resumeKey: string | null
  }>
}

async function readPendingInterruptId(handler: Handler, threadId: string): Promise<string> {
  const res = await handler.fetch(
    new Request(`http://localhost/threads/${threadId}/pending_interrupts`),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as PendingInterruptsBody
  const interruptId = body.interrupts[0]?.interruptId ?? ""
  expect(interruptId).not.toBe("")
  return interruptId
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

interface SseEvent {
  readonly event: string
  readonly data: unknown
  readonly retry: number | undefined
}

/**
 * Incremental SSE reader: parses events out of a response body as they
 * arrive, rather than buffering to completion — required to observe a
 * mid-stream `state` frame from a live attach while the primary turn behind
 * it is still blocked.
 */
function createSseReader(response: Response) {
  const maybeReader = response.body?.getReader()
  if (!maybeReader) throw new Error("expected a response body")
  const reader: ReadableStreamDefaultReader<Uint8Array> = maybeReader
  const decoder = new TextDecoder()
  let buffer = ""
  let streamDone = false

  async function nextEvent(): Promise<SseEvent | null> {
    for (;;) {
      const blockEnd = buffer.indexOf("\n\n")
      if (blockEnd !== -1) {
        const block = buffer.slice(0, blockEnd)
        buffer = buffer.slice(blockEnd + 2)
        if (!block.trim()) continue
        let event = "message"
        let dataLine: string | undefined
        let retry: number | undefined
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice("event: ".length)
          else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length)
          else if (line.startsWith("retry: ")) retry = Number(line.slice("retry: ".length))
        }
        if (dataLine === undefined && retry === undefined) continue
        return { data: dataLine !== undefined ? JSON.parse(dataLine) : undefined, event, retry }
      }
      if (streamDone) return null
      const { done, value } = await reader.read()
      if (done) {
        streamDone = true
        continue
      }
      buffer += decoder.decode(value, { stream: true })
    }
  }

  async function until(predicate: (event: SseEvent) => boolean): Promise<SseEvent> {
    for (;;) {
      const event = await nextEvent()
      if (event === null) throw new Error("SSE stream ended before a matching event arrived")
      if (predicate(event)) return event
    }
  }

  return { nextEvent, until }
}

/** Parse an SSE response body to completion into discrete events. Handles the
 * `retry:` line the durable-path terminator carries. */
async function readSse(response: Response): Promise<SseEvent[]> {
  const reader = response.body?.getReader()
  if (!reader) return []
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  const events: SseEvent[] = []
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue
    let event = "message"
    let dataLine: string | undefined
    let retry: number | undefined
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length)
      else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length)
      else if (line.startsWith("retry: ")) retry = Number(line.slice("retry: ".length))
    }
    if (dataLine === undefined && retry === undefined) continue
    events.push({ data: dataLine !== undefined ? JSON.parse(dataLine) : undefined, event, retry })
  }
  return events
}

interface ErrorBody {
  readonly error: { readonly message: string; readonly details?: { readonly code?: string } }
}

async function threadStatus(handler: Handler, threadId: string): Promise<string> {
  const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
  expect(response.status).toBe(200)
  return ((await response.json()) as { status: string }).status
}

describe("GET /threads/:thread_id/runs/stream — attach endpoint (durable path)", () => {
  it("serves the durable path for a thread that exists but has no live turn", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-durable"
    await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))
    expect(await threadStatus(handler, threadId)).toBe("idle")

    const res = await handler.fetch(attachRequest(threadId))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const events = await readSse(res)
    const state = events.find((e) => e.event === "state")
    expect(state).toBeDefined()
    const stateData = state?.data as Record<string, unknown>
    expect(stateData.live).toBe(false)
    expect(stateData.anchor).toBeNull()
    expect(stateData.turn).toBeNull()
    expect(stateData.resume).toBe(false)
    expect(stateData.input).toBeNull()
    expect(stateData.run_started_at).toBeNull()
    expect(stateData.status).toBe("idle")
    expect(stateData.interrupts).toEqual([])

    const done = events.find((e) => e.event === "done")
    expect(done?.data).toEqual({ output: null })
    // The done frame is the last SUBSTANTIVE event; only the bare retry hint
    // (no event/data lines of its own) follows it.
    expect(events.indexOf(done as SseEvent)).toBe(events.length - 2)

    // retry hint: present, an integer, within [1500, 2500] — never the exact
    // value, since it is jittered with Math.random().
    const retryEvent = events.find((e) => e.retry !== undefined)
    expect(retryEvent?.retry).toBeDefined()
    const retryMs = retryEvent?.retry as number
    expect(Number.isInteger(retryMs)).toBe(true)
    expect(retryMs).toBeGreaterThanOrEqual(1500)
    expect(retryMs).toBeLessThanOrEqual(2500)
  })

  it("404s an unknown thread with thread_not_found", async () => {
    const handler = await createHandler(await fixtureApp())

    const res = await handler.fetch(attachRequest("nope"))

    expect(res.status).toBe(404)
    const body = (await res.json()) as ErrorBody
    expect(body.error.details?.code).toBe("thread_not_found")
  })

  it("409s a thread that has never run with thread_route_unknown", async () => {
    const handler = await createHandler(await fixtureApp())
    const created = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    const res = await handler.fetch(attachRequest(threadId))

    expect(res.status).toBe(409)
    const body = (await res.json()) as ErrorBody
    expect(body.error.details?.code).toBe("thread_route_unknown")
  })
})

describe("GET /threads/:thread_id/runs/stream — attach endpoint (live path)", () => {
  it("tails a live turn: attach mid-run sees a live state frame with anchor and values, then the tail through done", async () => {
    const appRoot = await fixtureApp({
      "src/app/chat/index.ts": CHAT_ROUTE,
      "src/app/chat/tools/slowPing.ts": SLOW_PING_TOOL,
    })
    const startedFile = join(appRoot, "started.json")
    const releaseFile = join(appRoot, "release.json")
    await withAimock(
      script()
        .user("hi")
        .replies("hi there")
        .user("run it")
        .callsTool("slowPing", { startedFile, releaseFile })
        .replies("done")
        .build(),
    )
    const handler = await createHandler(appRoot)
    const threadId = "t-live-attach"

    // Warm-up turn: establishes the checkpoint that becomes THIS turn's
    // anchor. hub.open reads the anchor before the second turn's own route
    // stream begins executing, so a fresh thread's first-ever run would
    // legitimately have a null anchor — this warm-up is what gives it a
    // real one.
    await drain(await handler.fetch(chatRunRequest(threadId, "hi")))

    const runPromise = handler.fetch(chatRunRequest(threadId, "run it"))
    await waitForFile(startedFile)

    const attach = await handler.fetch(attachRequest(threadId))
    expect(attach.status).toBe(200)
    const events = createSseReader(attach)
    const state = await events.until((e) => e.event === "state")
    const stateData = state.data as Record<string, unknown>
    expect(stateData.live).toBe(true)
    expect(stateData.anchor).not.toBeNull()
    expect(stateData.resume).toBe(false)
    expect(stateData.interrupts).toEqual([])

    // Strong content assertion, not just non-null: the anchor is the
    // checkpoint from the WARM-UP turn (2 messages: "hi" / "hi there"), not
    // the LATEST one — by the time we attach, the second turn has already
    // committed its own "run it" message and tool call, so reading the
    // latest checkpoint instead of the anchor would see more than these two
    // messages, or different content, and this assertion would catch it.
    const values = stateData.values as {
      readonly messages?: ReadonlyArray<{ readonly kwargs?: { readonly content?: string } }>
    }
    expect(values.messages).toHaveLength(2)
    expect(values.messages?.[0]?.kwargs?.content).toBe("hi")
    expect(values.messages?.[1]?.kwargs?.content).toBe("hi there")

    await writeFile(releaseFile, "release")

    // A live intermediate frame, not just the terminal: slowPing resolves
    // once released and its result is published via liveTurn.publish before
    // the turn's own "done" — proving publish() actually reaches this
    // subscriber's queue, not just close()'s terminal fan-out.
    const toolResult = await events.until((e) => e.event === "tool_result")
    const toolResultData = toolResult.data as Record<string, unknown>
    expect(toolResultData.name).toBe("slowPing")
    const toolOutput = toolResultData.output as { readonly kwargs?: { readonly content?: string } }
    expect(toolOutput.kwargs?.content).toBe(JSON.stringify("pong"))

    const done = await events.until((e) => e.event === "done")
    expect(done).toBeDefined()

    await drain(await runPromise)
  }, 60_000)
})

describe("POST /threads/:thread_id/resume — attach endpoint (live path)", () => {
  it("attach during a resume turn reports resume:true and empty interrupts", async () => {
    const appRoot = await fixtureApp({
      "src/app/park/index.ts": PARK_ROUTE,
      "src/app/park/tools/deployProd.ts": BLOCKING_DEPLOY_TOOL,
    })
    const startedFile = join(appRoot, "resume-started.json")
    const releaseFile = join(appRoot, "resume-release.json")
    await withAimock(
      script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging", startedFile, releaseFile })
        .replies("Deployed.")
        .build(),
    )
    const handler = await createHandler(appRoot)
    const threadId = "t-resume-attach"

    await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))
    const interruptId = await readPendingInterruptId(handler, threadId)

    const resumePromise = handler.fetch(resumeRequest(threadId, interruptId))
    await waitForFile(startedFile)

    const attach = await handler.fetch(attachRequest(threadId))
    expect(attach.status).toBe(200)
    const events = createSseReader(attach)
    const state = await events.until((e) => e.event === "state")
    const stateData = state.data as Record<string, unknown>
    expect(stateData.live).toBe(true)
    expect(stateData.resume).toBe(true)
    expect(stateData.interrupts).toEqual([])
    // The parked checkpoint IS this turn's anchor.
    expect(stateData.anchor).not.toBeNull()

    await writeFile(releaseFile, "release")

    const done = await events.until((e) => e.event === "done")
    expect(done).toBeDefined()

    await drain(await resumePromise)
  }, 60_000)
})

describe("GET /threads/:thread_id/runs/stream — attach during an AG-UI turn", () => {
  it("tails AP-vocabulary frames while an AG-UI turn is live", async () => {
    const appRoot = await fixtureApp({
      "src/app/chat/index.ts": CHAT_ROUTE,
      "src/app/chat/tools/slowPing.ts": SLOW_PING_TOOL,
    })
    const startedFile = join(appRoot, "agui-started.json")
    const releaseFile = join(appRoot, "agui-release.json")
    await withAimock(
      script()
        .user("run it")
        .callsTool("slowPing", { startedFile, releaseFile })
        .replies("done")
        .build(),
    )
    const handler = await createHandler(appRoot)
    const threadId = "t-agui-attach"

    const runPromise = handler.fetch(chatAguiRequest(threadId, "run it"))
    await waitForFile(startedFile)

    const attach = await handler.fetch(attachRequest(threadId))
    expect(attach.status).toBe(200)
    const events = createSseReader(attach)
    const state = await events.until((e) => e.event === "state")
    const stateData = state.data as Record<string, unknown>
    expect(stateData.live).toBe(true)
    // AP vocabulary, not AG-UI's own encoding — the hub stores raw
    // StreamChunks published before AG-UI translation.
    expect(stateData.interrupts).toEqual([])

    await writeFile(releaseFile, "release")

    const done = await events.until((e) => e.event === "done")
    expect(done?.data).toBeDefined()

    await drain(await runPromise)
  }, 60_000)
})

describe("handler.close() — live-turn shutdown", () => {
  // Note: on this HTTP path, the primary producer's own abort-driven
  // `finally` also calls `liveTurn.close()` independently, so this test
  // alone does not isolate `liveTurnHub.closeAll()` — closeAll() itself
  // (fanning a terminal to a subscriber whose entry has no active producer
  // loop, which is hard to construct over HTTP) is unit-tested directly in
  // live-turn-hub.test.ts ("closeAll fans a terminal frame to every entry's
  // subscribers"). This test instead asserts the observable end-to-end
  // behavior: whichever path fires it, a hanging attach viewer sees a
  // terminal frame when the server shuts down.
  it("fans a terminal frame to a hanging attach viewer on shutdown", async () => {
    const appRoot = await fixtureApp({
      "src/app/chat/index.ts": CHAT_ROUTE,
      "src/app/chat/tools/slowPing.ts": SLOW_PING_TOOL,
    })
    const startedFile = join(appRoot, "shutdown-started.json")
    const releaseFile = join(appRoot, "shutdown-release.json")
    await withAimock(
      script()
        .user("run it")
        .callsTool("slowPing", { startedFile, releaseFile })
        .replies("done")
        .build(),
    )
    const handler = await createHandler(appRoot)
    const threadId = "t-shutdown-attach"

    const runPromise = handler.fetch(chatRunRequest(threadId, "run it")).catch(() => undefined)
    await waitForFile(startedFile)

    const attach = await handler.fetch(attachRequest(threadId))
    expect(attach.status).toBe(200)
    const events = createSseReader(attach)
    const state = await events.until((e) => e.event === "state")
    expect((state.data as Record<string, unknown>).live).toBe(true)

    await handler.close()

    const done = await events.until((e) => e.event === "done")
    expect(done).toBeDefined()

    await writeFile(releaseFile, "release").catch(() => undefined)
    await runPromise
  }, 60_000)
})
