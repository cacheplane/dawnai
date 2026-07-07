# Vector / Semantic Recall Design (Phase 4 — memory follow-up)

Date: 2026-07-06
Status: approved design, pending implementation plan
Branch: `feat/memory-vector-recall`
Prior art: smarter recall (`docs/superpowers/specs/2026-07-05-smarter-recall-design.md`, PR #294)

## Goal

Add opt-in vector/semantic recall to long-term memory, so `recall` can surface
memories that match a query's **meaning** even when they share no words — while
never regressing the exact-lexical matches (IDs, codes, proper nouns, numbers)
that keyword recall is best at. Preserve Dawn's local-first properties: zero
native dependencies by default, deterministic CI with no network, and
zero-config keyword recall unchanged for anyone who doesn't opt in.

## Research verdict (drives the whole design)

Deep research (2026-07-06, 3-vote adversarial verification) settled the core
question — for short, fact-like memory records the answer is **hybrid, keyword
co-equal with vector, fused by Reciprocal Rank Fusion**; NOT pure-vector and NOT
semantic-dominant. Load-bearing evidence:

- **Pure dense retrieval fails hardest on exactly what memory holds.** Dense
  underperforms BM25/keyword on exact-lexical + entity matches: EntityQuestions
  DPR Acc@20 56.6 vs BM25 70.8 (~14-pt gap); BEIR zero-shot DPR −47.7% vs BM25.
  Memory records are entity-rich short facts → dropping keyword regresses the
  most-noticed recalls.
- **Keyword and vector rank near-orthogonally** (RBO ~0.10 between DPR and BM25)
  → combine, don't choose; hybrid beats either alone (~7.4% NDCG in one bench).
- **Every agent-memory system that adds keyword keeps it**: mem0 (semantic+BM25+
  entity), Zep/Graphiti (semantic+BM25 via RRF, *co-equal, explicitly not
  favoring vectors*), Azure AI Search (BM25+vector via RRF). Pure-vector systems
  (Mastra semantic recall, LangGraph store) omit keyword by scope, not as a
  recommendation.
- **RRF (rank-based) is the canonical fusion**, preferred over a weighted *score*
  blend because BM25/IDF and cosine scores live on incompatible scales; RRF
  fuses ranks (scale-free, deterministic). Canonical constant k=60 (industry
  standard; robust range 40–80). Two honest caveats: (a) k=60's primary source
  wasn't independently confirmed and it's tuned for long TREC lists — our short
  lists may want smaller k → expose as a knob; (b) 2021–22 dense-vs-BM25 gaps
  are bi-encoder-era, newer encoders closed the *aggregate* gap but not the
  exact-match slice that matters here.

## Two orthogonal pluggable axes

Vector recall introduces two independent seams that compose as {embedder} × {store}:

| Axis | Contract | Ships in v1 | Later |
|---|---|---|---|
| **Embedder** | `(texts) → vectors` | `openaiEmbedder`, `fakeEmbedder` | local/ONNX, Cohere, … |
| **Store** | `MemoryStore` (existing `config.memory.store` seam) | `sqliteMemoryStore` (brute-force cosine) | `@dawn-ai/memory-pgvector` (native ANN) |

Design invariant: `@dawn-ai/memory` stays **zero-dependency**. It receives vectors
and computes cosine in JS; it never imports an embedder or a provider SDK. Every
provider/backend with a heavy or native dep lives in its own peripheral package,
opt-in to install.

## The Embedder contract

```ts
// @dawn-ai/core (config-facing; referenced by DawnConfig.memory.vector)
export interface Embedder {
  /** Stable id of the model+provider, e.g. "openai:text-embedding-3-small".
   *  Stored with each vector so vectors from a different embedder are ignored
   *  (never cross-compared — cosine across models is meaningless). */
  readonly id: string
  /** Embedding dimensionality (e.g. 1536). */
  readonly dims: number
  /** Batch-embed. Same function used at write time (memory content) AND query
   *  time (the recall query) — symmetry is required for cosine to be valid. */
  embed(texts: readonly string[]): Promise<Float32Array[]>
}
```

- **`openaiEmbedder({ model = "text-embedding-3-small" })`** — housed in
  `@dawn-ai/langchain` (candidate: it already owns the OpenAI dep + the
  `OPENAI_BASE_URL` resolution behind `createChatModel` in
  `packages/langchain/src/chat-model-factory.ts`), reusing that plumbing so it
  rides the same seam aimock intercepts. Batches, handles auth via the existing
  key resolution. `id = "openai:<model>"`, `dims` per model (1536 for -3-small).
  (Plan may split to a dedicated `@dawn-ai/embed-openai` if the langchain coupling
  proves awkward; the `Embedder` interface makes that a move, not a redesign.)
- **`fakeEmbedder({ dims = 8 })`** — in `@dawn-ai/testing`. Deterministic
  `text → vector` via a hash of the string (stable, no network). The primary CI
  embedder; makes the whole feature testable without any real embedding call.

Enabling vector is one line: `memory: { vector: { embedder: openaiEmbedder() } }`.
No `vector` block → vector fully off → today's keyword recall, byte-for-byte.

## Storage (sqlite, migration v2 — additive)

Add to the `memories` table (nullable, so existing rows are untouched):

```sql
ALTER TABLE memories ADD COLUMN embedding BLOB;         -- Float32 little-endian, dims*4 bytes
ALTER TABLE memories ADD COLUMN embedding_model TEXT;   -- Embedder.id that produced it
```

- Write path: when `vector` is enabled, the capability embeds the record's
  `content` and passes the vector; the store persists `embedding` + `embedding_model`.
- A row whose `embedding_model` ≠ the *current* embedder id (provider swapped, or
  never embedded) is treated as **no vector** → it still participates in keyword
  recall, just not the vector list. Graceful degradation, no migration forced.
- `dims` is derivable from BLOB length; a stored vector whose length ≠ current
  embedder `dims` is likewise ignored (defensive against model change).

## Recall: two gated paths

**Vector OFF (default) — unchanged.** Exactly today's `search()`: query-less
recency path, and the ranked keyword path (`scoreMemory`: 0.6·IDF + 0.3·recency +
0.1·confidence). Zero churn — the DX bar.

**Vector ON — new hybrid path** (activates when a non-empty `query` string is
present, even if it tokenizes to zero keyword tokens — the vector list can still
match). A **query-less** search (no `query` at all — the injected index,
`listCandidates`, `dawn memory list`) stays the recency path unchanged even with
vector on: there is nothing to embed, and those consumers depend on recency order.

1. **Query embedding** — the capability embeds the query once (network call;
   acceptable because vector is opt-in — the "no network without config" rule
   holds). On embed failure → skip the vector list, fall back to keyword-only
   (recall never fails).
2. **Two candidate lists over the namespace:**
   - *keyword list* — the existing IDF-overlap ranking (candidate pool ≤ `candidatePool`, default 256).
   - *vector list* — brute-force cosine of the query vector against every row whose `embedding_model` matches the current embedder; top-`vectorK` (default 64).
3. **RRF fuse** the two lists, co-equal by default:
   `rrf(d) = Σ_lists wᵢ / (rrfK + rankᵢ(d))`, `rrfK` default 60, `w_keyword = w_vector = 1`.
   A record present in only one list simply has no rank in the other (contributes 0) — RRF subsumes the union-pool cleanly.
4. **Second-stage recency/confidence** as a *bounded multiplier* (so relevance
   dominates and these only reorder near-ties, never override):
   `final(d) = rrf(d) · (1 + wRec·recency(d) + wConf·confidence(d))`,
   defaults `wRec = 0.3`, `wConf = 0.1`, `recency` = the shipped exponential
   decay (`2^(−age/halfLife)`), reusing `recall.recencyHalfLifeMs` (default 14d —
   one half-life knob, not a duplicate), `confidence` = stored 0..1. Bounded in
   `[rrf, 1.4·rrf]`.
5. **Sort** `final DESC`, then the shipped stable tiebreak (`updatedAt DESC, id
   ASC`, codepoint compare), apply `limit`, then the tag post-filter.

Purity/determinism: two new pure functions in `@dawn-ai/memory` —
`cosineSimilarity(a, b)` and `fuseRRF(lists, opts)`. Both deterministic; RRF is
rank arithmetic. `scoreMemory` keeps its keyword-only role unchanged. No
`Date.now()` in lib code; the query's `now` supplies the recency reference (data-
derived fallback as today).

