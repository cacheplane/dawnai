# Smarter Recall Design (Phase 4 — memory follow-up)

Date: 2026-07-05
Status: approved design, pending implementation plan
Branch: `feat/memory-recall-ranking`

## Goal

Replace pure-recency ordering in long-term-memory recall with a deterministic
relevance score, so `recall({ query })` returns the memories that best match the
question — not merely the most recently written ones. Stay inside `node:sqlite`
(no FTS5, no embeddings, no network, no new dependencies) and preserve byte-level
determinism so aimock fixtures and eval scorers remain stable.

## Background: what exists today

`sqliteMemoryStore().search()` (`packages/memory/src/sqlite-store.ts`):

1. Tokenize the query (`tokenize.ts`: lowercase, split on non-alphanumerics,
   drop 1-char tokens, **dedupe**).
2. SQL filter: `namespace = ? AND status = ?` [+ `kind = ?`] and, when the query
   has tokens, `id IN (SELECT memory_id FROM memory_tokens WHERE token IN (...))`.
3. `ORDER BY updated_at DESC, id ASC LIMIT ?` — **pure recency**.
4. Optional tag post-filter in JS.

Consequences: a memory matching one query token ranks identically to one
matching five; the stored `confidence` field is never read during recall.

Constraints inherited from the shipped system (verified in code):

- `memory_tokens` holds **one row per distinct token per memory** (tokenize
  dedupes) → term frequency is not stored; classic BM25 is impossible without a
  schema migration.
- `@dawn-ai/memory` library code must not call `Date.now()` (determinism rule);
  the capability receives a per-request timestamp as `context.memory.now`.
- Tokens are indexed from `content + tags + JSON data values` (`reindex()`), so
  matching already spans all three.
- The memory-index prompt fragment and `listCandidates` perform **query-less**
  searches; their recency ordering is depended on by shipped tests
  (`memory-index-refresh.test.ts`, live smoke) and must not change.

Related prior work: PR #257 (tool input schemas + index `cacheKey` refresh),
PR #279 (non-Zod schema guard). Both merged; this design assumes them.

## Decision: IDF-weighted overlap (Option B)

Three options were considered:

- **A. Plain overlap count** — rank by number of matched query tokens. Rejected:
  treats "the" and "acme" as equally informative.
- **B. IDF-weighted overlap (chosen)** — weight each matched token by how rare it
  is in the namespace. Computable entirely from the existing tables.
- **C. Full BM25** — requires term frequency, hence a schema migration +
  reindex of existing rows. Rejected (not deferred-by-accident): memories are
  one-line facts; TF adds ~nothing for short documents, at real migration cost.

**Doc-length normalization is deliberately omitted.** Because relevance is an
overlap *fraction* bounded per query (see below), a memory with many tokens
gains no per-query score advantage from its extra tokens; BM25's length damping
exists to counter TF inflation, which cannot occur here. If vector recall later
lands, the scoring seam (`score.ts`) is where such a knob would go.

## Scoring model

For a query that tokenizes to `Q = {q1..qn}` (n ≥ 1), against the candidate set
described below:

```
idf(t)     = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
             N     = count of memories matching the SQL base filter
                     (namespace + status [+ kind]) — the "corpus"
             df(t) = count of corpus memories containing token t

relevance  = Σ_{t ∈ Q ∩ tokens(m)} idf(t) / Σ_{t ∈ Q} idf(t)        ∈ [0, 1]

recency    = 2^(−ageMs / halfLifeMs)                                 ∈ (0, 1]
             ageMs = reference − updated_at (clamped ≥ 0)
             reference = query.now when provided, else the maximum
             updated_at across the candidate set (data-derived fallback)
             halfLifeMs default = 14 days

confidence = the record's stored confidence, clamped to [0, 1]

score      = wRel·relevance + wRec·recency + wConf·confidence
             defaults: wRel = 0.6, wRec = 0.3, wConf = 0.1

order      = score DESC, then updated_at DESC, then id ASC
```

Notes:

- The BM25-smoothed idf is **always positive**, including when df = N (a token
  present in every memory still contributes a small weight; no zeroing, no
  negative values as in unsmoothed idf).
- Query tokens with df = 0 (appearing in *no* memory) contribute their (maximal)
  idf to the **denominator only**. This is a per-query constant, so relative
  ordering is unaffected; it simply keeps `relevance` interpretable as
  "fraction of the query's information matched".
- Weights are used as given (after filling defaults); they need not sum to 1 —
  the score is used only for ordering.
