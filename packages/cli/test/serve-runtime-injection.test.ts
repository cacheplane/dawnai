import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it, vi } from "vitest"

import { serveRuntime } from "../src/lib/dev/serve-runtime.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-serve-injection-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "serve-injection-fixture", "type": "module" }\n',
    "src/app/probe/index.ts": "export const workflow = async (_input: unknown) => ({ ok: true })\n",
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

function memoryThreadsStore(): {
  readonly store: ThreadsStore
  readonly threads: Map<string, Thread>
} {
  const threads = new Map<string, Thread>()
  let seq = 0
  const store: ThreadsStore = {
    createThread: async (input) => {
      const now = new Date().toISOString()
      const thread: Thread = {
        created_at: now,
        metadata: input.metadata ?? {},
        status: "idle",
        thread_id: input.thread_id ?? `mem-${++seq}`,
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
      if (thread) {
        threads.set(threadId, { ...thread, metadata: { ...thread.metadata, ...patch } })
      }
    },
    updateStatus: async (threadId, status) => {
      const thread = threads.get(threadId)
      if (thread) threads.set(threadId, { ...thread, status })
    },
  }
  return { store, threads }
}

// ---------------------------------------------------------------------------
// ServeRuntimeOptions pass-through: the injection options survive the
// serveRuntime → startRuntimeServer hop and reach the live HTTP server.
// ---------------------------------------------------------------------------

describe("serveRuntime — injected-store pass-through", () => {
  it("a turn over real HTTP lands the thread in the injected in-memory store", async () => {
    const appRoot = await fixtureApp()
    const { store: threadsStore, threads } = memoryThreadsStore()
    const middleware = vi.fn(() => ({ action: "continue" as const }))

    const server = await serveRuntime({
      appRoot,
      host: "127.0.0.1",
      middleware,
      port: 0,
      threadsStore,
    })
    cleanup.push(() => server.close())

    const response = await fetch(`${server.url}/threads/th-serve-injected/runs/wait`, {
      body: JSON.stringify({ input: {}, route: "/probe#workflow" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    // The injected instances made it through the pass-through spread: the
    // thread the AP handler created lives in the in-memory store, and the
    // injected middleware ran on the request.
    expect(threads.has("th-serve-injected")).toBe(true)
    expect(middleware).toHaveBeenCalled()
  }, 30_000)
})
