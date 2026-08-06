import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { MemoryRecord } from "@dawn-ai/memory"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it } from "vitest"

import { runMemoryCommand } from "../src/commands/memory.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-memory-apps")

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), '{ "name": "memory-temp-app", "type": "module" }\n')
  return root
}

const baseRecord: MemoryRecord = {
  id: "m1",
  kind: "semantic",
  namespace: "ws=app|route=/r",
  content: "esc",
  data: { subject: "billing" },
  source: { type: "run", id: "run-1" },
  confidence: 0.9,
  tags: [],
  status: "candidate",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe("dawn memory", () => {
  it("list shows candidate records", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const lines: string[] = []
    await runMemoryCommand(
      ["list"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain("m1")
    expect(output).toContain("candidate")
  })

  it("approve flips status to active", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const io = { stdout: () => {}, stderr: () => {} }
    await runMemoryCommand(["approve", "m1"], { cwd: appRoot }, io)

    const updated = await store.get("m1")
    expect(updated?.status).toBe("active")
  })

  it("approve supersedes a contradicting active row", async () => {
    // No src/app or route memory.ts → identity resolution falls back to the
    // default [subject, predicate] keys.
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      data: { subject: "acme", predicate: "threshold", value: "750" },
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["approve", "cand"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect((await store.get("cand"))?.status).toBe("active")
    expect((await store.get("old"))?.status).toBe("superseded")
    const output = lines.join("\n")
    expect(output).toContain("approved cand (superseded)")
    expect(output).toContain("superseded old")
    expect(output).toContain("default identity")
  })

  it("approve respects a route's custom identity", async () => {
    const appRoot = await makeApp()
    // Full Dawn app shape so discoverRoutes finds the /notes route and its
    // memory.ts (mirrors packages/inspector/test/fixtures/app).
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}\n")
    const routeDir = join(appRoot, "src", "app", "notes")
    await mkdir(routeDir, { recursive: true })
    await writeFile(join(routeDir, "index.ts"), "export const agent = {}\n")
    await mkdir(join(appRoot, "node_modules"), { recursive: true })
    await symlink(
      join(repoRoot, "node_modules", ".pnpm", "zod@4.4.3", "node_modules", "zod"),
      join(appRoot, "node_modules", "zod"),
      "dir",
    )
    await writeFile(
      join(routeDir, "memory.ts"),
      [
        'import { z } from "zod"',
        "export default {",
        '  kind: "semantic",',
        '  scope: ["route"],',
        "  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),",
        '  identity: ["subject"],',
        "}",
      ].join("\n"),
    )

    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    // Same subject, different predicate+value: contradicts under identity
    // ["subject"] but would be a plain ADD under the default [subject, predicate].
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "limit", value: "750" },
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["approve", "cand"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect((await store.get("cand"))?.status).toBe("active")
    expect((await store.get("old"))?.status).toBe("superseded")
    const output = lines.join("\n")
    expect(output).toContain("approved cand (superseded)")
    expect(output).not.toContain("default identity")
  })

  it("approve fails loudly when a route's memory.ts exists but cannot load", async () => {
    // A broken memory.ts must NOT silently fall back to default identity keys
    // (wrong keys could miss or mis-target a supersede).
    const appRoot = await makeApp()
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}\n")
    const routeDir = join(appRoot, "src", "app", "notes")
    await mkdir(routeDir, { recursive: true })
    await writeFile(join(routeDir, "index.ts"), "export const agent = {}\n")
    await writeFile(join(routeDir, "memory.ts"), "export default {{{ not valid ts\n")

    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "threshold", value: "750" },
    })

    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["approve", "cand"], { cwd: appRoot }, io)).rejects.toThrow(
      /Failed to load .*memory\.ts/,
    )
    // No reconciliation with (fallback) keys happened.
    expect((await store.get("cand"))?.status).toBe("candidate")
    expect((await store.get("old"))?.status).toBe("active")
  })

  it("approve dedupes an identical-data candidate", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["approve", "cand"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect(lines.join("\n")).toContain("approved old (deduped)")
    expect(await store.get("cand")).toBeNull()
    expect((await store.get("old"))?.status).toBe("active")
  })

  it("forget hard-deletes a record", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const io = { stdout: () => {}, stderr: () => {} }
    await runMemoryCommand(["forget", "m1"], { cwd: appRoot }, io)

    expect(await store.get("m1")).toBeNull()
  })

  it("search filters by query substring in content/namespace", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)
    await store.put({
      ...baseRecord,
      id: "m2",
      content: "other topic",
      namespace: "ws=app|route=/x",
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["search", "esc"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain("m1")
    expect(output).not.toContain("m2")
  })

  it("inspect prints full JSON for a record", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const lines: string[] = []
    await runMemoryCommand(
      ["inspect", "m1"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain('"id"')
    expect(output).toContain("m1")
    expect(output).toContain("billing")
  })

  it("reject deletes a candidate record", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const io = { stdout: () => {}, stderr: () => {} }
    await runMemoryCommand(["reject", "m1"], { cwd: appRoot }, io)

    expect(await store.get("m1")).toBeNull()
  })

  it("prune deletes expired rows and reports counts", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "expired",
      status: "active",
      expiresAt: "2020-01-01T00:00:00.000Z",
    })
    await store.put({
      ...baseRecord,
      id: "live",
      kind: "episodic",
      status: "active",
      effectiveAt: new Date().toISOString(),
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["prune"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toMatch(/1 expired/)
    expect(output).toMatch(/0 over-cap/)
    expect(await store.get("expired")).toBeNull()
    expect(await store.get("live")).not.toBeNull()
  })

  it("prune --cap enforces the episodic cap", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (let i = 1; i <= 4; i++) {
      await store.put({
        ...baseRecord,
        id: `ep-${i}`,
        kind: "episodic",
        status: "active",
        effectiveAt: `2026-08-0${i}T00:00:00.000Z`,
      })
    }

    const lines: string[] = []
    await runMemoryCommand(
      ["prune", "--cap", "2"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    // The two oldest (ep-1, ep-2) are pruned; the two newest survive.
    expect(await store.get("ep-1")).toBeNull()
    expect(await store.get("ep-2")).toBeNull()
    expect(await store.get("ep-3")).not.toBeNull()
    expect(await store.get("ep-4")).not.toBeNull()
    expect(lines.join("\n")).toMatch(/2 over-cap/)
  })

  it("prune without --cap defaults to the resolved memory.episodes.cap", async () => {
    const appRoot = await makeApp()
    // Configure a cap of 2; `dawn memory prune` (no --cap) must enforce it —
    // the docs promise the default retention pass applies the configured cap.
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      "export default { memory: { episodes: { cap: 2 } } }\n",
    )
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (let i = 1; i <= 4; i++) {
      await store.put({
        ...baseRecord,
        id: `ep-${i}`,
        kind: "episodic",
        status: "active",
        effectiveAt: `2026-08-0${i}T00:00:00.000Z`,
      })
    }

    const lines: string[] = []
    await runMemoryCommand(
      ["prune"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    // The two oldest (ep-1, ep-2) are pruned; the two newest survive.
    expect(await store.get("ep-1")).toBeNull()
    expect(await store.get("ep-2")).toBeNull()
    expect(await store.get("ep-3")).not.toBeNull()
    expect(await store.get("ep-4")).not.toBeNull()
    expect(lines.join("\n")).toMatch(/2 over-cap/)
  })

  // -------------------------------------------------------------------------
  // Distillation subcommands (`consolidate` / `reflect`)
  //
  // 2026-07-06 is a Monday, so Jul 6..10 all fall in ONE ISO week — a single
  // namespace-week batch. Those dates are also far enough in the past to clear
  // the default `olderThanMs` (7 days) whenever this suite runs.
  // -------------------------------------------------------------------------

  function episode(id: string, day: number): MemoryRecord {
    const at = `2026-07-${String(day).padStart(2, "0")}T09:00:00.000Z`
    return {
      ...baseRecord,
      id,
      kind: "episodic",
      status: "active",
      content: `run ${id}`,
      data: {},
      createdAt: at,
      updatedAt: at,
      effectiveAt: at,
    }
  }

  async function consolidatedRecords(store: ReturnType<typeof sqliteMemoryStore>) {
    const page = await store.browse({ kind: "episodic", limit: 100 })
    return page.records.filter((r) => r.tags.includes("consolidated"))
  }

  it("consolidate is a no-op with nothing to do", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    // One episode is below the default minBatchSize (5) → no batch qualifies.
    await store.put(episode("e1", 7))

    const lines: string[] = []
    await runMemoryCommand(
      ["consolidate"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect(lines.join("\n")).toMatch(/nothing to consolidate/)
    expect(await consolidatedRecords(store)).toHaveLength(0)
    expect((await store.get("e1"))?.status).toBe("active")
  })

  it("consolidate with nothing to do never constructs a model (no provider/key needed)", async () => {
    const appRoot = await makeApp()
    // An unsupported provider makes model construction throw a loud, actionable
    // error — so a clean exit here PROVES the no-op path never resolved a
    // provider or built a chat model. `dawn memory consolidate` must be safe to
    // put in cron on a machine with no API key.
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      'export default { memory: { distill: { provider: "definitely-not-a-provider" } } }\n',
    )
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(episode("e1", 7))

    const lines: string[] = []
    await expect(
      runMemoryCommand(
        ["consolidate"],
        { cwd: appRoot },
        { stdout: (m) => lines.push(m), stderr: () => {} },
      ),
    ).resolves.toBeUndefined()
    expect(lines.join("\n")).toMatch(/nothing to consolidate/)
  })

  it("consolidate DOES construct a model when there is work (bad provider surfaces)", async () => {
    const appRoot = await makeApp()
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      'export default { memory: { distill: { provider: "definitely-not-a-provider" } } }\n',
    )
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (const day of [6, 7, 8, 9, 10]) await store.put(episode(`e${day}`, day))

    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["consolidate"], { cwd: appRoot }, io)).rejects.toThrow(
      /Unsupported agent provider "definitely-not-a-provider"/,
    )
    // Nothing was written: the failure happened before any model call.
    expect(await consolidatedRecords(store)).toHaveLength(0)
  })

  // Provider selection. Every case below is asserted through a model-CONSTRUCTION
  // error, so no test here ever reaches `.invoke()` — with both provider keys
  // unset there is no way for a wrong branch to make a real network call.
  async function withoutProviderKeys<T>(fn: () => Promise<T>): Promise<T> {
    const saved = {
      openai: process.env.OPENAI_API_KEY,
      openaiBase: process.env.OPENAI_BASE_URL,
      anthropic: process.env.ANTHROPIC_API_KEY,
    }
    process.env.OPENAI_API_KEY = undefined
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL
    delete process.env.ANTHROPIC_API_KEY
    try {
      return await fn()
    } finally {
      if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai
      if (saved.openaiBase !== undefined) process.env.OPENAI_BASE_URL = saved.openaiBase
      if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic
    }
  }

  async function appWithWork(config?: string): Promise<string> {
    const appRoot = await makeApp()
    if (config !== undefined) await writeFile(join(appRoot, "dawn.config.ts"), config)
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (const day of [6, 7, 8, 9, 10]) await store.put(episode(`e${day}`, day))
    return appRoot
  }

  it("--model re-infers the provider when none was authored", async () => {
    // No `memory.distill.provider` in config → the resolved provider is merely
    // INFERRED from the default model (gpt-5-mini → openai). Overriding the
    // model across provider families must move the provider with it, or we'd
    // hand a Claude model id to ChatOpenAI. Constructing ChatAnthropic is only
    // reachable via provider "anthropic", and it fails loudly without a key —
    // that error IS the proof, and it needs no Anthropic credentials.
    const appRoot = await appWithWork()
    const io = { stdout: () => {}, stderr: () => {} }
    await withoutProviderKeys(async () => {
      await expect(
        runMemoryCommand(["consolidate", "--model", "claude-sonnet-4-5"], { cwd: appRoot }, io),
      ).rejects.toThrow(/Anthropic API key not found/)
    })
  })

  it("--model does NOT override an explicitly authored provider", async () => {
    // An authored provider is a deliberate choice (proxies, OpenAI-compatible
    // endpoints) and outranks inference. The unsupported id makes the branch
    // unambiguous: re-inferring from the Claude model id would have produced an
    // Anthropic key error instead.
    const appRoot = await appWithWork(
      'export default { memory: { distill: { provider: "definitely-not-a-provider" } } }\n',
    )
    const io = { stdout: () => {}, stderr: () => {} }
    await withoutProviderKeys(async () => {
      await expect(
        runMemoryCommand(["consolidate", "--model", "claude-sonnet-4-5"], { cwd: appRoot }, io),
      ).rejects.toThrow(/Unsupported agent provider "definitely-not-a-provider"/)
    })
  })

  it("--provider overrides both the authored config and inference", async () => {
    // Authored openai + a model id that also infers to openai: only an explicit
    // --provider can produce an Anthropic model here.
    const appRoot = await appWithWork(
      'export default { memory: { distill: { provider: "openai" } } }\n',
    )
    const io = { stdout: () => {}, stderr: () => {} }
    await withoutProviderKeys(async () => {
      await expect(
        runMemoryCommand(
          ["consolidate", "--model", "gpt-5", "--provider", "anthropic"],
          { cwd: appRoot },
          io,
        ),
      ).rejects.toThrow(/Anthropic API key not found/)
    })
  })

  it("reflect validates --provider like every other flag", async () => {
    const appRoot = await makeApp()
    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["reflect", "--provider"], { cwd: appRoot }, io)).rejects.toThrow(
      /Missing value for --provider/,
    )
    await expect(
      runMemoryCommand(["reflect", "--provider", "  "], { cwd: appRoot }, io),
    ).rejects.toThrow(/Invalid --provider value/)
  })

  it("consolidate --dry-run prints batches without writing", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (const day of [6, 7, 8, 9, 10]) await store.put(episode(`e${day}`, day))

    const lines: string[] = []
    await runMemoryCommand(
      ["consolidate", "--dry-run"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain(baseRecord.namespace)
    expect(output).toMatch(/5 records/)
    expect(output).toMatch(/dry run, nothing written/)
    expect(await consolidatedRecords(store)).toHaveLength(0)
    for (const day of [6, 7, 8, 9, 10]) {
      expect((await store.get(`e${day}`))?.status).toBe("active")
    }
  })

  it("reflect is a no-op below the threshold", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    // One record is far below the default minNewRecords (10).
    await store.put(episode("e1", 7))

    const lines: string[] = []
    await runMemoryCommand(
      ["reflect"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect(lines.join("\n")).toMatch(/nothing to reflect/)
    expect((await store.browse({ kind: "reflection", limit: 10 })).total).toBe(0)
  })

  it("consolidate rejects a non-numeric --max-batches", async () => {
    const appRoot = await makeApp()
    const io = { stdout: () => {}, stderr: () => {} }
    await expect(
      runMemoryCommand(["consolidate", "--max-batches", "notanumber"], { cwd: appRoot }, io),
    ).rejects.toThrow(/Invalid --max-batches value: "notanumber" \(expected a number >= 0\)/)
  })

  it("reflect rejects a negative --max-batches and an unknown flag", async () => {
    const appRoot = await makeApp()
    const io = { stdout: () => {}, stderr: () => {} }
    await expect(
      runMemoryCommand(["reflect", "--max-batches", "-1"], { cwd: appRoot }, io),
    ).rejects.toThrow(/Invalid --max-batches value: "-1"/)
    await expect(runMemoryCommand(["reflect", "--nope"], { cwd: appRoot }, io)).rejects.toThrow(
      /Unknown argument: "--nope"/,
    )
    await expect(
      runMemoryCommand(["consolidate", "--namespace"], { cwd: appRoot }, io),
    ).rejects.toThrow(/Missing value for --namespace/)
  })

  it("consolidate --namespace scopes the pass", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (const day of [6, 7, 8, 9, 10]) {
      await store.put({ ...episode(`b${day}`, day), namespace: "ws=app|route=/other" })
    }

    const lines: string[] = []
    await runMemoryCommand(
      ["consolidate", "--dry-run", "--namespace", baseRecord.namespace],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect(lines.join("\n")).toMatch(/nothing to consolidate/)
  })

  it("unknown subcommand throws CliError", async () => {
    const appRoot = await makeApp()
    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["badcmd"], { cwd: appRoot }, io)).rejects.toThrow(
      /Unknown subcommand/,
    )
  })
})
