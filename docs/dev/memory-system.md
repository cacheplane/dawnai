# Long-term memory — developer walkthrough

> Draft developer documentation. A full, code-grounded walkthrough of Dawn's
> long-term memory system as it exists on `main` (post-PR #250 + #257). Written
> to help assess the current design and guide the "smarter recall" follow-up.
> Reflects `main` @ #275 **plus** the `feat/memory-recall-ranking` branch
> (smarter recall — ranked `search()`, shipped; see §4 and §14).

## 1. Mental model: three layers, one overloaded word

"Memory" in Dawn means three distinct things. Only the third is a queryable store.

| Layer | What it is | Mechanism | Source |
|---|---|---|---|
| **L1 — workspace profile** | Global facts true across the whole app | Whole `workspace/AGENTS.md` spliced into the system prompt every turn | `core/.../built-in/agents-md.ts` |
| **L2 — route profile** | Route-scoped prose facts | Whole route `memory.md` spliced into the prompt (32 KiB cap) | `core/.../built-in/memory-md.ts` |
| **L3 — typed collection** | A namespaced database of discrete typed facts the agent reads/writes via tools | `recall`/`remember` tools + an injected index, backed by SQLite | `@dawn-ai/memory` + `core/.../built-in/memory.ts` |

L1/L2 are **text injection** — no ranking, no queries, re-read each turn. L3 is the
real subsystem: records, namespaces, write governance, recall. Everything below is L3
unless stated. "Smarter recall" touches exactly one function inside L3.

## 2. File map (where everything lives)

**`@dawn-ai/memory`** — storage engine, no deps but `node:sqlite`:
- `types.ts` — `MemoryRecord`, `MemoryStore`, `MemoryQuery`, `MemoryKind`, `MemoryStatus`.
- `sqlite-store.ts` — `sqliteMemoryStore()`: schema/migrations (v1 tokens, v2 embedding cols), tokenized index, hybrid `search()`.
- `score.ts` — pure recall scoring: `idf()`, `scoreMemory()`, exported `recencyDecay()` (reused by the hybrid second stage), `RecallRankingOptions` + defaults.
- `vector.ts` — pure vector primitives: `cosineSimilarity()`, `fuseRRF()` (Reciprocal Rank Fusion), `RankedList`, `DEFAULT_RRF_K` / `DEFAULT_VECTOR_K`. No I/O, no clock — deterministic for aimock/replay.
- `hybrid.ts` — the **shared, backend-agnostic ranking core**: `rankKeywordCandidates()` (IDF relevance over a store-supplied candidate pool + df/N stats) and `fuseHybrid()` (co-equal RRF over a keyword list and a vector list + the bounded recency/confidence second stage). Pure — no I/O, no clock. Both stores call it after doing their own retrieval, so recall ordering is the same across backends.
- `tokenize.ts` — lowercase / split / drop-1-char / **dedupe** → tokens.
- `namespace.ts` — `serializeNamespace()` + `MemoryScopeTuple`.
- `reconcile.ts` — `classifyWrite()` (deterministic add/update/supersede).
- `index.ts` — barrel (also re-exports `rankKeywordCandidates` / `fuseHybrid`).

**`@dawn-ai/memory-pgvector`** — the Tier-2 Postgres + pgvector `MemoryStore` backend (production / multi-instance):
- `schema.ts` — `vectorColumnDef()` (the pure `vector` ≤2000 / `halfvec` ≤4000 dimension branch + cosine ops) and idempotent `initSchema()` (extension, tables, token indexes, HNSW index).
- `pgvector-store.ts` — `pgvectorMemoryStore()`: a full `MemoryStore` over a `pg` pool. Retrieves in SQL (HNSW `<=>` cosine top-K vector list + a token-matched keyword pool with live df/N), then ranks through the shared `rankKeywordCandidates` / `fuseHybrid` core — same ordering as sqlite. Lazy idempotent schema init; `close()` ends the pool.
- `queries.ts` — SQL strings + `rowToRecord` / `pageAndTagFilter` (mirrors the sqlite bodies).

**`@dawn-ai/sdk`**
- `memory.ts` — `defineMemory({ kind, scope, schema, identity? })` (author API).

**`@dawn-ai/core`**
- `capabilities/built-in/memory.ts` — the L3 capability: contributes `recall`/`remember` tools + the memory-index prompt fragment.
- `capabilities/built-in/memory-md.ts` — the L2 fragment.
- `capabilities/types.ts` — `MemoryContext`, `MemoryStoreLike`, `PromptFragment` (note `cacheKey`).
- `types.ts` — `DawnConfig.memory` config shape.

**`@dawn-ai/cli`**
- `lib/runtime/resolve-memory.ts` — `resolveMemoryStore()`, `resolveMemoryWrites()`, `buildMemoryContext()`, `routeNamespaceKey()`.
- `lib/runtime/execute-route.ts` — registers the marker, builds `MemoryContext` per request, applies capabilities.
- `lib/typegen/run-typegen.ts` — `MEMORY_EXTRA_TOOLS` + `hasMemory()` detection.
- `commands/memory.ts` — the `dawn memory` CLI.

**`@dawn-ai/langchain`**
- `agent-adapter.ts` — materializes the agent; folds the fragment `cacheKey` into the materialize cache.

**`@dawn-ai/testing`** — `seedMemory()` + `runMemoryStoreConformance()` (the shared `MemoryStore` contract kit; see §4). **`@dawn-ai/evals`** — `memoryRecalled`/`memoryFresh`/`memoryIsolated` scorers.

## 3. The data model

```ts
interface MemoryRecord {
  id: string                 // data-derived: memory_ + sha1(namespace | JSON(data)).slice(16)
  kind: "semantic" | "episodic" | "procedural" | "reflection"  // only semantic is wired
  namespace: string          // e.g. "workspace=app|route=/research"
  content: string            // human-readable summary (what recall prints)
  data: Record<string, unknown>   // the typed payload, validated against the route schema
  source: { type: "run"|"user"|"tool"|"eval"|"human"; id: string }
  confidence: number         // 0..1 — blended into ranked recall (default weight 0.1)
  tags: readonly string[]
  status: "candidate" | "active" | "superseded"
  supersedes?: readonly string[]
  createdAt: string; updatedAt: string
  effectiveAt?: string; expiresAt?: string   // episodic temporal fields — declared, UNUSED
}
```

Two things to notice: the schema is **forward-looking** (all four kinds + temporal fields
exist but only `semantic` is implemented), and **`confidence` now earns its keep** — ranked
recall blends it into the composite score (default weight 0.1; see §4).

**Status lifecycle:** `candidate` → (approve) → `active` → (contradicted) → `superseded`.
Supersession never deletes; the old row flips status and the new row records `supersedes: [oldId]`.

**The `id` is data-derived** (`sha1(namespace | JSON(data))`), so the *same fact* always
maps to the same id (idempotent), while a *contradicting value* gets a new id and can coexist
as `active` while the old goes `superseded`.

## 4. Storage internals (`sqlite-store.ts`)

Two tables (migration v1):

```sql
memories(id PK, kind, namespace, content, data, source, confidence,
         tags, status, supersedes, created_at, updated_at, effective_at, expires_at)
  INDEX (namespace, status, updated_at DESC)
memory_tokens(memory_id FK→memories ON DELETE CASCADE, token)
  INDEX (token), INDEX (memory_id)
```

`memory_tokens` holds **one row per distinct token per memory** — `tokenize()` dedupes,
so term-frequency is not stored (every TF = 1). This is the key constraint for ranking:
**IDF is computable** (count memories per token) but classic **BM25 TF is not**, without a
schema migration.

`reindex(record)` deletes the memory's token rows and re-inserts tokens from
`content + tags + data values`. So recall matches against the content, the tags, and the
stringified data — not just `content`.

**`search(query)` today (ranked, this branch):**
1. `status` defaults to `active`, `limit` to `8`. Tokenize the query.
2. **Zero tokens** (or no `query` at all) → the original SQL path, unchanged:
   `WHERE namespace = ? AND status = ?` [`AND kind = ?`], `ORDER BY updated_at DESC, id ASC LIMIT ?`.
   The index fragment, `listCandidates`, and `dawn memory list` all live here — query-less
   consumers keep pure recency.
3. **≥ 1 token** → **candidate pool**: same SQL filter plus the token-overlap `IN` subquery,
   ordered `updated_at DESC, id ASC`, capped at `candidatePool` (default **256**) instead of
   the caller's `limit`.
4. **Live corpus stats** — one `COUNT` for `N` (rows matching the base filter) and one
   grouped count for per-token `df`, computed fresh per search. Nothing is precomputed, so
   there are no stats to drift.
5. **Score** each candidate with the pure `scoreMemory()` (`score.ts`): IDF-weighted overlap
   fraction (weight 0.6) + exponential recency decay (0.3, half-life 14 days) + stored
   `confidence` (0.1).
6. **Sort** `score DESC, updated_at DESC, id ASC` (codepoint compare, matching SQLite BINARY
   collation), apply the caller's `limit`, then the optional tag filter in JS (unchanged).

So the *filter* and the *ranking* are both token-aware now: a six-week-old memory matching
the query's rare tokens outranks yesterday's marginal one-token match. Tuning lives in
`DawnConfig.memory.recall` (`weights` / `recencyHalfLifeMs` / `candidatePool`; non-positive
or non-finite half-life/pool values fall back to defaults); a custom `config.memory.store`
bypasses it entirely. Matching is still exact-token — no stemming.

**Hybrid path (opt-in vector recall).** Migration **v2** adds two nullable columns —
`embedding BLOB` (a Float32 vector) and `embedding_model TEXT` (the embedder id that produced
it). The keyword-only ranked path above is unchanged; the hybrid path is **gated on
`q.queryEmbedding`** (plus `q.embedderId`) and never runs otherwise:

1. **Keyword list** — the same candidate pool as above, but ranked by *relevance only*
   (recency/confidence weights zeroed) to produce a rank-ordered id list.
2. **Vector list** — brute-force cosine (`cosineSimilarity`, `vector.ts`) over rows whose
   `embedding_model = q.embedderId` and `embedding IS NOT NULL`; sorted, capped at `vectorK`
   (default 64). Rows with a mismatched embedder tag are ignored → graceful keyword-only
   fallback across a model change.
3. **Fusion** — the keyword and vector id lists are fused co-equally by `fuseRRF` (RRF: an id
   absent from a list contributes 0, so the fused set is the **union**). Per-list `weights`
   and `rrfK` are tunable.
4. **Second stage** — the union of records is re-scored `rrf * (1 + recencyWeight·recencyDecay
   + confidenceWeight·confidence)` (bounded boosts reusing the exported `recencyDecay`), then
   sorted `score DESC, updated_at DESC, id ASC`, limited, and tag-filtered.

Determinism holds under a fixed embedder: all steps are pure arithmetic over the supplied
embedding, with the same stable `updated_at, id` tiebreak. The store never embeds — the
capability supplies `queryEmbedding`; the store persists `{embedding, embeddingModel}` passed
to `put`. Store-side default tuning comes from `sqliteMemoryStore({ vector })`, overridable
per-query via `q.vector`.

**The ranking core is shared, not per-store (`hybrid.ts`).** The two reusable pure pieces of
the ranked path above — IDF relevance over a candidate pool, and RRF fusion + the recency/
confidence second stage — live in `hybrid.ts` as `rankKeywordCandidates()` and `fuseHybrid()`.
`sqlite-store.ts` does its retrieval (SQL over `node:sqlite`) and then calls them; the
`@dawn-ai/memory-pgvector` store does *its* retrieval (HNSW `<=>` cosine top-K + a token-matched
keyword pool over `pg`) and calls the **same** functions. So a backend can only change *where
data lives and how it is retrieved*, never *how results are ranked* — recall ordering is the
same across sqlite and pgvector. This parity is enforced, not just asserted: the shared
`runMemoryStoreConformance()` kit (`@dawn-ai/testing`) runs one `MemoryStore` contract (put/get,
namespace isolation, query-less recency, supersede, candidate listing, the hybrid/vector-recall
cases) against **sqlite** in-process on every run, and against **real pgvector** in a gated
Testcontainers lane (`DAWN_TEST_PGVECTOR=1`, `pgvector/pgvector:pg16`; skipped otherwise).

**`classifyWrite()` (`reconcile.ts`)** decides add/update/supersede deterministically by
comparing the incoming record's identity key (default `["subject","predicate"]`) against
existing active records — no LLM. The capability uses this logic in `auto` mode.

## 5. The author contract

A route opts into L3 by adding `memory.ts` next to `index.ts`:

```ts
// src/app/research/memory.ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],            // namespace dimensions
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
  // identity?: ["subject","predicate"]      // defaults for semantic
})
```

`scope` decides isolation: `["workspace","route"]` → namespace `workspace=app|route=/research`,
so two routes (and two apps) never read each other's memories. `schema` is the zod shape of a
fact's `data`, enforced at write time. (L2 is even simpler: drop a `memory.md` file; its text
is injected. No declaration needed.)