- All arithmetic is pure; identical inputs always produce identical order. The
  `updated_at DESC, id ASC` tiebreak keeps ordering stable when scores are
  exactly equal.

## Determinism and the `now` parameter

`MemoryQuery` gains an optional field:

```ts
interface MemoryQuery {
  // ...existing fields...
  /** ISO timestamp used as the recency reference. Optional; when absent,
   *  recency is measured relative to the newest candidate's updated_at. */
  readonly now?: string
}
```

- The **capability's `recall` tool** passes `context.memory.now` (already
  plumbed per-request by the CLI) so recall reflects true staleness.
- Direct store callers (tests, CLI internals) may omit it; the fallback
  reference is the max `updated_at` among candidates — fully data-derived, so
  the library still never reads a clock.
- The structural `MemoryStoreLike.search()` signature in
  `@dawn-ai/core/capabilities/types.ts` gains the same optional `now`.

`Date.parse()` on the ISO strings is the only time handling; invalid or missing
timestamps degrade to age 0 (recency = 1) rather than throwing.

## Execution flow in `search()`

When `q.query` tokenizes to **zero** tokens (or is absent): the existing SQL
path runs unchanged (`ORDER BY updated_at DESC, id ASC LIMIT ?`). This preserves
the index fragment, `listCandidates`, and every current query-less consumer
byte-for-byte.

When it tokenizes to **≥ 1** token:

1. **Candidate pool** — existing SQL filter (≥ 1 token match), but ordered by
   `updated_at DESC, id ASC` and capped at `candidatePool` (default **256**)
   instead of the caller's `limit`. Pool truncation by recency is deterministic;
   the cap is documented (docs page) since a silent cap can read as "searched
   everything".
2. **Corpus stats** — one query for `N` (count over the base filter) and one for
   per-token `df` (`SELECT token, COUNT(DISTINCT memory_id) ... WHERE token IN
   (...)` joined to the base filter). Small: bounded by |Q| rows.
3. **Score** each candidate with the pure scorer. Each candidate's token set is
   recomputed in JS via the same token-derivation helper `reindex()` uses
   (content + tags + data values → `tokenize()`), so it is guaranteed
   consistent with what the token table holds — no extra SQL round-trip.
4. **Sort** by the composite order and apply the caller's `limit` (default 8).
5. **Tag post-filter** is applied after the limit, on the returned page —
   exactly today's semantics (including the existing under-fill caveat when
   combining `tags` with `limit`; unchanged by this work).

Perf envelope: per-namespace memory counts are small (tens to low hundreds);
pool ≤ 256; everything is index-backed. No measurable regression expected; no
caching added (YAGNI).

## Public API and configuration

New pure module `packages/memory/src/score.ts`:

```ts
export interface RecallWeights {
  readonly relevance?: number   // default 0.6
  readonly recency?: number     // default 0.3
  readonly confidence?: number  // default 0.1
}
export interface RecallRankingOptions {
  readonly weights?: RecallWeights
  readonly recencyHalfLifeMs?: number   // default 14 * 24 * 60 * 60 * 1000
  readonly candidatePool?: number       // default 256
}
export function idf(df: number, corpusSize: number): number
export function scoreMemory(args: {
  readonly memoryTokens: ReadonlySet<string>
  readonly queryTokens: readonly string[]
  readonly dfByToken: ReadonlyMap<string, number>
  readonly corpusSize: number
  readonly updatedAt: string
  readonly confidence: number
  readonly referenceNow: string
  readonly options?: RecallRankingOptions
}): number
```

Store factory:

```ts
sqliteMemoryStore({ path, recall?: RecallRankingOptions })
```

Config surface (`DawnConfig.memory` in `@dawn-ai/core/types.ts`):

```ts
memory?: {
  // ...existing fields...
  /** Recall ranking tuning. All fields defaulted; omit for standard behavior. */
  readonly recall?: {
    readonly weights?: { relevance?: number; recency?: number; confidence?: number }
    readonly recencyHalfLifeMs?: number
    readonly candidatePool?: number
  }
}
```

`resolveMemoryStore()` (`packages/cli/src/lib/runtime/resolve-memory.ts`)
threads `config.memory.recall` into the default `sqliteMemoryStore` call.
A custom `config.memory.store` bypasses all of this (it owns its own ranking).

## Error handling / edge cases

- **Empty corpus (N = 0)** — the token filter yields no candidates; empty result,
  no division by zero (denominator path never runs without candidates).
