# Vector / Semantic Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in hybrid (keyword + vector) recall to long-term memory per the approved spec `docs/superpowers/specs/2026-07-06-vector-recall-design.md` — keyword co-equal with vector, fused by RRF, with a bounded recency/confidence second stage.

**Architecture:** Two orthogonal pluggable axes — a pluggable `Embedder` (`openaiEmbedder` + `fakeEmbedder`) and the existing pluggable `MemoryStore`. `@dawn-ai/memory` stays zero-dep: new pure `cosineSimilarity` + `fuseRRF`, and a hybrid `search()` path gated on `q.queryEmbedding` (vector-off behavior is byte-for-byte unchanged). The capability embeds writes and queries via the configured embedder; embeddings are stored as Float32 BLOBs tagged by embedder id.

**Tech Stack:** TypeScript, `node:sqlite` (BLOB storage, brute-force cosine in JS), vitest, aimock (`@copilotkit/aimock`, ships `/v1/embeddings`). No new native deps. Branch: `feat/memory-vector-recall` (created off origin/main; spec committed).

**Working directory:** `/Users/blove/repos/dawn` (primary checkout, on the branch). Every Bash command starts `cd /Users/blove/repos/dawn`.

**Guardrails (every subagent, every task):**
- BRANCH PIN: before ANY commit, `git rev-parse --abbrev-ref HEAD` MUST print `feat/memory-vector-recall`; else STOP + report BLOCKED. Never switch branches, never commit detached.
- LINT: only `pnpm exec biome check --config-path packages/config-biome/biome.json <files>` (scoped `--write` on touched files OK). NEVER bare `biome check --write`. Style: no semicolons, 2-space, double quotes.
- Determinism: no `Date.now()`/argless `new Date()` in `packages/*/src` (tests may use them). Pure functions stay pure.
- `pnpm test` runs in a CLEAN shell — do NOT source `.env` (pollutes env-loading tests + un-skips live smokes).
- `.env` (`OPENAI_API_KEY`) is LOCAL-only for the gated live smoke; never print, never CI.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/memory/src/vector.ts` (create) | Pure `cosineSimilarity`, `fuseRRF`, `RankedList` type + defaults |
| `packages/memory/src/score.ts` (modify) | Extract + export `recencyDecay` (reused by hybrid second stage) |
| `packages/memory/src/types.ts` (modify) | `MemoryQuery` vector fields; `MemoryStore.put` opts |
| `packages/memory/src/sqlite-store.ts` (modify) | Migration v2 (embedding cols); `put` opts; hybrid `search()` path |
| `packages/memory/src/index.ts` (modify) | Barrel: vector fns, `recencyDecay`, `VectorRankingOptions` |
| `packages/memory/test/vector.test.ts` (create) | cosine + RRF units |
| `packages/memory/test/sqlite-store.test.ts` (modify) | Injected-vector hybrid ordering tests |
| `packages/core/src/capabilities/types.ts` (modify) | `Embedder` type; widen `MemoryStoreLike`; `MemoryContext.embedder` |
| `packages/core/src/types.ts` (modify) | `DawnConfig.memory.vector` |
| `packages/core/src/index.ts` (modify) | Export `Embedder` |
| `packages/core/src/capabilities/built-in/memory.ts` (modify) | Embed query on recall, embed content on remember |
| `packages/core/test/memory-capability-vector.test.ts` (create) | Capability embeds writes+queries (fake store+embedder) |
| `packages/langchain/src/openai-embedder.ts` (create) | `openaiEmbedder()` via `OpenAIEmbeddings` + `OPENAI_BASE_URL` |
| `packages/langchain/src/index.ts` (modify) | Export `openaiEmbedder` |
| `packages/langchain/test/openai-embedder.test.ts` (create) | Contract test vs aimock `/v1/embeddings` |
| `packages/testing/src/fake-embedder.ts` (create) | Deterministic hash `fakeEmbedder` |
| `packages/testing/src/memory.ts` (modify) | `seedMemory` accepts `embedding`/`embeddingModel` |
| `packages/testing/src/index.ts` (modify) | Export `fakeEmbedder` |
| `packages/cli/src/lib/runtime/resolve-memory.ts` (modify) | Thread `vector` tuning into store; resolve embedder into context |
| `packages/cli/src/lib/runtime/execute-route.ts` (modify) | Pass embedder to `buildMemoryContext` |
| `packages/testing/test/memory-vector-e2e.test.ts` (create) | aimock fake-embedder full-wiring e2e |
| `packages/testing/test/memory-live.smoke.test.ts` (modify) | Gated real-embedding paraphrase scenario |
| `apps/web/content/docs/memory.mdx` + `docs/dev/memory-system.md` (modify) | Vector recall docs |
| `.changeset/vector-recall.md` (create) | patch: memory, core, cli, langchain, testing |

---

### Task 1: Pure `cosineSimilarity` + `fuseRRF`

**Files:** Create `packages/memory/src/vector.ts`, `packages/memory/test/vector.test.ts`; modify `packages/memory/src/index.ts`.

- [ ] **Step 1: Write failing tests** — `packages/memory/test/vector.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { cosineSimilarity, DEFAULT_RRF_K, fuseRRF } from "../src/vector.js"

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, ~0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1, 10)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 10)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1, 10)
  })
  it("returns 0 when either vector has zero norm (no NaN)", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })
  it("returns 0 on length mismatch rather than throwing", () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2]))).toBe(0)
  })
})

