# Smarter Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pure-recency ordering in long-term-memory recall with deterministic IDF-weighted relevance ranking (+ recency decay + confidence), per the approved spec `docs/superpowers/specs/2026-07-05-smarter-recall-design.md`.

**Architecture:** A new pure scoring module in `@dawn-ai/memory` (`score.ts`); `sqliteMemoryStore.search()` gains a ranked path for tokenized queries (candidate pool + live df/N stats + JS scoring) while the query-less path stays byte-for-byte unchanged; `MemoryQuery` gains optional `now`; the core capability passes `context.memory.now`; `DawnConfig.memory.recall` threads tuning options via `resolveMemoryStore`.

**Tech Stack:** TypeScript, `node:sqlite`, vitest, aimock harness (`@dawn-ai/testing`). No new dependencies. Branch: `feat/memory-recall-ranking` (already created; spec committed).

**Working directory:** `/Users/blove/repos/dawn` (the primary checkout, already on the branch). All commands run from there. Use the repo lint script pattern (`pnpm exec biome check --config-path packages/config-biome/biome.json <files>`) — NEVER bare `biome check --write` (it mass-reformats with wrong defaults).

**Deviation from spec (approved rationale):** The spec's "eval dogfood in the research template" is DEFERRED — the template has no evals today and adding `@dawn-ai/evals` to a scaffold template destabilizes the generated-app verify lanes (known SCAFFOLD_PACKAGES hazard). The aimock before/after e2e (Task 5) is the deterministic quality gate instead. Task 7 amends the spec to record this.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/memory/src/score.ts` (create) | Pure scoring: `idf()`, `scoreMemory()`, `RecallWeights`, `RecallRankingOptions`, defaults |
| `packages/memory/src/types.ts` (modify) | `MemoryQuery.now?: string` |
| `packages/memory/src/sqlite-store.ts` (modify) | `sqliteMemoryStore({ path, recall? })`; ranked path in `search()` |
| `packages/memory/src/index.ts` (modify) | Barrel exports for score module |
| `packages/memory/test/score.test.ts` (create) | Score unit tests |
| `packages/memory/test/sqlite-store.test.ts` (modify) | Ranked-ordering store tests |
| `packages/core/src/capabilities/types.ts` (modify) | `MemoryStoreLike.search` gains `now?` |
| `packages/core/src/types.ts` (modify) | `DawnConfig.memory.recall` (structural, no import of @dawn-ai/memory) |
| `packages/core/src/capabilities/built-in/memory.ts` (modify) | recall tool passes `now: mem.now` |
| `packages/core/test/memory-capability-recall.test.ts` (create) | now-plumbing test via fake store |
| `packages/cli/src/lib/runtime/resolve-memory.ts` (modify) | thread `config.memory.recall` into `sqliteMemoryStore` |
| `packages/cli/test/resolve-memory.test.ts` (modify) | recall-options threading test |
| `packages/testing/test/memory-ranking-e2e.test.ts` (create) | aimock before/after e2e (headline) |
| `packages/testing/test/memory-live.smoke.test.ts` (modify) | gated live ranking scenario |
| `apps/web/content/docs/memory.mdx` (modify) | "How recall ranks" docs |
| `docs/dev/memory-system.md` (modify+commit) | §4/§13/§14 updates (file currently untracked — commit it) |
| `docs/dev/smarter-recall-dx.md` (commit) | DX draft (currently untracked) |
| `.changeset/smarter-recall.md` (create) | patch: memory, core, cli |

---

### Task 1: Pure scoring module (`score.ts`)

**Files:**
- Create: `packages/memory/src/score.ts`
- Create: `packages/memory/test/score.test.ts`
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/test/score.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  DEFAULT_CANDIDATE_POOL,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  idf,
  scoreMemory,
} from "../src/score.js"

const NOW = "2026-07-05T00:00:00.000Z"
const DAY = 24 * 60 * 60 * 1000
function ago(ms: number): string {
  return new Date(Date.parse(NOW) - ms).toISOString()
}

describe("idf", () => {
  it("is monotonically decreasing in df and always positive", () => {
    const n = 10
    const values = [0, 1, 5, 10].map((df) => idf(df, n))
    expect(values[0]).toBeGreaterThan(values[1]!)
    expect(values[1]).toBeGreaterThan(values[2]!)
    expect(values[2]).toBeGreaterThan(values[3]!)
    for (const v of values) expect(v).toBeGreaterThan(0) // smoothed: df=N still > 0
  })
  it("clamps df above corpusSize instead of going negative", () => {
    expect(idf(12, 10)).toBeGreaterThan(0)
  })
})

