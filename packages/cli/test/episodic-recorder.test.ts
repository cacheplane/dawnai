import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it } from "vitest"

import { type EpisodeInput, recordEpisode } from "../src/lib/runtime/record-episode.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// Like eval-command.test.ts, temp apps live *inside* the repo tree so node
// module resolution walks up to the workspace node_modules (@dawn-ai/sdk is
// resolvable from packages/cli/node_modules).
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-episodic-apps")

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

// ---------------------------------------------------------------------------
// Harness loader: @dawn-ai/testing cannot be a dependency of @dawn-ai/cli
// (it depends on @dawn-ai/cli — a cycle), so the aimock harness is loaded from
// its built output, exactly the way the eval-command tests exercise it via the
// temp app's node_modules. Requires `pnpm build` (CI builds before testing).
// ---------------------------------------------------------------------------

interface HarnessRunResult {
  readonly finalMessage: string
  readonly threadId: string
  readonly toolResults: ReadonlyArray<{ readonly name: string }>
}

interface ScriptBuilderLike {
  user(text: string): ScriptBuilderLike
  callsTool(name: string, args: Record<string, unknown>): ScriptBuilderLike
  replies(content: string): ScriptBuilderLike
}

interface HarnessLike {
  run(opts: { input: string; fixtures?: ScriptBuilderLike }): Promise<HarnessRunResult>
  reset(): void
  close(): Promise<void>
}

interface TestingModule {
  createAgentHarness(opts: { appRoot: string; route: string }): Promise<HarnessLike>
  script(): ScriptBuilderLike
}

async function loadTesting(): Promise<TestingModule> {
  const distEntry = join(repoRoot, "packages", "testing", "dist", "index.js")
  return (await import(pathToFileURL(distEntry).href)) as unknown as TestingModule
}

// ---------------------------------------------------------------------------
// Fixture app factory
// ---------------------------------------------------------------------------

async function makeApp(dawnConfig: string): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  tempDirs.push(root)

  await writeFile(join(root, "package.json"), '{ "name": "episodic-temp-app", "type": "module" }\n')
  await writeFile(join(root, "dawn.config.ts"), dawnConfig)

  const routeDir = join(root, "src", "app", "chat")
  await mkdir(join(routeDir, "tools"), { recursive: true })
  await writeFile(
    join(routeDir, "index.ts"),
    [
      'import { agent } from "@dawn-ai/sdk"',
      "export default agent({",
      '  model: "gpt-4o-mini",',
      '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
      "})",
      "",
    ].join("\n"),
  )
  await writeFile(
    join(routeDir, "tools", "applyFilter.ts"),
    [
      "/** Apply a status filter and report how many matched. */",
      "export default async function applyFilter(input: {",
      '  status: "open" | "closed"',
      "}): Promise<{ matched: number }> {",
      '  return { matched: input.status === "open" ? 2 : 0 }',
      "}",
      "",
    ].join("\n"),
  )
  // zod is not hoisted to the workspace root; symlink the copy the probe-app
  // fixtures use so the memory.ts schema is a real ZodType (the remember tool
  // schema goes through langchain's zod → JSON-schema conversion).
  await mkdir(join(root, "node_modules"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "testing", "node_modules", "zod"),
    join(root, "node_modules", "zod"),
    "dir",
  )
  await writeFile(
    join(routeDir, "memory.ts"),
    [
      'import { defineMemory } from "@dawn-ai/sdk"',
      'import { z } from "zod"',
      "export default defineMemory({",
      '  kind: "semantic",',
      '  scope: ["route"],',
      "  schema: z.object({ note: z.string() }),",
      "})",
      "",
    ].join("\n"),
  )
  return root
}

const NAMESPACE = "route=/chat" // scope ["route"] for the /chat route

async function episodicRecords(appRoot: string): Promise<MemoryRecord[]> {
  const store = sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
  const page = await store.browse({ kind: "episodic", limit: 100 })
  return [...page.records]
}

// ---------------------------------------------------------------------------
// Harness integration
// ---------------------------------------------------------------------------

