import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// Count sqlite memory-store constructions at the seam resolve-memory.ts
// actually calls: the default (no dawn.config.ts `memory.store`) path opens
// exactly one DatabaseSync via `sqliteMemoryStore`. The mock passes through
// to the real implementation, so counting calls counts sqlite opens.
vi.mock("@dawn-ai/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/memory")>()
  return {
    ...actual,
    sqliteMemoryStore: vi.fn(actual.sqliteMemoryStore),
  }
})

import { sqliteMemoryStore } from "@dawn-ai/memory"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-lazy-memory-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "lazy-memory-fixture", "type": "module" }\n',
    "src/app/probe/index.ts": "export const workflow = async (_input: unknown) => ({ ok: true })\n",
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Fixture whose `/chat#agent` route has a `memory.ts`, so the memory
 * capability (remember/recall tools) activates on every run. */
async function memoryAgentFixtureApp(): Promise<string> {
  const appRoot = await fixtureApp({
    "src/app/chat/index.ts": [
      'import { agent } from "@dawn-ai/sdk"',
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })',
      "",
    ].join("\n"),
    "src/app/chat/memory.ts": [
      'import { defineMemory } from "@dawn-ai/sdk"',
      'import { z } from "zod"',
      "export default defineMemory({",
      '  kind: "semantic",',
      '  scope: ["route"],',
      "  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),",
      "})",
      "",
    ].join("\n"),
  })
  // `memory.ts` imports `zod` directly (not just via `@dawn-ai/sdk`'s
  // re-exports) — make it resolvable from the tmpdir fixture the same way
  // load-memory.test.ts does for loadRouteMemory's own fixtures.
  await mkdir(join(appRoot, "node_modules"), { recursive: true })
  await symlink(
    join(repoRoot, "node_modules", ".pnpm", "zod@4.4.3", "node_modules", "zod"),
    join(appRoot, "node_modules", "zod"),
    "dir",
  )
  return appRoot
}

const memorySqlitePath = (appRoot: string) => join(appRoot, ".dawn", "memory.sqlite")

async function getMemoryCandidates(
  handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>,
): Promise<{ status: number; body: { candidates: unknown[] } }> {
  const response = await handler.fetch(new Request("http://localhost/memory/candidates"))
  return { body: (await response.json()) as { candidates: unknown[] }, status: response.status }
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock instance for the
 * duration of the test, restoring the previous env afterward. */
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

// ---------------------------------------------------------------------------
// (1) No eager boot-time sqlite open for apps that never touch memory
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — lazy memory store", () => {
  it("does not create .dawn/memory.sqlite for an app that never hits a memory route", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    expect(existsSync(memorySqlitePath(appRoot))).toBe(false)
  })

  // -------------------------------------------------------------------
  // (2) First touch opens the store, on demand
  // -------------------------------------------------------------------

  it("opens .dawn/memory.sqlite (and serves 200) on the first /memory/candidates hit", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    expect(existsSync(memorySqlitePath(appRoot))).toBe(false)

    const { status, body } = await getMemoryCandidates(handler)

    expect(status).toBe(200)
    expect(body.candidates).toEqual([])
    expect(existsSync(memorySqlitePath(appRoot))).toBe(true)
  })

  // -------------------------------------------------------------------
  // (3) Two requests reuse one store (memoized thunk — one construction)
  // -------------------------------------------------------------------

  it("constructs the sqlite memory store exactly once across two /memory/candidates requests", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const opensBefore = vi.mocked(sqliteMemoryStore).mock.calls.length

    const first = await getMemoryCandidates(handler)
    expect(first.status).toBe(200)

    const second = await getMemoryCandidates(handler)
    expect(second.status).toBe(200)

    expect(vi.mocked(sqliteMemoryStore).mock.calls.length).toBe(opensBefore + 1)
  })

  // -------------------------------------------------------------------
  // (4) One store serves both the capability (remember/recall) path and the
  // /memory/candidates HTTP path.
  // -------------------------------------------------------------------

  it("shares one store between the memory capability and the /memory/candidates routes", async () => {
    const appRoot = await memoryAgentFixtureApp()
    await withAimock(
      script()
        .user("Remember that acme escalates billing above 500.")
        .callsTool("remember", {
          data: { subject: "billing", predicate: "escalate_above", value: "500" },
          content: "acme escalates billing above 500",
        })
        .replies("Noted.")
        .build(),
    )

    // Baseline BEFORE boot: distinguishes "opened once, lazily, on first use"
    // (this task) from "opened eagerly at boot AND again per-request by the
    // capability path" (the pre-existing behavior) — both would otherwise
    // reach the same post-boot delta.
    const opensBefore = vi.mocked(sqliteMemoryStore).mock.calls.length

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    // Capability path: the agent's `remember` tool call writes a candidate
    // through the memory context's store.
    const runResponse = await handler.fetch(
      new Request("http://localhost/threads/th-lazy-memory-1/runs/wait", {
        body: JSON.stringify({
          input: {
            messages: [
              { role: "user", content: "Remember that acme escalates billing above 500." },
            ],
          },
          route: "/chat#agent",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(runResponse.status).toBe(200)

    // HTTP path: the same candidate must be visible via /memory/candidates.
    const { status, body } = await getMemoryCandidates(handler)
    expect(status).toBe(200)
    expect(body.candidates).toHaveLength(1)

    // Exactly one sqlite open serves BOTH call sites.
    expect(vi.mocked(sqliteMemoryStore).mock.calls.length).toBe(opensBefore + 1)
  }, 30_000)
})
