// LIVE SMOKE — memory distillation against a real model. Gated on OPENAI_API_KEY:
// SKIPS in CI (no key) and runs only locally. Never add to a CI lane; never print the key.
//
// What only a live run can prove: the aimock suites script the model's response,
// so they cannot tell you whether a REAL model, given the real consolidation /
// reflection prompts, returns output the parser accepts and a summary/insight
// good enough for recall to surface afterwards. Both tests therefore end with a
// real agent run that has to reach the derived record through `recall`.
//
// The engine is driven through `runMemoryCommand` (the CLI's public runtime
// surface) rather than `runConsolidation`/`runReflection` directly — those are
// internal to @dawn-ai/cli and not exported from `@dawn-ai/cli/runtime`, and the
// command path is the thing users actually invoke.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runMemoryCommand } from "@dawn-ai/cli/runtime"
import { type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
// Reuses the episodic probe app: one route with a memory.ts, the run recorder
// enabled, and the default SQLite store at <appRoot>/.dawn/memory.sqlite.
const episodicRoot = fileURLToPath(new URL("./fixtures/probe-app-episodic", import.meta.url))
// scope: ["route"] on the fixture's memory.ts → this exact namespace.
const NAMESPACE = "route=/memory-chat"

function dbPath(root: string): string {
  return join(root, ".dawn", "memory.sqlite")
}
function cleanDb(root: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath(root)}${s}`, { force: true })
}
const io = { stdout: () => {}, stderr: () => {} }

/** Midday UTC `days` ago — truncated to the date so a spread of a few hours can
 *  never cross into the next ISO week (consolidation groups per namespace-week). */
function middayUtcDaysAgo(days: number, plusHours: number): string {
  const day = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  return `${day}T${pad(10 + plusHours)}:00:00.000Z`
}
function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function episode(id: string, content: string, at: string): MemoryRecord {
  return {
    id,
    kind: "episodic",
    namespace: NAMESPACE,
    content,
    data: { input: content, outcome: "ok" },
    source: { type: "run", id },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: at,
    updatedAt: at,
    effectiveAt: at,
  }
}

beforeEach(() => {
  cleanDb(episodicRoot)
})
afterEach(() => {
  cleanDb(episodicRoot)
})

it.skipIf(!live)(
  "consolidate → recall: a week of episodes becomes one summary the agent can recall",
  async () => {
    const store = sqliteMemoryStore({ path: dbPath(episodicRoot) })
    // Six episodes in ONE namespace-week, backdated ~10 days so they clear the
    // default 7-day `olderThanMs` cutoff. Six ≥ the default minBatchSize of 5,
    // so exactly one batch is eligible.
    //
    // Every episode carries the ticket id ZQ-7714. After consolidation the six
    // sources are SUPERSEDED — invisible to `recall` — so the only path by which
    // that token can reach the agent is the summary the model just wrote.
    const seeded = [
      "Worked the Zephyr migration (ticket ZQ-7714): drained the legacy write queue",
      "Worked the Zephyr migration (ticket ZQ-7714): backfilled the customer index",
      "Worked the Zephyr migration (ticket ZQ-7714): cut over read traffic to the new cluster",
      "Worked the Zephyr migration (ticket ZQ-7714): fixed the double-write reconciliation job",
      "Worked the Zephyr migration (ticket ZQ-7714): retired the legacy replica",
      "Worked the Zephyr migration (ticket ZQ-7714): wrote the rollback runbook",
    ].map((content, i) => episode(`memory_ep_smoke_${i}`, content, middayUtcDaysAgo(10, i)))
    for (const rec of seeded) await store.put(rec)

    await runMemoryCommand(["consolidate"], { cwd: episodicRoot }, io)

    // Exactly one summary: tagged "consolidated", with the provenance the docs promise.
    const page = await store.browse({ kind: "episodic", namespacePrefix: NAMESPACE, limit: 500 })
    const summaries = page.records.filter((r) => r.tags.includes("consolidated"))
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    expect(summary.status).toBe("active")
    expect(summary.data.sourceCount).toBe(6)
    expect(summary.data.derivedFrom).toHaveLength(6)
    // Guard with a readable failure: if the real model dropped the ticket id,
    // fail HERE rather than three minutes later on the agent's answer.
    expect(summary.content).toContain("ZQ-7714")

    // Every source superseded (and stamped with the source TTL prune reaps later).
    for (const rec of seeded) {
      const after = await store.get(rec.id)
      expect(after?.status).toBe("superseded")
      expect(after?.expiresAt).toBeTruthy()
    }

    const h = await createAgentHarness({
      appRoot: episodicRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      const r = await h.run({
        input:
          "Using your long-term memory, what did you work on last week on the Zephyr migration?",
      })
      expectToolCalled(r, "recall")
      const recall = String(r.toolResults.find((t) => t.name === "recall")?.content ?? "")
      // The summary itself must be the row recall returned (results render as
      // "<id>: <content>"), and the token must reach the answer.
      expect(recall).toContain(summary.id)
      expect(`${recall}\n${r.finalMessage}`).toContain("ZQ-7714")
    } finally {
      await h.close()
    }
  },
  240_000,
)

it.skipIf(!live)(
  "reflect → approve → recall: a candidate insight is invisible until approved",
  async () => {
    const store = sqliteMemoryStore({ path: dbPath(episodicRoot) })
    // Twelve episodes ≥ the default minNewRecords of 10, all pointing at one
    // pattern a real model should generalize. Backdated a few days each so the
    // reflection (stamped `now`) is unambiguously the freshest row in the namespace.
    const seeded = [
      "Friday afternoon deploy of griffin failed: config drift on the edge nodes",
      "Friday afternoon deploy of griffin rolled back after health checks flapped",
      "Tuesday deploy of griffin succeeded with no incidents",
      "Friday afternoon deploy of griffin failed: stale secrets in the release bundle",
      "Wednesday deploy of griffin succeeded with no incidents",
      "Friday afternoon deploy of griffin needed a manual restart of two pods",
      "Monday deploy of griffin succeeded with no incidents",
      "Friday afternoon deploy of griffin failed: migration lock held by a stuck job",
      "Thursday deploy of griffin succeeded with no incidents",
      "Friday afternoon deploy of griffin rolled back after error rates spiked",
      "Tuesday deploy of griffin succeeded with no incidents",
      "Friday afternoon deploy of griffin failed: unreviewed schema change shipped",
    ].map((content, i) => episode(`memory_ep_reflect_${i}`, content, middayUtcDaysAgo(2 + i, 0)))
    for (const rec of seeded) await store.put(rec)

    await runMemoryCommand(["reflect"], { cwd: episodicRoot }, io)

    // Insights land as CANDIDATES by default — the governance the docs promise.
    const reflections = await store.browse({ kind: "reflection", namespacePrefix: NAMESPACE })
    const candidates = reflections.records.filter((r) => r.status === "candidate")
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    const insight = candidates[0]!
    expect(insight.data.coveredUntil).toBeTruthy()
    expect(insight.data.derivedFrom).toHaveLength(12)

    // ...and a candidate is hidden from recall until a human promotes it.
    const hidden = await store.search({ namespace: NAMESPACE, status: "active", query: "griffin" })
    expect(hidden.some((r) => r.id === insight.id)).toBe(false)

    await runMemoryCommand(["approve", insight.id], { cwd: episodicRoot }, io)
    expect((await store.get(insight.id))?.status).toBe("active")

    const h = await createAgentHarness({
      appRoot: episodicRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      const r = await h.run({
        input:
          "Using your long-term memory, what have you learned about griffin deployments — is there a pattern?",
      })
      expectToolCalled(r, "recall")
      // Recall renders "<id>: <content>", so the approved insight's id is a
      // model-phrasing-independent proof that the reflection surfaced.
      const recall = String(r.toolResults.find((t) => t.name === "recall")?.content ?? "")
      expect(recall).toContain(insight.id)
    } finally {
      await h.close()
    }
  },
  240_000,
)