## Public API / configuration

```ts
// DawnConfig.memory (structural in @dawn-ai/core; @dawn-ai/memory imports nothing new)
memory?: {
  // ...existing (store?, writes?, indexMaxEntries?, resolveScope?, recall?) ...
  readonly vector?: {
    readonly embedder: Embedder            // presence enables vector recall
    readonly weights?: { keyword?: number; vector?: number }  // RRF per-list, default 1/1
    readonly rrfK?: number                 // default 60
    readonly vectorK?: number              // nearest-neighbors pulled, default 64
    readonly recencyWeight?: number        // second-stage, default 0.3
    readonly confidenceWeight?: number     // second-stage, default 0.1
  }
}
```

`resolveMemoryStore`/`buildMemoryContext` thread `vector` through: the store gets
its brute-force config; the capability gets the embedder (to embed writes +
queries). A custom `config.memory.store` owns its own ranking (as today) — vector
config applies to the default sqlite store.

The `MemoryStore` interface widens (additively) so non-sqlite backends can take
vectors without an interface break later:

```ts
// MemoryQuery gains optional fields (additive, like `now` before it):
interface MemoryQuery {
  // ...existing... now?: string
  queryEmbedding?: Float32Array   // present → the store runs the vector list
  embedderId?: string             // only rows with matching embedding_model are compared
  vector?: { weights?; rrfK?; vectorK?; recencyWeight?; confidenceWeight? }
}
interface MemoryStore {
  put(rec: MemoryRecord, opts?: { embedding?: Float32Array; embeddingModel?: string }): Promise<void>
  search(q: MemoryQuery): Promise<readonly MemoryRecord[]>
  // get/update/supersede/delete/listCandidates unchanged
}
```