describe("fuseRRF", () => {
  it("co-equal fusion: an item ranked high in BOTH lists beats items in one", () => {
    const scores = fuseRRF([{ ids: ["a", "b", "c"] }, { ids: ["b", "a", "d"] }])
    // b: 1/(60+2)+1/(60+1); a: 1/(60+1)+1/(60+2) — equal; both beat c and d (one list only)
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!, 12)
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!)
    expect(scores.get("d")!).toBeGreaterThan(0)
    expect(scores.get("c")! < scores.get("a")!).toBe(true)
  })
  it("an item present in only one list still gets a positive score", () => {
    const scores = fuseRRF([{ ids: ["x"] }, { ids: ["y"] }])
    expect(scores.get("x")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
    expect(scores.get("y")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
  })
  it("per-list weights bias the fusion", () => {
    const scores = fuseRRF([
      { ids: ["a", "b"], weight: 2 },
      { ids: ["b", "a"], weight: 1 },
    ])
    // a: 2/(61)+1/(62); b: 2/(62)+1/(61) — a should edge b due to weight on list 1's top
    expect(scores.get("a")! > scores.get("b")!).toBe(true)
  })
  it("smaller k separates top ranks more (larger score gap)", () => {
    const gapSmallK = fuseRRF([{ ids: ["a", "b"] }], { k: 1 })
    expect(gapSmallK.get("a")! - gapSmallK.get("b")!).toBeGreaterThan(
      fuseRRF([{ ids: ["a", "b"] }], { k: 1000 }).get("a")! -
        fuseRRF([{ ids: ["a", "b"] }], { k: 1000 }).get("b")!,
    )
  })
  it("non-positive/non-finite k falls back to the default", () => {
    expect(fuseRRF([{ ids: ["a"] }], { k: 0 }).get("a")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
    expect(fuseRRF([{ ids: ["a"] }], { k: -5 }).get("a")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
  })
})
```

- [ ] **Step 2: Run — expect fail** (`Cannot find module '../src/vector.js'`):
  `pnpm --filter @dawn-ai/memory exec vitest run test/vector.test.ts`

- [ ] **Step 3: Implement** — `packages/memory/src/vector.ts`:

```ts
// Pure vector-recall primitives — no I/O, no clock, no randomness. Deterministic
// so aimock fixtures and eval replays stay stable. See
// docs/superpowers/specs/2026-07-06-vector-recall-design.md.

export const DEFAULT_RRF_K = 60
export const DEFAULT_VECTOR_K = 64

export interface RankedList {
  /** Ids ordered best → worst. Rank is the 1-based index. */
  readonly ids: readonly string[]
  /** Per-list weight in the fusion; default 1 (co-equal). */
  readonly weight?: number
}

/** Raw cosine similarity in [-1, 1]. Zero-norm or length-mismatch → 0 (never NaN/throw). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Reciprocal Rank Fusion. score(id) = Σ_lists weight / (k + rank). An id absent
 * from a list contributes 0 (RRF subsumes the union of the lists). Rank-based, so
 * it is immune to the score-scale incompatibility between IDF and cosine.
 */
export function fuseRRF(
  lists: readonly RankedList[],
  opts?: { readonly k?: number },
): Map<string, number> {
  const rawK = opts?.k
  const k = typeof rawK === "number" && Number.isFinite(rawK) && rawK > 0 ? rawK : DEFAULT_RRF_K
  const out = new Map<string, number>()
  for (const list of lists) {
    const w = typeof list.weight === "number" && Number.isFinite(list.weight) ? list.weight : 1
    for (let i = 0; i < list.ids.length; i++) {
      const id = list.ids[i] as string
      out.set(id, (out.get(id) ?? 0) + w / (k + (i + 1)))
    }
  }
  return out
}
```

- [ ] **Step 4: Barrel** — add to `packages/memory/src/index.ts`:

```ts
export {
  cosineSimilarity,
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_K,
  fuseRRF,
  type RankedList,
} from "./vector.js"
```

- [ ] **Step 5: Run — expect pass**, then whole package:
  `pnpm --filter @dawn-ai/memory test` (expect all green, +5 vector tests)

- [ ] **Step 6: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/memory/src/vector.ts packages/memory/src/index.ts packages/memory/test/vector.test.ts
git add packages/memory/src/vector.ts packages/memory/src/index.ts packages/memory/test/vector.test.ts
git commit -m "feat(memory): pure cosineSimilarity + RRF fusion primitives"
```

---

### Task 2: Extract + export `recencyDecay`

**Files:** modify `packages/memory/src/score.ts`, `packages/memory/src/index.ts`; the shipped `score.test.ts` is the regression guard.

Rationale: the hybrid second stage needs the same recency decay `scoreMemory` uses. Extract it so there is ONE implementation.

- [ ] **Step 1: Read `score.ts`** — find the inline recency computation inside `scoreMemory` (the `2 ** (-ageMs / halfLife)` block after `parseMs`).

- [ ] **Step 2: Add the exported helper** to `packages/memory/src/score.ts` (above `scoreMemory`):

```ts
/**
 * Exponential recency decay in (0, 1]. age = referenceMs − updatedMs, clamped ≥ 0;
 * invalid/absent timestamps degrade to age 0 (decay 1). Non-positive/non-finite
 * halfLife falls back to the default.
 */
export function recencyDecay(updatedAt: string, referenceNow: string, halfLifeMs?: number): number {
  const hl =
    typeof halfLifeMs === "number" && Number.isFinite(halfLifeMs) && halfLifeMs > 0
      ? halfLifeMs
      : DEFAULT_RECENCY_HALF_LIFE_MS
  const ref = Date.parse(referenceNow)
  const upd = Date.parse(updatedAt)
  const ageMs = Number.isNaN(ref) || Number.isNaN(upd) ? 0 : Math.max(0, ref - upd)
  return 2 ** (-ageMs / hl)
}
```

- [ ] **Step 3: Refactor `scoreMemory`** to call `recencyDecay(args.updatedAt, args.referenceNow, args.options?.recencyHalfLifeMs)` in place of its inline block (behavior identical). Keep everything else unchanged.

- [ ] **Step 4: Export** — add `recencyDecay` to the `score.js` export block in `packages/memory/src/index.ts`.

- [ ] **Step 5: Run — the SHIPPED score tests must still pass** (they guard the refactor):
  `pnpm --filter @dawn-ai/memory test` (expect all green, unchanged count + Task 1)

- [ ] **Step 6: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/memory/src/score.ts packages/memory/src/index.ts
git add packages/memory/src/score.ts packages/memory/src/index.ts
git commit -m "refactor(memory): extract exported recencyDecay for reuse in hybrid recall"
```

---

### Task 3: Store — migration v2, `put` embeddings, hybrid `search()`

**Files:** modify `packages/memory/src/types.ts`, `packages/memory/src/sqlite-store.ts`, `packages/memory/test/sqlite-store.test.ts`.

- [ ] **Step 1: Widen types** — in `packages/memory/src/types.ts`:

Add to `MemoryQuery` (after `now?`):
```ts
  /** When present, the store runs the hybrid path: keyword ∪ vector-nearest, RRF-fused. */
  readonly queryEmbedding?: Float32Array
  /** Only rows whose stored embedding_model equals this are vector-compared. */
  readonly embedderId?: string
  /** Hybrid tuning; all fields defaulted. */
  readonly vector?: VectorRankingOptions
```
Add the type + change `MemoryStore.put`:
```ts
export interface VectorRankingOptions {
  readonly weights?: { readonly keyword?: number; readonly vector?: number }
  readonly rrfK?: number
  readonly vectorK?: number
  readonly recencyWeight?: number
  readonly confidenceWeight?: number
  readonly recencyHalfLifeMs?: number
}
export interface MemoryStore {
  put(
    rec: MemoryRecord,
    opts?: { readonly embedding?: Float32Array; readonly embeddingModel?: string },
  ): Promise<void>
  // ...rest unchanged...
}
```
Export `VectorRankingOptions` from `index.ts` barrel (types block).

- [ ] **Step 2: Write failing store tests** — append to `packages/memory/test/sqlite-store.test.ts` (reuse the existing `rec()` helper; add a vector helper):

```ts
  // --- vector / hybrid recall ---
  const EM = "fake:test" // embedder id tag used by these tests
  function vec(...xs: number[]) {
    return new Float32Array(xs)
  }

  it("hybrid: a semantic-only match (0 shared words) is recalled via the vector list", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    // "delivery" query will share NO tokens with this content, but its vector is near.
    await s.put(
      rec({ id: "sem", namespace: "ns", content: "faster shipping preferred", updatedAt: "2026-07-01T00:00:00.000Z" }),
      { embedding: vec(1, 0, 0), embeddingModel: EM },
    )
    await s.put(
      rec({ id: "kw", namespace: "ns", content: "acme billing threshold", updatedAt: "2026-07-01T00:00:00.000Z" }),
      { embedding: vec(0, 1, 0), embeddingModel: EM },
    )
    const out = await s.search({
      namespace: "ns",
      query: "expedite delivery", // shares no tokens with "sem"
      queryEmbedding: vec(0.95, 0.05, 0),
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    })
    // "sem" enters ONLY via the vector list (no keyword overlap) and must be recalled.
    expect(out.map((r) => r.id)).toContain("sem")
    expect(out[0]?.id).toBe("sem")
  })

  it("hybrid: an exact keyword hit still ranks even with a poor vector", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({ id: "exact", namespace: "ns", content: "order ALPHA-111 status shipped", updatedAt: "2026-07-01T00:00:00.000Z" }),
      { embedding: vec(0, 0, 1), embeddingModel: EM },
    )
    await s.put(
      rec({ id: "near", namespace: "ns", content: "delivery timing note", updatedAt: "2026-07-01T00:00:00.000Z" }),
      { embedding: vec(1, 0, 0), embeddingModel: EM },
    )
    const out = await s.search({
      namespace: "ns",
      query: "ALPHA-111", // exact token only "exact" has
      queryEmbedding: vec(0.9, 0.1, 0), // vector-near "near", far from "exact"
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    })
    // Co-equal RRF: the exact keyword match is present and must be recalled (not buried).
    expect(out.map((r) => r.id)).toContain("exact")
  })

  it("hybrid: rows with a mismatched embedder tag are ignored by the vector list", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({ id: "stale", namespace: "ns", content: "faster shipping", updatedAt: "2026-07-01T00:00:00.000Z" }),
      { embedding: vec(1, 0, 0), embeddingModel: "old:model" }, // different embedder
    )
    const out = await s.search({
      namespace: "ns",
      query: "expedite delivery",
      queryEmbedding: vec(1, 0, 0),
      embedderId: EM, // does not match "old:model"
      now: "2026-07-05T00:00:00.000Z",
    })
    // No keyword overlap AND embedder mismatch → "stale" is not vector-eligible → not recalled.
    expect(out.map((r) => r.id)).not.toContain("stale")
  })

  it("no queryEmbedding → keyword path unchanged (vector columns ignored)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns", content: "billing threshold" }), {
      embedding: vec(1, 0, 0),
      embeddingModel: EM,
    })
    const out = await s.search({ namespace: "ns", query: "billing threshold", now: "2026-07-05T00:00:00.000Z" })
    expect(out.map((r) => r.id)).toEqual(["a"]) // pure keyword path still works with embeddings present
  })

  it("put without embedding opts persists a keyword-only row (back-compat)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns", content: "billing threshold" })) // no opts
    expect((await s.search({ namespace: "ns", query: "billing" })).map((r) => r.id)).toEqual(["a"])
  })
