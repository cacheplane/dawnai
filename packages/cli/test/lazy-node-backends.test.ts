import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { script } from "../../testing/dist/index.js"

// Passthrough spy — counts default sqlite memory-store constructions without
// changing behavior. Everything else @dawn-ai/memory exports stays real.
vi.mock("@dawn-ai/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/memory")>()
  return {
    ...actual,
    sqliteMemoryStore: vi.fn(actual.sqliteMemoryStore),
  }
})

// Passthrough spy — counts default localFilesystem backend constructions on
// the request path (createWorkspaceFs / buildOffload fallbacks).
vi.mock("@dawn-ai/workspace/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/workspace/node")>()
  return {
    ...actual,
    localFilesystem: vi.fn(actual.localFilesystem),
  }
})

import { sqliteMemoryStore } from "@dawn-ai/memory"
import { localFilesystem } from "@dawn-ai/workspace/node"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { hasWorkspaceDir } from "../src/lib/runtime/execute-route.js"
import { resolveMemoryStore } from "../src/lib/runtime/resolve-memory.js"
import { cleanup, runChatTurn, withAimock } from "./helpers/static-modules-fixture.js"

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  return dir
}

/** Minimal agent fixture: no config backends, no memory.ts, no workspace/. */
async function fixtureApp(): Promise<string> {
  const appRoot = await tempDir("dawn-lazy-node-backends-")
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "lazy-node-backends-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

describe("resolve-memory — sqlite store is lazy", () => {
  it("constructs the default sqlite store only when resolveMemoryStore is called", async () => {
    // Importing resolve-memory (top of this file) must not have constructed
    // the default sqlite store.
    expect(vi.mocked(sqliteMemoryStore)).not.toHaveBeenCalled()

    const appRoot = await tempDir("dawn-lazy-memory-")
    const store = await resolveMemoryStore(appRoot)

    // Construction happens at CALL time, against the default path — and the
    // dynamically-imported factory is the same (mock-visible) module binding.
    expect(vi.mocked(sqliteMemoryStore)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sqliteMemoryStore)).toHaveBeenCalledWith(
      expect.objectContaining({ path: join(appRoot, ".dawn", "memory.sqlite") }),
    )
    expect(typeof store.put).toBe("function")
    expect(typeof store.search).toBe("function")
    // MemoryStore exposes no close(); the DatabaseSync handle is released at
    // process exit (same as the pre-existing resolve-memory.test.ts suite).
  })
})

describe("execute-route — default localFilesystem is memoized", () => {
  it("constructs localFilesystem at most once across two turns", async () => {
    const appRoot = await fixtureApp()
    await withAimock(
      script()
        .user("turn one")
        .replies("First reply.")
        .user("turn two")
        .replies("Second reply.")
        .build(),
    )

    const before = vi.mocked(localFilesystem).mock.calls.length

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    // Boot alone must not construct the default filesystem backend.
    expect(vi.mocked(localFilesystem).mock.calls.length).toBe(before)

    const first = await runChatTurn(handler, "th-lazy-fs-1", "turn one")
    expect(first).toContain("First reply.")
    expect(first).toContain("RUN_FINISHED")

    const second = await runChatTurn(handler, "th-lazy-fs-2", "turn two")
    expect(second).toContain("Second reply.")
    expect(second).toContain("RUN_FINISHED")

    // The default backend is a module-level memo: exactly one construction
    // serves both turns (previously one fresh instance per request).
    expect(vi.mocked(localFilesystem).mock.calls.length).toBe(before + 1)
  }, 30_000)
})

describe("execute-route — offload workspace/ probe memoizes only positives", () => {
  it("re-probes negatives (workspace/ created mid-process is seen) and caches positives", async () => {
    const appRoot = await tempDir("dawn-lazy-probe-")

    expect(hasWorkspaceDir(appRoot)).toBe(false)

    // Agent tools can create workspace/ mid-process (localFilesystem's
    // writeFile mkdirs recursively) and the dev watcher ignores workspace/
    // changes, so a negative probe must NOT stick: the very next call — no
    // cache reset, no restart — sees the new directory.
    await mkdir(join(appRoot, "workspace"))
    expect(hasWorkspaceDir(appRoot)).toBe(true)

    // Positive results ARE memoized (the runtime never un-creates a
    // workspace dir): removing it externally does not flip the cached true.
    await rm(join(appRoot, "workspace"), { recursive: true })
    expect(hasWorkspaceDir(appRoot)).toBe(true)
  })
})
