# @dawn-ai/memory

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/sqlite-storage@0.8.23

## 0.8.22

### Patch Changes

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 3c68800: `BrowseQuery.status` and `.kind` now accept a set, not just one value.

  `browse({ status: ["candidate", "superseded"] })` matches any of them. A bare
  value behaves exactly as before, so every existing caller is unaffected.

  An **empty** set matches nothing rather than everything: "any of none" is false,
  and reading it as "unfiltered" would show every row to a caller that had just
  narrowed its filter to zero. Both backends implement it — sqlite via `IN (…)`,
  Postgres via `= ANY($n::text[])`, where an empty array is already false — and
  five new contract tests in `runMemoryStoreConformance` hold them to the same
  reading, including that `total` counts the whole matching set.

  The Inspector's list route accepts the filter repeated (`?status=a&status=b`).
  One bad value rejects the request rather than being silently dropped. A param
  that appears zero times is absent, not an empty set, so the empty-set rule is
  unreachable over HTTP.

- 8398c90: `BrowseQuery` grows a real query language, and `BrowsePage` grows a continuation.

  **Breaking for anyone who implements `MemoryStore` themselves.** `BrowsePage.continuation`
  is required, and `browse` must now honor `filters`, `namespace`, `orderBy` and `cursor`.
  Run `runMemoryStoreConformance` from `@dawn-ai/testing`: it is the definition of the new
  obligations, and it runs against SQLite in-process and against a real Postgres behind
  `DAWN_TEST_PGVECTOR=1`. Both bundled stores are updated.

  New on `BrowseQuery`:

  - `filters` — AND-combined normalized predicates, at most one per field and eight in
    total: `status`/`kind` (`in`/`notIn`), `content`
    (`contains`/`notContains`/`equals`/`notEquals`/`startsWith`/`endsWith`, case-insensitive
    substring — not LIKE, so `%` and `_` are literal), `namespace` (`equals`/`startsWith`,
    byte-exact), `confidence` (comparisons plus an inclusive `between`), and `updatedAt`
    (`onDay`/`beforeDay`/`afterDay`/`betweenDays` over UTC day buckets).
  - `namespace` — an EXACT namespace, distinct from the prefix. `namespacePrefix` keeps its
    byte-exact semantics and is now a sargable range instead of a `substr()` scan.
  - `orderBy` — up to three entries over a closed whitelist
    (`updatedAt`/`createdAt`/`confidence`/`namespace`/`kind`/`status`), always terminated by
    an `id` tie-break so every window is deterministic. Absent or empty is still
    `updated_at DESC`.
  - `cursor` — an opaque keyset continuation. It carries a fingerprint of the query that
    issued it, so replaying it against a different filter or sort is rejected rather than
    silently answering the wrong question.

  `BrowsePage.total` is now read from the same transaction snapshot as `records` (SQLite
  `BEGIN DEFERRED`, Postgres `REPEATABLE READ`), so a response can no longer report rows and
  a count from two different versions of the table. It remains the size of the whole
  matching set, never what is left after a cursor.

  `validateBrowseQuery` is exported (also from the pure `@dawn-ai/memory/browse` subpath,
  which never pulls `node:sqlite`). Both stores run it defensively and throw; the Inspector's
  list route runs it at the HTTP boundary and returns 400. An unknown enum value used to
  match zero rows and look like an empty dataset — now it is an error. `limit` is bounded to
  1..1000 at the HTTP boundary only; in-process callers such as the CLI's consolidation scan
  are unaffected.

  `@dawn-ai/core`'s structural mirror is now the named `BrowseQueryLike` / `BrowsePageLike`
  (plus `BrowseFilterLike` / `BrowseSortEntryLike`), compared directly by the contract-parity
  tripwire. The previous inline shape drifted silently because method parameters are checked
  bivariantly.

  Both backends gain an index on the global browse order (`updated_at DESC, id ASC`);
  Postgres also gains a C-collated namespace index so the prefix range is sargable there.

- Updated dependencies [bedad77]
  - @dawn-ai/sqlite-storage@0.8.22

## 0.8.21

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.20

## 0.8.19

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.19

## 0.8.18

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.18

## 0.8.17

### Patch Changes

