import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RunnableConfig } from "@langchain/core/runnables"
import { MemorySaver } from "@langchain/langgraph"
import {
  type BaseCheckpointSaver,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  emptyCheckpoint,
} from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture routes
// ---------------------------------------------------------------------------

/** Plain graph route: completes immediately, never parks, never checkpoints. */
const ECHO_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

/** Blocking graph route (same shape as run-cancellation.test.ts): holds the
 * run slot until a release file appears, so a cancel can land mid-run. It
 * deliberately ignores ctx.signal and self-releases after 15s. */
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

const DEPLOY_TOOL = [
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  "  return 'deployed to ' + input.env",
  "}",
  "",
].join("\n")

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-pending-interrupts-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "pending-interrupts-fixture", "type": "module" }\n',
    "src/app/blocking/index.ts": BLOCKING_ROUTE,
    "src/app/echo/index.ts": ECHO_ROUTE,
    "src/app/park/index.ts": PARK_ROUTE,
    "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
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

/** drainDeadlineMs keeps afterEach from waiting the 30s default when a test
 * deliberately abandons a still-running route; the long heartbeat interval
 * keeps asserted SSE text free of `: ping` frames. `checkpointer` is the seam
 * the malformed-write and postgres cases inject through. */
async function createHandler(appRoot: string, checkpointer?: BaseCheckpointSaver) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
    ...(checkpointer ? { checkpointer } : {}),
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

// ---------------------------------------------------------------------------
// Requests, readers, assertions
// ---------------------------------------------------------------------------

function runStreamRequest(
  threadId: string,
  route: string,
  input: unknown = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input, route }),
    headers: { "content-type": "application/json", ...headers },
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

