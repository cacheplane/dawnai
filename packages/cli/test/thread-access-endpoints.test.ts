import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { THREAD_ACCESS_METADATA_KEY, type ThreadAccessPolicy } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

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