- 7f4bce6: Memory distillation: `dawn memory consolidate` and `dawn memory reflect`.

  Two explicitly-invoked passes that compact accumulated memories. Neither runs
  automatically — nothing is wired into the runtime, a request, or the lazy
  retention pass.

  **`dawn memory consolidate`** groups active episodic records older than
  `consolidate.olderThanMs` (default 7 days) per (namespace, ISO week), spends one
  model call per batch, and writes a summary record (kind `episodic`, tagged
  `consolidated`, `data = { period, sourceCount, derivedFrom }`, `effectiveAt` at
  the window's end, no expiry by default). The summary is written FIRST and its
  sources superseded only afterwards, so a crash leaves a redundant summary rather
  than orphaned sources with nothing summarizing them. Each superseded source is
  additionally stamped with `consolidate.sourceTtlMs` (default 7 days) so the
  normal prune reaps it later — a superseded row is invisible to `recall` but still
  occupies a slot in the per-namespace episodic cap. Summaries are never
  re-consolidated (`data.derivedFrom` excludes them from every pass).

  **`dawn memory reflect`** derives durable insights per namespace from records
  newer than that namespace's watermark (the highest `data.coveredUntil` on its
  existing reflections), between `reflect.minNewRecords` (10) and
  `reflect.maxRecords` (100). Insights are written as **candidates by default**
  (`reflect.writes: "candidate" | "auto"`) — a model's generalization about your
  users gets a human read before `recall` can surface it. Approve them with
  `dawn memory approve` or the Inspector, exactly like any other candidate write.

  **Cron-safe.** Both commands share the flags
  `[--dry-run] [--namespace <prefix>] [--model <id>] [--provider <id>] [--max-batches <n>]`
  and are threshold-aware no-ops: below the thresholds they print one line, exit
  `0`, and never construct a model — so they never read an API key. `--dry-run`
  reports the full plan while making zero model calls, and `--max-batches`
  (default 5) bounds the spend of any single invocation. That makes
  `0 3 * * * cd /srv/app && npx dawn memory consolidate && npx dawn memory reflect`
  free on an idle app and safe on an app with no credentials configured.

  Configured under `memory.distill` in `dawn.config.ts` (`model` defaults to
  `gpt-5-mini`; `provider` is inferred from the model id, falling back to
  `openai`).

  **Distilled records are written to be findable.** Recall is keyword match, and a
  model asked to generalize writes an abstraction that names none of its sources
  ("earlier-week deployment windows are lower risk" for a batch about _griffin_) —
  which no realistic question retrieves, and for consolidation the sources that did
  carry the name are already superseded. Both distillation prompts now require the
  concrete entities (service and project names, ticket/error identifiers,
  filenames, people) to be carried through verbatim. Measured live, this is the
  difference between an insight that ranks first for "griffin deploys" and one that
  does not appear at all.

  **`recall` no longer invites guessed time windows.** The `since`/`until` schema
  descriptions now steer the model to relative offsets (`"-7d"`, resolved against
  the request clock) and state that it does not know today's date. A model asked
  "what did I work on last week?" would otherwise supply an absolute window from
  around its training cutoff — observed live: a 2026 store queried with
  `since: "2023-10-02"` — which matches nothing, silently, because an empty result
  is indistinguishable from an empty store.

  **Placeholder model output can never destroy history.** Both prompts end with
  their own schema example (`{"summary": "..."}`); a model that echoes it back
  returns a payload that is structurally valid and semantically empty. Written, that
  summary would then supersede the real episodes it claims to summarize — whose
  content is the only other copy. A summary or insight carrying no letter and no
  digit anywhere is now a parse failure, so the batch fails loudly and its sources
  stay active.

  **A zero-insight reflection pass still advances the watermark.** It persists one
  `superseded` sentinel (content `(no insights from this pass)`) carrying
  `coveredUntil`, invisible to `recall`. Without it, a namespace whose memories
  legitimately yield no durable insight was re-examined — and re-paid for — on
  every cron run, forever.

  **One failed source link can no longer split a batch.** A batch is the atom of
  idempotency (its summary id hashes its own source-id list), so each source's
  supersede/expiry pair is now isolated: a transient failure on one source leaves
  that source active and unstamped while the rest of the batch links normally,
  instead of leaving the survivors to form a different chunk — and a second
  overlapping summary — on the next run. The batch still reports as failed.
  `--max-batches 0` now reports the deferred work rather than claiming there is
  nothing to do.

  **`kind: "reflection"` is now accepted** by `defineMemory` and the generated
  `remember` tool, where it previously threw. Reflections are append-only, like
  episodic writes — a later insight never supersedes an earlier one. This is
  **additive, not breaking**: no existing app changes behavior and no action is
  required. `procedural` remains typed-but-unwired and still throws.

  - @dawn-ai/sqlite-storage@0.8.17

## 0.8.16

### Patch Changes

- d845720: Runtime edge-readiness (deploy-anywhere B3, PR 1 of 3).

  New `@dawn-ai/cli/fetch` entry exposes the web-standard runtime with a module
  graph that contains none of Dawn's own filesystem, SQLite, or CLI code —
  enforced by an esbuild-metafile test that also pins the remaining upstream
  `node:` edges so the set can only shrink.

  `serveRuntime`/`startRuntimeServer`/`createRuntimeFetchHandler` now accept an
  injected checkpointer, threads store, permissions store, memory store,
  middleware, and a `DawnConfig` object (`seedDawnConfig`). With everything
  supplied, nothing reads `dawn.config.ts` or opens SQLite — including subagent
  turns, which previously rebuilt their own stores. On the injected path a
  missing store fails loudly at boot instead of silently falling back.

  Capability markers read through a new sync `MarkerFs` facade (node
  implementation behind `@dawn-ai/core/node`), the subagents descriptor map is
  derived from the static module manifest with no dynamic imports, the manifest
  now carries `src/middleware.ts`, and `@dawn-ai/memory` gained pure
  `./namespace` and `./reconcile` subpaths. Behavior with nothing injected is
  unchanged.

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [2da55fa]
  - @dawn-ai/sqlite-storage@0.8.16

