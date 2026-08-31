# @dawn-ai/memory-pgvector

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

- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [8398c90]
  - @dawn-ai/memory@0.8.22

## 0.8.21

### Patch Changes

- @dawn-ai/memory@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/memory@0.8.20

## 0.8.19

### Patch Changes

- 4102312: Handle `pg` pool errors instead of crashing the process.

  Both Postgres-backed packages created their `pg` `Pool` with no `'error'` listener.
  `pg` emits that event on the **pool** when an **idle** client fails, and an
  EventEmitter `'error'` with no listener is an uncaught exception — so the process
  exits. Idle connections are dropped as a matter of course: a server restart, a
  failover, `idle_session_timeout`, a container stopping. Any of those took the whole
  app down instead of the pool quietly replacing one connection.

  This surfaced as a CI flake — the `pgvector-docker` lane failing _after_ all 50 tests
  passed, because stopping the test container terminates idle clients with `57P01` — but
  the flake was the symptom. The same defect applied in production, and most sharply in
  `@dawn-ai/postgres-storage`, whose checkpointer, threads and permissions stores hold
  durable agent state for exactly the long-running and edge deployments where connection
  drops are routine.

  Pools these packages own now log a warning and carry on; `pg` has already discarded the
  broken client, and the next query transparently opens a new one. A caller-supplied
  `pool` is left untouched — its owner controls its lifecycle and error handling. In
  `@dawn-ai/postgres-storage` the three stores now share one `resolvePool` helper, so the
  rule cannot drift between them.

  Both packages gained a test that terminates a live idle connection with
  `pg_terminate_backend` and asserts no uncaught exception, that the drop was logged, and
  that the store still serves the next query. Both fail without the fix.

  - @dawn-ai/memory@0.8.19

## 0.8.18

### Patch Changes

- @dawn-ai/memory@0.8.18

## 0.8.17

### Patch Changes

- Updated dependencies [7f4bce6]
  - @dawn-ai/memory@0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [d845720]
- Updated dependencies [2da55fa]
  - @dawn-ai/memory@0.8.16

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

- Updated dependencies [029a2cf]
  - @dawn-ai/memory@0.8.15

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

- Updated dependencies [937be0f]
  - @dawn-ai/memory@0.8.14

## 0.8.13

### Patch Changes

- @dawn-ai/memory@0.8.13

## 0.8.12

### Patch Changes

- @dawn-ai/memory@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/memory@0.8.11

## 0.8.10

### Patch Changes

- e3c253b: Type generated `remember.data` from each route's `defineMemory()` Zod schema
  instead of `Record<string, unknown>`, so route code gets compile-time memory fact
  shape checks that match runtime validation. `pgvectorMemoryStore()` now validates
  the dimension ceiling during construction, failing invalid configs before opening
  a pool or initializing schema.
  - @dawn-ai/memory@0.8.10

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
- Updated dependencies [ca9bc13]
- Updated dependencies [1dd2147]
  - @dawn-ai/memory@0.8.9