```

- [ ] **Step 3: Run — expect the hybrid tests fail** (queryEmbedding ignored today; `sem`/`exact` not recalled):
  `pnpm --filter @dawn-ai/memory exec vitest run test/sqlite-store.test.ts`

- [ ] **Step 4: Implement — migration v2** in `packages/memory/src/sqlite-store.ts`, append to `MIGRATIONS`:

```ts
  {
    version: 2,
    up: `
      ALTER TABLE memories ADD COLUMN embedding BLOB;
      ALTER TABLE memories ADD COLUMN embedding_model TEXT;
    `,
  },
```

- [ ] **Step 5: Implement — `put` opts + persist embedding.** Change `putRecord` to take an optional embedding, and the `put` method to forward opts. Replace `putRecord` signature/body’s INSERT to include the two columns:

```ts
  function putRecord(
    rec: MemoryRecord,
    embed?: { embedding?: Float32Array; embeddingModel?: string },
  ): void {
    const blob =
      embed?.embedding && embed.embeddingModel ? Buffer.from(embed.embedding.buffer.slice(0)) : null
    const model = embed?.embedding && embed.embeddingModel ? embed.embeddingModel : null
    db.prepare(
      `INSERT OR REPLACE INTO memories
       (id,kind,namespace,content,data,source,confidence,tags,status,supersedes,created_at,updated_at,effective_at,expires_at,embedding,embedding_model)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      rec.id, rec.kind, rec.namespace, rec.content, JSON.stringify(rec.data),
      JSON.stringify(rec.source), rec.confidence, JSON.stringify(rec.tags), rec.status,
      rec.supersedes ? JSON.stringify(rec.supersedes) : null,
      rec.createdAt, rec.updatedAt, rec.effectiveAt ?? null, rec.expiresAt ?? null,
      blob, model,
    )
    reindex(rec)
  }
```
And the `put` method:
```ts
    async put(rec, opts) {
      putRecord(rec, opts)
    },
```
Note: `update`/`supersede` call `putRecord(...)` with no embedding — that DROPS the embedding on update. To preserve it, `update` should re-read the existing embedding. Add a helper `getEmbeddingRow(id)` and have `update` pass it through:
```ts
  function getEmbeddingRow(id: string): { embedding?: Float32Array; embeddingModel?: string } {
    const row = db.prepare("SELECT embedding, embedding_model FROM memories WHERE id = ?").get(id) as
      | { embedding?: Uint8Array; embedding_model?: string }
      | undefined
    if (row?.embedding && row.embedding_model) {
      return {
        embedding: new Float32Array(
          row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
        ),
        embeddingModel: row.embedding_model,
      }
    }
    return {}
  }
```
In `update`: `putRecord({ ...current, ...patch, id }, getEmbeddingRow(id))`.

- [ ] **Step 6: Implement — hybrid path in `search()`.** After the query-less early return and BEFORE the existing ranked path, insert the hybrid gate. Import the new helpers at top:
```ts
import { DEFAULT_CANDIDATE_POOL, recencyDecay, type RecallRankingOptions, scoreMemory } from "./score.js"
import { cosineSimilarity, DEFAULT_VECTOR_K, fuseRRF } from "./vector.js"
```
Then, inside `search`, after `if (terms.length === 0) { ... }` and before `// Ranked path`:
```ts
      // Hybrid path — active only when the caller supplies a query embedding.
      if (q.queryEmbedding && q.embedderId) {
        const v = q.vector ?? {}
        const vectorK =
          typeof v.vectorK === "number" && Number.isFinite(v.vectorK) && v.vectorK > 0
            ? Math.floor(v.vectorK)
            : DEFAULT_VECTOR_K
        const wKeyword = typeof v.weights?.keyword === "number" ? v.weights.keyword : 1
        const wVector = typeof v.weights?.vector === "number" ? v.weights.vector : 1

        // Keyword-ranked ids: reuse the ranked candidate pool, ordered by relevance ONLY.
        const kwRecords = rankKeyword(q, baseSql, baseParams, terms, { relevance: 1, recency: 0, confidence: 0 })
        const keywordIds = kwRecords.map((r) => r.id)

        // Vector-ranked ids: brute-force cosine over rows with a matching embedder tag.
        const vecRows = db
          .prepare(
            `SELECT m.id AS id, m.embedding AS embedding FROM memories m
             WHERE ${baseSql} AND m.embedding_model = ? AND m.embedding IS NOT NULL`,
          )
          .all(...baseParams, q.embedderId) as { id: string; embedding: Uint8Array }[]
        const scoredVec = vecRows
          .map((r) => {
            const emb = new Float32Array(
              r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength),
            )
            return { id: r.id, sim: cosineSimilarity(q.queryEmbedding as Float32Array, emb) }
          })
          .sort((a, b) => b.sim - a.sim || cmp(a.id, b.id))
          .slice(0, vectorK)
        const vectorIds = scoredVec.map((r) => r.id)

        // Union pool of records (dedup by id) for the second stage.
        const byId = new Map<string, MemoryRecord>()
        for (const r of kwRecords) byId.set(r.id, r)
        for (const r of vectorIds) if (!byId.has(r)) byId.set(r, getById(r) as MemoryRecord)
        if (byId.size === 0) return []

        const rrf = fuseRRF(
          [
            { ids: keywordIds, weight: wKeyword },
            { ids: vectorIds, weight: wVector },
          ],
          { k: v.rrfK },
        )

        const wRec = typeof v.recencyWeight === "number" ? v.recencyWeight : 0.3
        const wConf = typeof v.confidenceWeight === "number" ? v.confidenceWeight : 0.1
        const referenceNow = q.now ?? [...byId.values()][0]?.updatedAt ?? ""
        const fused = [...byId.values()].map((record) => {
          const base = rrf.get(record.id) ?? 0
          const rec2 = recencyDecay(record.updatedAt, referenceNow, v.recencyHalfLifeMs)
          const conf = record.confidence < 0 ? 0 : record.confidence > 1 ? 1 : record.confidence
          return { record, score: base * (1 + wRec * rec2 + wConf * conf) }
        })
        fused.sort(
          (a, b) =>
            b.score - a.score ||
            cmp(b.record.updatedAt, a.record.updatedAt) ||
            cmp(a.record.id, b.record.id),
        )
        let records = fused.slice(0, limit).map((s) => s.record)
        if (q.tags && q.tags.length > 0) {
          const want = new Set(q.tags)
          records = records.filter((r) => r.tags.some((t) => want.has(t)))
        }
        return records
      }
```
Extract the existing keyword candidate-pool+score logic into a reusable `rankKeyword(q, baseSql, baseParams, terms, weightsOverride?)` local function that RETURNS the sorted `MemoryRecord[]` (pool → df/N stats → scoreMemory with the given weights → sort). The existing ranked path (below the hybrid gate) then becomes `return pageAndTagFilter(rankKeyword(q, baseSql, baseParams, terms), limit, q)`. Keep the query-less path exactly as is. (Refactor carefully — the shipped smarter-recall tests are the guard.)

- [ ] **Step 7: Run — all green** (`pnpm --filter @dawn-ai/memory test`), and verify the SHIPPED smarter-recall ordering tests still pass (they exercise `rankKeyword` via the non-hybrid path).

- [ ] **Step 8: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/memory/src packages/memory/test
git add packages/memory/src packages/memory/test
git commit -m "feat(memory): hybrid recall — embedding storage + RRF fusion in sqlite store"
```

---

### Task 4: Core — `Embedder` type, widen `MemoryStoreLike`, `DawnConfig.memory.vector`

**Files:** modify `packages/core/src/capabilities/types.ts`, `packages/core/src/types.ts`, `packages/core/src/index.ts`.

- [ ] **Step 1:** In `packages/core/src/capabilities/types.ts` add the `Embedder` interface and widen `MemoryStoreLike` + `MemoryContext`:
```ts
export interface Embedder {
  readonly id: string
  readonly dims: number
  embed(texts: readonly string[]): Promise<Float32Array[]>
}
```
Widen `MemoryStoreLike.put` and `.search` (additive):
```ts
  put(
    rec: MemoryRecordLike,
    opts?: { embedding?: Float32Array; embeddingModel?: string },
  ): Promise<void>
  search(q: {
    namespace: string
    query?: string
    kind?: string
    tags?: readonly string[]
    status?: string
    limit?: number
    now?: string
    queryEmbedding?: Float32Array
    embedderId?: string
    vector?: unknown // structural; the store validates
  }): Promise<readonly MemoryRecordLike[]>
```
Add to `MemoryContext`:
```ts
  /** The resolved embedder when vector recall is enabled; the capability embeds
   *  writes + queries through it. Absent → keyword-only. */
  readonly embedder?: Embedder
```

- [ ] **Step 2:** In `packages/core/src/types.ts`, add to `DawnConfig.memory` (after `recall`):
```ts
    /** Opt-in vector/semantic recall. Presence of `embedder` enables it; absent
     *  → keyword-only (unchanged). Ignored when a custom `store` is supplied. */
    readonly vector?: {
      readonly embedder: import("./capabilities/types.js").Embedder
      readonly weights?: { readonly keyword?: number; readonly vector?: number }
      readonly rrfK?: number
      readonly vectorK?: number
      readonly recencyWeight?: number
      readonly confidenceWeight?: number
    }
```

- [ ] **Step 3:** Export `Embedder` from `packages/core/src/index.ts` (the capabilities/types export block that already exports `MemoryContext`/`MemoryStoreLike`).

- [ ] **Step 4:** `pnpm --filter @dawn-ai/core typecheck` — clean. `pnpm --filter @dawn-ai/core test` — unchanged green (additive optional fields break nothing).

- [ ] **Step 5: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/core/src/capabilities/types.ts packages/core/src/types.ts packages/core/src/index.ts
git add packages/core/src/capabilities/types.ts packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat(core): Embedder type, DawnConfig.memory.vector, widened MemoryStoreLike"
```

---

### Task 5: `openaiEmbedder` (@dawn-ai/langchain)

**Files:** create `packages/langchain/src/openai-embedder.ts`; modify `packages/langchain/src/index.ts`.

- [ ] **Step 1:** Create `packages/langchain/src/openai-embedder.ts` — lazily imports `OpenAIEmbeddings` from `@langchain/openai` (already a dep) and honors `OPENAI_BASE_URL` so aimock intercepts it:
```ts
import type { Embedder } from "@dawn-ai/core"

const DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
}

/** OpenAI embedder over the shared OPENAI_BASE_URL seam (aimock-mockable). */
export function openaiEmbedder(opts?: {
  readonly model?: string
  readonly importer?: (s: string) => Promise<Record<string, unknown>>
}): Embedder {
  const model = opts?.model ?? "text-embedding-3-small"
  const importer =
    opts?.importer ?? ((s: string) => import(s) as Promise<Record<string, unknown>>)
  let clientP: Promise<{ embedDocuments(t: string[]): Promise<number[][]> }> | undefined
  async function client() {
    if (!clientP) {
      clientP = importer("@langchain/openai").then((m) => {
        const Ctor = m.OpenAIEmbeddings as new (o: Record<string, unknown>) => {
          embedDocuments(t: string[]): Promise<number[][]>
        }
        const baseURL = process.env.OPENAI_BASE_URL
        return new Ctor({
          model,
          ...(baseURL ? { configuration: { baseURL } } : {}),
        })
      })
    }
    return clientP
  }
  return {
    id: `openai:${model}`,
    dims: DIMS[model] ?? 1536,
    async embed(texts) {
      if (texts.length === 0) return []
      const c = await client()
      const raw = await c.embedDocuments([...texts])
      return raw.map((v) => Float32Array.from(v))
    },
  }
}
```

- [ ] **Step 2:** Export from `packages/langchain/src/index.ts`: `export { openaiEmbedder } from "./openai-embedder.js"`.

- [ ] **Step 3:** `pnpm --filter @dawn-ai/langchain typecheck` — clean. (Contract test is Task 9.)

- [ ] **Step 4: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/langchain/src/openai-embedder.ts packages/langchain/src/index.ts
git add packages/langchain/src/openai-embedder.ts packages/langchain/src/index.ts
git commit -m "feat(langchain): openaiEmbedder over the OPENAI_BASE_URL seam"
```

---

### Task 6: `fakeEmbedder` + `seedMemory` vector support (@dawn-ai/testing)

**Files:** create `packages/testing/src/fake-embedder.ts`; modify `packages/testing/src/memory.ts`, `packages/testing/src/index.ts`; test in the package’s existing test dir.

- [ ] **Step 1: Write failing test** — `packages/testing/test/fake-embedder.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { fakeEmbedder } from "../src/fake-embedder.js"

describe("fakeEmbedder", () => {
  it("is deterministic and unit-length per text", async () => {
    const e = fakeEmbedder({ dims: 8 })
    const [a1] = await e.embed(["hello world"])
    const [a2] = await e.embed(["hello world"])
    expect([...a1!]).toEqual([...a2!]) // deterministic
    const norm = Math.sqrt([...a1!].reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 6) // normalized
  })
  it("similar strings are nearer than dissimilar ones (cosine)", async () => {
    const e = fakeEmbedder({ dims: 64 })
    const [a] = await e.embed(["faster shipping"])
    const [b] = await e.embed(["faster shipping now"]) // shares tokens
    const [c] = await e.embed(["quarterly tax filing"]) // unrelated
    const cos = (x: Float32Array, y: Float32Array) =>
      [...x].reduce((s, xi, i) => s + xi * (y[i] as number), 0)
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!))
  })
})
```
Note: for "similar nearer" to hold, make the fake embedding a normalized **bag-of-token-hash** vector (shared tokens → overlapping dimensions → higher cosine), not a whole-string hash.

- [ ] **Step 2: Run — expect fail.** `pnpm --filter @dawn-ai/testing exec vitest run test/fake-embedder.test.ts`

- [ ] **Step 3: Implement** — `packages/testing/src/fake-embedder.ts`:
```ts
import type { Embedder } from "@dawn-ai/core"

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Deterministic, network-free embedder for tests: a normalized bag-of-token-hash
 * vector, so strings sharing tokens are nearer in cosine. NOT for production.
 */