describe("episodic auto-recorder (aimock harness)", () => {
  it("records exactly one well-formed episode for an enabled run", async () => {
    const { createAgentHarness, script } = await loadTesting()
    const appRoot = await makeApp(
      "export default { memory: { episodes: { enabled: true, ttlMs: 3_600_000 } } }\n",
    )
    const before = Date.now()
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      const result = await h.run({
        input: "Filter open items please",
        fixtures: script()
          .user("Filter open items please")
          .callsTool("applyFilter", { status: "open" })
          .replies("Found 2 open items."),
      })
      expect(result.finalMessage).toContain("Found 2")
      const after = Date.now()

      const episodes = await episodicRecords(appRoot)
      expect(episodes).toHaveLength(1)
      const ep = episodes[0] as MemoryRecord
      expect(ep.id).toMatch(/^memory_ep_[0-9a-f]{16}$/)
      expect(ep.kind).toBe("episodic")
      expect(ep.status).toBe("active")
      expect(ep.namespace).toBe(NAMESPACE)
      expect(ep.source.type).toBe("run")
      expect(ep.source.id).toBe(result.threadId)
      expect(ep.content).toMatch(/^run ok: Filter open items please/)
      expect(ep.data.outcome).toBe("ok")
      expect(ep.data.toolsUsed).toContain("applyFilter")
      // effectiveAt is the run start; expiresAt is exactly start + configured TTL.
      const effectiveAt = Date.parse(ep.effectiveAt ?? "")
      const expiresAt = Date.parse(ep.expiresAt ?? "")
      expect(effectiveAt).toBeGreaterThanOrEqual(before)
      expect(effectiveAt).toBeLessThanOrEqual(after)
      expect(expiresAt - effectiveAt).toBe(3_600_000)
    } finally {
      await h.close()
    }
  }, 120_000)

  it("records nothing when episodes are not configured (default off)", async () => {
    const { createAgentHarness, script } = await loadTesting()
    const appRoot = await makeApp("export default {}\n")
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      const result = await h.run({
        input: "Filter open items please",
        fixtures: script().user("Filter open items please").replies("Done."),
      })
      expect(result.finalMessage).toContain("Done")
      expect(await episodicRecords(appRoot)).toHaveLength(0)
    } finally {
      await h.close()
    }
  }, 120_000)

  it('records nothing when writes are "off" even with episodes enabled', async () => {
    const { createAgentHarness, script } = await loadTesting()
    const appRoot = await makeApp(
      'export default { memory: { writes: "off", episodes: { enabled: true } } }\n',
    )
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      const result = await h.run({
        input: "Filter open items please",
        fixtures: script().user("Filter open items please").replies("Done."),
      })
      expect(result.finalMessage).toContain("Done")
      expect(await episodicRecords(appRoot)).toHaveLength(0)
    } finally {
      await h.close()
    }
  }, 120_000)

  it('records a failed run as outcome "error" by default', async () => {
    const { createAgentHarness } = await loadTesting()
    const appRoot = await makeApp("export default { memory: { episodes: { enabled: true } } }\n")
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      // No fixture registered for this input → aimock replies 404
      // ("No fixture matched") → the model call throws → the run fails.
      await expect(h.run({ input: "This run will fail" })).rejects.toThrow()

      const episodes = await episodicRecords(appRoot)
      expect(episodes).toHaveLength(1)
      const ep = episodes[0] as MemoryRecord
      expect(ep.data.outcome).toBe("error")
      expect(ep.content).toMatch(/^run error: This run will fail/)
      expect(ep.data.toolsUsed).toEqual([])
    } finally {
      await h.close()
    }
  }, 120_000)

  it("records nothing for a failed run when includeFailedRuns is false", async () => {
    const { createAgentHarness } = await loadTesting()
    const appRoot = await makeApp(
      "export default { memory: { episodes: { enabled: true, includeFailedRuns: false } } }\n",
    )
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      await expect(h.run({ input: "This run will fail" })).rejects.toThrow()
      expect(await episodicRecords(appRoot)).toHaveLength(0)
    } finally {
      await h.close()
    }
  }, 120_000)

  it("burst + cap: five runs with cap 3 keep exactly the newest three episodes", async () => {
    const { createAgentHarness, script } = await loadTesting()
    const appRoot = await makeApp(
      "export default { memory: { episodes: { enabled: true, cap: 3 } } }\n",
    )
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      const inputs = [1, 2, 3, 4, 5].map((i) => `burst run number ${i}`)
      for (const input of inputs) {
        h.reset() // fresh thread per run → distinct episodes
        const result = await h.run({
          input,
          fixtures: script().user(input).replies(`ack: ${input}`),
        })
        expect(result.finalMessage).toContain("ack")
      }

      const episodes = await episodicRecords(appRoot)
      expect(episodes).toHaveLength(3)
      // The three newest by event time survive the cap.
      const kept = new Set(episodes.map((e) => e.data.input))
      expect(kept).toEqual(new Set(inputs.slice(2)))
      const times = episodes.map((e) => Date.parse(e.effectiveAt ?? "")).sort((a, b) => a - b)
      for (const t of times) expect(Number.isFinite(t)).toBe(true)
    } finally {
      await h.close()
    }
  }, 240_000)
})

