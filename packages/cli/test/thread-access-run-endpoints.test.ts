import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy, ThreadAccessRequest } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
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
        fallback: () => {
          throw new Error("fallback should not be reached for run.stream")
        },
        update: (request) => {
          seen.push(request.operation)
          return { decision: "deny" }
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
        fallback: () => {
          throw new Error("fallback should not be reached for run.wait")
        },
        update: (request) => {
          seen.push(request.operation)
          return { decision: "deny" }
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
        fallback: () => {
          throw new Error("fallback should not be reached for run.agui")
        },
        update: (request) => {
          seen.push(request.operation)
          return { decision: "deny" }
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