export function fakeEmbedder(opts?: { readonly dims?: number }): Embedder {
  const dims = opts?.dims ?? 64
  return {
    id: `fake:${dims}`,
    dims,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dims)
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1)) {
          v[hash(tok) % dims] += 1
        }
        let n = 0
        for (const x of v) n += x * x
        n = Math.sqrt(n) || 1
        for (let i = 0; i < dims; i++) v[i] = (v[i] as number) / n
        return v
      })
    },
  }
}
```

- [ ] **Step 4: `seedMemory` embeddings** — in `packages/testing/src/memory.ts`, extend `SeedInput` and the `put` call to forward embeddings:
```ts
type SeedInput = Partial<MemoryRecord> &
  Pick<MemoryRecord, "id" | "namespace" | "content"> & {
    embedding?: Float32Array
    embeddingModel?: string
  }
// ...in the loop:
    const { embedding, embeddingModel, ...record } = r
    await store.put(
      { kind: "semantic", data: {}, source: { type: "eval", id: "seed" }, confidence: 1, tags: [], status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...record },
      embedding && embeddingModel ? { embedding, embeddingModel } : undefined,
    )
```

- [ ] **Step 5: Export** `fakeEmbedder` from `packages/testing/src/index.ts`.

- [ ] **Step 6: Run — green.** `pnpm --filter @dawn-ai/testing exec vitest run test/fake-embedder.test.ts` + `pnpm --filter @dawn-ai/testing exec vitest run test/memory-seed.test.ts`

- [ ] **Step 7: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/testing/src/fake-embedder.ts packages/testing/src/memory.ts packages/testing/src/index.ts packages/testing/test/fake-embedder.test.ts
git add packages/testing/src/fake-embedder.ts packages/testing/src/memory.ts packages/testing/src/index.ts packages/testing/test/fake-embedder.test.ts
git commit -m "feat(testing): deterministic fakeEmbedder + seedMemory vector support"
```

