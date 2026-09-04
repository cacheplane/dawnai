# @dawn-ai/inspector

## 0.8.25

### Patch Changes

- @dawn-ai/core@0.8.25
- @dawn-ai/memory@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/core@0.8.24
- @dawn-ai/memory@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/core@0.8.23
  - @dawn-ai/memory@0.8.23

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
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

- f5fae17: Bulk actions now prune succeeded ids from the selection, so a retry after a partial
  failure re-sends only the failures and can never repeat a completed delete. Polling
  pauses for the duration of a bulk run.
- a26edae: Make the memory browse honest about what it is showing.

  The list is no longer polled through `usePolling`, which documents its own
  last-write-wins hole: a new `useMemoryBrowse` hook owns a desired query revision
  that any canonical-query change bumps, and **every response is discarded whole
  unless its revision is still the desired one**. Aborting the superseded request is
  an optimization on top; correctness never depends on winning that race. Stats keep
  polling as before.

  - One browse request in flight at a time, with the contention case removed rather
    than handled: a tick that comes due while a request is in flight is skipped
    instead of racing it.
  - A poll tick refreshes the head of the window and reconciles: updated rows take the
    server's payload and position, rows that vanished from the refreshed span are
    dropped, and rows beyond the span are retained rather than evicted because inserts
    arrived above them.
  - A refresh failure does not blank the answer already on screen: those rows stay and
    the failure arrives as its own banner with a retry. A failure that leaves the
    desired query with nothing fulfilled — the first load, or a query change whose
    fetch fails while the previous question's rows are still up — holds the error
    state and suspends polling until a retry succeeds, so the failure does not flicker
    on a two-second cadence.
  - Pausing (live off, hidden tab, held error) replaces the freshness claim with an
    as-of stamp; resuming ticks immediately instead of waiting out the interval.
  - The list grid now receives `dataState` and `resultMeta` from
    `@pretable/react@0.3.0`, so loading, empty and error are body states of the grid
    rather than a table that happens to have no rows, and the server's count reaches
    the screen reader through the results announcement. A status line above both views
    reads "N loaded of M matching".
  - The timeline view no longer answers "No episodes in this window." while the window
    is still loading, or after loading it failed.
  - The namespace facet sends the exact `namespace` parameter instead of narrowing a
    prefix answer client-side — otherwise the total and the rows would describe
    different sets.

  `useMemoryBrowse` also arbitrates load-more against the poll cadence and keeps a
  separate failure slot for it.

- 3c68800: Memory Inspector: filter status and kind from the grid's column funnels.

  The two header selects are gone. Each funnel is a checklist of that column's
  values, so you can ask for "candidate or superseded" — which the selects, being
  single-choice, could not express.

  Filtering stays server-side: the funnels only decide the query, which sends the
  filter repeated (`?status=candidate&status=superseded`). Narrowing only the rows
  already loaded would quietly answer a different question, since the list is one
  page of a larger store. Every column's funnel therefore maps to a server
  predicate; a control that could only narrow the rows already on screen would
  mislead. Content is also what search is for, and namespace is what the facet
  rail scopes, with real counts.

  `is none of` is resolved against the column's options rather than needing
  negation downstream, and a filter that matches nothing now says "No memories
  match these filters" instead of claiming nothing has been stored yet.

- 3c68800: Group the Memory Inspector list by namespace when viewing all namespaces.

  Namespace-scoped views stay flat — every row would sit under one header — and so
  do truncated pages. Group headers count the rows the grid holds, so on a page
  capped below the store's size that number is an artifact of where the cap fell:
  it read "route=/notes (197)" beside a facet rail saying 250. The rail remains
  the honest navigator for anything larger than a page.

- f0aafae: The Memory Inspector's browse grid is server-authoritative.

  Filtering and sorting now reach the store instead of rearranging the loaded window.
  `content`, `namespace`, `confidence` and `updated` gain funnels — they had none,
  because a funnel over one page of a larger store answers a different question than
  the one it appears to ask — and every funnel declares a type and an operator list
  pruned to exactly what `BrowseQuery` honors: `status`/`kind` (`is any of` / `is none
of`), `namespace` (`equals` / `starts with`), `content` (the six substring and
  equality operators), `confidence` (comparisons and an inclusive range) and `updated`
  (UTC day operators). `is empty` / `is not empty` leave the `status` and `kind` menus,
  where they had been offered: no `BrowseFilter` arm expresses them and every browse
  field is NOT NULL, so they were controls the server ignored.

  Sorting comes back with them. Every browse column was non-sortable, because ordering
  a server-selected window locally re-ranks the wrong sample under a truthful-looking
  `aria-sort`; five columns are now sortable against the store's own ordering.
  `content` stays unsortable — the store's sort whitelist has no content field — and
  because the store accepts three sort keys, a fourth is declined with a notice rather
  than drawn as an active sort the server never applied.

  A funnel value the mapping cannot express is refused the same way: the query mapping
  rejects rather than silently dropping a clause, so the intent is declined and named
  in a notice, and the rows keep answering the question the server was actually asked.
  The notice names the control in the words on screen — "That confidence value is out
  of range, so the filter was not applied." — while the mapping's own message, which
  quotes the value it was handed, goes to the console for whoever is debugging.

  Also in this release:

  - The SEARCH grid no longer offers funnels. Search results are a ranked sample the
    store chose and carry no server authority to filter against, but the `status` and
    `kind` funnels were live there and narrowed that sample engine-side, under a header
    that looked exactly like the browse grid's.
  - Load-more is a control that sits outside the `role="grid"` element and stays
    focusable in every state, asking for the window that starts after the rows already
    resident. Residency is capped at 1 000 records — deliberately equal to the maximum
    request limit, so one head refresh always re-derives the whole resident span.
  - The facet rail's counts are labelled as global, because they come from the stats
    endpoint and describe every memory rather than the current query. Before that
    response lands, the total reads `—` rather than `0`.
  - The grid is no longer remounted to clear a selection; a `datasetKey` pivot clears
    selection, focus and group expansion in the same emit that lands the new rows.
  - The bulk action bar is withheld whenever the rows on screen answer a previous
    query — while the new one loads, and equally while it is failing and those rows
    are all that survived. Approving or forgetting a selection formed under a
    question the grid has stopped answering is the ambiguity this release exists to
    remove; the bar returns once the rows are the answer to what was asked.
  - While a search is running, browse-only controls are marked `aria-disabled` and stay
    focusable with an `aria-describedby` explanation, rather than staying active and
    being silently ignored.
  - An open column funnel closes when a search or the timeline takes the browse grid off
    screen. The funnel's panel is rendered outside the grid, so hiding the grid left it
    floating over whatever replaced it — the one browse control that stayed undimmed,
    unexplained and able to change the browse query from a surface nobody could see.
  - The timeline's episodic default now stands beside an _excluding_ `kind` funnel. It
    stands down only for a narrowing one, where leaving it on would AND two narrowings
    into the empty set; standing down for an exclusion instead widened the timeline to
    every kind the funnel had not excluded, while each row still read as an episode.

- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [8398c90]
- Updated dependencies [3c68800]
- Updated dependencies [908d690]
- Updated dependencies [d42774e]
  - @dawn-ai/core@0.8.22
  - @dawn-ai/memory@0.8.22

## 0.8.21

### Patch Changes

- 23c5f55: Memory Inspector: pick up the pretable 0.0.8 header theme fixes.

  Grid header labels were rendering in the body-cell colour, and the header's
  column dividers in a fixed colour rather than the grid's own rule token — both
  because inline styles on the header button beat the skin regardless of how it is
  layered. Headers are dimmer than cell text again, and their dividers match the
  body gridlines.

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/core@0.8.21
  - @dawn-ai/memory@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/core@0.8.20
- @dawn-ai/memory@0.8.20

## 0.8.19

### Patch Changes

- b6a264c: Memory Inspector: bulk approve, reject, and forget from the grid.

  Curating memory meant opening each candidate's detail sheet and approving it one
  at a time. The grid now has a checkbox column; ticking rows raises an action bar
  with the same verbs the sheet exposes. Approve and reject apply to the
  candidates in the selection — approving anything else is not a thing the store
  can do — while forget applies to everything ticked.

  Actions run one at a time, because approve reconciles against the other actives
  in its namespace and overlapping approvals would race each other into avoidable
  conflicts. If any fail, the bar says how many and why, and keeps the selection
  so the failures can be read and retried rather than silently disappearing.

  Requires `@pretable/react` 0.0.5 for `onRowSelectionChange`, added upstream for
  this (cacheplane/pretable#230) — the checkbox column already existed, but
  nothing could read what it had checked.

- 0aecfb3: Memory Inspector: the records grid now fills its container at any window width.

  Column widths were hand-tuned to sum to ~1030px so a row fit beside the facet
  rail on a 1280px screen — a number that was wrong on every other screen, leaving
  dead space on wide ones and overflowing narrow ones. The `content` column now
  takes whatever the other columns leave over, down to a 240px floor below which
  the grid scrolls instead of squeezing the text.

  Requires `@pretable/react` 0.0.6 for `column.flex`, added upstream for this
  (cacheplane/pretable#249) — nothing in the grid could size to its container.

- Updated dependencies [9dde7c6]
  - @dawn-ai/core@0.8.19
  - @dawn-ai/memory@0.8.19

## 0.8.18

### Patch Changes

- ed10fac: Memory Inspector: the records list is now a real `@pretable/react` grid, with column sorting.

  It shipped as a semantic `<table>` stand-in because `@pretable/react@0.0.2` was uninstallable — it hard-depended on `@pretable/ui@0.0.2`, which had never been published. `@pretable/ui` is on npm now, so the grid goes in behind the same `MemoryGrid` props and sorting arrives with it. Clicking a column header sorts by it; the `updated` column sorts chronologically rather than by its formatted text.

  Requires `@pretable/react`/`@pretable/ui` 0.0.3, which carry the fixes this integration prompted upstream: row activation via `onRowActivate`, columns reconciled in place rather than rebuilding the grid (so a sort survives live polling), and the header/cell CSS corrections.

- Updated dependencies [c6b08a9]
  - @dawn-ai/core@0.8.18
  - @dawn-ai/memory@0.8.18

## 0.8.17

### Patch Changes

- 1a9ae7b: Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
  to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

  Consolidate tool analysis in Core behind one compiler boundary and program, with shared
  projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
  the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
  API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
  optionality and use a compiler-neutral fallback for collection intersections.

  Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
  and `extractParameterType` exports. Their removal is an intentional breaking change.

  Add permanent packed-consumer and exact-version post-publish verification for the
  TypeScript tooling packages.

- Updated dependencies [713797f]
- Updated dependencies [7f4bce6]
- Updated dependencies [1a9ae7b]
  - @dawn-ai/core@0.8.17
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
  - @dawn-ai/core@0.8.16
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
  - @dawn-ai/core@0.8.15

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
- Updated dependencies [83e5153]
  - @dawn-ai/memory@0.8.14
  - @dawn-ai/core@0.8.14