- **All-common token (df = N)** — smoothed idf stays a small positive number.
- **Query tokens matching nothing** — inflate only the shared denominator;
  ordering unaffected.
- **Missing/invalid timestamps** — age clamps to 0 (recency 1); never throws.
- **`confidence` outside [0,1]** — clamped defensively in the scorer.
- **Weights all zero** — score 0 for everything; tiebreak (recency) fully
  determines order, i.e. degrades to today's behavior rather than misbehaving.
- **Tag filter interaction** — tags are applied as a post-filter on the ranked,
  limited page (current behavior preserved). Documented caveat (existing):
  combining `tags` with `limit` can under-fill the page; unchanged by this work.
- **candidatePool exceeded** — deterministic recency truncation; noted in the
  docs page.

## Testing

- **`score.test.ts` (new, pure units):** idf monotonicity + smoothing bounds;
  rare-token dominance ("matches 1 rare term > matches 1 common term");
  overlap-fraction behavior ("matches 2 terms > matches 1, same rarity");
  recency decay halving at half-life; confidence weight effect; absent-`now`
  fallback; weight-override arithmetic; clamping.
- **Store-level ordering tests (`sqlite-store.test.ts` additions):** seed a
  namespace and assert exact expected orderings, including: relevant-but-older
  beats recent-but-marginal (the headline case); query-less path unchanged
  (exact recency order); `now` passed vs omitted; candidatePool truncation;
  kind/status filters interact correctly with corpus stats.
- **Capability:** recall tool passes `context.memory.now` (assert via a fake
  store capturing the query).
- **Agent e2e (aimock, CI-safe) — the headline scenario:** seed a backdated
  (~6 weeks) relevant fact directly via the store (writes through the
  `remember` tool always stamp `now`, so age must be seeded), write a fresh
  marginal distractor through the real agent loop, then drive `recall` with a
  scripted tool call and assert the relevant memory is the FIRST line of the
  real tool result. This test FAILS against today's pure-recency code — it is
  the before/after proof for the feature. aimock scripts only the model; the
  runtime, capability, SQLite, tokenization, and ranking are all real.
- **Existing suites stay green:** `@dawn-ai/memory` units, capability tests,
  `memory-e2e.test.ts` (cross-thread), `memory-index-refresh.test.ts`,
  research-template eval. Any assertion that is accidentally order-sensitive
  with a single result is unaffected by construction.
- **Gated live smoke** (`memory-live.smoke.test.ts`) re-run locally
  (OPENAI_API_KEY, never CI) as final verification, PLUS one new ranking
  scenario: seed the backdated relevant fact, let the REAL model store a
  distractor and then ask the question naturally; assert the recall tool was
  called AND its result carries the value (finalMessage alone can false-pass:
  the index hint can leak the answer into the system prompt — observed live),
  with the seeded value placed past the 80-char index-hint slice so recall is
  the only source. Covers what aimock cannot — whether the model's
  own query phrasing is good enough for the ranker.
- **Eval dogfood: DEFERRED.** The research template ships no evals today, and
  adding `@dawn-ai/evals` to a scaffold template destabilizes the generated-app
  verify lanes (known SCAFFOLD_PACKAGES hazard). The aimock before/after e2e is
  the deterministic quality gate; a template eval can follow when the template
  grows an evals directory for other reasons.

## Documentation

- `apps/web/content/docs/memory.mdx` — update the "Deterministic recall" callout
  and add a short "How recall ranks" subsection (IDF-weighted overlap + recency
  + confidence; the `memory.recall` config; the candidatePool cap).
- `docs/dev/memory-system.md` — update §4 (search internals) and §13/§14
  (roadmap: ranking done; vector recall plugs into the scoring seam).

## Packaging & release

- Changed packages: `@dawn-ai/memory` (score.ts, search), `@dawn-ai/core`
  (`DawnConfig.memory.recall`, `MemoryQuery.now` structural type),
  `@dawn-ai/cli` (`resolveMemoryStore` threading).
- Changeset: **patch** for all three (fixed 0.x group — patch keeps the group on
  a patch; do not use minor, per release GOTCHA 6).

## Out of scope (explicit)

- Vector / embedding recall (next natural sub-project; `score.ts` is its seam).
- Term-frequency storage / true BM25 (rejected, see Decision).
- Doc-length normalization (omitted with rationale, see Decision).
- Episodic/procedural/reflection kinds, memory graph, Inspector UI, Postgres.
- Any change to write governance, supersession, or the index fragment.