---

### Task 7: Capability embeds writes + queries; CLI threads vector config

**Files:** modify `packages/core/src/capabilities/built-in/memory.ts`, `packages/cli/src/lib/runtime/resolve-memory.ts`, `packages/cli/src/lib/runtime/execute-route.ts`; test `packages/core/test/memory-capability-vector.test.ts`.

- [ ] **Step 1: Write failing capability test** — `packages/core/test/memory-capability-vector.test.ts` builds a `MemoryContext` with a fake embedder + a capturing store, runs the recall tool, asserts the store received a `queryEmbedding` + `embedderId`; runs remember (auto), asserts the store’s `put` received an `embedding`+`embeddingModel`. (Mirror the existing `memory-capability-recall.test.ts` construction; add `embedder` to the context.)

- [ ] **Step 2: Run — expect fail** (capability doesn’t embed yet).

- [ ] **Step 3: Recall embeds the query** — in `packages/core/src/capabilities/built-in/memory.ts` recall `run`, before the search, when `mem.embedder` present, embed and pass through (embed failure → keyword-only, never throw):
```ts
          let queryVec: Float32Array | undefined
          if (mem.embedder && q.query) {
            try {
              ;[queryVec] = await mem.embedder.embed([q.query])
            } catch {
              queryVec = undefined // fall back to keyword-only
            }
          }
          const rows = await mem.store.search({
            namespace: mem.namespace,
            ...(q.query ? { query: q.query } : {}),
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.tags ? { tags: q.tags } : {}),
            limit: q.limit ?? 8,
            now: mem.now,
            ...(queryVec && mem.embedder ? { queryEmbedding: queryVec, embedderId: mem.embedder.id, vector: mem.vector } : {}),
          })
```
(Add `readonly vector?: unknown` + `readonly embedder?: Embedder` already on `MemoryContext`; thread `mem.vector` = the tuning object — see Step 5.)

