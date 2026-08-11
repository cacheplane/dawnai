import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MemoryStore } from "@dawn-ai/memory"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { FilesystemBackend } from "@dawn-ai/workspace"

import { script } from "../../../testing/dist/index.js"
import { cleanup } from "./static-modules-fixture.js"

/** A one-route agent app — the smallest thing the bundled runtime can serve. */
export async function chatFixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-fetch-entry-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "fetch-entry-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      "export default agent({\n" +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You are terse.",\n' +
      "})\n",
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

export function simpleScript() {
  return script().user("hello from the bundle").replies("bundled reply").build()
}

export function memoryThreadsStore(): {
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

export function fakePermissionsStore(): PermissionsStore {
  return {
    addAllow: async () => {},
    load: async () => {},
    match: () => "allow" as const,
    mode: "non-interactive" as const,
  }
}

export function fakeMemoryStore(): MemoryStore {
  return {
    browse: async () => ({ records: [], total: 0, continuation: null }),
    delete: async () => {},
    get: async () => null,
    listCandidates: async () => [],
    prune: async () => ({ deletedExpired: 0, deletedOverCap: 0 }),
    put: async () => {},
    search: async () => [],
    stats: async () => ({
      byKind: {},
      byNamespace: {},
      bySourceType: {},
      byStatus: {},
      total: 0,
    }),
    supersede: async () => {},
    update: async () => {},
  }
}

/**
 * A filesystem backend with no filesystem — what an edge deployment supplies
 * via `config.backends.filesystem` in place of `localFilesystem()`. Enough for
 * `createWorkspaceFs` to build a workspace handle; the fixture route never
 * calls a workspace tool.
 */
export function inMemoryFilesystem(): FilesystemBackend {
  const files = new Map<string, string>()
  return {
    listDir: async (path) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1)),
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`no such file: ${path}`)
      return content
    },
    realPath: async (path) => path,
    writeFile: async (path, content) => {
      files.set(path, content)
      return { bytesWritten: Buffer.byteLength(content, "utf8") }
    },
  }
}