## 0.8.15

### Patch Changes

- 029a2cf: Episodic memory: Dawn apps can now remember what happened. An opt-in runtime
  recorder (`memory.episodes.enabled`) writes one episode per agent run from the
  trace — input, outcome, tools used, duration — with TTL + per-namespace cap
  retention; routes can also author episodes via `defineMemory({ kind: "episodic" })`
  (append-only, never superseded). `recall` gains `since`/`until` time windows
  (ISO or relative like "-24h"); the Inspector gains a timeline view; `dawn memory
prune` runs retention manually.

  BREAKING: `MemoryStore` now requires `prune(opts)`; `search`/`browse` accept
  `since`/`until` and exclude expired rows when `now` is supplied. Custom stores
  must implement `prune` (`runMemoryStoreConformance` enforces the contract).

  - @dawn-ai/sqlite-storage@0.8.15

## 0.8.14

### Patch Changes

- 937be0f: New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
  Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
  memories with supersede-aware approval. Ships as a scaffold devDependency.

  BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
  must implement them (the built-in sqlite/pgvector stores already do, and
  `runMemoryStoreConformance` enforces the contract). The config-facing store type is
  now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
  contradicting active row instead of leaving two actives.

  - @dawn-ai/sqlite-storage@0.8.14

## 0.8.13

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.13

## 0.8.12

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.10

## 0.8.9

### Patch Changes

- ca9bc13: Add `@dawn-ai/memory-pgvector` — a Postgres + pgvector MemoryStore backend for
  production/multi-instance vector memory. Enable with
  `memory: { store: pgvectorMemoryStore({ connectionString, dimensions }) }`. HNSW
  (cosine) vector retrieval; reuses the exact same pure hybrid ranking (RRF +
  recency/confidence) as the default sqlite backend, so recall ordering is
  identical across backends. Adds a shared `runMemoryStoreConformance` kit
  (@dawn-ai/testing) run against both backends. Dimensions ≤2000 use `vector`,
  ≤4000 use `halfvec` (text-embedding-3-large); pgvectorscale/DiskANN and in-SQL
  RRF are deferred. Also pins `openaiEmbedder` to float embedding encoding
  (`encodingFormat: "float"`) — avoids a base64 decode interop quirk that could
  yield wrong embedding dimensionality against some proxies/mocks.
- 1dd2147: Opt-in vector/semantic recall for long-term memory. Enable with
  `memory: { vector: { embedder: openaiEmbedder() } }`: recall becomes hybrid —
  keyword (IDF) and vector (cosine) candidate lists fused co-equally by Reciprocal
  Rank Fusion, with a bounded recency/confidence second stage. Keyword recall is
  never dropped (dense retrieval is weak on exact IDs/codes/names), and default
  keyword-only recall is unchanged. Pluggable `Embedder` (`openaiEmbedder`,
  `fakeEmbedder`); embeddings stored as Float32 BLOBs in the existing node:sqlite
  store (zero new native deps), tagged by embedder id with graceful keyword-only
  fallback on model change. pgvector is a planned follow-up backend.
  - @dawn-ai/sqlite-storage@0.8.9

## 0.8.8

### Patch Changes

- 26780ab: `serializeNamespace` now percent-encodes the reserved delimiters (`%`, `|`, `=`) in scope dimension values, so a `tenant`/`user`/`agent` value (from `resolveScope`) or an oddly-named workspace/route containing a delimiter can no longer corrupt the namespace or collide across scopes. Ordinary values (no reserved chars) are unchanged, so existing stored memories and persisted permission patterns keep matching byte-for-byte.
  - @dawn-ai/sqlite-storage@0.8.8

## 0.8.7

### Patch Changes

- 6a683c8: Smarter recall: long-term-memory `recall` now ranks results by IDF-weighted
  relevance blended with recency decay and stored confidence, instead of pure
  recency — a six-week-old fact that actually answers the query outranks
  yesterday's marginal match. Deterministic (no clock, no network, no new deps;
  same store + same query → same order), zero-config (tune via
  `DawnConfig.memory.recall` only if needed), and query-less searches (the
  injected index, `dawn memory list`) keep their recency order.
  - @dawn-ai/sqlite-storage@0.8.7

## 0.8.6

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.6

## 0.8.5

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.5

## 0.8.4

### Patch Changes

- @dawn-ai/sqlite-storage@0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.
  - @dawn-ai/sqlite-storage@0.8.3