- [ ] **Step 4: Remember embeds content** — in the remember `run`, compute `content` (already exists), then embed before each `mem.store.put(record)` when `mem.embedder` present (embed failure → store keyword-only):
```ts
          let putOpts: { embedding?: Float32Array; embeddingModel?: string } | undefined
          if (mem.embedder) {
            try {
              const [ev] = await mem.embedder.embed([content])
              if (ev) putOpts = { embedding: ev, embeddingModel: mem.embedder.id }
            } catch {
              putOpts = undefined // persist keyword-only
            }
          }
          // ...at each put site:
          await mem.store.put(record, putOpts)
```
Apply to ALL `mem.store.put(record)` sites in remember (there are the auto add + supersede paths + candidate path).

- [ ] **Step 5: MemoryContext carries embedder + tuning** — add to `MemoryContext` (core types, Task 4 added `embedder`; also add `readonly vector?: import("./types.js")...`). Simplify: add `readonly vector?: { weights?; rrfK?; vectorK?; recencyWeight?; confidenceWeight? }` to `MemoryContext`. Then in `buildMemoryContext` (`resolve-memory.ts`) accept `embedder?` + `vector?` args and set them; in `execute-route.ts` pass `embedder: loadedDawnConfig?.memory?.vector?.embedder` and `vector: <tuning>` when present.

