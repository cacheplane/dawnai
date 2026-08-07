# @dawn-ai/inspector

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