## 6. Typegen

`run-typegen.ts` checks `hasMemory(routeDir)` (does `memory.ts` exist?) and, if so, appends
`MEMORY_EXTRA_TOOLS` to the route's generated `.dawn/dawn.generated.d.ts` — typed `recall`
and `remember`. Caveat: generated `remember.data` is typed `Record<string, unknown>`, not the
route's zod schema — compile-time field types on the write path are deferred. (The schema *is*
enforced at runtime.)

## 7. The L3 capability (`built-in/memory.ts`)

`detect`: active iff the CLI built a `context.memory` (i.e. the route has `memory.ts`).
`load(context)` returns a `CapabilityContribution` with:

- **`recall` tool** — schema `{ query?, kind?, tags?, limit? }`; calls `store.search()`; prints `id: content` lines or `(no memories found)`.
- **`remember` tool** (omitted when `writes: "off"`) — schema `{ data: <route schema>, content?, tags?, confidence? }`; `validate(data)` → `store.put()` as `active` (auto) or `candidate`; auto mode runs add/update/supersede inline.
- **`promptFragment`** — the memory index: up to `indexMaxEntries` (default 20) active records, content sliced to 80 chars, under a `# Long-Term Memory` heading, `placement: "after_user_prompt"`.

> The `recall`/`remember` **input schemas** are the #257 fix. Before it, the tools shipped
> with no schema, so a real model called them with empty/invalid args and every write was
> rejected by `validate()` — memory was unusable by an actual agent. `remember.data` is now
> the route's own `defineMemory()` schema, threaded through `MemoryContext.schema`.

