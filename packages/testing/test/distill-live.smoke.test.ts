// LIVE SMOKE — memory distillation against a real model. Gated on OPENAI_API_KEY:
// SKIPS in CI (no key) and runs only locally. Never add to a CI lane; never print the key.
//
// What only a live run can prove: the aimock suites script the model's response,
// so they cannot tell you whether a REAL model, given the real consolidation /
// reflection prompts, returns output the parser accepts and a summary/insight
// good enough for recall to surface afterwards. Both tests therefore search for
// the LIVE-AUTHORED record with a question phrased the way a user would phrase
// it, and then run a real agent turn over it.
//
// Two things the first live run of this file taught us, both encoded below:
//
//   1. Ask what a user would ask, not what the fixture makes true. The original
//      consolidation question said "last week", but consolidation only touches
//      episodes older than `olderThanMs` (7 days), so the seeded week is ~10
//      days old BY CONSTRUCTION and "last week" genuinely excludes it. The model
//      dutifully passed a time window and recall correctly returned nothing —
//      a question no agent could answer, not a bug in distillation. (Worse, the
//      model first guessed an ABSOLUTE 2023 window against a 2026 store; that
//      is what the since/until schema guidance in the memory capability now
//      steers away from.)
//   2. `recall` is not the only path from the agent to a memory. The memory-index
//      prompt fragment lists active memories inline (truncated to 80 chars), and
//      a real model will happily answer a general question straight from it
//      without calling any tool — observed. So a live turn may legitimately make
//      zero tool calls, and only a question whose answer lives PAST the 80-char
//      truncation reliably forces `recall`. The consolidation test uses exactly
//      that (the ticket id sits well past the cutoff); the reflection test does
//      not assert a tool call at all, and proves reachability by search instead.
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
/** Run a memory command, buffering its output. The engine isolates a failed
 *  batch and reports WHY on stderr, then the command throws a summary line
 *  ("reflect finished with 1 failed batch(es) — see the errors above"). With the
 *  streams discarded there was no "above": a live failure surfaced as a sentence
 *  pointing at output nothing had kept. Re-throw with the detail attached. */
async function runMemory(argv: readonly string[]): Promise<void> {
  const errors: string[] = []
  const io = { stdout: () => {}, stderr: (s: string) => errors.push(s.trimEnd()) }
  try {
    await runMemoryCommand([...argv], { cwd: episodicRoot }, io)
  } catch (error) {
    const detail = errors.length > 0 ? `\n${errors.join("\n")}` : " (no stderr captured)"
    throw new Error(`dawn memory ${argv.join(" ")} failed: ${String(error)}${detail}`)
  }
}

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

    await runMemory(["consolidate"])

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

    // Reachability, measured directly on the LIVE-authored summary before any
    // agent is involved: a question in the user's own words, ranked against the
    // real store, must return the summary. This is the assertion that isolates
    // "the model wrote a findable summary" from "the agent asked well" — when
    // the live turn below fails, this line says which of the two broke.
    const found = await store.search({
      namespace: NAMESPACE,
      status: "active",
      query: "what happened with the Zephyr migration?",
    })
    expect(found.map((r) => r.id)).toContain(summary.id)

    const h = await createAgentHarness({
      appRoot: episodicRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      // Deliberately no time framing (see note 1 in the file header) — this is
      // the question someone actually asks of an agent's long-term memory. The
      // ticket id is what forces a real `recall`: the memory index advertises
      // the summary but truncates at 80 chars, well before "ZQ-7714".
      const r = await h.run({
        input: "Using your long-term memory, what do you know about the Zephyr migration?",
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

    await runMemory(["reflect"])

    // Insights land as CANDIDATES by default — the governance the docs promise.
    const reflections = await store.browse({ kind: "reflection", namespacePrefix: NAMESPACE })
    const candidates = reflections.records.filter((r) => r.status === "candidate")
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    for (const candidate of candidates) {
      expect(candidate.data.coveredUntil).toBeTruthy()
      expect(candidate.data.derivedFrom).toHaveLength(12)
      // ...and a candidate is hidden from recall until a human promotes it.
      // Queried with the candidate's OWN text, so the gate is what hides it —
      // a fixed query like "griffin" could pass merely because the model chose
      // not to use that word, which is exactly what happened before the
      // distillation prompts began demanding verbatim entity names.
      const hidden = await store.search({
        namespace: NAMESPACE,
        status: "active",
        query: candidate.content,
      })
      expect(hidden.map((r) => r.id)).not.toContain(candidate.id)
    }

    // Approve the whole pass, the way a human reviewing it would. Picking one
    // arbitrary candidate made this test a coin flip: which of the N insights a
    // real model writes — and which one lands first — is not knowable in advance.
    for (const candidate of candidates) {
      await runMemory(["approve", candidate.id])
      expect((await store.get(candidate.id))?.status).toBe("active")
    }
    const approvedIds = new Set(candidates.map((c) => c.id))

    // THE assertion this test exists for: an insight a real model just wrote,
    // ranked against the 12 source episodes it generalizes (which are still
    // active — reflection, unlike consolidation, does not supersede its
    // sources), must come back for a question in the user's own words. It is a
    // genuine regression guard: before the reflection prompt required verbatim
    // entity names, the insights named no service at all ("earlier-week
    // deployment windows are lower risk") and lost this ranking to twelve
    // episodes that each said "griffin".
    const question = "What should I know about griffin deploys?"
    const ranked = await store.search({ namespace: NAMESPACE, status: "active", query: question })
    expect(ranked.some((r) => approvedIds.has(r.id))).toBe(true)

    const h = await createAgentHarness({
      appRoot: episodicRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      const r = await h.run({ input: `Using your long-term memory: ${question}` })
      // No tool-call assertion here on purpose (see note 2 in the file header):
      // the agent may answer this from the memory index without calling recall,
      // and both routes are legitimate reads of long-term memory. What IS
      // provable end-to-end is that the answer carries facts that exist nowhere
      // but this store — the agent has no other source for either token.
      const answer = r.finalMessage.toLowerCase()
      expect(answer).toContain("griffin")
      expect(answer).toContain("friday")
      // When it did take the tool route, the reflection pass has to be what it
      // surfaced — recall renders "<id>: <content>", so the id is a
      // model-phrasing-independent proof.
      const recalls = r.toolResults.filter((t) => t.name === "recall")
      if (recalls.length > 0) {
        const text = recalls.map((t) => String(t.content ?? "")).join("\n")
        expect([...approvedIds].some((id) => text.includes(id))).toBe(true)
      }
    } finally {
      await h.close()
    }
  },
  240_000,
)
