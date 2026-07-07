# pgvector Memory Backend Design (Phase 4 — memory follow-up)

Date: 2026-07-07
Status: approved design, pending implementation plan
Branch: `feat/memory-pgvector`
Prior art: vector recall (`docs/superpowers/specs/2026-07-06-vector-recall-design.md`, PR #313)

## Goal

Ship `@dawn-ai/memory-pgvector` — a production, Postgres + pgvector backend that
implements the `MemoryStore` interface, selected via `config.memory.store`. It
gives Dawn apps a multi-instance, large-scale vector memory option while keeping
recall ranking **byte-identical** to the default sqlite backend. Emphasis on
thorough, real-Postgres testing and hands-on dogfooding.

## Background

- The `MemoryStore` seam is already vector-ready (PR #313): a custom store is a
  live value on `config.memory.store`; `resolveMemoryStore` returns it directly
  and skips all sqlite tuning (custom stores own their ranking); the capability
  embeds queries/content and passes `queryEmbedding` + `embedderId` to *any*
  store — so pgvector needs zero embedder awareness.
- `pg` (node-postgres) and the `pgvector` npm helper are **pure JavaScript** — no
  native build. The only friction is a *running Postgres* for tests.
- `@dawn-ai/memory` already exports the pure ranking primitives this backend
  reuses: `fuseRRF`, `recencyDecay`, `scoreMemory`, `tokenize`, `cosineSimilarity`,
  `serializeNamespace`, `classifyWrite`, and the record/query types.
- Note: the structural `MemoryStoreLike` (the config type) omits `delete` /
  `listCandidates`, but the `dawn memory` CLI needs them — pgvector implements
  the **full** `MemoryStore`.

## Research-grounded decisions (2026-07-07, 3-vote verified)

- **App-side fusion for parity (chosen), knowingly.** In-SQL RRF *is* the
  canonical pgvector pattern (Supabase `hybrid_search`, Katz `rrf_score()`,
  pgvector-python `rrf.py`) and its edge is one round-trip. We deliberately fuse
  **app-side in shared pure JS** to guarantee identical ranking to the sqlite
  backend (DRY, one implementation). The research explicitly supports this
  ("pgvector does not force app-side fusion; app-side keeps parity"). Documented
  as a conscious tradeoff, not an oversight.
- **HNSW + `vector_cosine_ops` + `<=>`.** HNSW is the consensus best practice
  (~30× IVFFlat QPS at 99% recall on 1536-dim OpenAI data; **no training step, so
  it builds on an empty table** — essential for a store that starts empty). mem0
  uses HNSW (or DiskANN), never IVFFlat. Defaults `m=16`, `ef_construction=64`
  (allow 256 for quality), `ef_search=40`, all config-exposed.
- **The 2,000-dim index ceiling is real.** pgvector `vector` *stores* to 16k dims
  but HNSW/IVFFlat on plain `vector` caps at **2,000**. `text-embedding-3-small`
  (1536) fits; `text-embedding-3-large` (3072) does **not** — it needs `halfvec`
  (indexable to 4,000 via `halfvec_cosine_ops`). The store branches on dimension.
- **Testcontainers, not GitHub-services-only.** `@testcontainers/postgresql` +
  `pgvector/pgvector:pg16` spins the container programmatically, so the *same*
  gated tests run locally and in CI with one mechanism. (PGlite-pgvector exists
  but its index fidelity is undocumented — reinforces the Docker-only decision.)
- **Hybrid keyword+vector is rare in the field.** mem0 and Mastra pgvector are
  vector-*only*; only Zep/Graphiti fuses (app-side RRF). Dawn's hybrid is already
  ahead — not catching up.

## Architecture — a thin backend over a shared ranking core

Today the hybrid ranking (keyword scoring, RRF, recency/confidence second stage)
lives *inside* `sqlite-store.ts`. To guarantee cross-backend parity, extract the
**pure** ranking pieces into a backend-agnostic module in `@dawn-ai/memory`
(`hybrid.ts`):

- `rankKeywordCandidates(records, dfByToken, corpusSize, queryTokens, opts)` →
  keyword-ranked records (the JS scoring, minus SQL).
- `fuseHybrid({ keywordRanked, vectorRanked, records, referenceNow, opts })` →
  final ranked records: `fuseRRF` over the two id-lists + the bounded
  `recencyDecay`/confidence second stage + stable sort. (Reuses shipped `fuseRRF`
  + `recencyDecay`.)

Both stores become: *do your own retrieval (backend SQL), then call the shared
core*. `sqliteMemoryStore` is refactored to call it (its existing hybrid tests are
the guard — any reorder means the extraction diverged, fix the extraction not the
test). `pgvectorMemoryStore` calls it fresh. So `@dawn-ai/memory-pgvector`
contains **only** Postgres retrieval + schema and depends on `@dawn-ai/memory`
(pure-JS) for ranking. Parity is structural.

## Package layout (`@dawn-ai/memory-pgvector`)

Mirrors `@dawn-ai/sqlite-storage` / `@dawn-ai/sandbox`:

- `src/pgvector-store.ts` — `pgvectorMemoryStore(opts)` factory implementing `MemoryStore`.
- `src/schema.ts` — idempotent DDL (extension, tables, indexes) + tiny migration runner.
- `src/queries.ts` — the retrieval SQL (vector top-K, keyword pool + df/N stats, get/put/update/supersede/delete/listCandidates).
- `src/index.ts` — barrel.
- Dependencies: `pg`, `pgvector`, `@dawn-ai/memory` (workspace). Dev: `@testcontainers/postgresql`.

## Schema, dimensions, config

Config:
```ts
pgvectorMemoryStore({
  connectionString?: string        // or pass a pg.Pool
  pool?: import("pg").Pool         // caller-owned pool (mutually exclusive with connectionString)
  dimensions: number               // REQUIRED — must match the embedder's dims
  index?: { type?: "hnsw"; m?: number; efConstruction?: number; efSearch?: number }  // HNSW defaults 16/64/40
  schema?: string                  // Postgres schema name, default "public"
  tablePrefix?: string             // default "dawn_memory"
})
```

DDL (idempotent, run once on first connect, transactional):
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS <prefix>_memories (
  id text PRIMARY KEY, kind text NOT NULL, namespace text NOT NULL,
  content text NOT NULL, data jsonb NOT NULL, source jsonb NOT NULL,
  confidence real NOT NULL, tags jsonb NOT NULL, status text NOT NULL,
  supersedes jsonb, created_at text NOT NULL, updated_at text NOT NULL,
  effective_at text, expires_at text,
  embedding <VECTOR_TYPE>(<dimensions>), embedding_model text
);
CREATE TABLE IF NOT EXISTS <prefix>_tokens (
  memory_id text NOT NULL REFERENCES <prefix>_memories(id) ON DELETE CASCADE, token text NOT NULL
);
CREATE INDEX ... ON <prefix>_memories (namespace, status, updated_at DESC);
CREATE INDEX ... ON <prefix>_tokens (token);
CREATE INDEX ... ON <prefix>_memories USING hnsw (embedding <OPS>) WITH (m=?, ef_construction=?);
```

**Dimension branch:** `dimensions ≤ 2000` → `VECTOR_TYPE = vector`, `OPS =
vector_cosine_ops`. `dimensions ≤ 4000` (i.e. > 2000) → `VECTOR_TYPE = halfvec`,
`OPS = halfvec_cosine_ops` (enables `text-embedding-3-large` at 3072).
`dimensions > 4000` → throw a clear config error at construction. Document 1536
(`-small`) as the smooth default.

## Retrieval flow

`put(rec, { embedding, embeddingModel })` — upsert the row (`INSERT ... ON
CONFLICT (id) DO UPDATE`), re-tokenize into the tokens table (same `tokenize()`),
write the `embedding` (via the `pgvector` serializer) + `embedding_model`. `update`
re-reads and preserves the embedding when the patch omits it (parity with sqlite).

`search(q)`:
- **Query-less** (no `query`): `... WHERE namespace/status[/kind] ORDER BY updated_at DESC, id ASC LIMIT` — recency, unchanged semantics.
- **No `queryEmbedding`** (keyword-only): keyword pool + df/N stats → `rankKeywordCandidates` → page → tag filter.
- **Hybrid** (`queryEmbedding` present): in Postgres, run (a) vector top-K —
  `ORDER BY embedding <=> $vec LIMIT vectorK` filtered to namespace/status[/kind]
  + `embedding_model = $embedderId`, `ef_search` set per query via `SET LOCAL
  hnsw.ef_search`; and (b) the keyword pool + df/N stats. Hand both to the shared
  `fuseHybrid` → identical ranking → return records.

Determinism/parity: the fusion is the shared pure code; only retrieval differs.
HNSW is approximate, so vector *retrieval* can vary run-to-run at scale — accept
this (it is the nature of ANN and matches every production backend); the
conformance kit's vector-ordering assertions use small corpora where HNSW recall
is effectively exact, and looser "is recalled" assertions at scale.

## The shared `MemoryStore` conformance kit

New export in `@dawn-ai/testing` (mirrors sandbox `runProviderConformance`):
```ts
runMemoryStoreConformance({
  name: string,
  makeStore: () => Promise<MemoryStore> | MemoryStore,
  describe, test,   // injected vitest fns
})
```
Asserts the full contract: put/get round-trip, namespace + status isolation,
supersession (old→superseded, new active, supersedes link), candidate
list/approve semantics, delete, embedding round-trip, keyword ranking order,
and hybrid ordering with **injected** vectors (deterministic — the
"semantic-only match recalled" + "exact-token match not buried" cases from #313).
Run it against **sqliteMemoryStore (in-process, always)** — backfilling formal
conformance coverage sqlite never had — and **pgvectorMemoryStore (real PG,
gated)**. The kit is the parity guarantee: the fake cannot drift from reality.

## Testing strategy (the emphasis)

Three tiers:
1. **Conformance kit** — sqlite always (default validate lane); pgvector behind
   `DAWN_TEST_PGVECTOR=1` via Testcontainers (`pgvector/pgvector:pg16`), in a
   dedicated CI lane modeled on `sandbox-docker`. Default validate never sets the
   flag → CI stays green with no Postgres.
2. **pgvector-specific integration** (same gated lane): schema/migration
   idempotency (run init twice, no error), the dimension branch (1536→vector,
   3072→halfvec, >4000→throw), HNSW index existence + `ef_search` application,
   concurrency (parallel puts/searches over a pool), and the exact retrieval SQL.
3. **Dogfood smoke** (doubly-gated, local): a full Dawn agent + `pgvectorMemoryStore`
   (real Postgres via Testcontainers or a local container) + real `openaiEmbedder`
   (real key) — the "expedite delivery → faster shipping" zero-shared-token
   paraphrase recall, end to end. Ships a `docker run` / compose one-liner + a
   `pnpm dogfood:pgvector` script so it's runnable by hand.

Local ergonomics: `DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test`
spins the container programmatically (Testcontainers needs a Docker daemon).

## Connection & lifecycle

A `pg.Pool` (built from `connectionString`, or the caller's injected `pool`). The
store exposes `close(): Promise<void>` (ends the pool) — used by tests and
graceful shutdown. Schema init runs once, guarded by an in-memory `initialized`
promise (idempotent + concurrency-safe). `MemoryStore` itself gains no `close` —
`close` is a pgvector-store extra (structural typing lets callers who hold the
concrete type call it).

## Error handling

- Missing `pgvector` extension / insufficient privileges to `CREATE EXTENSION` →
  a clear actionable error at init ("enable the vector extension or grant …").
- `dimensions > 4000` → construction error naming the halfvec ceiling.
- A stored `embedding_model` ≠ the query `embedderId` → excluded from the vector
  retrieval (SQL `WHERE embedding_model = $1`), graceful keyword-only fallback —
  parity with sqlite.
- Connection errors surface as thrown errors (the capability's recall/remember
  already degrade gracefully around store failures where designed; a hard DB
  outage is a real error, not silently swallowed).

## Scope / non-goals

In: the backend package, the shared ranking-core extraction (+ sqlite refactor
under its test guard), the conformance kit, the Testcontainers gated lane + the
dogfood smoke, docs, changeset. **Out (deferred, noted):** DiskANN via
`pgvectorscale` (very-large-scale path mem0 offers); in-SQL RRF as a future
single-round-trip perf option; IVFFlat; binary quantization / subvector indexing
for >4000 dims; connection-secret management; multi-tenant pool strategies;
pg-native `tsvector`/BM25 ranking (we replicate the token+IDF table for parity).

## Packaging & release

- New package `@dawn-ai/memory-pgvector` (public). Its first publish needs the
  OIDC new-package bootstrap (see the npm-release memory: bootstrap BEFORE merging
  the Version PR, pack the tarball from `changeset-release/main`).
- Changed existing packages: `@dawn-ai/memory` (extract `hybrid.ts`, refactor
  sqlite-store to use it), `@dawn-ai/testing` (`runMemoryStoreConformance`).
- Changeset: **patch** for `@dawn-ai/memory`, `@dawn-ai/testing`, AND the new
  `@dawn-ai/memory-pgvector` (new packages join the fixed group and take a
  changeset entry so they version with the group). Fixed 0.x group — GOTCHA 6:
  never `minor` (it inflates the whole group to 1.0.0). The conformance kit takes
  a `makeStore` factory, so `@dawn-ai/testing` does NOT depend on the pgvector
  package (no cycle) — the pgvector package's own test imports the kit.
- Docs: `apps/web/content/docs/memory.mdx` (a "Postgres backend" subsection —
  enable via `config.memory.store = pgvectorMemoryStore({ … })`, HNSW, the
  dimension note, that ranking matches sqlite); `docs/dev/memory-system.md`
  (pgvector now shipped; the shared ranking core).

## Open tuning questions (validate during build, not blockers)

- HNSW `ef_construction` default 64 vs 256 (quality vs build time) — pick 64,
  expose, revisit with the dogfood corpus.
- `vectorK` / `candidatePool` defaults for pgvector — reuse the #313 defaults (64
  / 256) for parity; confirm they behave on a real ANN index.
