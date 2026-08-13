import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy, ThreadAccessRequest, ThreadOperation } from "@dawn-ai/sdk"
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import type { CreateThreadInput, Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"
const HELLO_ROUTE = "/hello#graph"

/**
 * Same fixture-app shape as `thread-access-endpoints.test.ts`: a scratch app
 * with one trivial graph route, `threadAccess`/`threadsStore` injected through
 * `StartRuntimeServerOptions` (this package cannot import the harness in
 * `@dawn-ai/testing` without a build cycle).
 */
async function setup(
  options: {
    readonly threadAccess?: ThreadAccessPolicy
    readonly threadsStore?: ThreadsStore
  } = {},
): Promise<{ readonly handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>> }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-run-endpoints-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-run-endpoints-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(options.threadAccess ? { threadAccess: options.threadAccess } : {}),
    ...(options.threadsStore ? { threadsStore: options.threadsStore } : {}),
  })
  cleanup.push(() => handler.close())
  return { handler }
}

function post(path: string, payload?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), {
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
}

/**
 * A minimal, schema-valid `RunAgentInput` body for `POST /agui/:routeId`.
 * `routeKey` is URL-encoded into the path — the route table has no `threads`
 * segment here, so the client-supplied `threadId` in the body is the only
 * thread identity this endpoint sees.
 */
function aguiPost(
  routeKey: string,
  payload: { readonly threadId: string; readonly runId: string } & Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(new URL(`/agui/${encodeURIComponent(routeKey)}`, "http://localhost"), {
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...headers,
    },
    method: "POST",
    body: JSON.stringify({ state: {}, tools: [], context: [], forwardedProps: {}, ...payload }),
  })
}

/**
 * `ownerOnlyPolicy`, except the deny is held open until the test releases
 * it. Pins a denied caller mid-flight — INSIDE the policy, before it can
 * reach any side effect — so a test can prove that side effect was never
 * taken. A gate placed after the side effect would be holding it while this
 * caller is still parked here.
 */
interface HeldDenyPolicy {
  readonly policy: ThreadAccessPolicy
  /** Resolves once a denied caller is inside the policy and cannot advance. */
  readonly denyEntered: Promise<void>
  readonly releaseDeny: () => void
}

function heldDenyOwnerOnlyPolicy(): HeldDenyPolicy {
  let markEntered: () => void = () => undefined
  const denyEntered = new Promise<void>((resolve) => {
    markEntered = () => resolve()
  })
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return {
    denyEntered,
    policy: {
      fallback: async (request) => {
        if (request.headers["x-actor"] === "owner") return { decision: "allow" }
        markEntered()
        await held
        return { decision: "deny" }
      },
    },
    releaseDeny: () => release(),
  }
}

/** Reads the response body to completion so a streaming run finishes and releases its slot. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

/**
 * An in-memory `ThreadsStore` that reports every id handed to `createThread` —
 * the HTTP response alone cannot answer "was a row created", only the store
 * the endpoint actually wrote to can.
 */
function recordingThreadsStore(onCreate: (threadId: string) => void): ThreadsStore {
  const threads = new Map<string, Thread>()
  let seq = 0
  return {
    createThread: async (input) => {
      const now = new Date().toISOString()
      const thread: Thread = {
        created_at: now,
        metadata: input.metadata ?? {},
        status: "idle",
        thread_id: input.thread_id ?? `t-rec-${++seq}`,
        updated_at: now,
      }
      threads.set(thread.thread_id, thread)
      onCreate(thread.thread_id)
      return thread
    },
    deleteThread: async (threadId) => {
      threads.delete(threadId)
    },
    getThread: async (threadId) => threads.get(threadId),
    listThreads: async () => [...threads.values()],
    updateMetadata: async (threadId, patch) => {
      const thread = threads.get(threadId)
      if (thread) threads.set(threadId, { ...thread, metadata: { ...thread.metadata, ...patch } })
    },
    updateStatus: async (threadId, status) => {
      const thread = threads.get(threadId)
      if (thread) threads.set(threadId, { ...thread, status })
    },
  }
}