- [ ] **Step 6: `resolveMemoryStore` threads store tuning** — pass `vector` tuning into `sqliteMemoryStore` (NOT the embedder — the store never embeds):
```ts
    recall = loaded.config.memory?.recall
    const vectorCfg = loaded.config.memory?.vector
    // store needs only tuning, not the embedder:
    if (vectorCfg) storeVector = { weights: vectorCfg.weights, rrfK: vectorCfg.rrfK, vectorK: vectorCfg.vectorK, recencyWeight: vectorCfg.recencyWeight, confidenceWeight: vectorCfg.confidenceWeight }
```
Then `sqliteMemoryStore({ path, ...(recall?{recall}:{}), ...(storeVector?{vector:storeVector}:{}) })`. NOTE: `sqliteMemoryStore` currently takes only `{path, recall}` — add an optional `vector?: VectorRankingOptions` to its opts and pass it as the DEFAULT tuning for `search` when the query omits `q.vector`. (In Step 3 of Task 3 the search reads `q.vector`; make the store fall back to `opts.vector` when `q.vector` is undefined.)

- [ ] **Step 7: Run** — `pnpm --filter @dawn-ai/core test` + `pnpm --filter @dawn-ai/cli exec vitest run test/resolve-memory.test.ts test/build-memory-context.test.ts` (all green; adjust `build-memory-context` if it asserts the exact context shape).

- [ ] **Step 8: Lint + commit** (scoped biome over the 3 files + test); commit `feat(core+cli): capability embeds recall query + remember content; thread vector config`.

---

### Task 8: aimock fake-embedder e2e

**Files:** create `packages/testing/test/memory-vector-e2e.test.ts`. Model: `packages/testing/test/memory-ranking-e2e.test.ts`.

- [ ] **Step 1:** The probe app needs vector enabled. Either add a `dawn.config.ts` `memory.vector.embedder = fakeEmbedder()` to a probe fixture, OR (simpler) drive the store directly through a harness whose app config supplies the fake embedder. Prefer: add `memory: { writes: "auto", vector: { embedder: fakeEmbedder() } }` to `packages/testing/test/fixtures/probe-app/dawn.config.ts` (check nothing else depends on its current shape; if it does, make a sibling `probe-app-vector` fixture). Document the choice in the test header.

- [ ] **Step 2: Test** — agent remembers a fact phrased one way; a paraphrase query with **zero shared tokens** recalls it (proving the vector list, since keyword alone returns nothing). Seed nothing; write through the real agent loop (`script().callsTool("remember", …)`), then recall with a paraphrase via `script().callsTool("recall", { query: "<paraphrase, no shared words>" })`, assert the recall tool result contains the remembered fact. Because both memory content and query are embedded by the SAME `fakeEmbedder` (bag-of-token-hash), pick a paraphrase that shares a token or two so the fake vectors are near (the fake embedder is lexical-ish; document that the live smoke in Task 9 covers true synonymy).

- [ ] **Step 3: Run** (CI-safe, no key): `pnpm build` then `pnpm --filter @dawn-ai/testing exec vitest run test/memory-vector-e2e.test.ts`. Also re-run `memory-e2e`, `memory-ranking-e2e`, `memory-index-refresh`, `memory-seed` for regressions.

- [ ] **Step 4: Lint + commit** `test(testing): aimock fake-embedder hybrid recall e2e`.

---

### Task 9: openaiEmbedder contract (aimock) + gated live smoke

**Files:** create `packages/langchain/test/openai-embedder.test.ts`; modify `packages/testing/test/memory-live.smoke.test.ts`.