Backends that ignore the embedding args = keyword-only. `pgvectorMemoryStore`
(Tier-2) implements the same signatures with native `<=>`/HNSW + in-DB hybrid.

## Failure handling

- **Write embed failure** — store the record *without* an embedding (keyword-only
  for that row); never drop the memory. Debug-gated warn.
- **Query embed failure** — skip the vector list; keyword-only recall for that
  call. Recall must never throw because embeddings are down.
- **Embedder/model change** — mismatched `embedding_model` rows silently degrade
  to keyword-only until re-embedded (no crash, no forced migration).
- **Dimension mismatch** — stored BLOB length ≠ current `dims` → ignore that
  vector (treat as unembedded).

## Testing strategy

Most coverage needs no network and no aimock, because vectors are injectable:

- **Pure units** (`@dawn-ai/memory`): `cosineSimilarity` (orthogonal=0, identical=1,
  clamp), `fuseRRF` (co-equal fusion, single-list, weight override, k effect,
  deterministic tiebreak), the bounded second-stage multiplier.
- **Store search with injected vectors**: extend `seedMemory` to accept
  `embedding` + `embeddingModel`; seed rows with vector literals, search with a
  query-vector literal, assert exact hybrid ordering — including the headline
  "semantic-only match (0 shared words) is recalled" and "exact-token match still
  wins on an ID query" cases. No embedder called.
- **Full-wiring e2e (aimock, CI-safe)** via `createAgentHarness` with
  `vector: { embedder: fakeEmbedder }`: agent writes a memory → it's embedded →
  recall embeds the query → hybrid ranks → correct record returned. Deterministic,
  zero network.
- **Real-client contract** (`openaiEmbedder`): the harness already routes
  `OPENAI_BASE_URL` to aimock, and aimock ships `/v1/embeddings` + a
  vector-handler (verified, v1.28.0) — so `openaiEmbedder` is intercepted; record
  real vectors once, replay in CI.
- **Gated live smoke** (`skipIf(!OPENAI_API_KEY)`, never CI): real OpenAI
  embeddings, a paraphrase query with zero shared words recalls the seeded fact.

## Scope

**v1 (this build):** the `Embedder` contract; `openaiEmbedder` + `fakeEmbedder`;
sqlite migration v2 (embedding columns); brute-force cosine + `fuseRRF` +
second-stage in the sqlite store; the widened `MemoryStore` interface (designed
for pgvector drop-in); `DawnConfig.memory.vector` config threaded via CLI;
`seedMemory` vector support; docs; patch changeset. Fully working local,
zero-native-dep, opt-in, deterministic-CI vector recall.

**Tier-2 (named follow-up, its own package/PR):** `@dawn-ai/memory-pgvector` —
native `pg` driver, HNSW/IVFFlat, in-DB hybrid (BM25/tsvector + `<=>` fused by
RRF), containerized (non-CI) tests. Lands cleanly because v1 designed the
interface for it. Reason to split: pgvector needs a live Postgres, which breaks
the in-process/zero-dep/no-key CI story that makes the sqlite path clean.

## Out of scope (explicit)

- pgvector itself (Tier-2, above).
- sqlite-vec extension (a middle ANN tier for very large local corpora, loadable
  via `allowExtension` on Node ≥22.13 — deferred; brute-force covers v1's sizes).
- A local/ONNX embedder (`localEmbedder`) — the interface supports it; its
  native/wasm dep + cold-start + CI story are a separate follow-up package.
- Reranker (cross-encoder) stage.
- `dawn memory reindex` backfill command — v1 degrades unembedded rows to
  keyword-only; bulk re-embed of a pre-existing store is a follow-up (note it).
- Cross-namespace / multi-embedder-in-one-search (invalid: cosine is per-model).

## Packaging & release

- Changed: `@dawn-ai/memory` (cosine, fuseRRF, migration, store hybrid path),
  `@dawn-ai/core` (`Embedder` type, `DawnConfig.memory.vector`, widened
  `MemoryStoreLike`), `@dawn-ai/cli` (thread `vector`), the package owning
  `openaiEmbedder` (OpenAI plumbing), `@dawn-ai/testing` (`fakeEmbedder`,
  `seedMemory` vectors).
- Changeset: **patch** for all (fixed 0.x group — GOTCHA 6: a `minor` inflates
  the whole group to 1.0.0).

## Open tuning questions (validate with an eval, not blockers)

- `rrfK` default 60 (industry) vs smaller for our short lists.
- `vectorK` default 64; `keyword`/`vector` co-equal weights; second-stage
  recency/confidence weights. All exposed in config; defaults set here, revisited
  against a memory recall-quality eval (paraphrase recall vs exact-ID recall).