describe("POST /threads/:id/runs/stream", () => {
  it("denies an unauthorized run without creating the row or taking a run slot", async () => {
    const seen: ThreadAccessRequest["operation"][] = []
    const created: string[] = []
    const threadsStore = recordingThreadsStore((id) => created.push(id))
    const { handler } = await setup({
      threadAccess: {
        // The row does not exist, so this run's own create is the decision
        // being asked for — `update` would be asking about a thread that is
        // not there. Both other handlers throw rather than record: a denial
        // that arrived on the wrong axis is not the denial this test claims.
        create: (request) => {
          seen.push(request.operation)
          return { decision: "deny" }
        },
        fallback: () => {
          throw new Error("fallback should not be reached for run.stream")
        },
        update: () => {
          throw new Error("a missing row is a create, not an update, for run.stream")
        },
      },
      threadsStore,
    })

    const response = await handler.fetch(
      post("/threads/t-victim/runs/stream", { input: {}, route: HELLO_ROUTE }),
    )

    expect(response.status).toBe(403)
    expect(seen).toEqual(["run.stream"])
    expect(created).toEqual([])
    expect(await threadsStore.getThread("t-victim")).toBeUndefined()
  })

  it("allows an authorized run", async () => {
    const { handler } = await setup({ threadAccess: { fallback: () => ({ decision: "allow" }) } })
    const response = await handler.fetch(
      post("/threads/t-mine/runs/stream", { input: {}, route: HELLO_ROUTE }),
    )
    expect(response.status).toBe(200)
    await drain(response)
  })

  it("does not take the run slot on a denied request: a second, authorized run on the same thread still succeeds", async () => {
    // If the denied request had reached `runRegistry.begin` before the gate
    // rejected it, the slot would still be held (nothing ever releases a slot
    // it never legitimately finished with), and this second call would 409
    // with run_in_flight instead of completing normally.
    let calls = 0
    const threadAccess: ThreadAccessPolicy = {
      fallback: () => {
        calls += 1
        return calls === 1 ? { decision: "deny" } : { decision: "allow" }
      },
    }
    const { handler } = await setup({ threadAccess })

    const denied = await handler.fetch(
      post("/threads/t-retry/runs/stream", { input: {}, route: HELLO_ROUTE }),
    )
    expect(denied.status).toBe(403)

    const allowed = await handler.fetch(
      post("/threads/t-retry/runs/stream", { input: {}, route: HELLO_ROUTE }),
    )
    expect(allowed.status).toBe(200)
    await drain(allowed)
  })
})

describe("POST /threads/:id/runs/wait", () => {
  it("denies an unauthorized run without creating the row or taking a run slot", async () => {
    const seen: ThreadAccessRequest["operation"][] = []
    const created: string[] = []
    const threadsStore = recordingThreadsStore((id) => created.push(id))
    const { handler } = await setup({
      threadAccess: {
        // The row does not exist, so this run's own create is the decision
        // being asked for — `update` would be asking about a thread that is
        // not there. Both other handlers throw rather than record: a denial
        // that arrived on the wrong axis is not the denial this test claims.
        create: (request) => {
          seen.push(request.operation)
          return { decision: "deny" }
        },
        fallback: () => {
          throw new Error("fallback should not be reached for run.wait")
        },
        update: () => {
          throw new Error("a missing row is a create, not an update, for run.wait")
        },
      },
      threadsStore,
    })

    const response = await handler.fetch(
      post("/threads/t-victim/runs/wait", { input: {}, route: HELLO_ROUTE }),
    )

    expect(response.status).toBe(403)
    expect(seen).toEqual(["run.wait"])
    expect(created).toEqual([])
    expect(await threadsStore.getThread("t-victim")).toBeUndefined()
  })

  it("allows an authorized run", async () => {
    const { handler } = await setup({ threadAccess: { fallback: () => ({ decision: "allow" }) } })
    const response = await handler.fetch(
      post("/threads/t-mine/runs/wait", { input: {}, route: HELLO_ROUTE }),
    )
    expect(response.status).toBe(200)
  })

  it("does not take the run slot on a denied request: a second, authorized run on the same thread still succeeds", async () => {
    // If the denied request had reached `runRegistry.begin` before the gate
    // rejected it, the slot would still be held (nothing ever releases a slot
    // it never legitimately finished with), and this second call would 409
    // with run_in_flight instead of completing normally.
    let calls = 0
    const threadAccess: ThreadAccessPolicy = {
      fallback: () => {
        calls += 1
        return calls === 1 ? { decision: "deny" } : { decision: "allow" }
      },
    }
    const { handler } = await setup({ threadAccess })

    const denied = await handler.fetch(
      post("/threads/t-retry/runs/wait", { input: {}, route: HELLO_ROUTE }),
    )
    expect(denied.status).toBe(403)

    const allowed = await handler.fetch(
      post("/threads/t-retry/runs/wait", { input: {}, route: HELLO_ROUTE }),
    )
    expect(allowed.status).not.toBe(409)
  })
})

