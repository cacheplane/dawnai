import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  THREAD_ACCESS_METADATA_KEY,
  type ThreadAccessPolicy,
  type ThreadAccessRequest,
  type ThreadAccessResult,
} from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"

/**
 * A handler over a scratch app. `threadAccess` is injected through
 * `StartRuntimeServerOptions` rather than written to disk: `packages/cli`
 * cannot import `@dawn-ai/testing` (not a dependency, and the reverse edge
 * would be a build cycle), so the injector's own option is exercised from
 * `packages/testing/test/thread-access-harness.test.ts` instead.
 */
async function setup(
  options: {
    readonly checkpointer?: BaseCheckpointSaver
    readonly threadAccess?: ThreadAccessPolicy
    readonly threadsStore?: ThreadsStore
  } = {},
): Promise<{ readonly handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>> }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-endpoints-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-endpoints-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
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

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), { headers, method: "GET" })
}

function del(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), { headers, method: "DELETE" })
}

/**
 * An in-memory `ThreadsStore` that records every metadata object handed to
 * `createThread`. The HTTP response cannot answer the prototype-chain question
 * on its own — `JSON.stringify` never serializes an inherited property — so the
 * assertion has to run against the object the endpoint actually passed down.
 */
function capturingThreadsStore(captured: Array<Record<string, unknown> | undefined>): ThreadsStore {
  const threads = new Map<string, Thread>()
  let seq = 0
  return {
    createThread: async (input) => {
      captured.push(input.metadata)
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

describe("POST /threads with no policy installed", () => {
  it("drops a client-supplied dawn:access and keeps every sibling", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      post("/threads", { metadata: { "dawn:access": { ownerId: "attacker" }, keep: 1 } }),
    )
    expect(response.status).toBe(200)
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({ keep: 1 })
  })

  it("does not create an empty metadata object for a body that had none", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(post("/threads"))
    expect(response.status).toBe(200)
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({})
  })

  it("stores ordinary metadata unchanged", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({ tenant: "acme" })
  })

  it("still 400s on a non-object metadata", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(post("/threads", { metadata: "nope" }))
    expect(response.status).toBe(400)
  })

  it("still round-trips the stored metadata through GET /threads/:thread_id", async () => {
    const { handler } = await setup()
    const created = await handler.fetch(
      post("/threads", { metadata: { "dawn:access": { ownerId: "attacker" }, keep: 1 } }),
    )
    const { thread_id } = (await created.json()) as { thread_id: string }
    const fetched = await handler.fetch(get(`/threads/${thread_id}`))
    const thread = (await fetched.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({ keep: 1 })
  })

  it("cannot re-attach the reserved key through a __proto__ entry in the body", async () => {
    // The metadata object this endpoint builds is what the store persists and
    // what a policy is handed, so "stripped" has to mean the key does not
    // resolve on it AT ALL — an own-property check alone would miss a key put
    // back on the prototype chain. The body is raw text because a JS object
    // literal cannot express a `__proto__` data property.
    const captured: Array<Record<string, unknown> | undefined> = []
    const { handler } = await setup({ threadsStore: capturingThreadsStore(captured) })
    const response = await handler.fetch(
      new Request(new URL("/threads", "http://localhost"), {
        body: '{"metadata":{"dawn:access":{"ownerId":"decoy"},"__proto__":{"dawn:access":{"ownerId":"attacker"}},"keep":1}}',
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(response.status).toBe(200)
    const stored = captured[0]
    expect(stored?.[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype)
    expect(stored?.keep).toBe(1)
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
  })
})

const allowAll: ThreadAccessPolicy = { fallback: () => ({ decision: "allow" }) }
const denyAll: ThreadAccessPolicy = { fallback: () => ({ decision: "deny" }) }

/** Records every request the runtime made, in order. */
function recording(result: ThreadAccessResult = { decision: "allow" }): {
  readonly policy: ThreadAccessPolicy
  readonly seen: ThreadAccessRequest[]
} {
  const seen: ThreadAccessRequest[] = []
  return {
    policy: {
      fallback: (req) => {
        seen.push(req)
        return result
      },
    },
    seen,
  }
}

describe("GET /threads/:thread_id", () => {
  it("answers a denied read with the same bytes a genuine miss returns", async () => {
    const open = await setup()
    const genuineMiss = await open.handler.fetch(get("/threads/t-does-not-exist"))
    const genuineBody = await genuineMiss.text()

    const gated = await setup({ threadAccess: denyAll })
    const denied = await gated.handler.fetch(get("/threads/t-does-not-exist"))
    expect(denied.status).toBe(genuineMiss.status)
    expect(await denied.text()).toBe(genuineBody)
  })

  it("answers a denied read of a row that DOES exist with a genuine miss's bytes", async () => {
    // The enumeration oracle in its sharpest form: same app, same policy, one
    // id that exists and one that does not. Nothing in either reply separates
    // them. A thread id is four random bytes, so a distinguishable answer is a
    // scan away from being an inventory.
    const { handler } = await setup({
      threadAccess: { fallback: () => ({ decision: "allow" }), read: () => ({ decision: "deny" }) },
    })
    const created = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    const { thread_id } = (await created.json()) as { thread_id: string }
    const existing = await handler.fetch(get(`/threads/${thread_id}`))
    const missing = await handler.fetch(get("/threads/t-never-created"))
    expect(existing.status).toBe(404)
    expect(await existing.text()).toBe(await missing.text())
  })

  it("still answers 404 for a row that does not exist, with a permissive policy", async () => {
    // agui-endpoint.test.ts relies on this: a 404 there proves a
    // middleware-rejected run created no thread.
    const { handler } = await setup({ threadAccess: allowAll })
    const response = await handler.fetch(get("/threads/never-created"))
    expect(response.status).toBe(404)
  })

  it("invokes the policy with the row loaded, the operation, the method and the url", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    const created = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    const { thread_id } = (await created.json()) as { thread_id: string }
    seen.length = 0
    await handler.fetch(get(`/threads/${thread_id}?x=1`, { "x-user-id": "u-1" }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      action: "read",
      headers: { "x-user-id": "u-1" },
      method: "GET",
      operation: "thread.get",
      threadId: thread_id,
      url: `/threads/${thread_id}?x=1`,
    })
    expect(seen[0]?.thread?.metadata).toEqual({ tenant: "acme" })
    expect(seen[0]?.requestedMetadata).toBeUndefined()
  })

  it("invokes the policy with thread undefined when the row is missing", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(get("/threads/t-missing"))
    expect(seen.at(-1)?.thread).toBeUndefined()
    expect(seen.at(-1)?.threadId).toBe("t-missing")
  })

  it("cannot be handed a stamp through a __proto__ entry in the stored metadata", async () => {
    // The sibling of the create-path strip, one layer down: the subject the
    // policy authorizes against is built by reading the stored metadata, and a
    // chain read there would resurrect a forged stamp that the strip removed
    // from the own properties. The body is raw text because a JS object literal
    // cannot express a `__proto__` data property.
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    const created = await handler.fetch(
      new Request(new URL("/threads", "http://localhost"), {
        body: '{"metadata":{"__proto__":{"dawn:access":{"ownerId":"attacker"}},"keep":1}}',
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    const { thread_id } = (await created.json()) as { thread_id: string }
    seen.length = 0
    await handler.fetch(get(`/threads/${thread_id}`))
    const subject = seen.at(-1)?.thread
    expect(subject?.access).toBeUndefined()
    // Not merely absent from `metadata`'s own keys: unreachable through it.
    expect(Object.getPrototypeOf(subject?.metadata)).toBe(Object.prototype)
    expect(subject?.metadata[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
    expect(subject?.metadata.keep).toBe(1)
  })

  it("honors a read handler that overrides the status to 403", async () => {
    const { handler } = await setup({
      threadAccess: { fallback: () => ({ decision: "deny", status: 403 }) },
    })
    const response = await handler.fetch(get("/threads/t-anything"))
    expect(response.status).toBe(403)
  })

  it("honors a supplied deny body", async () => {
    const { handler } = await setup({
      threadAccess: { fallback: () => ({ body: { why: "nope" }, decision: "deny", status: 403 }) },
    })
    const response = await handler.fetch(get("/threads/t-anything"))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ why: "nope" })
  })

  it("awaits an async policy before answering", async () => {
    // An unawaited promise is not an allow: `ok` reads undefined off it and the
    // request denies. So a 200 here is only reachable if the gate settled it.
    const { handler } = await setup({
      threadAccess: {
        fallback: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return { decision: "allow" }
        },
      },
    })
    const created = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    const { thread_id } = (await created.json()) as { thread_id: string }
    const response = await handler.fetch(get(`/threads/${thread_id}`))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { metadata: unknown }).metadata).toEqual({ tenant: "acme" })
  })
})

/** A checkpointer that always has a transcript, for a thread whose row is gone. */
function checkpointerWithTuple(): BaseCheckpointSaver {
  return {
    getTuple: async () => ({
      checkpoint: { channel_values: { messages: ["hello"] } },
      config: { configurable: { checkpoint_ns: "", thread_id: "t-orphan" } },
      metadata: {},
    }),
  } as unknown as BaseCheckpointSaver
}

/** A store with no rows at all: every read misses, exactly as a deleted row does. */
function emptyThreadsStore(): ThreadsStore {
  return {
    createThread: async (input) => ({
      created_at: "2026-01-01T00:00:00.000Z",
      metadata: input.metadata ?? {},
      status: "idle",
      thread_id: input.thread_id ?? "t-empty",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
    deleteThread: async () => {},
    getThread: async () => undefined,
    listThreads: async () => [],
    updateMetadata: async () => {},
    updateStatus: async () => {},
  }
}

describe("GET /threads/:thread_id/state", () => {
  it("answers a denied read with the same bytes a missing checkpoint returns", async () => {
    const open = await setup()
    const genuineMiss = await open.handler.fetch(get("/threads/t-nothing/state"))
    expect(genuineMiss.status).toBe(404)
    const genuineBody = await genuineMiss.text()

    const gated = await setup({ threadAccess: denyAll })
    const denied = await gated.handler.fetch(get("/threads/t-nothing/state"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(genuineBody)
  })

  it("uses the thread.state operation", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(get("/threads/t-x/state"))
    expect(seen.at(-1)?.operation).toBe("thread.state")
    expect(seen.at(-1)?.action).toBe("read")
  })

  it("gates a checkpoint that outlived its thread row", async () => {
    // The checkpointer is a SEPARATE store from ThreadsStore, so short-circuiting
    // a missing row to the endpoint's 404 would hand the transcript to anyone.
    const denied = await setup({
      checkpointer: checkpointerWithTuple(),
      threadAccess: denyAll,
      threadsStore: emptyThreadsStore(),
    })
    const response = await denied.handler.fetch(get("/threads/t-orphan/state"))
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("hello")

    const { policy, seen } = recording()
    const allowed = await setup({
      checkpointer: checkpointerWithTuple(),
      threadAccess: policy,
      threadsStore: emptyThreadsStore(),
    })
    const served = await allowed.handler.fetch(get("/threads/t-orphan/state"))
    expect(served.status).toBe(200)
    // The gate ran with no row rather than being skipped.
    expect(seen.at(-1)?.operation).toBe("thread.state")
    expect(seen.at(-1)?.thread).toBeUndefined()
  })
})

describe("DELETE /threads/:thread_id", () => {
  it("returns 403 for an unauthorized thread AND for one that never existed", async () => {
    // The oracle collapse: 204-for-everything today means a 403 would otherwise
    // announce "this exists and is not yours".
    const gated = await setup({ threadAccess: denyAll })
    const missing = await gated.handler.fetch(del("/threads/t-never-existed"))
    expect(missing.status).toBe(403)
    const missingBody = await missing.text()

    const open = await setup()
    const created = await open.handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    const existing = await gated.handler.fetch(del(`/threads/${thread_id}`))
    expect(existing.status).toBe(403)
    expect(await existing.text()).toBe(missingBody)
  })

  it("carries the thread_access_denied code in error.details", async () => {
    const { handler } = await setup({ threadAccess: denyAll })
    const response = await handler.fetch(del("/threads/t-x"))
    expect(await response.json()).toEqual({
      error: {
        details: { code: "thread_access_denied" },
        kind: "request_error",
        message: "Forbidden",
      },
    })
  })

  it("does not delete the row when the policy denies", async () => {
    // One app, so the row the DELETE is refused on is the row the GET reads.
    const { handler } = await setup({
      threadAccess: {
        delete: () => ({ decision: "deny" }),
        fallback: () => ({ decision: "allow" }),
      },
    })
    const created = await handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    expect((await handler.fetch(del(`/threads/${thread_id}`))).status).toBe(403)
    expect((await handler.fetch(get(`/threads/${thread_id}`))).status).toBe(200)
  })

  it("still returns 204 when the policy allows", async () => {
    const { handler } = await setup({ threadAccess: allowAll })
    const created = await handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    expect((await handler.fetch(del(`/threads/${thread_id}`))).status).toBe(204)
  })

  it("invokes the policy with thread undefined when the row is missing", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(del("/threads/t-gone"))
    expect(seen.at(-1)).toMatchObject({
      action: "delete",
      operation: "thread.delete",
      threadId: "t-gone",
    })
    expect(seen.at(-1)?.thread).toBeUndefined()
  })
})

describe("POST /threads/:thread_id/cancel", () => {
  it("returns 403 for a missing row rather than the handler's 404", async () => {
    const { handler } = await setup({ threadAccess: denyAll })
    const response = await handler.fetch(post(`/threads/t-missing/cancel`))
    expect(response.status).toBe(403)
  })

  it("uses the update action and the thread.cancel operation", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(post("/threads/t-x/cancel"))
    expect(seen.at(-1)?.action).toBe("update")
    expect(seen.at(-1)?.operation).toBe("thread.cancel")
  })

  it("ignores a stamp on a non-create allow, leaving the stored metadata alone", async () => {
    // Without this, "honored on create ONLY" is a doc comment with no
    // enforcement, and a refactor that merged the stamp on every allow would
    // pass every other case in this suite.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const { handler } = await setup({
        threadAccess: {
          create: () => ({ decision: "allow" }),
          fallback: () => ({ decision: "allow", stamp: { ownerId: "smuggled" } }),
        },
      })
      const created = await handler.fetch(post("/threads", { metadata: { keep: 1 } }))
      const { thread_id } = (await created.json()) as { thread_id: string }
      const before = await (await handler.fetch(get(`/threads/${thread_id}`))).text()
      await handler.fetch(post(`/threads/${thread_id}/cancel`))
      await handler.fetch(get(`/threads/${thread_id}`))
      const after = await (await handler.fetch(get(`/threads/${thread_id}`))).text()
      expect(after).toBe(before)
      // Once per process, not once per request: this is a policy-authoring
      // mistake, not a per-request failure. Several requests carried a stamp
      // above; exactly one warning came out.
      expect(
        warn.mock.calls.filter((call) => String(call[0]).includes("create only")),
      ).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("malformed and throwing policies", () => {
  const malformed: ThreadAccessPolicy = { fallback: () => undefined as never }

  it("denies at the per-action default: 403 on DELETE, 404 on both reads", async () => {
    // A single "yields 403" assertion would pass against an implementation that
    // hard-codes 403 and silently reopens read enumeration.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const { handler } = await setup({ threadAccess: malformed })
      expect((await handler.fetch(del("/threads/t-x"))).status).toBe(403)
      expect((await handler.fetch(post("/threads/t-x/cancel"))).status).toBe(403)
      expect((await handler.fetch(get("/threads/t-x"))).status).toBe(404)
      expect((await handler.fetch(get("/threads/t-x/state"))).status).toBe(404)
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps a malformed read denial matching a genuine miss byte for byte", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const open = await setup()
      const genuine = await open.handler.fetch(get("/threads/t-x"))
      const { handler } = await setup({ threadAccess: malformed })
      const denied = await handler.fetch(get("/threads/t-x"))
      expect(await denied.text()).toBe(await genuine.text())
    } finally {
      warn.mockRestore()
    }
  })

  it("does not honor an allow inherited through the prototype chain", async () => {
    // A policy return value is data. An `allow` that the object did not own is
    // the shape of some unrelated base object deciding an authorization.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const { handler } = await setup({
        threadAccess: {
          fallback: () => Object.create({ decision: "allow" }) as ThreadAccessResult,
        },
      })
      expect((await handler.fetch(del("/threads/t-x"))).status).toBe(403)
      expect((await handler.fetch(get("/threads/t-x"))).status).toBe(404)
      // Denied through the malformed-return path, i.e. the inherited `allow`
      // was never read as a decision.
      expect(
        warn.mock.calls.filter((call) => String(call[0]).includes("neither an allow nor a deny")),
      ).not.toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it("turns a throwing policy into a 500 and never deletes the row", async () => {
    // The endpoint's real work must not run. A throw is not caught by the gate:
    // it propagates to fetch's catch-all, which is fail-closed and honest,
    // where a 403 would hide a broken policy behind a working-looking one.
    let deletes = 0
    const base = emptyThreadsStore()
    const store: ThreadsStore = {
      ...base,
      deleteThread: async () => {
        deletes += 1
      },
    }
    const { handler } = await setup({
      threadAccess: {
        fallback: () => {
          throw new Error("policy exploded")
        },
      },
      threadsStore: store,
    })
    const response = await handler.fetch(del("/threads/t-x"))
    expect(response.status).toBe(500)
    expect(deletes).toBe(0)
  })
})
