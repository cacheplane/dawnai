---
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/core": patch
"@dawn-ai/testing": patch
"@dawn-ai/inspector": patch
---

`BrowseQuery` grows a real query language, and `BrowsePage` grows a continuation.

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