function pendingInterruptsRequest(threadId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/pending_interrupts`, { headers })
}

interface PendingInterruptsBody {
  readonly interrupts: ReadonlyArray<{
    readonly interruptId: string
    readonly resumeKey: string | null
    readonly value?: Record<string, unknown>
  }>
}

interface ErrorBody {
  readonly error: { readonly message: string; readonly details?: { readonly code?: string } }
}

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

async function drain(response: Response): Promise<void> {
  await readSseText(response)
}

async function readPendingInterruptsBody(
  handler: Handler,
  threadId: string,
): Promise<PendingInterruptsBody> {
  const response = await handler.fetch(pendingInterruptsRequest(threadId))
  expect(response.status).toBe(200)
  return (await response.json()) as PendingInterruptsBody
}

// ---------------------------------------------------------------------------
// A checkpointer that reports one unaddressable pending write: the outer id is
// not a 32-hex resume key, so the parse yields the interrupt AND sets
// `malformed`. The seeding route is a plain graph, which never checkpoints, so
// the base tuple here is genuinely absent — the write is grafted onto an empty
// checkpoint rather than onto a real one. That is enough for this endpoint,
// which reads only `pendingWrites`.
// ---------------------------------------------------------------------------

const MALFORMED_THREAD_ID = "t-malformed"

const MALFORMED_WRITE: CheckpointPendingWrite = [
  "33a12321-3ec2-56a7-b4d7-0337886c4386",
  "__interrupt__",
  { id: "not-a-resume-key", value: { interruptId: "perm-malformed" } },
]

class MalformedPendingWritesSaver extends MemorySaver {
  /** Flipped on only after the seeding run, so nothing the run itself reads is
   * ever handed a synthetic tuple. */
  armed = false

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config)
    if (!this.armed || config.configurable?.thread_id !== MALFORMED_THREAD_ID) return tuple
    return {
      checkpoint: tuple?.checkpoint ?? emptyCheckpoint(),
      config,
      ...(tuple?.metadata ? { metadata: tuple.metadata } : {}),
      pendingWrites: [MALFORMED_WRITE],
    }
  }
}

describe("GET /threads/:thread_id/pending_interrupts", () => {
  it("returns 404 thread_not_found for a thread that does not exist", async () => {
    const handler = await createHandler(await fixtureApp())

    const response = await handler.fetch(pendingInterruptsRequest("t-missing"))

    expect(response.status).toBe(404)
    const body = (await response.json()) as ErrorBody
    expect(body.error.details?.code).toBe("thread_not_found")
  })

  it("returns an empty list for a thread that ran without parking", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-no-interrupts"
    await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))

    const response = await handler.fetch(pendingInterruptsRequest(threadId))

    expect(response.status).toBe(200)
    // Pinned on the success path specifically: this is where a cache would be
    // tempting and where a stale answer would be wrong.
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ interrupts: [] })
  }, 30_000)

  it("returns the parked interrupt with the payload that renders its prompt", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-parked-payload"

    const text = await readSseText(
      await handler.fetch(parkRunRequest(threadId, "deploy to staging")),
    )
    expect(text).toContain("event: interrupt")

    const body = await readPendingInterruptsBody(handler, threadId)

    expect(body.interrupts).toHaveLength(1)
    const [parked] = body.interrupts
    expect(parked?.interruptId).toMatch(/^perm-/)
    expect(parked?.resumeKey).toMatch(/^[0-9a-f]{32}$/)
    // The whole point of the endpoint: everything a reloaded UI needs to put
    // the permission prompt back on screen, with no live stream.
    expect(parked?.value).toMatchObject({
      detail: { toolName: "deployProd" },
      interruptId: parked?.interruptId,
      kind: "tool",
      type: "permission-request",
    })
  }, 60_000)

  it("lists a malformed pending write and never surfaces the malformed flag", async () => {
    const saver = new MalformedPendingWritesSaver()
    const handler = await createHandler(await fixtureApp(), saver)
    await drain(await handler.fetch(runStreamRequest(MALFORMED_THREAD_ID, "/echo#graph")))
    saver.armed = true

    const response = await handler.fetch(pendingInterruptsRequest(MALFORMED_THREAD_ID))

    expect(response.status).toBe(200)
    // Reported, not withheld: this endpoint says what is parked. POST /resume
    // is the surface that refuses to act on writes it cannot address safely
    // (malformed_checkpoint), and `malformed` is not part of this contract.
    expect(await response.json()).toEqual({
      interrupts: [
        {
          interruptId: "perm-malformed",
          resumeKey: null,
          value: { interruptId: "perm-malformed" },
        },
      ],
    })
  }, 30_000)
})

/** Rejects unless `x-allow` is present, echoing what it observed so a test can
 * pin the middleware inputs a body-less GET produces. */
const ECHO_MIDDLEWARE = [
  'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"',
  "export default defineMiddleware((req) =>",
  '  req.headers["x-allow"] ? allow() : reject(403, { method: req.method, routeId: req.routeId }),',
  ")",
  "",
].join("\n")

describe("GET /threads/:thread_id/pending_interrupts — gating", () => {
  it("refuses a thread that has never run with 409 thread_route_unknown", async () => {
    const handler = await createHandler(await fixtureApp())
    const created = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    const response = await handler.fetch(pendingInterruptsRequest(threadId))

    // Fail closed: with no route there is no identity for route-scoped
    // middleware to gate on, and interrupt payloads must never fall through.
    expect(response.status).toBe(409)
    const body = (await response.json()) as ErrorBody
    expect(body.error.details?.code).toBe("thread_route_unknown")
  })

  it("gates on middleware, which observes method GET and the thread's route", async () => {
    const handler = await createHandler(await fixtureApp({ "src/middleware.ts": ECHO_MIDDLEWARE }))
    const threadId = "t-gated"

    // Prove the fixture middleware LOADED before reading anything into a 200.
    // loadMiddleware swallows every import error and returns undefined, so an
    // unloadable fixture serves 200s indistinguishable from a handler that
    // never calls runMiddleware — and this GET would look gated when it is not.
    // This pair is also the "identical to the POST stream" gating assertion.
    const streamRejected = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(streamRejected.status).toBe(403)
    expect(await streamRejected.json()).toEqual({ method: "POST", routeId: "/echo" })

    // The rejected POST never reached the threads store, so this allowed run is
    // what creates the thread and records its route.
    const seeded = await handler.fetch(
      runStreamRequest(threadId, "/echo#graph", {}, { "x-allow": "1" }),
    )
    expect(seeded.status).toBe(200)
    await drain(seeded)

    const rejected = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(rejected.status).toBe(403)
    // Dawn's first AP endpoint where middleware sees a method other than POST.
    expect(await rejected.json()).toEqual({ method: "GET", routeId: "/echo" })

    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-allow": "1" }))
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ interrupts: [] })
  }, 30_000)

  it("gates on the route persisted in thread metadata when nothing ran in-process", async () => {
    const handler = await createHandler(await fixtureApp({ "src/middleware.ts": ECHO_MIDDLEWARE }))

    // Pins the restart path: the in-memory threadRouteMap is populated by a run
    // in THIS process, so it is empty for a thread created with metadata and
    // never run. Only the durable `thread.metadata.route` arm can supply the
    // identity here — the arm a server restart leaves as the sole survivor.
    const created = await handler.fetch(
      new Request("http://localhost/threads", {
        body: JSON.stringify({ metadata: { route: "/echo#graph" } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(created.status).toBe(200)
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    const rejected = await handler.fetch(pendingInterruptsRequest(threadId))

    // A 409 here would mean the metadata arm never ran; a 200 would mean the
    // gate was skipped entirely.
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toEqual({ method: "GET", routeId: "/echo" })

    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-allow": "1" }))
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ interrupts: [] })
  }, 30_000)
})