describe("scoreMemory", () => {
  const base = {
    corpusSize: 6,
    updatedAt: NOW,
    confidence: 1,
    referenceNow: NOW,
  }
  it("rare-token match outranks common-token match (IDF dominance)", () => {
    const df = new Map([
      ["acme", 6], // in every memory — uninformative
      ["threshold", 1], // rare — informative
    ])
    const queryTokens = ["acme", "threshold"]
    const matchesRare = scoreMemory({
      ...base,
      memoryTokens: new Set(["threshold"]),
      queryTokens,
      dfByToken: df,
    })
    const matchesCommon = scoreMemory({
      ...base,
      memoryTokens: new Set(["acme"]),
      queryTokens,
      dfByToken: df,
    })
    expect(matchesRare).toBeGreaterThan(matchesCommon)
  })
  it("matching more query tokens scores higher (overlap fraction)", () => {
    const df = new Map([
      ["billing", 2],
      ["threshold", 2],
    ])
    const queryTokens = ["billing", "threshold"]
    const two = scoreMemory({
      ...base,
      memoryTokens: new Set(["billing", "threshold"]),
      queryTokens,
      dfByToken: df,
    })
    const one = scoreMemory({
      ...base,
      memoryTokens: new Set(["billing"]),
      queryTokens,
      dfByToken: df,
    })
    expect(two).toBeGreaterThan(one)
    expect(two).toBeCloseTo(0.6 * 1 + 0.3 * 1 + 0.1 * 1, 10) // full match, age 0, conf 1
  })
  it("recency component halves at exactly one half-life", () => {
    const df = new Map([["x", 1]])
    const args = {
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      confidence: 1,
      referenceNow: NOW,
      options: { weights: { relevance: 0, recency: 1, confidence: 0 } },
    }
    const fresh = scoreMemory({ ...args, updatedAt: NOW })
    const halfLife = scoreMemory({ ...args, updatedAt: ago(DEFAULT_RECENCY_HALF_LIFE_MS) })
    expect(fresh).toBeCloseTo(1, 10)
    expect(halfLife).toBeCloseTo(0.5, 10)
  })
  it("confidence is clamped to [0,1]", () => {
    const df = new Map([["x", 1]])
    const args = {
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: NOW,
      referenceNow: NOW,
      options: { weights: { relevance: 0, recency: 0, confidence: 1 } },
    }
    expect(scoreMemory({ ...args, confidence: 1.5 })).toBeCloseTo(1, 10)
    expect(scoreMemory({ ...args, confidence: -0.2 })).toBeCloseTo(0, 10)
  })
  it("invalid timestamps degrade to age 0 (recency 1), never throw", () => {
    const df = new Map([["x", 1]])
    const score = scoreMemory({
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: "not-a-date",
      confidence: 1,
      referenceNow: "also-not-a-date",
      options: { weights: { relevance: 0, recency: 1, confidence: 0 } },
    })
    expect(score).toBeCloseTo(1, 10)
  })
  it("weight overrides merge with defaults (partial weights allowed)", () => {
    const df = new Map([["x", 1]])
    const score = scoreMemory({
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: NOW,
      confidence: 0,
      referenceNow: NOW,
      options: { weights: { confidence: 0.5 } }, // relevance/recency keep defaults 0.6/0.3
    })
    expect(score).toBeCloseTo(0.6 + 0.3 + 0, 10)
  })
  it("exposes the documented defaults", () => {
    expect(DEFAULT_RECENCY_HALF_LIFE_MS).toBe(14 * DAY)
    expect(DEFAULT_CANDIDATE_POOL).toBe(256)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/memory exec vitest run test/score.test.ts`
Expected: FAIL — `Cannot find module '../src/score.js'`

- [ ] **Step 3: Implement `score.ts`**

Create `packages/memory/src/score.ts`:

```ts
// Pure recall scoring — no I/O, no clock, no randomness. Deterministic by
// construction so aimock fixtures and eval replays stay stable. See
// docs/superpowers/specs/2026-07-05-smarter-recall-design.md.

export interface RecallWeights {
  readonly relevance?: number
  readonly recency?: number
  readonly confidence?: number
}

export interface RecallRankingOptions {
  readonly weights?: RecallWeights
  readonly recencyHalfLifeMs?: number
  readonly candidatePool?: number
}

export const DEFAULT_RECALL_WEIGHTS = {
  relevance: 0.6,
  recency: 0.3,
  confidence: 0.1,
} as const

export const DEFAULT_RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
export const DEFAULT_CANDIDATE_POOL = 256

/**
 * BM25-smoothed inverse document frequency. Always positive — a token present
 * in every memory (df = corpusSize) still carries a small weight rather than
 * zeroing out or going negative (as unsmoothed idf would).
 */
export function idf(df: number, corpusSize: number): number {
  const d = Math.max(0, df)
  const n = Math.max(d, corpusSize)
  return Math.log(1 + (n - d + 0.5) / (d + 0.5))
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Parse an ISO timestamp; NaN (invalid/missing) degrades to null, never throws. */
function parseMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Composite recall score: wRel·relevance + wRec·recency + wConf·confidence.
 *
 * relevance = Σ idf(matched query tokens) / Σ idf(all query tokens) — the
 * fraction of the query's information this memory matches (0..1). Query
 * tokens matching nothing inflate only the shared denominator, so relative
 * ordering is unaffected.
 *
 * recency = 2^(−age / halfLife), age measured from `referenceNow` back to
 * `updatedAt`, clamped ≥ 0. Invalid timestamps degrade to age 0.
 */
export function scoreMemory(args: {
  readonly memoryTokens: ReadonlySet<string>
  readonly queryTokens: readonly string[]
  readonly dfByToken: ReadonlyMap<string, number>
  readonly corpusSize: number
  readonly updatedAt: string
  readonly confidence: number
  readonly referenceNow: string
  readonly options?: RecallRankingOptions
}): number {
  const weights = { ...DEFAULT_RECALL_WEIGHTS, ...args.options?.weights }
  const halfLife = args.options?.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS

  let matchedIdf = 0
  let totalIdf = 0
  for (const t of args.queryTokens) {
    const w = idf(args.dfByToken.get(t) ?? 0, args.corpusSize)
    totalIdf += w
    if (args.memoryTokens.has(t)) matchedIdf += w
  }
  const relevance = totalIdf > 0 ? matchedIdf / totalIdf : 0

  const ref = parseMs(args.referenceNow)
  const upd = parseMs(args.updatedAt)
  const ageMs = ref !== null && upd !== null ? Math.max(0, ref - upd) : 0
  const recency = 2 ** (-ageMs / halfLife)

  const confidence = clamp01(args.confidence)

  return weights.relevance * relevance + weights.recency * recency + weights.confidence * confidence
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/memory/src/index.ts`, add (keeping alphabetical grouping with the existing exports):

```ts
export {
  DEFAULT_CANDIDATE_POOL,
  DEFAULT_RECALL_WEIGHTS,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  idf,
  type RecallRankingOptions,
  type RecallWeights,
  scoreMemory,
} from "./score.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/memory exec vitest run test/score.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Lint + commit**

```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/memory/src/score.ts packages/memory/src/index.ts packages/memory/test/score.test.ts
git add packages/memory/src/score.ts packages/memory/src/index.ts packages/memory/test/score.test.ts
git commit -m "feat(memory): pure IDF-weighted recall scoring module"
```

---

### Task 2: Ranked path in `sqliteMemoryStore.search()`

**Files:**
- Modify: `packages/memory/src/types.ts` (MemoryQuery)
- Modify: `packages/memory/src/sqlite-store.ts`
- Modify: `packages/memory/test/sqlite-store.test.ts`

- [ ] **Step 1: Add `now` to `MemoryQuery`**

In `packages/memory/src/types.ts`, change the `MemoryQuery` interface to:

```ts
export interface MemoryQuery {
  readonly namespace: string
  readonly query?: string
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
  readonly status?: MemoryStatus
  readonly limit?: number
  /** ISO timestamp used as the recency reference for ranked (query) searches.
   *  Optional; when absent, recency is measured relative to the newest
   *  candidate's updatedAt (data-derived — the library never reads a clock). */
  readonly now?: string
}
```

- [ ] **Step 2: Write the failing store tests**

Append to `packages/memory/test/sqlite-store.test.ts` (inside the existing `describe("sqliteMemoryStore", ...)`, reusing the existing `rec()` helper):

```ts
  it("ranked recall: relevant-but-old beats recent-but-marginal (headline)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    // Several acme memories so "acme" is common (low idf) in the namespace.
    await s.put(rec({ id: "m1", namespace: "ns", content: "acme invoice format is pdf", updatedAt: "2026-06-30T00:00:00.000Z" }))
    await s.put(rec({ id: "m2", namespace: "ns", content: "acme owner is jordan", updatedAt: "2026-07-01T00:00:00.000Z" }))
    await s.put(rec({ id: "target", namespace: "ns", content: "acme billing escalation threshold is 500 dollars", updatedAt: "2026-05-20T00:00:00.000Z" }))
    await s.put(rec({ id: "distractor", namespace: "ns", content: "acme contact jordan prefers slack", updatedAt: "2026-07-04T00:00:00.000Z" }))
    const out = await s.search({
      namespace: "ns",
      query: "acme billing escalation threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    // Pure recency (old behavior) would put "distractor" first; ranking must not.
    expect(out[0]?.id).toBe("target")
  })

  it("ranked recall: same relevance ties break by recency then id", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "b_old", namespace: "ns", content: "billing threshold fact", updatedAt: "2026-07-01T00:00:00.000Z" }))
    await s.put(rec({ id: "a_new", namespace: "ns", content: "billing threshold fact", updatedAt: "2026-07-04T00:00:00.000Z" }))
    const out = await s.search({ namespace: "ns", query: "billing threshold", now: "2026-07-05T00:00:00.000Z" })
    expect(out.map((r) => r.id)).toEqual(["a_new", "b_old"])
  })

  it("ranked recall: omitted `now` falls back to newest candidate (deterministic)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "x", namespace: "ns", content: "billing threshold", updatedAt: "2026-07-04T00:00:00.000Z" }))
    await s.put(rec({ id: "y", namespace: "ns", content: "billing note", updatedAt: "2026-07-01T00:00:00.000Z" }))
    const a = await s.search({ namespace: "ns", query: "billing threshold" })
    const b = await s.search({ namespace: "ns", query: "billing threshold" })
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id)) // same inputs → same order
    expect(a[0]?.id).toBe("x") // matches 2/2 tokens; y matches 1/2
  })

  it("ranked recall: confidence breaks ties at equal relevance and recency", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "hedged", namespace: "ns", content: "billing threshold fact", confidence: 0.4, updatedAt: "2026-07-01T00:00:00.000Z" }))
    await s.put(rec({ id: "sure", namespace: "ns", content: "billing threshold fact", confidence: 1, updatedAt: "2026-07-01T00:00:00.000Z" }))
    const out = await s.search({ namespace: "ns", query: "billing threshold", now: "2026-07-05T00:00:00.000Z" })
    expect(out[0]?.id).toBe("sure")
  })

  it("ranked recall: candidatePool caps scored candidates by recency, deterministically", async () => {
    const s = sqliteMemoryStore({ path: ":memory:", recall: { candidatePool: 1 } })
    await s.put(rec({ id: "older", namespace: "ns", content: "billing threshold exact", updatedAt: "2026-07-01T00:00:00.000Z" }))
    await s.put(rec({ id: "newer", namespace: "ns", content: "billing note", updatedAt: "2026-07-04T00:00:00.000Z" }))
    const out = await s.search({ namespace: "ns", query: "billing threshold", now: "2026-07-05T00:00:00.000Z" })
    // Pool of 1 keeps only the NEWEST token-match; "older" never gets scored.
    expect(out.map((r) => r.id)).toEqual(["newer"])
  })

  it("query-less search is unchanged: pure recency order", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "old", namespace: "ns", content: "billing threshold exact match", updatedAt: "2026-07-01T00:00:00.000Z" }))
    await s.put(rec({ id: "new", namespace: "ns", content: "unrelated note", updatedAt: "2026-07-04T00:00:00.000Z" }))
    const out = await s.search({ namespace: "ns" })
    expect(out.map((r) => r.id)).toEqual(["new", "old"])
  })
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `pnpm --filter @dawn-ai/memory exec vitest run test/sqlite-store.test.ts`
Expected: FAIL — headline test gets `distractor` first (recency order); candidatePool test fails on the `recall` option (TS error: unknown property) — if TS blocks the run entirely, that's the expected failure mode; proceed.

- [ ] **Step 4: Implement the ranked path**

In `packages/memory/src/sqlite-store.ts`:

(a) Add imports at the top:

```ts
import {
  DEFAULT_CANDIDATE_POOL,
  type RecallRankingOptions,
  scoreMemory,
} from "./score.js"
```

(b) Change the factory signature:

```ts
export function sqliteMemoryStore(opts: {
  path: string
  /** Recall ranking tuning; all fields defaulted. See score.ts. */
  recall?: RecallRankingOptions
}): MemoryStore {
```

(c) Replace the body of `async search(q: MemoryQuery)` with:

```ts
    async search(q: MemoryQuery) {
      const status = q.status ?? "active"
      const limit = q.limit ?? 8
      const terms = q.query ? tokenize(q.query) : []

      // Shared base filter (namespace + status [+ kind]) — the "corpus".
      let baseSql = `m.namespace = ? AND m.status = ?`
      const baseParams: SQLInputValue[] = [q.namespace, status]
      if (q.kind) {
        baseSql += ` AND m.kind = ?`
        baseParams.push(q.kind)
      }

      if (terms.length === 0) {
        // Query-less path: EXACTLY the pre-ranking behavior (index fragment,
        // listCandidates-adjacent consumers depend on pure recency order).
        const rows = db
          .prepare(
            `SELECT m.* FROM memories m WHERE ${baseSql} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
          )
          .all(...baseParams, limit) as Record<string, unknown>[]
        let records = rows.map(rowToRecord)
        if (q.tags && q.tags.length > 0) {
          const want = new Set(q.tags)
          records = records.filter((r) => r.tags.some((t) => want.has(t)))
        }
        return records
      }

      // Ranked path — see docs/superpowers/specs/2026-07-05-smarter-recall-design.md.
      const pool = opts.recall?.candidatePool ?? DEFAULT_CANDIDATE_POOL
      const placeholders = terms.map(() => "?").join(",")

      // 1) Candidate pool: rows matching ≥1 query token, newest first (pool
      //    truncation by recency is deterministic).
      const candidateRows = db
        .prepare(
          `SELECT m.* FROM memories m WHERE ${baseSql}
           AND m.id IN (SELECT memory_id FROM memory_tokens WHERE token IN (${placeholders}))
           ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
        )
        .all(...baseParams, ...terms, pool) as Record<string, unknown>[]
      const candidates = candidateRows.map(rowToRecord)
      if (candidates.length === 0) return []

      // 2) Corpus stats, computed live (nothing cached → nothing to go stale).
      const corpusSize = (
        db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${baseSql}`).get(...baseParams) as {
          n: number
        }
      ).n
      const dfRows = db
        .prepare(
          `SELECT t.token AS token, COUNT(DISTINCT t.memory_id) AS df
           FROM memory_tokens t JOIN memories m ON m.id = t.memory_id
           WHERE ${baseSql} AND t.token IN (${placeholders}) GROUP BY t.token`,
        )
        .all(...baseParams, ...terms) as { token: string; df: number }[]
      const dfByToken = new Map(dfRows.map((r) => [r.token, r.df]))

      // 3) Score. Candidate token sets are recomputed via the same helper
      //    reindex() uses, so they are guaranteed consistent with the table.
      //    Pool is updated_at-DESC ordered, so candidates[0] is the newest —
      //    the data-derived reference when the caller supplies no clock.
      const referenceNow = q.now ?? candidates[0]?.updatedAt ?? ""
      const scored = candidates.map((record) => ({
        record,
        score: scoreMemory({
          memoryTokens: new Set(tokensFor(record)),
          queryTokens: terms,
          dfByToken,
          corpusSize,
          updatedAt: record.updatedAt,
          confidence: record.confidence,
          referenceNow,
          ...(opts.recall ? { options: opts.recall } : {}),
        }),
      }))

      // 4) Sort (score DESC, updated_at DESC, id ASC — stable) and page.
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          b.record.updatedAt.localeCompare(a.record.updatedAt) ||
          a.record.id.localeCompare(b.record.id),
      )
      let records = scored.slice(0, limit).map((s) => s.record)

      // 5) Tag post-filter on the returned page — today's semantics, unchanged.
      if (q.tags && q.tags.length > 0) {
        const want = new Set(q.tags)
        records = records.filter((r) => r.tags.some((t) => want.has(t)))
      }
      return records
    },
```

- [ ] **Step 5: Run the full memory package tests**

Run: `pnpm --filter @dawn-ai/memory test`
Expected: PASS — all new tests plus every pre-existing test (namespace, reconcile, tokenize, types, and the existing sqlite-store recency/isolation tests, which use either query-less searches or single-relevance cases that rank identically).

If the pre-existing test `search matches tokenized keywords and orders by recency (updatedAt desc)` fails: inspect it — it uses two records with the SAME tokens, so equal relevance → recency tiebreak preserves its expected order. A failure there means the tiebreak is wrong; fix the comparator, not the test.

- [ ] **Step 6: Lint + commit**

```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/memory/src packages/memory/test
git add packages/memory/src packages/memory/test
git commit -m "feat(memory): ranked recall path — IDF relevance + recency + confidence"
```

---

### Task 3: Core types + capability passes `now`

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (MemoryStoreLike)
- Modify: `packages/core/src/types.ts` (DawnConfig.memory.recall)
- Modify: `packages/core/src/capabilities/built-in/memory.ts` (recall tool)
- Create: `packages/core/test/memory-capability-recall.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/memory-capability-recall.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createMemoryMarker } from "../src/capabilities/built-in/memory.js"
import type { CapabilityMarkerContext, MemoryContext } from "../src/capabilities/types.js"

const NOW = "2026-07-05T12:00:00.000Z"

function makeContext(captured: { query?: Record<string, unknown> }): CapabilityMarkerContext {
  const memory: MemoryContext = {
    store: {
      async put() {},
      async get() {
        return null
      },
      async search(q) {
        // The index query (query-less) also lands here; only capture ranked queries.
        if ((q as { query?: string }).query) captured.query = q as Record<string, unknown>
        return []
      },
      async update() {},
      async supersede() {},
    },
    namespace: "route=/probe",
    writes: "auto",
    defined: { kind: "semantic", scope: ["route"] },
    validate: () => ({ ok: true, value: {} }),
    now: NOW,
  }
  return {
    routeManifest: { tools: [], stateFields: [] } as unknown as CapabilityMarkerContext["routeManifest"],
    descriptor: undefined,
    appRoot: "/tmp/nowhere",
    memory,
  }
}

describe("memory capability recall tool", () => {
  it("passes context.memory.now as the recency reference on ranked searches", async () => {
    const captured: { query?: Record<string, unknown> } = {}
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext(captured))
    const recall = contribution.tools?.find((t) => t.name === "recall")
    expect(recall).toBeDefined()
    await recall?.run({ query: "billing threshold" }, { signal: new AbortController().signal })
    expect(captured.query?.now).toBe(NOW)
  })
})
```

Note: if `CapabilityMarkerContext.routeManifest` rejects the cast above, mirror how the existing capability tests in `packages/core/test/` construct a minimal context (check `ls packages/core/test/` for e.g. skills/planning capability tests and copy their manifest stub).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/core exec vitest run test/memory-capability-recall.test.ts`
Expected: FAIL — `captured.query?.now` is `undefined` (recall doesn't pass it yet). A TS error on `now` in the search arg type is the same failure; proceed.

- [ ] **Step 3: Add `now` to `MemoryStoreLike.search`**

In `packages/core/src/capabilities/types.ts`, change the search signature inside `MemoryStoreLike`:

```ts
  search(q: {
    namespace: string
    query?: string
    kind?: string
    tags?: readonly string[]
    status?: string
    limit?: number
    /** ISO recency reference for ranked searches; stores may ignore it. */
    now?: string
  }): Promise<readonly MemoryRecordLike[]>
```

- [ ] **Step 4: Pass `now` from the recall tool**

In `packages/core/src/capabilities/built-in/memory.ts`, in the `recall` tool's `run`, change the `mem.store.search({...})` call to include the reference timestamp:

```ts
          const rows = await mem.store.search({
            namespace: mem.namespace,
            ...(q.query ? { query: q.query } : {}),
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.tags ? { tags: q.tags } : {}),
            limit: q.limit ?? 8,
            // Recency reference for ranked recall — the per-request timestamp,
            // NOT Date.now() (determinism rule; see module docblock).
            now: mem.now,
          })
```

- [ ] **Step 5: Add `recall` to `DawnConfig.memory`**

In `packages/core/src/types.ts`, inside the `readonly memory?: { ... }` block (after `indexMaxEntries`), add:

```ts
    /** Recall ranking tuning for the default SQLite store. All fields
     *  defaulted; omit for standard behavior. Ignored when a custom `store`
     *  is supplied (custom stores own their own ranking). */
    readonly recall?: {
      readonly weights?: {
        readonly relevance?: number
        readonly recency?: number
        readonly confidence?: number
      }
      readonly recencyHalfLifeMs?: number
      readonly candidatePool?: number
    }
```

(Structural on purpose — `@dawn-ai/core` must not import `@dawn-ai/memory`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/core test`
Expected: PASS — the new test plus all existing core tests (the added `now` field is optional; existing fake stores ignore it).

- [ ] **Step 7: Lint + commit**

```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/core/src packages/core/test/memory-capability-recall.test.ts
git add packages/core/src packages/core/test/memory-capability-recall.test.ts
git commit -m "feat(core): recall passes per-request now; DawnConfig.memory.recall tuning type"
```

---

### Task 4: CLI threads `memory.recall` config into the default store

**Files:**
- Modify: `packages/cli/src/lib/runtime/resolve-memory.ts`
- Modify: `packages/cli/test/resolve-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Read `packages/cli/test/resolve-memory.test.ts` first and reuse its existing tmp-appRoot/config-file helpers. Add this test (adapt helper names to what the file actually uses):

```ts
it("threads config.memory.recall into the default sqlite store", async () => {
  // App root with a dawn.config.ts that caps the ranked candidate pool at 1.
  const appRoot = await makeTmpApp({
    dawnConfig: `export default { memory: { recall: { candidatePool: 1 } } }\n`,
  })
  const store = await resolveMemoryStore(appRoot)
  const base = {
    kind: "semantic" as const,
    namespace: "ns",
    data: {},
    source: { type: "run" as const, id: "r" },
    confidence: 1,
    tags: [],
    status: "active" as const,
    createdAt: "2026-07-01T00:00:00.000Z",
  }
  await store.put({ ...base, id: "older", content: "billing threshold exact", updatedAt: "2026-07-01T00:00:00.000Z" })
  await store.put({ ...base, id: "newer", content: "billing note", updatedAt: "2026-07-04T00:00:00.000Z" })
  const out = await store.search({ namespace: "ns", query: "billing threshold", now: "2026-07-05T00:00:00.000Z" })
  // candidatePool 1 → only the newest token-match is scored/returned. With the
  // default pool (256), "older" (2/2 token match) would win instead.
  expect(out.map((r) => r.id)).toEqual(["newer"])
})
```

If the existing file has no tmp-app helper, create the app root with `mkdtemp` + write `dawn.config.ts` with `writeFile`, matching whatever pattern `resolve-memory.test.ts` already uses for its `resolveMemoryWrites` config tests (it has ones — mirror them exactly).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/resolve-memory.test.ts`
Expected: the new test FAILS with `["older"]` first (recall options not threaded, default pool 256 scores both, older wins on relevance).

- [ ] **Step 3: Thread the option**

In `packages/cli/src/lib/runtime/resolve-memory.ts`, replace `resolveMemoryStore` with:

```ts
export async function resolveMemoryStore(appRoot: string): Promise<MemoryStoreLike> {
  let recall: Record<string, unknown> | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.memory?.store) return loaded.config.memory.store as MemoryStoreLike
    recall = loaded.config.memory?.recall as Record<string, unknown> | undefined
  } catch {
    // no dawn.config.ts / unreadable — use default
  }
  return sqliteMemoryStore({
    path: join(appRoot, ".dawn", "memory.sqlite"),
    ...(recall ? { recall } : {}),
  }) as unknown as MemoryStoreLike
}
```

- [ ] **Step 4: Run the CLI memory tests**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/resolve-memory.test.ts test/build-memory-context.test.ts test/memory-command.test.ts`
Expected: PASS (new test + all existing).

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/cli/src/lib/runtime/resolve-memory.ts packages/cli/test/resolve-memory.test.ts
git add packages/cli/src/lib/runtime/resolve-memory.ts packages/cli/test/resolve-memory.test.ts
git commit -m "feat(cli): thread DawnConfig.memory.recall into the default memory store"
```

---

### Task 5: aimock before/after e2e (the headline proof)

**Files:**
- Create: `packages/testing/test/memory-ranking-e2e.test.ts`

Model: `packages/testing/test/memory-e2e.test.ts` (same probe app `/memory-chat#agent`, auto-writes mode, schema `{subject, predicate, value}`).

- [ ] **Step 1: Write the test**

Create `packages/testing/test/memory-ranking-e2e.test.ts`:

```ts
// Deterministic (aimock) e2e for RANKED recall: a relevant-but-old memory must
// outrank a recent-but-marginal one. Under pure-recency (pre-ranking) recall
// this test FAILS — it is the before/after proof for smarter recall. aimock
// scripts only the model; runtime, capability, SQLite, tokenization, and
// ranking are all real. Runs in CI (no API key).
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterAll, beforeAll, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const dbBase = join(appRoot, ".dawn", "memory.sqlite")
function cleanDb() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbBase}${suffix}`, { force: true })
}

beforeAll(cleanDb)
afterAll(cleanDb)

it("ranks a relevant-but-old memory above a recent-but-marginal one", async () => {
  // Seed the backdated relevant fact directly: writes through the remember
  // tool always stamp the request time, so age must be seeded at the store.
  const store = sqliteMemoryStore({ path: dbBase })
  const sixWeeksAgo = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString()
  await store.put({
    id: "memory_ranktarget",
    kind: "semantic",
    namespace: "route=/memory-chat",
    content: "acme billing escalation threshold is 500 dollars",
    data: { subject: "acme", predicate: "billing-escalation-threshold", value: "500 dollars" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: sixWeeksAgo,
    updatedAt: sixWeeksAgo,
  })

  const h = await createAgentHarness({ appRoot, route: "/memory-chat#agent" })
  try {
    // Fresh marginal distractor written through the REAL agent loop
    // (tool → validate → put → reindex), auto mode → active immediately.
    h.reset()
    await h.run({
      input: "Remember that the acme contact jordan prefers slack.",
      fixtures: script()
        .user("Remember that the acme contact jordan prefers slack.")
        .callsTool("remember", {
          data: { subject: "acme-contact", predicate: "prefers", value: "slack" },
          content: "acme contact jordan prefers slack",
        })
        .replies("Noted."),
    })

    // Recall: aimock scripts the CALL; the tool RESULT (and its ordering) is real.
    h.reset()
    const r = await h.run({
      input: "What is acme's billing escalation threshold?",
      fixtures: script()
        .user("What is acme's billing escalation threshold?")
        .callsTool("recall", { query: "acme billing escalation threshold" })
        .replies("The threshold is 500 dollars."),
    })
    const recall = r.toolResults.find((t) => t.name === "recall")
    expect(recall, "recall tool must have been executed").toBeDefined()
    const lines = String(recall?.content ?? "").split("\n")
    // Both memories share the "acme" token, so both are in the result set;
    // the SIX-WEEK-OLD relevant fact must be ranked FIRST. Pure recency
    // (the pre-ranking behavior) puts the fresh distractor first instead.
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toContain("memory_ranktarget")
  } finally {
    await h.close()
  }
}, 60_000)
```

- [ ] **Step 2: Verify it fails against pre-ranking code (sanity of the "before" claim)**

```bash
cd /Users/blove/repos/dawn
git stash  # stash nothing-or-WIP; the ranking commits are already in — so instead:
```

Skip the literal revert dance: the "fails before" property was locked in by Task 2's headline store test (same ordering logic). Just run it against the current build:

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/memory-ranking-e2e.test.ts`
Expected: PASS. (If it fails with `lines[0]` = the distractor, the ranked path is not engaged end-to-end — check that the testing package resolves the WORKSPACE `@dawn-ai/memory` build: run `pnpm build` first; the harness consumes built dist via workspace linking.)

- [ ] **Step 3: Run the neighboring memory e2es for regressions**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/memory-e2e.test.ts test/memory-index-refresh.test.ts test/memory-seed.test.ts`
Expected: PASS (their recall cases have a single matching memory — order-insensitive).

- [ ] **Step 4: Lint + commit**

```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/testing/test/memory-ranking-e2e.test.ts
git add packages/testing/test/memory-ranking-e2e.test.ts
git commit -m "test(testing): ranked-recall before/after e2e — relevance beats recency"
```

---

### Task 6: Live smoke ranking scenario (gated)

**Files:**
- Modify: `packages/testing/test/memory-live.smoke.test.ts`

- [ ] **Step 1: Add the scenario**

Append to `packages/testing/test/memory-live.smoke.test.ts` (reusing the file's existing `live`, `probeRoot`, `dbPath`, `cleanDb` helpers and its `it.skipIf(!live)` pattern):

```ts
it.skipIf(!live)(
  "ranked recall: real model finds the relevant old fact past a fresh distractor",
  async () => {
    // Seed the backdated relevant fact (remember stamps request time; age must be seeded).
    const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
    const sixWeeksAgo = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString()
    await store.put({
      id: "memory_live_ranktarget",
      kind: "semantic",
      namespace: "route=/memory-chat",
      content: "acme billing escalation threshold is 500 dollars",
      data: { subject: "acme", predicate: "billing-escalation-threshold", value: "500 dollars" },
      source: { type: "tool", id: "remember" },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: sixWeeksAgo,
      updatedAt: sixWeeksAgo,
    })

    const h = await createAgentHarness({
      appRoot: probeRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      // Real model stores a fresh marginal distractor its own way.
      await h.run({
        input:
          "Use the remember tool now. data: subject 'acme-contact', predicate 'prefers', value 'slack'.",
      })
      h.reset()
      // Natural question — covers what aimock cannot: whether the model's own
      // query phrasing is good enough for the ranker.
      const r = await h.run({
        input: "What is acme's billing escalation threshold?",
      })
      expect(r.finalMessage).toContain("500")
    } finally {
      await h.close()
    }
  },
  150_000,
)
```

- [ ] **Step 2: Verify it still SKIPS without a key (CI safety)**

Run: `env -u OPENAI_API_KEY pnpm --filter @dawn-ai/testing exec vitest run test/memory-live.smoke.test.ts`
Expected: all tests skipped (now 6 skipped).

- [ ] **Step 3: Run the full live smoke locally (gated)**

The key lives in `/Users/blove/repos/dawn/.env` — authorized for LOCAL runs only. NEVER print it, never add it to CI.

```bash
cd /Users/blove/repos/dawn
set -a; . ./.env; set +a
pnpm --filter @dawn-ai/testing exec vitest run test/memory-live.smoke.test.ts
```

Expected: 6 passed (5 existing + the new ranking scenario). If the new scenario fails, diagnose before touching assertions: check the recall tool result ordering in `r.toolResults` first (ranker vs model-phrasing issue).

- [ ] **Step 4: Lint + commit**

```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/testing/test/memory-live.smoke.test.ts
git add packages/testing/test/memory-live.smoke.test.ts
git commit -m "test(testing): gated live ranking scenario — natural query beats fresh distractor"
```

---

### Task 7: Documentation + spec amendment

**Files:**
- Modify: `apps/web/content/docs/memory.mdx`
- Modify: `docs/dev/memory-system.md` (untracked — will be added)
- Add: `docs/dev/smarter-recall-dx.md` (untracked — will be added)
- Modify: `docs/superpowers/specs/2026-07-05-smarter-recall-design.md`

- [ ] **Step 1: Update `memory.mdx`**

(a) Find the `<Callout type="info" title="Deterministic recall">` block and replace its body text with:

```text
Recall is deterministic: an IDF-weighted keyword match blended with recency and confidence, over a SQLite store — no FTS5, embedding model, or network call in the path. The same query against the same store returns the same rows in the same order, which keeps evals and fixtures stable (and replayable under aimock).
```

(b) After the paragraph documenting **`recall({ query?, kind?, tags?, limit? })`**, add a new subsection:

```mdx
### How recall ranks

Ranked recall (any call with a `query`) orders results by a weighted blend:

| Signal | Default weight | Meaning |
|---|---|---|
| Relevance | 0.6 | IDF-weighted overlap — matching rare, specific words counts far more than ubiquitous ones |
| Recency | 0.3 | Exponential decay; the boost halves every 14 days |
| Confidence | 0.1 | The `confidence` stored with the memory |

Ties break by `updatedAt` (newest first), then `id`. Query-less searches (the
injected index, `dawn memory list`) keep pure recency order.

Tune it in `dawn.config.ts` (all fields optional and defaulted):

```ts title="dawn.config.ts"
export default {
  memory: {
    recall: {
      weights: { relevance: 0.6, recency: 0.3, confidence: 0.1 },
      recencyHalfLifeMs: 14 * 24 * 60 * 60 * 1000,
      candidatePool: 256, // ranked searches score at most this many newest token-matches
    },
  },
} satisfies import("@dawn-ai/core").DawnConfig
```

<Callout type="info" title="No stemming">
  Matching is exact-token: "escalation" and "escalates" are different tokens.
  Specific, consistent wording in remembered `content` gives the ranker better
  signal — vague summaries rank vaguely.
</Callout>
```

(c) In the "What's deferred" list, remove/adjust the "importance-weighted ranking" clause (now shipped) while keeping vector/BM25-FTS5 deferred.

- [ ] **Step 2: Update `docs/dev/memory-system.md`**

- §4: replace the "`search(query)` today" steps and the "pure recency" gap paragraph with the ranked-path description (pool → live df/N stats → `scoreMemory` → sort → limit; query-less path unchanged).
- §13: move "recall ranking is pure recency" from limitations to shipped; keep vector/episodic/graph/inspector/postgres deferred.
- §14: retitle to reflect DONE and note vector recall plugs into `score.ts`.

- [ ] **Step 3: Amend the spec (eval-dogfood deferral)**

In `docs/superpowers/specs/2026-07-05-smarter-recall-design.md`, replace the `**Eval dogfood:**` bullet with:

```markdown
- **Eval dogfood: DEFERRED.** The research template ships no evals today, and
  adding `@dawn-ai/evals` to a scaffold template destabilizes the generated-app
  verify lanes (known SCAFFOLD_PACKAGES hazard). The aimock before/after e2e is
  the deterministic quality gate; a template eval can follow when the template
  grows an evals directory for other reasons.
```

- [ ] **Step 4: Docs check + commit**

```bash
cd /Users/blove/repos/dawn
node scripts/check-docs.mjs
git add apps/web/content/docs/memory.mdx docs/dev/memory-system.md docs/dev/smarter-recall-dx.md docs/superpowers/specs/2026-07-05-smarter-recall-design.md
git commit -m "docs(memory): how recall ranks + dev walkthrough/DX docs + spec amendment"
```

(`check-docs.mjs` bans certain marketing phrases in source — e.g. `byte-identical`. If it flags one of the new docs, reword.)

---

### Task 8: Changeset, full validation, PR

**Files:**
- Create: `.changeset/smarter-recall.md`

- [ ] **Step 1: Write the changeset (PATCH — fixed 0.x group; minor would bump the whole group to 1.0.0)**

Create `.changeset/smarter-recall.md`:

```markdown
---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Smarter recall: long-term-memory `recall` now ranks results by IDF-weighted
relevance blended with recency decay and stored confidence, instead of pure
recency — a six-week-old fact that actually answers the query outranks
yesterday's marginal match. Deterministic (no clock, no network, no new deps;
same store + same query → same order), zero-config (tune via
`DawnConfig.memory.recall` only if needed), and query-less searches (the
injected index, `dawn memory list`) keep their recency order.
```

- [ ] **Step 2: Full local validation**

```bash
cd /Users/blove/repos/dawn
pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

Expected: all green. Run `pnpm test` WITHOUT sourcing `.env` (a sourced OPENAI_API_KEY un-skips live smokes AND pollutes env-loading tests — known false-failure source).

- [ ] **Step 3: Commit changeset, push, open PR**

```bash
cd /Users/blove/repos/dawn
git add .changeset/smarter-recall.md
git commit -m "chore: changeset for smarter recall"
git push -u origin feat/memory-recall-ranking
gh pr create --base main --head feat/memory-recall-ranking \
  --title "feat(memory): smarter recall — IDF-weighted relevance ranking" \
  --body "$(cat <<'EOF'
## What

`recall` now ranks by relevance instead of pure recency: IDF-weighted token
overlap (0.6) + recency decay, half-life 14d (0.3) + stored confidence (0.1),
with a stable updatedAt/id tiebreak. A six-week-old fact that answers the
query outranks yesterday's marginal match.

- New pure `score.ts` in `@dawn-ai/memory` (idf + scoreMemory + options)
- Ranked path in `sqliteMemoryStore.search()` — candidate pool (256) + live
  df/N corpus stats; query-less searches (index fragment, `dawn memory list`)
  are byte-for-byte unchanged
- `MemoryQuery.now` recency reference; capability passes `context.memory.now`
  (no clock in the library — absent `now` falls back to newest candidate)
- `DawnConfig.memory.recall` tuning (weights / halfLife / candidatePool),
  threaded via `resolveMemoryStore`; custom stores unaffected
- Docs: "How recall ranks" + dev walkthrough (`docs/dev/memory-system.md`) +
  DX draft

## Proof

- `memory-ranking-e2e.test.ts` (aimock, CI-safe): relevant-but-old memory is
  the FIRST recall result past a fresh distractor written through the real
  agent loop — this test fails under pre-ranking pure-recency code.
- Store-level exact-ordering tests + pure score units (IDF dominance, decay
  half-life, clamps, tiebreaks, absent-now fallback).
- Gated live smoke extended with a natural-phrasing ranking scenario — 6/6
  locally against a real model (skips in CI, no key).

## Notes

- Deterministic end to end: no Date.now(), no network, no new dependencies.
- Spec: docs/superpowers/specs/2026-07-05-smarter-recall-design.md (template
  eval dogfood deferred — scaffold-lane hazard; noted in spec).
- Patch changeset (fixed 0.x group).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Auto-merge + verify**

```bash
gh pr merge --squash --auto
gh pr checks --watch
```

Expected: validate/CodeQL/review/changesets all green → auto-merges.

---

## Self-review notes (done at plan time)

- **Spec coverage:** score module (T1), ranked path + pool + stats + query-less preservation (T2), `now` plumbing both type layers + capability (T3), config threading (T4), aimock before/after e2e (T5), live scenario (T6), docs + spec amendment (T7), patch changeset (T8). Eval-dogfood consciously deferred with spec amendment (T7). ✓
- **Type consistency:** `RecallRankingOptions`/`scoreMemory` signature identical across T1 (definition), T2 (store usage), T3/T4 (structural config mirror). `MemoryQuery.now` (memory) ↔ `search(q).now` (core structural) both optional strings. ✓
- **Known trap flags embedded:** bare-biome ban, patch-not-minor changeset, `.env` pollution of `pnpm test`, `check-docs.mjs` banned phrases, workspace build before harness e2e.