describe("POST /agui/:routeId", () => {
  it("denies an unauthorized run without creating the row or taking a run slot", async () => {
    const seen: ThreadAccessRequest["operation"][] = []
    const created: string[] = []
    const threadsStore = recordingThreadsStore((id) => created.push(id))
    const { handler } = await setup({
      threadAccess: {
        // The row does not exist, so this run's own create is the decision
        // being asked for — `update` would be asking about a thread that is
        // not there. Both other handlers throw rather than record: a denial
        // that arrived on the wrong axis is not the denial this test claims.
        create: (request) => {
          seen.push(request.operation)
          return { decision: "deny" }
        },
        fallback: () => {
          throw new Error("fallback should not be reached for run.agui")
        },
        update: () => {
          throw new Error("a missing row is a create, not an update, for run.agui")
        },
      },
      threadsStore,
    })

    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, { threadId: "t-victim", runId: "run-1", messages: [] }),
    )

    expect(response.status).toBe(403)
    expect(seen).toEqual(["run.agui"])
    expect(created).toEqual([])
    expect(await threadsStore.getThread("t-victim")).toBeUndefined()
  })

  it("allows an authorized run", async () => {
    const { handler } = await setup({ threadAccess: { fallback: () => ({ decision: "allow" }) } })
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, { threadId: "t-mine", runId: "run-1", messages: [] }),
    )
    expect(response.status).toBe(200)
    await drain(response)
  })

  it("does not take the run slot on a denied request: a second, authorized run on the same thread still succeeds", async () => {
    // Same reasoning as the /runs/stream and /runs/wait siblings above: a
    // gate placed after `runRegistry.begin` would leave the slot held
    // (nothing releases a slot it never legitimately finished with), and
    // this second call would 409 with run_in_flight instead of completing.
    let calls = 0
    const threadAccess: ThreadAccessPolicy = {
      fallback: () => {
        calls += 1
        return calls === 1 ? { decision: "deny" } : { decision: "allow" }
      },
    }
    const { handler } = await setup({ threadAccess })

    const denied = await handler.fetch(
      aguiPost(HELLO_ROUTE, { threadId: "t-retry", runId: "run-1", messages: [] }),
    )
    expect(denied.status).toBe(403)

    const allowed = await handler.fetch(
      aguiPost(HELLO_ROUTE, { threadId: "t-retry", runId: "run-2", messages: [] }),
    )
    expect(allowed.status).toBe(200)
    await drain(allowed)
  })

  it("does not take the resume claim on a denied request, so a legitimate resume attempt on the same thread is not DoSed", async () => {
    // The sequential deny-then-allow idiom above cannot prove anything
    // about `resumeClaims`: the claim is released in a top-level `finally`
    // that runs on every early return, so by the time a denied fetch()
    // resolves the claim is already free again regardless of where the
    // gate sits. Proving the ordering needs a caller pinned INSIDE the
    // policy, still holding whatever it holds, while a second request
    // probes the claim.
    const gate = heldDenyOwnerOnlyPolicy()
    const { handler } = await setup({ threadAccess: gate.policy })
    const threadId = "t-agui-claim"

    // Fired and deliberately not awaited: this caller is now pinned inside
    // the policy. If the gate correctly runs before `resumeClaims.tryClaim`,
    // it never reached the claim at all.
    const attacker = handler.fetch(
      aguiPost(HELLO_ROUTE, {
        threadId,
        runId: "attacker-run",
        messages: [],
        resume: [{ interruptId: "guessed-1", status: "resolved" }],
      }),
    )
    await Promise.race([
      gate.denyEntered,
      // A gate placed after the claim never reaches the policy via
      // `fallback` for a caller that already 409'd on the claim itself.
      // Fall through rather than hang; the assertions below catch it.
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])

    // An owner call on the SAME thread, also resume-shaped so it reaches
    // `resumeClaims.tryClaim` itself. Nothing ever parked on this thread,
    // so the claim being free resolves as 409 stale_interrupt (no pending
    // interrupts to match against) rather than 409 resume_in_progress
    // (the claim already held). The two are the same HTTP status and
    // differ only in the error code, which is exactly what this test has
    // to distinguish.
    const second = await handler.fetch(
      aguiPost(
        HELLO_ROUTE,
        {
          threadId,
          runId: "owner-run",
          messages: [],
          resume: [{ interruptId: "guessed-2", status: "resolved" }],
        },
        { "x-actor": "owner" },
      ),
    )
    const body = (await second.json()) as { error: { details?: { code?: string } } }
    // Both outcomes are a 409, so `expect(second.status).toBe(409)` alone
    // would pass either way and could never catch a gate placed after the
    // claim — the `code` assertion below is the one doing the work and must
    // stay. Do not "simplify" this to a status-only check.
    expect(second.status).toBe(409)
    expect(body.error.details?.code).toBe("stale_interrupt")

    gate.releaseDeny()
    expect((await attacker).status).toBe(403)
  }, 10_000)
})

