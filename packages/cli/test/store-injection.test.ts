import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { MemoryStore } from "@dawn-ai/memory"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"

import { script } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import {
  buildStaticModulesForFixture,
  cleanup,
  runChatTurn,
  withAimock,
} from "./helpers/static-modules-fixture.js"

// Count sqlite store constructions at the seams the runtime actually calls:
// createThreadsStore / sqliteCheckpointer each open exactly one DatabaseSync,
// so counting factory calls counts sqlite opens. Passthrough spies — real
// behavior is unchanged (the negative control below depends on it).
vi.mock("@dawn-ai/sqlite-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/sqlite-storage")>()
  return {
    ...actual,
    createThreadsStore: vi.fn(actual.createThreadsStore),
    sqliteCheckpointer: vi.fn(actual.sqliteCheckpointer),
  }
})

// Every default permissions-store construction performs exactly one
// `.dawn/permissions.json` read (store.load() inside buildPermissionsStore /
// resolvePermissionsStore), so zero createPermissionsStore calls proves zero
// permissions-file reads.
vi.mock("@dawn-ai/permissions/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/permissions/node")>()
  return {
    ...actual,
    createPermissionsStore: vi.fn(actual.createPermissionsStore),
  }
})

// The default memory path (resolveMemoryStore, no config `memory.store`)
// opens exactly one DatabaseSync via sqliteMemoryStore — counting factory
// calls counts sqlite memory opens.
vi.mock("@dawn-ai/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/memory")>()
  return {
    ...actual,
    sqliteMemoryStore: vi.fn(actual.sqliteMemoryStore),
  }
})

