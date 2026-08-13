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