// ---------------------------------------------------------------------------
// The implicit create
//
// All three endpoints below create the thread row when it is missing, on an id
// the CLIENT picked. Until this PR that create passed no metadata, so the row
// carried no access stamp and `thread.access === undefined` stopped meaning
// "created before the policy existed".
// ---------------------------------------------------------------------------

interface RunEndpoint {
  readonly name: string
  readonly operation: ThreadOperation
  readonly request: (threadId: string, headers: Record<string, string>) => Request
}

let runSeq = 0

/** The three endpoints that perform an implicit create, driven identically. */
const RUN_ENDPOINTS: readonly RunEndpoint[] = [
  {
    name: "POST /threads/:id/runs/stream",
    operation: "run.stream",
    request: (threadId, headers) =>
      post(`/threads/${threadId}/runs/stream`, { input: {}, route: HELLO_ROUTE }, headers),
  },
  {
    name: "POST /threads/:id/runs/wait",
    operation: "run.wait",
    request: (threadId, headers) =>
      post(`/threads/${threadId}/runs/wait`, { input: {}, route: HELLO_ROUTE }, headers),
  },
  {
    name: "POST /agui/:routeId",
    operation: "run.agui",
    request: (threadId, headers) =>
      aguiPost(HELLO_ROUTE, { threadId, runId: `run-${++runSeq}`, messages: [] }, headers),
  },
]

/**
 * The policy shape the docs teach and the scaffold ships: `create` stamps the
 * caller, everything else authorizes against the stamp the row carries.
 *
 * `legacyUnstamped` is the branch an app writes for a thread that predates the
 * policy, and it is the whole reason this PR exists — both answers are in the
 * docs and both are wrong in a different way while the implicit create writes
 * no stamp. `"deny"` (the conservative one the scaffold ships, modulo its
 * admin escape hatch) locks the creating caller out of its own thread on turn
 * two. `"allow"` keeps the conversation working and hands every later caller
 * the same row, because an attacker can manufacture an unstamped row on demand
 * by naming an id at a run endpoint.
 */
function stampingOwnerPolicy(legacyUnstamped: "allow" | "deny"): ThreadAccessPolicy {
  return {
    create: (request) => {
      const actor = request.headers["x-actor"]
      return actor ? { decision: "allow", stamp: { ownerId: actor } } : { decision: "deny" }
    },
    fallback: (request) => {
      const actor = request.headers["x-actor"]
      if (!actor) return { decision: "deny" }
      // No row yet: the endpoint is about to make one, and only the `create`
      // handler above decides who owns it. Denying here instead would refuse
      // the first turn outright, which is the other half of the same bind.
      if (request.thread === undefined) return { decision: "allow" }
      const owner = request.thread.access?.ownerId
      if (owner === undefined) return { decision: legacyUnstamped } // legacy thread
      return owner === actor ? { decision: "allow" } : { decision: "deny" }
    },
  }
}

/** Records the whole `createThread` input, not just the id — metadata is the point here. */
function capturingThreadsStore(captured: CreateThreadInput[]): ThreadsStore {
  const threads = new Map<string, Thread>()
  let seq = 0
  return {
    createThread: async (input) => {
      captured.push(input)
      const now = new Date().toISOString()
      const thread: Thread = {
        created_at: now,
        metadata: input.metadata ?? {},
        status: "idle",
        thread_id: input.thread_id ?? `t-cap-${++seq}`,
        updated_at: now,
      }
      threads.set(thread.thread_id, thread)
      return thread
    },
    deleteThread: async (threadId) => {
      threads.delete(threadId)
    },
    getThread: async (threadId) => threads.get(threadId),
    listThreads: async () => [...threads.values()],
    updateMetadata: async (threadId, patch) => {
      const thread = threads.get(threadId)
      if (thread) threads.set(threadId, { ...thread, metadata: { ...thread.metadata, ...patch } })
    },
    updateStatus: async (threadId, status) => {
      const thread = threads.get(threadId)
      if (thread) threads.set(threadId, { ...thread, status })
    },
  }
}