**The index `cacheKey` (the #257 staleness fix):** the index is computed once at `load()`
time and the fragment's `render()` closes over that snapshot. The fragment now also exposes
`cacheKey = sha1(indexEntries.map(id@updatedAt))`. `agent-adapter` computes a
`fragmentFingerprint` over all fragments' `cacheKey`s and folds it into the per-descriptor
materialize cache. When a memory is written, the fingerprint changes, so the next run
re-materializes the agent with a fresh index instead of serving the stale snapshot. (The
`recall` tool was always live; this fixed the *hint* specifically.)

## 8. CLI runtime wiring (`resolve-memory.ts` + `execute-route.ts`)

Per request, `execute-route` builds a `MemoryContext` via `buildMemoryContext()`:

- **store** — `resolveMemoryStore(appRoot)`: `config.memory.store` if set, else `sqliteMemoryStore({ path: <appRoot>/.dawn/memory.sqlite })`.
- **namespace** — derive `{ workspace: basename(appRoot), route: routeNamespaceKey(routePath), ...resolveScope?.() }`, restrict to the dimensions the route declared in `scope`, then `serializeNamespace()`. `routeNamespaceKey()` normalizes a file path (`src/app/research/index.ts`) to a clean route id (`/research`) — regex-free (a CodeQL-ReDoS-driven choice).
- **writes** — `resolveMemoryWrites(appRoot)`: `config.memory.writes ?? "candidate"`.
- **schema / validate** — the route's zod schema + a `validate(data)` wrapper.
- **now** — request timestamp (lib code is deterministic — no `Date.now()` inside `@dawn-ai/memory`; the capability takes `context.memory.now`).

`execute-route` then runs `applyCapabilities`, which calls `memory.load(context)` and merges
its tools + prompt fragment into the route.

## 9. Request lifecycle (end to end)

1. HTTP run (`POST /threads/:id/runs/wait`) → `execute-route`.
2. `buildMemoryContext` (store, namespace, writes, schema, now).
3. `applyCapabilities` → `memory.load()` → searches the store for the index, returns `recall`/`remember` + the index fragment.
4. `agent-adapter.materializeAgent` → prompt = `systemPrompt` + fragments (fingerprint-keyed cache); toolset includes `recall`/`remember`.
5. Model turn:
   - `recall({ query })` → `store.search(namespace, query)` → rows. **← smarter recall lives here.**
   - `remember({ data })` → `validate` → `store.put` (+ reconcile in auto mode).

## 10. Write governance

`DawnConfig.memory.writes` (default `candidate`):

| Mode | `remember` tool | Write lands as | Reconciliation |
|---|---|---|---|
| `off` | not generated (recall-only) | — | — |
| `candidate` *(default)* | generated | `candidate` (hidden from recall) | none |
| `auto` | generated | `active` immediately | inline add/update/supersede |

Candidates are managed out-of-band with the `dawn memory` CLI:
`list` / `search <q>` (substring filter over candidates, **not** the agent's tokenized recall) /
`inspect <id>` / `approve <id>` (→ active) / `reject <id>` (hard delete) / `forget <id>` (hard
delete). Note: supersession/reconciliation runs only on `auto` writes — approving a candidate
just flips its status; it does not reconcile contradictions. Permission-gated `auto` writes
were specced but not shipped (auto writes are not gated by `@dawn-ai/permissions`).

## 11. Config surface (`DawnConfig.memory`)

```ts
memory?: {
  enabled?: boolean        // NOT read — L3 activates purely on memory.ts presence
  store?: MemoryStoreLike  // default: sqlite at .dawn/memory.sqlite
  writes?: "off" | "candidate" | "auto"   // default "candidate"
  indexMaxEntries?: number // default 20
  resolveScope?: (ctx) => Record<string,string>   // fill tenant/user/agent per request
}
```

## 12. Testing surfaces

- **Unit** (`@dawn-ai/memory`): store, tokenize, namespace, reconcile.
- **Capability** (`@dawn-ai/core`): tool behavior + index fragment.
- **`seedMemory`** (`@dawn-ai/testing`): insert rows directly in tests.
- **Scorers** (`@dawn-ai/evals`): `memoryRecalled` / `memoryFresh` / `memoryIsolated`.
- **Deterministic e2e** (aimock, CI-safe): cross-thread remember→recall; `memory-index-refresh.test.ts` (mid-process index refresh).
- **Gated live smoke** (`memory-live.smoke.test.ts`, `skipIf(!OPENAI_API_KEY)`): real-model remember/recall/supersession/isolation/index/candidate flow. Skips in CI.

## 13. Current limitations & deferred roadmap

Shipped: the `semantic` kind with ranked keyword recall — IDF-weighted relevance blended with
recency decay and stored confidence — **plus opt-in hybrid vector recall** (keyword ∪ vector,
RRF-fused, bounded recency/confidence second stage; see §4). Vector recall is enabled by
supplying `DawnConfig.memory.vector.embedder`; absent, recall is the unchanged keyword path.
The **Tier-2 Postgres / pgvector store backend** (`@dawn-ai/memory-pgvector`) also ships now:
HNSW + cosine retrieval in SQL, the same shared ranking core, dimension branch (`vector` ≤2000 /
`halfvec` ≤4000), enabled via `config.memory.store` (see §4). Explicitly still deferred (spec
§"Out of scope"):

- `episodic` / `procedural` / `reflection` kinds; episodic-from-traces; background consolidation.
- BM25/FTS5 (term frequency is not stored).
- Faster ANN over the *local* store — a `sqlite-vec` middle tier. Vector recall on the sqlite
  backend is brute-force cosine in JS over Float32 BLOBs (fine for typical per-namespace corpora;
  linear in matching rows); the pgvector backend already uses an HNSW index for larger corpora.
- pgvector follow-ups: `pgvectorscale` / DiskANN indexing, and pushing the RRF fusion down into
  SQL (today pgvector retrieves both lists and fuses in the shared JS core).
- Memory graph (edges/relations).
- Dev-server Memory Inspector UI (no dev UI host exists today).
- Schema-typed `remember.data` in typegen.

## 14. Where "smarter recall" plugged in (DONE — this branch)

It landed exactly where §4 describes: one function, `search()` in `sqlite-store.ts`, now
runs pool → live df/N stats → pure `scoreMemory()` (`score.ts`) → sort → limit for ranked
queries. Everything upstream (capability, tools, context-building, prompt index) was left
untouched, and no-query searches (the index, `listCandidates`) kept pure-recency behavior.
Determinism held: all-arithmetic scoring + the stable `updated_at, id` tiebreak kept aimock
fixtures and eval scorers green. The next natural step, vector / embedding recall, has since
shipped as an opt-in hybrid path (see §4): rather than a fourth blended signal, it adds a
second candidate list (vector-nearest) fused co-equally with keyword by RRF, keeping the
exported `recencyDecay` from `score.ts` for its bounded second stage.

## 15. Glossary

- **namespace** — the isolation key, `dim=value|...` over `workspace,route,tenant,user,agent`.
- **identity key** — the fields (default `subject,predicate`) that decide whether a new write updates/supersedes an existing fact.
- **index / index hint** — the `# Long-Term Memory` block injected into the prompt listing recallable memories. A hint; the source of truth is the `recall` tool.
- **candidate** — a written-but-unapproved memory, hidden from recall until promoted.
- **reconciliation** — deterministic add/update/supersede classification on write (`auto` mode only).