import { sqliteMemoryStore } from "@dawn-ai/memory"
import { createPermissionsStore } from "@dawn-ai/permissions/node"
import { createThreadsStore, sqliteCheckpointer } from "@dawn-ai/sqlite-storage"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture: parent agent with a descriptor-override subagent (same shape as
// static-descriptor-map.test.ts) — the subagent turn is the interesting hop,
// because it re-enters executeResolvedRoute outside the HTTP layer.
// ---------------------------------------------------------------------------

// Both routes carry a memory.ts so BOTH the parent turn and the subagent
// turn activate the memory capability — pinning that one memoized store
// thunk serves the whole tree (and, un-injected, that sqlite memory opens).
const MEMORY_TS =
  'import { defineMemory } from "@dawn-ai/sdk"\n' +
  'import { z } from "zod"\n' +
  "export default defineMemory({\n" +
  '  kind: "semantic",\n' +
  '  scope: ["route"],\n' +
  "  schema: z.object({ subject: z.string(), value: z.string() }),\n" +
  "})\n"

async function subagentFixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-store-injection-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "store-injection-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'import helper from "../helper/index.js"\n' +
      "export default agent({\n" +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You coordinate work by dispatching subagents.",\n' +
      "  subagents: [helper],\n" +
      "})\n",
    "src/app/chat/memory.ts": MEMORY_TS,
    "src/app/helper/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      "export default agent({\n" +
      '  description: "Echoes text back verbatim.",\n' +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You echo whatever the user says.",\n' +
      "})\n",
    "src/app/helper/memory.ts": MEMORY_TS,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  // memory.ts imports `zod` directly — make it resolvable from the tmpdir
  // fixture the same way lazy-memory-store.test.ts does.
  await mkdir(join(appRoot, "node_modules"), { recursive: true })
  await symlink(
    join(repoRoot, "node_modules", ".pnpm", "zod@4.4.3", "node_modules", "zod"),
    join(appRoot, "node_modules", "zod"),
    "dir",
  )
  return appRoot
}

// Child input deliberately shares no words with the parent's user message so
// aimock's fixture matching cannot depend on registration order.
const CHILD_INPUT = "repeat: banana"

function subagentScript() {
  return script()
    .user("please delegate this task")
    .callsTool("task", { input: CHILD_INPUT, subagent: "helper" })
    .replies("Helper finished.")
    .user(CHILD_INPUT)
    .replies("banana banana")
    .build()
}

// ---------------------------------------------------------------------------
// In-memory store implementations against the REAL interfaces
// ---------------------------------------------------------------------------

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

function fakePermissionsStore(): PermissionsStore {
  return {
    addAllow: async () => {},
    load: async () => {},
    match: () => "allow" as const,
    mode: "non-interactive" as const,
  }
}

function fakeMemoryStore(): MemoryStore {
  return {
    browse: async () => ({ records: [], total: 0 }),
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

function spyCounts(): {
  threads: number
  checkpointer: number
  permissions: number
  memory: number
} {
  return {
    checkpointer: vi.mocked(sqliteCheckpointer).mock.calls.length,
    memory: vi.mocked(sqliteMemoryStore).mock.calls.length,
    permissions: vi.mocked(createPermissionsStore).mock.calls.length,
    threads: vi.mocked(createThreadsStore).mock.calls.length,
  }
}

// ---------------------------------------------------------------------------
// The seam proof: with all five options injected (+ seeded config + static
// modules), NOTHING touches sqlite or `.dawn/permissions.json` — not boot,
// not the parent turn, not the subagent re-entry.
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — full store/middleware injection", () => {
  it("boot + parent turn + subagent turn construct zero sqlite stores and zero permissions stores", async () => {
    const appRoot = await subagentFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    await withAimock(subagentScript())

    const { store: threadsStore, threads } = memoryThreadsStore()
    const middleware = vi.fn<DawnMiddleware>(() => ({ action: "continue" as const }))
    const memoryStoreThunk = vi.fn(async () => fakeMemoryStore())

    const before = spyCounts()

    const handler = await createRuntimeFetchHandler({
      appRoot,
      checkpointer: new MemorySaver(),
      config: {},
      memoryStore: memoryStoreThunk,
      middleware,
      modules,
      permissionsStore: fakePermissionsStore(),
      threadsStore,
    })
    cleanup.push(() => handler.close())

    const body = await runChatTurn(handler, "th-store-injection", "please delegate this task")

    // The full round-trip happened, including the subagent hop.
    expect(body).toContain("RUN_STARTED")
    expect(body).toContain("banana banana")
    expect(body).toContain("Helper finished.")
    expect(body).toContain("RUN_FINISHED")

    // Zero sqlite constructions (threads, checkpoints, memory) and zero
    // permissions-store constructions (⇒ zero `.dawn/permissions.json`
    // reads) across boot + both turns.
    expect(spyCounts()).toEqual(before)

    // The injected instances were USED, not merely tolerated: the thread the
    // AG-UI handler created lives in the in-memory store, and the injected
    // middleware ran.
    expect(threads.has("th-store-injection")).toBe(true)
    expect(middleware).toHaveBeenCalled()

    // Both routes have a memory.ts, so BOTH the parent and the subagent turn
    // resolved a memory store — yet the injected thunk fired exactly once:
    // the fetch handler's memoization is shared across the subagent hop.
    expect(memoryStoreThunk).toHaveBeenCalledTimes(1)
  }, 30_000)

  // Negative control: the same fixture WITHOUT injection must construct the
  // default sqlite stores and the per-request permissions store — proving the
  // spies detect the default path (i.e. the assertion above cannot pass
  // vacuously because the spies miss the construction seam).
  it("without injection, the default path constructs sqlite stores and permissions stores", async () => {
    const appRoot = await subagentFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    await withAimock(subagentScript())

    const before = spyCounts()

    const handler = await createRuntimeFetchHandler({ appRoot, modules })
    cleanup.push(() => handler.close())

    // Snapshot AFTER boot, BEFORE the turn, so boot-time and turn-time
    // construction are separately attributable.
    const afterBoot = spyCounts()
    // Boot constructs the default sqlite threads/checkpoint stores — the spy
    // detects the default path (the zero-assertion above is not vacuous).
    expect(afterBoot.threads).toBeGreaterThan(before.threads)
    expect(afterBoot.checkpointer).toBeGreaterThan(before.checkpointer)

    const body = await runChatTurn(handler, "th-store-default", "please delegate this task")
    expect(body).toContain("banana banana")
    expect(body).toContain("RUN_FINISHED")

    const after = spyCounts()
    // Turn-time movement: the per-request permissions factory constructs (and
    // re-reads `.dawn/permissions.json`) per turn, and routes with a memory.ts
    // resolve the default sqlite memory store lazily on first use.
    expect(after.permissions).toBeGreaterThan(afterBoot.permissions)
    expect(after.memory).toBeGreaterThan(afterBoot.memory)
    // Deliberately pinned at ZERO turn-delta: even un-injected, the fetch
    // handler's boot-resolved threads/checkpoint stores are inherited by the
    // parent turn AND the subagent hop (bootInstances threading) — the turn
    // constructs no further sqlite stores.
    expect(after.threads).toBe(afterBoot.threads)
    expect(after.checkpointer).toBe(afterBoot.checkpointer)
  }, 30_000)
})