/**
 * The lost side of a create race, made deterministic: `getThread` reports the
 * row absent, so the endpoint takes the create path, and `createThread` hands
 * back a row that belongs to somebody else — what an upsert backend does when
 * two callers both saw an absent row and one of them got there first.
 *
 * Not hypothetical on these endpoints in the way it is on `POST /threads`: the
 * id is client-chosen, so a caller can address any row in the store by name.
 */
function collidingThreadsStore(foreign: Thread): ThreadsStore {
  return {
    createThread: async () => foreign,
    deleteThread: async () => undefined,
    getThread: async () => undefined,
    listThreads: async () => [foreign],
    updateMetadata: async () => undefined,
    updateStatus: async () => undefined,
  }
}

/**
 * `getThread` reports the row absent on the FIRST read and present, owned by a
 * stranger, on every read after it. Reproduces a row appearing between the gate
 * and the create — a window that is a couple of statements wide on the Agent
 * Protocol handlers and much wider on AG-UI, which claims a resume and reads
 * the checkpointer's pending interrupts in between.
 */
function rowAppearsAfterTheGate(foreign: Thread): ThreadsStore {
  let reads = 0
  return {
    createThread: async () => foreign,
    deleteThread: async () => undefined,
    getThread: async () => (++reads === 1 ? undefined : foreign),
    listThreads: async () => [foreign],
    updateMetadata: async () => undefined,
    updateStatus: async () => undefined,
  }
}

describe("a row that appears between the gate and the create", () => {
  it("POST /agui/:routeId: re-authorizes it as an update, and denies a stranger", async () => {
    const now = new Date().toISOString()
    const foreign: Thread = {
      created_at: now,
      metadata: { [THREAD_ACCESS_METADATA_KEY]: { ownerId: "victim" } },
      status: "idle",
      thread_id: "t-appeared",
      updated_at: now,
    }
    const { handler } = await setup({
      threadAccess: stampingOwnerPolicy("deny"),
      threadsStore: rowAppearsAfterTheGate(foreign),
    })

    // The `create` decision permitted mallory, for a thread that did not exist
    // when it was asked. By the time the run reaches the create, one does — and
    // it is the victim's. Proceeding on the strength of the earlier decision
    // would be running on a thread nothing authorized this caller to touch.
    const response = await handler.fetch(
      aguiPost(
        HELLO_ROUTE,
        { threadId: "t-appeared", runId: "run-appeared", messages: [] },
        {
          "x-actor": "mallory",
        },
      ),
    )
    expect(response.status).toBe(403)
    await drain(response)
  }, 30_000)
})

