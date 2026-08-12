import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type DawnPostgresSaver, postgresCheckpointer } from "../../postgres-storage/dist/node.js"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { terminalStatus } from "../src/lib/dev/terminal-status.js"

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

/** Agent route that cannot resolve its model, so the turn fails BEFORE its
 * graph executes — no checkpoint written, nothing consumed. Agent-kind, so it
 * gets past the `canPark` short-circuit that a plain graph stops at. */
const BROKEN_AGENT_ROUTE = [
  'import { agent } from "@dawn-ai/sdk"',
  "export default agent({",
  '  model: "definitely-not-a-real-model-id",',
  '  systemPrompt: "You are a test agent.",',
  "})",
  "",
].join("\n")

/** Ordinary ungated tool that simply takes a while. Paired with the approve-gated
 * deployProd in ONE assistant turn, it keeps the superstep alive after the
 * permission interrupt has already been written — the window in which a parked
 * /runs/wait turn is durably parked but has not returned yet. Routine app code:
 * a slow sibling tool call is what any real agent turn looks like. */
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

function parkRunRequest(
  threadId: string,
  message: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({
      input: { messages: [{ content: message, role: "user" }] },
      route: "/park#agent",
    }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

/** Same turn as parkRunRequest, but on the blocking (non-streaming) endpoint —
 * the one spec §4 leaves out of the parked-STATUS work. */
function parkWaitRequest(
  threadId: string,
  message: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/wait`, {
    body: JSON.stringify({
      input: { messages: [{ content: message, role: "user" }] },
      route: "/park#agent",
    }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

/** The same park, driven through the endpoint the CopilotKit UIs actually use. */
function aguiParkRequest(
  threadId: string,
  message: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/agui/${encodeURIComponent("/park#agent")}`, {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ content: message, id: "m1", role: "user" }],
      runId: "r1",
      state: {},
      threadId,
      tools: [],
    }),
    headers: { "content-type": "application/json", ...headers },
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

/** Retry `assertion` until it stops throwing, or give up and rethrow. For state
 * that settles behind work the request already returned without waiting for. */