// ---------------------------------------------------------------------------
// Recorder retention semantics against a real sqlite store (unit-level)
// ---------------------------------------------------------------------------

function episode(overrides: Partial<EpisodeInput> & { readonly runId: string }): EpisodeInput {
  const startedAt = overrides.startedAt ?? Date.parse("2026-08-05T10:00:00.000Z")
  return {
    namespace: "route=/conc",
    input: `input for ${overrides.runId}`,
    outcome: "ok",
    toolsUsed: ["applyFilter"],
    startedAt,
    finishedAt: startedAt + 1500,
    ttlMs: 30 * 86_400_000,
    ...overrides,
  }
}

describe("recordEpisode against a real sqlite store", () => {
  it("is idempotent: the same EpisodeInput recorded twice yields ONE row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-episodic-idem-"))
    tempDirs.push(dir)
    const store = sqliteMemoryStore({ path: join(dir, "memory.sqlite") })

    const ep = episode({ runId: "run-retry" })
    await recordEpisode(store, ep, { cap: 10 })
    await recordEpisode(store, ep, { cap: 10 })

    const page = await store.browse({ kind: "episodic" })
    expect(page.total).toBe(1)
    expect(page.records[0]?.source).toEqual({ type: "run", id: "run-retry" })
  })

  it("CONCURRENCY: 8 parallel recordEpisode calls with cap 5 settle to exactly 5 well-formed rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-episodic-conc-"))
    tempDirs.push(dir)
    const store = sqliteMemoryStore({ path: join(dir, "memory.sqlite") })

    const base = Date.parse("2026-08-05T10:00:00.000Z")
    const eps = Array.from({ length: 8 }, (_, i) =>
      episode({ runId: `run-${i}`, startedAt: base + i * 1000 }),
    )

    // Must not reject — recordEpisode never throws, and WAL handles the
    // concurrent in-process writers.
    await expect(
      Promise.all(eps.map((ep) => recordEpisode(store, ep, { cap: 5 }))),
    ).resolves.toBeDefined()

    const page = await store.browse({ kind: "episodic", namespacePrefix: "route=/conc" })
    expect(page.total).toBe(5)
    for (const rec of page.records) {
      expect(rec.id).toMatch(/^memory_ep_[0-9a-f]{16}$/)
      expect(rec.kind).toBe("episodic")
      expect(rec.status).toBe("active")
      expect(rec.source.type).toBe("run")
      for (const field of [rec.createdAt, rec.updatedAt, rec.effectiveAt, rec.expiresAt]) {
        expect(Number.isFinite(Date.parse(field ?? ""))).toBe(true)
      }
    }
    // The five newest by event time (startedAt) survive.
    const survivors = new Set(page.records.map((r) => r.source.id))
    expect(survivors).toEqual(new Set(["run-3", "run-4", "run-5", "run-6", "run-7"]))
  })
})