describe("the implicit create a run endpoint performs", () => {
  for (const endpoint of RUN_ENDPOINTS) {
    it(`${endpoint.name}: the creating caller can take a SECOND turn on the thread it created`, async () => {
      // The conservative legacy branch: an unstamped row is nobody's. Until
      // the implicit create was stamped, this policy served turn one and then
      // refused its own author on turn two, because the row it had just made
      // read back as a thread that predated the policy.
      const { handler } = await setup({ threadAccess: stampingOwnerPolicy("deny") })
      const threadId = "t-implicit-second-turn"
      const actor = { "x-actor": "alice" }

      const first = await handler.fetch(endpoint.request(threadId, actor))
      expect(first.status).toBe(200)
      await drain(first)

      // The turn that was broken: the row exists now, and until this PR it
      // carried no stamp, so its own creator arrived as a stranger.
      const second = await handler.fetch(endpoint.request(threadId, actor))
      expect(second.status).toBe(200)
      await drain(second)
    }, 30_000)

    it(`${endpoint.name}: stamps the creating caller into the row`, async () => {
      const captured: CreateThreadInput[] = []
      const { handler } = await setup({
        threadAccess: stampingOwnerPolicy("deny"),
        threadsStore: capturingThreadsStore(captured),
      })

      const response = await handler.fetch(endpoint.request("t-stamped", { "x-actor": "alice" }))
      expect(response.status).toBe(200)
      await drain(response)

      expect(captured).toEqual([
        {
          metadata: { [THREAD_ACCESS_METADATA_KEY]: { ownerId: "alice" } },
          thread_id: "t-stamped",
        },
      ])
    }, 30_000)

    it(`${endpoint.name}: an intruder is denied on a thread another caller's run created`, async () => {
      // The migration hazard in one test. `fallback` admits an unstamped row as
      // a legacy thread, which is the common shape mid-rollout. Before the
      // implicit create was stamped, alice's turn manufactured exactly such a
      // row on demand and bob walked straight into it.
      const { handler } = await setup({ threadAccess: stampingOwnerPolicy("allow") })
      const threadId = "t-implicit-intruder"

      const mine = await handler.fetch(endpoint.request(threadId, { "x-actor": "alice" }))
      expect(mine.status).toBe(200)
      await drain(mine)

      const theirs = await handler.fetch(endpoint.request(threadId, { "x-actor": "bob" }))
      expect(theirs.status).toBe(403)
      await drain(theirs)
    }, 30_000)

    it(`${endpoint.name}: denies when the store hands back a row that belongs to someone else`, async () => {
      const now = new Date().toISOString()
      const foreign: Thread = {
        created_at: now,
        metadata: { [THREAD_ACCESS_METADATA_KEY]: { ownerId: "victim" } },
        status: "idle",
        thread_id: "t-collided",
        updated_at: now,
      }
      const { handler } = await setup({
        threadAccess: stampingOwnerPolicy("deny"),
        threadsStore: collidingThreadsStore(foreign),
      })

      // The `create` decision permits mallory and mints a stamp — and is
      // irrelevant, because the row that came back is the victim's. Only a
      // recheck against the ROW catches that; comparing the returned row's
      // stamp with the minted one would not, since a `permit()` with no stamp
      // makes both sides `undefined`.
      const response = await handler.fetch(endpoint.request("t-collided", { "x-actor": "mallory" }))
      expect(response.status).toBe(403)
      await drain(response)
    }, 30_000)

    it(`${endpoint.name}: asks under create, then rechecks the row under update`, async () => {
      const seen: ThreadAccessRequest[] = []
      const { handler } = await setup({
        threadAccess: {
          create: (request) => {
            seen.push(request)
            return { decision: "allow", stamp: { ownerId: "alice" } }
          },
          fallback: (request) => {
            seen.push(request)
            return { decision: "allow" }
          },
        },
      })

      const response = await handler.fetch(endpoint.request("t-two-step", { "x-actor": "alice" }))
      expect(response.status).toBe(200)
      await drain(response)

      expect(seen.map((request) => request.action)).toEqual(["create", "update"])
      // The endpoint's own operation throughout — never rewritten to
      // `thread.create`, which names a different endpoint.
      expect(seen.map((request) => request.operation)).toEqual([
        endpoint.operation,
        endpoint.operation,
      ])
      // No client metadata reaches these paths at all.
      expect(seen[0]?.requestedMetadata).toBeUndefined()
      expect(seen[0]?.thread).toBeUndefined()
      expect(seen[0]?.threadId).toBe("t-two-step")
      // The recheck authorizes the row that actually came back.
      expect(seen[1]?.thread?.access).toEqual({ ownerId: "alice" })
      expect(seen[1]?.threadId).toBe("t-two-step")
    }, 30_000)

    it(`${endpoint.name}: writes no metadata on the implicit create when the app has no policy`, async () => {
      // PR A's contract: no policy file means today's behavior, exactly. Not
      // `metadata: {}` either — the store distinguishes them.
      const captured: CreateThreadInput[] = []
      const { handler } = await setup({ threadsStore: capturingThreadsStore(captured) })

      const response = await handler.fetch(endpoint.request("t-hookless", {}))
      expect(response.status).toBe(200)
      await drain(response)

      expect(captured).toEqual([{ thread_id: "t-hookless" }])
    }, 30_000)

    it(`${endpoint.name}: writes no metadata when the policy allows the create without a stamp`, async () => {
      const captured: CreateThreadInput[] = []
      const { handler } = await setup({
        threadAccess: { fallback: () => ({ decision: "allow" }) },
        threadsStore: capturingThreadsStore(captured),
      })

      const response = await handler.fetch(endpoint.request("t-unstamped", {}))
      expect(response.status).toBe(200)
      await drain(response)

      expect(captured).toEqual([{ thread_id: "t-unstamped" }])
    }, 30_000)
  }
})