async function waitFor(assertion: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    try {
      await assertion()
      return
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** Block until the thread's checkpoint durably holds a parked interrupt. */
async function waitForParkedWrite(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(async () => {
    const tuple = await checkpointer.getTuple({
      configurable: { checkpoint_ns: "", thread_id: threadId },
    })
    const channels = tuple?.pendingWrites?.map(([, channel]) => channel) ?? []
    expect(channels).toContain("__interrupt__")
  }, timeoutMs)
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

/**
 * Saver that lets a turn park and then breaks the very next checkpoint write,
 * so `invokeResolvedRoute` returns `failed` with the `__interrupt__` write
 * already durable. That combination is real — the write lands before whatever
 * kills the turn, including a cancel that settles in the same tick — but it
 * cannot be produced by driving routes alone, so the fault is injected at the
 * one seam the handler treats as fallible.
 */
class BreakAfterParkSaver extends MemorySaver {
  override async putWrites(
    ...args: Parameters<MemorySaver["putWrites"]>
  ): ReturnType<MemorySaver["putWrites"]> {
    const [, writes] = args
    // Stored FIRST, so the interrupt is genuinely durable — the endpoint will
    // serve it — and only then does the turn die. Throwing before the write
    // would model nothing: there would be no parked prompt to protect.
    await super.putWrites(...args)
    if (writes.some(([channel]) => channel === "__interrupt__")) {
      throw new Error("checkpoint write failed after the turn parked")
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

/** Route-SCOPED policy: `/park` is admin-only, every other route is open to
 * everyone. This is the shape that makes a last-run-route gate exploitable —
 * the unprivileged caller is genuinely allowed to run `/echo`, so nothing stops
 * them from moving the thread's recorded route onto it. The blanket
 * ECHO_MIDDLEWARE above cannot express that, which is why one route per thread
 * was enough for every other gating test here. */
const ADMIN_PARK_MIDDLEWARE = [
  'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"',
  "export default defineMiddleware((req) =>",
  '  req.routeId !== "/park" || req.headers["x-admin"]',
  "    ? allow()",
  "    : reject(403, { routeId: req.routeId }),",
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

    // Prove the fixture middleware RAN before reading anything into a 200. An
    // unloadable fixture now fails the boot rather than silently yielding no
    // middleware, but a handler that never calls runMiddleware would still serve
    // 200s here and make this GET look gated when it is not.
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

  it("refuses with 409 thread_route_unknown when the recorded route is gone, without echoing it", async () => {
    const handler = await createHandler(await fixtureApp())

    // A recorded route the registry cannot resolve. Reachable in the field
    // whenever a route file is renamed or deleted while a thread that ran it
    // still exists; reachable here because POST /threads takes client-supplied
    // metadata, the same seam the persisted-route test above uses.
    const created = await handler.fetch(
      new Request("http://localhost/threads", {
        body: JSON.stringify({ metadata: { route: "/retired-route#agent" } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(created.status).toBe(200)
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    const response = await handler.fetch(pendingInterruptsRequest(threadId))

    expect(response.status).toBe(409)
    const body = (await response.json()) as ErrorBody
    // Same code as the never-ran arm: both mean "no usable route identity".
    expect(body.error.details?.code).toBe("thread_route_unknown")
    // The caller is still UNGATED here, so the server-derived key must not come
    // back — it would tell anyone who can name a thread id which route it ran.
    // The sibling `Unknown route: ...` sites may echo because there the key came
    // from the caller's own request body.
    expect(body.error.message).not.toContain("/retired-route")
    expect(JSON.stringify(body)).not.toContain("retired-route")
  })

  it("keeps gating on the route that PARKED after a weaker route runs on the thread", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const handler = await createHandler(
      await fixtureApp({ "src/middleware.ts": ADMIN_PARK_MIDDLEWARE }),
    )
    const threadId = "t-route-swap"

    // An admin parks a permission prompt on the protected route.
    const parkedRun = await handler.fetch(
      parkRunRequest(threadId, "deploy to staging", { "x-admin": "1" }),
    )
    expect(parkedRun.status).toBe(200)
    expect(await readSseText(parkedRun)).toContain("event: interrupt")

    // The unprivileged caller is refused, as they must be.
    const beforeSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(beforeSwap.status).toBe(403)
    expect(await beforeSwap.json()).toEqual({ routeId: "/park" })

    // Now they run a route the policy DOES allow them, on the same thread. The
    // run itself is legitimate; `/echo` is a plain graph that never touches the
    // checkpointer, so the parked `__interrupt__` write survives it untouched.
    const swap = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(swap.status).toBe(200)
    await drain(swap)

    // Gating identity must still be the PARKING route. Resolving it from the
    // last run instead hands this caller the interruptId/resumeKey pair that
    // POST /resume needs to answer someone else's permission prompt.
    const afterSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(afterSwap.status).toBe(403)
    expect(await afterSwap.json()).toEqual({ routeId: "/park" })

    // ...and the admin still gets the prompt back.
    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-admin": "1" }))
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as PendingInterruptsBody).interrupts).toHaveLength(1)
  }, 60_000)

  it("keeps gating on the parking route when the park happened on /runs/wait", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const handler = await createHandler(
      await fixtureApp({ "src/middleware.ts": ADMIN_PARK_MIDDLEWARE }),
    )
    const threadId = "t-route-swap-wait"

    // /runs/wait is excluded from the parked-STATUS work by spec §4, but it can
    // still park — and a park it does not record is a park this gate cannot see.
    const parkedRun = await handler.fetch(
      parkWaitRequest(threadId, "deploy to staging", { "x-admin": "1" }),
    )
    expect(parkedRun.status).toBe(200)

    const beforeSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(beforeSwap.status).toBe(403)

    const swap = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(swap.status).toBe(200)
    await drain(swap)

    const afterSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(afterSwap.status).toBe(403)
    expect(await afterSwap.json()).toEqual({ routeId: "/park" })

    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-admin": "1" }))
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as PendingInterruptsBody).interrupts).toHaveLength(1)
  }, 60_000)

  it("keeps gating on the parking route when the park happened over AG-UI", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const handler = await createHandler(
      await fixtureApp({ "src/middleware.ts": ADMIN_PARK_MIDDLEWARE }),
    )
    const threadId = "t-route-swap-agui"

    // /agui is where most parks are actually born — it is what the CopilotKit
    // chat and research UIs drive — so a park it fails to record is the common
    // case, not a corner one.
    const parkedRun = await handler.fetch(
      aguiParkRequest(threadId, "deploy to staging", { "x-admin": "1" }),
    )
    expect(parkedRun.status).toBe(200)
    await drain(parkedRun)

    const beforeSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(beforeSwap.status).toBe(403)

    const swap = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(swap.status).toBe(200)
    await drain(swap)

    const afterSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(afterSwap.status).toBe(403)
    expect(await afterSwap.json()).toEqual({ routeId: "/park" })

    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-admin": "1" }))
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as PendingInterruptsBody).interrupts).toHaveLength(1)
  }, 60_000)

  it("keeps gating when a weaker AGENT route fails before its graph runs", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const handler = await createHandler(
      await fixtureApp({
        "src/app/broken/index.ts": BROKEN_AGENT_ROUTE,
        "src/middleware.ts": ADMIN_PARK_MIDDLEWARE,
      }),
    )
    const threadId = "t-route-swap-broken-agent"

    await drain(
      await handler.fetch(parkRunRequest(threadId, "deploy to staging", { "x-admin": "1" })),
    )
    expect((await handler.fetch(pendingInterruptsRequest(threadId))).status).toBe(403)

    // Direct cover for settleParkedRoute's `pending.size > 0` guard, which every
    // other case here reaches only to skip: `/echo` short-circuits on !canPark
    // before the read, so deleting the guard leaves them all passing. An AGENT
    // route gets past that short-circuit, and one that dies at model resolution
    // never runs its graph — so the admin's interrupt is still the checkpoint's
    // latest pending write when this turn asks to retire the gate.
    const swap = await handler.fetch(runStreamRequest(threadId, "/broken#agent", {}))
    expect(swap.status).toBe(200)
    // Pins the premise rather than assuming it: the turn has to have FAILED, and
    // failed early. A route that merely completed would prove nothing here.
    expect(await readSseText(swap)).toContain("error")

    const afterSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(afterSwap.status).toBe(403)
    expect(await afterSwap.json()).toEqual({ routeId: "/park" })

    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-admin": "1" }))
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as PendingInterruptsBody).interrupts).toHaveLength(1)
  }, 60_000)

  it("keeps gating when a parked /runs/wait turn is cancelled mid-flight", async () => {
    const appRoot = await fixtureApp({
      "src/app/park/tools/slowPing.ts": SLOW_PING_TOOL,
      "src/middleware.ts": ADMIN_PARK_MIDDLEWARE,
    })
    const startedFile = join(appRoot, "slow-started.json")
    const releaseFile = join(appRoot, "slow-release.json")
    // One assistant turn, two tool calls: the approve-gated one parks, the
    // ordinary one keeps the superstep from ending. Built as a literal because
    // script().callsTool emits one call per turn.
    await withAimock([
      {
        match: { hasToolResult: false, turnIndex: 0, userMessage: "deploy to staging" },
        response: {
          toolCalls: [
            { arguments: { env: "staging" }, id: "call_deployProd_0_0", name: "deployProd" },
            { arguments: { releaseFile, startedFile }, id: "call_slowPing_0_0", name: "slowPing" },
          ],
        },
      },
    ])
    const saver = new MemorySaver()
    const handler = await createHandler(appRoot, saver)
    const threadId = "t-wait-cancel-park"

    // Deliberately not awaited: the whole point is to act while it is in flight.
    const waitPromise = handler.fetch(
      parkWaitRequest(threadId, "deploy to staging", { "x-admin": "1" }),
    )

    // Both preconditions, proven rather than slept for: the ordinary tool is
    // running, and the permission interrupt is already DURABLE in the
    // checkpoint. The second is the attacker's oracle — everything the endpoint
    // would hand over already exists at this instant.
    await waitForFile(startedFile)
    await waitForParkedWrite(saver, threadId)

    // Both of these are ungated today, which is what makes the window
    // reachable without credentials. Gating them is tracked separately; this
    // test only pins that reaching it wins the attacker nothing.
    expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)
    const waitResponse = await waitPromise
    expect(waitResponse.status).toBe(409)
    expect(((await waitResponse.json()) as ErrorBody).error.details?.code).toBe("run_cancelled")

    // The cancelled arm returns while the route is STILL EXECUTING, so the
    // settle cannot happen at return time — it has to wait for the abandoned
    // route to unwind. Releasing the tool is what lets that finally happen.
    await writeFile(releaseFile, "release")

    const swap = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(swap.status).toBe(200)
    await drain(swap)

    // Polled, not read once: the settle is deferred behind the abandoned
    // route's own unwind, so "eventually" is the honest contract here.
    await waitFor(async () => {
      const refused = await handler.fetch(pendingInterruptsRequest(threadId))
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ routeId: "/park" })
    })

    const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-admin": "1" }))
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as PendingInterruptsBody).interrupts).toHaveLength(1)
  }, 60_000)

  it("keeps gating when a parked /runs/wait turn then fails", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const saver = new BreakAfterParkSaver()
    const handler = await createHandler(
      await fixtureApp({ "src/middleware.ts": ADMIN_PARK_MIDDLEWARE }),
      saver,
    )
    const threadId = "t-wait-failed-park"

    // Covers /runs/wait's THIRD exit arm. A turn that parked and then failed is
    // still parked: the interrupt write is durable, so the arm that reports the
    // failure has to record the gate exactly like the arm that reports output.
    const failed = await handler.fetch(
      parkWaitRequest(threadId, "deploy to staging", { "x-admin": "1" }),
    )
    expect(failed.status).toBe(500)
    await waitForParkedWrite(saver, threadId)

    const swap = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(swap.status).toBe(200)
    await drain(swap)

    const afterSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(afterSwap.status).toBe(403)
    expect(await afterSwap.json()).toEqual({ routeId: "/park" })
  }, 60_000)

  it("refuses to delete a thread mid-turn, so the park stays recordable", async () => {
    const appRoot = await fixtureApp({
      "src/app/park/tools/slowPing.ts": SLOW_PING_TOOL,
      "src/middleware.ts": ADMIN_PARK_MIDDLEWARE,
    })
    const startedFile = join(appRoot, "delete-race-started.json")
    const releaseFile = join(appRoot, "delete-race-release.json")
    // The ungated tool runs FIRST, so there is a long stretch where the thread
    // is busy and nothing is parked yet — the window the delete has to land in.
    await withAimock(
      script()
        .user("deploy to staging")
        .callsTool("slowPing", { releaseFile, startedFile })
        .callsTool("deployProd", { env: "staging" })
        .build(),
    )
    const handler = await createHandler(appRoot)
    const threadId = "t-delete-midturn"

    const streamPromise = handler.fetch(
      parkRunRequest(threadId, "deploy to staging", { "x-admin": "1" }),
    )
    await waitForFile(startedFile)

    // Every settle path ends in updateMetadata, which is a documented NO-OP for
    // a missing row — not an error. So deleting the row here used to let the
    // turn park durably while its gate write silently wrote nothing, and the
    // attacker then recreated the row with a route of their own.
    const deleted = await handler.fetch(deleteThreadRequest(threadId))
    expect(deleted.status).toBe(409)
    const deleteBody = (await deleted.json()) as ErrorBody
    expect(deleteBody.error.details?.code).toBe("run_in_flight")

    await writeFile(releaseFile, "release")
    const streamText = await readSseText(await streamPromise)
    expect(streamText).toContain("event: interrupt")

    const swap = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
    expect(swap.status).toBe(200)
    await drain(swap)

    const afterSwap = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(afterSwap.status).toBe(403)
    expect(await afterSwap.json()).toEqual({ routeId: "/park" })
  }, 60_000)

  it("deletes a thread once its turn has finished", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-delete-idle"
    await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))

    // The refusal above is scoped to an IN-FLIGHT run, not to threads in
    // general: a settled thread still deletes, and its row and its payload go
    // together. Without this the 409 could be over-broad and nothing would say.
    expect((await handler.fetch(deleteThreadRequest(threadId))).status).toBe(204)
    expect((await handler.fetch(pendingInterruptsRequest(threadId))).status).toBe(404)
  }, 30_000)

  it("stops gating on the parking route once the parked prompt is answered", async () => {
    await withAimock(
      script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed.")
        .build(),
    )
    const handler = await createHandler(
      await fixtureApp({ "src/middleware.ts": ADMIN_PARK_MIDDLEWARE }),
    )
    const threadId = "t-route-swap-cleared"

    await drain(
      await handler.fetch(parkRunRequest(threadId, "deploy to staging", { "x-admin": "1" })),
    )
    const parked = await handler.fetch(pendingInterruptsRequest(threadId, { "x-admin": "1" }))
    expect(parked.status).toBe(200)
    const interruptId = ((await parked.json()) as PendingInterruptsBody).interrupts[0]?.interruptId
    expect(interruptId).toBeTruthy()

    // The resume answers the prompt and completes, so nothing is parked anymore.
    await drain(await handler.fetch(resumeRequest(threadId, interruptId ?? "", { "x-admin": "1" })))

    // The pin has to be retired, not merely stop mattering: /park is still the
    // LAST-RUN route here, so it would answer 403 either way. Moving the thread
    // onto /echo is what makes the two designs disagree — a pin that survives an
    // answered prompt gates an empty list on a route nobody is parked under, and
    // would keep doing so for every future turn on this thread.
    await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))

    const after = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({ interrupts: [] })
  }, 60_000)
})

function deleteThreadRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}`, { method: "DELETE" })
}

function cancelRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" })
}

async function threadStatus(handler: Handler, threadId: string): Promise<string> {
  const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
  expect(response.status).toBe(200)
  return ((await response.json()) as { status: string }).status
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

// ---------------------------------------------------------------------------
// "interrupted" is deliberately overloaded: cancelled OR parked. The
// discriminator is pending_interrupts — non-empty means the agent is waiting
// on a human. Both halves are asserted here so the overload cannot silently
// lose one of its meanings.
// ---------------------------------------------------------------------------

describe("thread status after a parked or cancelled turn", () => {
  it("marks a parked thread interrupted, with a non-empty pending_interrupts", async () => {
    await withAimock(
      script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    )
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-parked-status"

    await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))

    expect(await threadStatus(handler, threadId)).toBe("interrupted")
    const body = await readPendingInterruptsBody(handler, threadId)
    expect(body.interrupts).toHaveLength(1)
  }, 60_000)

  it("marks a cancelled thread interrupted, with an empty pending_interrupts", async () => {
    const appRoot = await fixtureApp()
    const handler = await createHandler(appRoot)
    const threadId = "t-cancelled-status"
    const startedFile = join(appRoot, "cancelled-started.json")
    const releaseFile = join(appRoot, "cancelled-release.json")

    const runResponse = await handler.fetch(
      runStreamRequest(threadId, "/blocking#graph", { releaseFile, startedFile }),
    )
    await waitForFile(startedFile)
    expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)
    await drain(runResponse)

    expect(await threadStatus(handler, threadId)).toBe("interrupted")
    const body = await readPendingInterruptsBody(handler, threadId)
    expect(body.interrupts).toEqual([])

    // The cancel stopped us CONSUMING the route, not the route itself: without
    // this the abandoned loop keeps polling for 15s past teardown, against a
    // tmpdir afterEach has already removed.
    await writeFile(releaseFile, "release")
  }, 30_000)

  it("still reports idle after a turn that completes without parking", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-completed-status"

    await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))

    expect(await threadStatus(handler, threadId)).toBe("idle")
  }, 30_000)
})

function resumeRequest(
  threadId: string,
  interruptId: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/threads/${threadId}/resume`, {
    body: JSON.stringify({
      resume: [{ interruptId, payload: "once", status: "resolved" }],
      route: "/park#agent",
    }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

describe("thread status after a resumed turn", () => {
  it("marks the thread interrupted when the resumed turn parks again", async () => {
    // "once" authorizes exactly one call, so the second call to the same tool
    // re-prompts and the resumed turn parks again.
    await withAimock(
      script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .callsTool("deployProd", { env: "prod" })
        .build(),
    )
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-resume-parks-again"

    await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))
    const first = await readPendingInterruptsBody(handler, threadId)
    const interruptId = first.interrupts[0]?.interruptId ?? ""
    expect(interruptId).not.toBe("")

    const resumeText = await readSseText(await handler.fetch(resumeRequest(threadId, interruptId)))
    expect(resumeText).toContain("event: interrupt")

    expect(await threadStatus(handler, threadId)).toBe("interrupted")
    const second = await readPendingInterruptsBody(handler, threadId)
    expect(second.interrupts).toHaveLength(1)
    // A NEW park, not an echo of the answered one.
    expect(second.interrupts[0]?.interruptId).not.toBe(interruptId)
  }, 60_000)

  it("returns the thread to idle when the resumed turn completes", async () => {
    await withAimock(
      script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-resume-completes"

    await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))
    const parked = await readPendingInterruptsBody(handler, threadId)
    const interruptId = parked.interrupts[0]?.interruptId ?? ""
    // Without this the whole test passes vacuously when the first turn never
    // parks: the resume 404s, the thread is still "idle", and the empty list
    // below is the state the thread was already in.
    expect(interruptId).not.toBe("")

    await drain(await handler.fetch(resumeRequest(threadId, interruptId)))

    expect(await threadStatus(handler, threadId)).toBe("idle")
    // The answered prompt is gone from durable state, so a reconnecting client
    // does not re-render a decision the human already made.
    const after = await readPendingInterruptsBody(handler, threadId)
    expect(after.interrupts).toEqual([])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Direct cover for the decision rule the handlers share. The parked-and-failed
// combination genuinely happens — the success-path status write sits inside the
// same try, so a write that rejects lands in the catch with the interrupt
// already seen — but it cannot be DRIVEN from here: reaching it needs a
// ThreadsStore that fails on demand, and createRuntimeFetchHandler exposes no
// seam to inject one. These cases are therefore the only coverage that
// combination gets — they pin the rule, not the wiring that feeds it.
// ---------------------------------------------------------------------------

describe("terminalStatus", () => {
  it("reports idle for a turn that neither parked nor was cancelled", () => {
    expect(terminalStatus({ cancelled: false, sawInterrupt: false })).toBe("idle")
  })

  it("reports interrupted for a parked turn", () => {
    expect(terminalStatus({ cancelled: false, sawInterrupt: true })).toBe("interrupted")
  })

  it("reports interrupted for a cancelled turn", () => {
    expect(terminalStatus({ cancelled: true, sawInterrupt: false })).toBe("interrupted")
  })

  it("reports interrupted for a turn that parked and was then cancelled", () => {
    expect(terminalStatus({ cancelled: true, sawInterrupt: true })).toBe("interrupted")
  })
})

// ---------------------------------------------------------------------------
// The endpoint reads nothing but the checkpointer's pending writes, so the
// saver is the only dependency that can change the LISTED INTERRUPTS: the 404
// and both 409 arms return before the checkpointer is touched, and the threads
// store that serves them has its own real-Postgres suite. Everything above runs
// on sqlite; this runs the same park → list → resume → empty arc against real
// Postgres. Gated on DAWN_TEST_PGSTORAGE=1 (needs Docker), matching
// packages/postgres-storage/test/*.
// ---------------------------------------------------------------------------

/** The one place the gate's env var is spelled, so the self-check below and the
 * suite it watches can never drift onto different names. */
const PGSTORAGE_LANE_REQUESTED = process.env.DAWN_TEST_PGSTORAGE === "1"

/** Flipped by the gated test itself. Vitest has no flag that fails a run for
 * SKIPPING tests — `--passWithNoTests` (already false by default in vitest 4)
 * only covers a filter that matches no FILE, which is a different mistake — so
 * "the CI step went green having run zero Postgres assertions" has to be caught
 * in the file. See the self-check at the bottom. */
let postgresLaneRan = false

describe.skipIf(!PGSTORAGE_LANE_REQUESTED)(
  "pending_interrupts against a real Postgres checkpointer",
  () => {
    let container: StartedPostgreSqlContainer
    let connectionString: string
    // handler.close() does NOT close an injected checkpointer, so the pool is
    // this suite's to end — otherwise vitest hangs on an open pg pool.
    //
    // Module-level rather than the per-test try/finally the sibling suite uses
    // (packages/postgres-storage/test/assume-migrated.test.ts), because here the
    // ORDERING is what matters: afterEach's handler.close() drains runs that may
    // still be writing checkpoints, so the pool has to outlive the test body.
    const savers: DawnPostgresSaver[] = []

    beforeAll(async () => {
      // A loaded CI runner can take minutes to pull postgres:16 and accept the
      // first connection; Testcontainers' 60s default is the honest lever.
      container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
      connectionString = container.getConnectionUri()
    }, 240_000)

    afterAll(async () => {
      // try/finally, not allSettled: a close() that rejects is still worth
      // surfacing, but it must never strand a running container.
      try {
        await Promise.all(savers.splice(0).map((saver) => saver.close()))
      } finally {
        await container?.stop()
      }
    })

    it("parks, lists the payload, and clears after a resume", async () => {
      await withAimock(
        script()
          .user("deploy to staging")
          .callsTool("deployProd", { env: "staging" })
          .replies("Deployed.")
          .build(),
      )
      const checkpointer = postgresCheckpointer({
        connectionString,
        // Fresh, never-migrated table set per test — no truncation, no teardown.
        tablePrefix: `t_${Math.random().toString(36).slice(2)}`,
      })
      // Registered before ready(), so a migration that throws still gets its
      // pool ended rather than leaking one and hanging the run.
      savers.push(checkpointer)
      await checkpointer.ready()
      const handler = await createHandler(await fixtureApp(), checkpointer)
      const threadId = "t-pg-parked"

      await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))

      // Proof this lane is worth its container: the assertion goes through the
      // saver instance directly, against a table prefix that exists only for
      // this test. If the handler ignored the injected checkpointer and used
      // the sqlite fallback, Postgres would hold nothing here — and every
      // assertion below would still pass, making the whole lane a no-op.
      const tuple = await checkpointer.getTuple({
        configurable: { checkpoint_ns: "", thread_id: threadId },
      })
      expect(tuple?.pendingWrites?.map(([, channel]) => channel)).toContain("__interrupt__")

      expect(await threadStatus(handler, threadId)).toBe("interrupted")
      const parked = await readPendingInterruptsBody(handler, threadId)
      expect(parked.interrupts).toHaveLength(1)
      expect(parked.interrupts[0]?.value).toMatchObject({ type: "permission-request" })

      const interruptId = parked.interrupts[0]?.interruptId ?? ""
      await drain(await handler.fetch(resumeRequest(threadId, interruptId)))

      expect(await threadStatus(handler, threadId)).toBe("idle")
      expect((await readPendingInterruptsBody(handler, threadId)).interrupts).toEqual([])

      // Last line of the test, so it records that every assertion above ran.
      postgresLaneRan = true
    }, 120_000)
  },
)

// ---------------------------------------------------------------------------
// Makes the gated CI step self-verifying. Without this the step is green under
// two very different outcomes — the Postgres arc passed, or the suite above
// quietly skipped and the run asserted nothing about Postgres at all. Vitest 4
// offers no mechanism to tell those apart from the outside: `passWithNoTests`
// is already false by default (a filter matching no file exits 1, verified),
// but a file that matches while its only new suite is skipped still reports
// success, and there is no fail-on-skipped flag to reach for. So the check
// lives here, where it can see whether the suite actually ran.
//
// Declared last because vitest runs a file's suites in declaration order.
// ---------------------------------------------------------------------------

describe("gated Postgres lane", () => {
  it("runs its assertions whenever DAWN_TEST_PGSTORAGE asks for them", () => {
    // Also pins the gate's polarity from the ordinary no-Docker lane: a suite
    // that ran without being asked would be starting containers everywhere.
    expect(postgresLaneRan).toBe(PGSTORAGE_LANE_REQUESTED)
  })
})