- [ ] **Step 1: openaiEmbedder contract test** — start aimock (or reuse the harness’s aimock), set `OPENAI_BASE_URL` to it, call `openaiEmbedder({ model: "text-embedding-3-small" }).embed(["hello","world"])`, assert it returns 2 `Float32Array`s of length 1536 (or the aimock-returned dim), deterministic across calls. If aimock’s `/v1/embeddings` returns a fixed dim ≠ 1536, assert on the returned length, not 1536. (Verify aimock’s embeddings response shape first.)

- [ ] **Step 2: Gated live smoke** — append to `memory-live.smoke.test.ts` an `it.skipIf(!live)` scenario: build a harness with a real `openaiEmbedder` (via the app’s dawn.config or a live-mode option), remember "the customer wants faster shipping", recall with "expedite delivery options" (zero shared words), assert the recalled content contains "shipping". Real embeddings, skips in CI.

- [ ] **Step 3:** Verify skip-without-key: `env -u OPENAI_API_KEY pnpm --filter @dawn-ai/testing exec vitest run test/memory-live.smoke.test.ts` → all skipped. Then local live run (load `.env` in the smoke shell only): full smoke green.

- [ ] **Step 4: Lint + commit** `test: openaiEmbedder aimock contract + gated live paraphrase smoke`.

---

### Task 10: Docs, changeset, validate, PR

**Files:** modify `apps/web/content/docs/memory.mdx`, `docs/dev/memory-system.md`; create `.changeset/vector-recall.md`.

- [ ] **Step 1: `memory.mdx`** — new "### Semantic recall (opt-in)" subsection under the long-term collection: enable with `memory: { vector: { embedder: openaiEmbedder() } }`; explain hybrid keyword+vector via RRF (keyword kept, co-equal, not dropped); the `fakeEmbedder` for tests; model-tagged vectors + graceful keyword fallback; tuning knobs. Update the "Deterministic recall" callout to note vector recall adds an opt-in network embed (still deterministic under a fixed embedder/replay).

- [ ] **Step 2: `docs/dev/memory-system.md`** — §2 file map (`vector.ts`), §4 the hybrid path (gated on `queryEmbedding`), §13 move vector recall from deferred to shipped-opt-in, note pgvector Tier-2 still deferred + the sqlite-vec middle tier.

- [ ] **Step 3: `check-docs.mjs`** — `node scripts/check-docs.mjs` (reword any banned marketing phrase).

- [ ] **Step 4: Changeset** `.changeset/vector-recall.md` (PATCH — fixed 0.x group; minor would bump the whole group to 1.0.0):
```markdown
---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
"@dawn-ai/testing": patch
---

Opt-in vector/semantic recall for long-term memory. Enable with
`memory: { vector: { embedder: openaiEmbedder() } }`: recall becomes hybrid —
keyword (IDF) and vector (cosine) candidate lists fused co-equally by Reciprocal
Rank Fusion, with a bounded recency/confidence second stage. Keyword recall is
never dropped (dense retrieval is weak on exact IDs/codes/names), and default
keyword-only recall is unchanged. Pluggable `Embedder` (`openaiEmbedder`,
`fakeEmbedder`); embeddings stored as Float32 BLOBs in the existing node:sqlite
store (zero new native deps), tagged by embedder id with graceful keyword-only
fallback on model change. pgvector is a planned follow-up backend.
```

- [ ] **Step 5: Full validate** (clean shell, no `.env`): `pnpm lint && pnpm build && pnpm typecheck && pnpm test` — all green (gated smokes skip).

- [ ] **Step 6: Commit, push, PR, auto-merge**:
```bash
cd /Users/blove/repos/dawn
git add .changeset/vector-recall.md apps/web/content/docs/memory.mdx docs/dev/memory-system.md
git commit -m "docs+changeset: opt-in hybrid vector recall"
git push -u origin feat/memory-vector-recall
gh pr create --base main --head feat/memory-vector-recall --title "feat(memory): opt-in vector/semantic recall (hybrid RRF)" --body "<summary per spec: hybrid keyword+vector RRF, pluggable Embedder, sqlite BLOB storage zero-native-dep, pgvector Tier-2 deferred; proof: fake-embedder e2e + gated live paraphrase smoke; patch changeset>"
gh pr merge --squash --auto
```

---

## Self-review

- **Spec coverage:** Embedder interface (T4) + openaiEmbedder (T5) + fakeEmbedder (T6); migration v2 + BLOB storage (T3); cosine + RRF (T1); recencyDecay extract (T2); hybrid gated path + second stage (T3); MemoryQuery/put widening (T3) + MemoryStoreLike (T4); DawnConfig.memory.vector threaded (T4, T7); capability embeds writes+queries + failure fallback (T7); seedMemory vectors (T6); tests pure/injected/e2e/contract/live (T1,T3,T6,T8,T9); docs (T10); patch changeset (T10). pgvector explicitly deferred. ✓
- **Type consistency:** `Embedder{id,dims,embed}`, `VectorRankingOptions{weights{keyword,vector},rrfK,vectorK,recencyWeight,confidenceWeight,recencyHalfLifeMs}`, `queryEmbedding`/`embedderId`/`vector` on the query, `{embedding,embeddingModel}` on put — identical across memory/core/cli/capability. ✓
- **Traps flagged inline:** branch pin; scoped biome; patch-not-minor; `.env` pollution; `update`/`supersede` must preserve embeddings (T3 Step 5); refactor guarded by shipped smarter-recall tests (T3 Step 7); aimock embeddings dim assert-on-actual (T9).
- **Risk to watch:** the `rankKeyword` extraction in T3 is the delicate refactor — the shipped ranked-path tests are the guard; if any reorder, fix the extraction, not the test.
