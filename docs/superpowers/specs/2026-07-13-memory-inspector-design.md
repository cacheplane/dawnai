# Memory Inspector — `@dawn-ai/inspector` (Dawn runtime inspection, Memory panel)

Date: 2026-07-13
Status: approved design, pending implementation plan
Branch: `feat/memory-inspector` (created off origin/main, spec committed)
Prior art: long-term memory (#250), hybrid recall (#313), pgvector backend (#318)

## Goal

Ship **`@dawn-ai/inspector`** — a browser-based, panel-oriented Dawn runtime
inspection tool — and its first panel, the **Memory panel**: browse, search,
inspect, and govern (approve / reject / forget) long-term memories from a real
UI. Launched with a single command, `dawn inspect`. The package is designed as a
shell that grows to inspect other Dawn subsystems (threads, runs/checkpoints,
sandbox, permissions) without repackaging; only the Memory panel is in scope for
this cycle.

Success = a Dawn developer running their app can, in one command, watch memories
appear as their agent runs, search them exactly as the agent's `recall` would,
and approve/supersede candidate writes visually — the dogfood loop the headless
`dawn memory` CLI can't provide.

## Background — what exists today

- **Memory store read surface is thin.** `MemoryStore`
  (`packages/memory/src/types.ts`) exposes `get`, `search` (namespace-scoped),
  and `listCandidates` (candidates-only). There is **no cross-namespace/status
  "browse everything" query** — the surface an inspector needs.
- **`dawn memory` CLI is a headless inspector.** `list` / `search` / `inspect` /
  `approve` / `reject` / `forget` (`packages/cli/src/commands/memory.ts`) over a
  store resolved by `resolveMemoryStore(appRoot)`
  (`packages/cli/src/lib/runtime/resolve-memory.ts`). But `list`/`search` only
  ever see **candidates**, and **`approve` skips supersede reconciliation** — a
  latent bug: approving a candidate that contradicts an active memory leaves two
  active rows.
- **No dev UI host exists.** `dawn dev` is a Dawn-owned `node:http` server
  (`packages/cli/src/lib/dev/runtime-server.ts`); nothing serves a browser page.
- **Config + store resolution live in the CLI.** `loadDawnConfig`
  (`packages/core/src/config.ts`) loads the user's `dawn.config.ts` (via the tsx
  ESM loader); `resolveMemoryStore` (CLI) picks `config.memory.store` or defaults
  to sqlite at `<appRoot>/.dawn/memory.sqlite`.
- **Scaffold devDeps are an established pattern.** `@dawn-ai/testing` and
  `@dawn-ai/evals` ship as `create-dawn-ai-app` devDependencies via the
  `SCAFFOLD_PACKAGES` machinery (`packages/cli/test/harness/scaffold-packaging.ts`).

## Decisions (locked in brainstorming)

- **Full Next.js** (app-router, React 19) as its **own server** — no hand-rolled
  router, no Hono. Rich, future-proof (real route handlers, server actions,
  streaming later). Rejected alternatives: Vite+Hono SPA and Next-static-export
  (both lighter but give up Next server features).
- **Separate package `@dawn-ai/inspector`**, generally named for growth (not
  `memory-inspector`). Isolates the heavy Next runtime from the base CLI.
  **Tree-shaking is the wrong lever** — `dependencies` install regardless of
  imports, Dawn's server runtime isn't bundled (tsx loader), and Next isn't a
  tree-shakeable library. Package separation is the mechanism.
- **Not `@dawn-ai/devkit`, not `@dawn-ai/memory` (investigated).** `devkit` is a
  zero-dependency, scaffold-side toolkit whose *only* consumer is
  `create-dawn-ai-app` — it is **never installed into a user app**, so hosting the
  inspector there would ship it to no one (`dawn inspect` runs inside the user app
  and needs the package in *that* `node_modules`) and would bloat the lean
  scaffolder with Next/React. `memory` is hot-path/pure. The established precedent:
  `@dawn-ai/testing` and `@dawn-ai/evals` — app-facing dev tools — are their own
  packages in the scaffold's devDependencies, **not** folded into devkit;
  `@dawn-ai/inspector` follows that exact pattern.
- **Distribution = scaffold devDep + optional-with-hint.** Auto-added to
  `create-dawn-ai-app` devDependencies (ships with scaffolded apps, zero manual
  step); `dawn inspect` prints a one-line `npm i -D @dawn-ai/inspector` hint if
  absent. Base CLI stays lean; the trilemma (full-Next / universal-zero-install /
  lean-CLI) is resolved by relaxing zero-install for non-scaffolded apps only.
- **Panel-based shell.** Ship the **Memory panel** only; design a panel seam so
  threads/runs/sandbox/permissions slot in later.
- **Table = `@pretable/react`** (+ `@pretable/ui` theme) — cacheplane's own
  pre-1.0 (0.0.2) data grid, built for wrapped variable-height text, column
  virtualization, and streaming-compatible updates: exactly the memory-content
  shape, and intentional dogfooding. **Chrome = shadcn/ui** (filters, badges,
  buttons, Sheet, inputs). **Tailwind v4** (shared by shadcn + `@pretable/ui`).
- **Command = `dawn inspect`** (defaults to the Memory panel while it's the only
  one).
- **Store acquisition = resolve the LIVE store in-process; no descriptor API.**
  `resolveMemoryStore(appRoot)` → `loadDawnConfig()` already returns the live
  `config.memory.store` and registers tsx itself, so the inspector's Next server
  can read *any* store — including bespoke custom implementations — with **zero new
  public API**. The earlier "serializable descriptor + built-ins only" plan was
  dropped once the seam was verified; the real work is Next bundler hygiene
  (`serverExternalPackages` + a runtime dynamic import).
- **`browse` is a REQUIRED `MemoryStore` method** (not optional). Dawn is pre-1.0
  and we are explicitly not carrying backwards compatibility, so we take the single
  clean code path: no degraded "limited view", no capability sniffing, one
  implementation to test. Custom stores must implement it; enforced by
  `runMemoryStoreConformance` and stated in the upgrade note.

## Non-goals (deferred, noted)

Episodic/procedural/reflection kinds; memory graph; threads/runs/sandbox/
permissions panels (the shell is built for them, none ship now); editing
arbitrary memory `data` fields in the UI (governance actions only:
approve/reject/forget + the reconciliation on approve); auth/multi-user (localhost
dev tool); embedding-in-`dawn dev` (standalone `dawn inspect` only, per the
hosting decision).

## Architecture

### Package layout (`@dawn-ai/inspector`)

A Next.js app-router project that builds to **standalone output** (self-contained
node server, published in the package):

- `app/` — the shell (layout, panel nav) + `app/memory/` (the Memory panel:
  list + detail).
- `app/api/memory/…/route.ts` — Next route handlers = the JSON API over the
  resolved store (list/browse, get, search, approve, reject, forget).
- `src/panels/` — panel registry + the `MemoryPanel`; the seam future panels
  register into (`{ id, label, icon, routes }`).
- `src/store/` — store acquisition (see "Store acquisition" below) + typed
  fetchers used by both server components and route handlers.
- `next.config.ts` (`output: "standalone"`), `tailwind.config`, `components/ui/`
  (shadcn), theme CSS importing `@pretable/ui/themes/*` + `@pretable/ui/grid.css`.
- Deps: `next`, `react@^19`, `react-dom@^19`, `@pretable/react`, `@pretable/ui`,
  shadcn's deps (radix, tailwind v4, lucide, cva), `@dawn-ai/memory`
  (store + resolution seam), `@dawn-ai/core` (config types). It does **not** depend
  on `@dawn-ai/memory-pgvector` — a pgvector app already has it, and we load that
  app's live store rather than rebuilding one.

### `dawn inspect` command (in `@dawn-ai/cli`)

`packages/cli/src/commands/inspect.ts`:
1. Resolve `@dawn-ai/inspector` from the app's `node_modules`. Absent → print the
   install hint and exit 0.
2. Spawn the inspector's standalone Next server (`node <inspector>/server.js`)
   with env: `DAWN_APP_ROOT` and `DAWN_INSPECTOR_PORT` (flag `--port`, else an
   allocated free port). The CLI does **not** resolve the store — the inspector
   resolves it itself from `DAWN_APP_ROOT` (see "Store acquisition").
4. Wait for readiness (`/healthz`), print `Dawn Inspector ready at http://…`, open
   the browser. SIGINT/SIGTERM → tear down the child.

`cli → inspector` is a **dynamic import / spawn only** (optional dep), so there is
no build-time cycle even though `inspector → cli` is avoided entirely (see next).

### Store acquisition — resolve the live store in-process

The Next server reads the app's `MemoryStore` by resolving the user's config **in
its own process**: `resolveMemoryStore(appRoot)` → `loadDawnConfig()` returns the
**live** `config.memory.store`, and `loadDawnConfig` registers the tsx loader
itself (`packages/core/src/config.ts`). No descriptor, no serialization, and — the
key consequence — **no new public API**: *every* store is inspectable, including
bespoke custom implementations, because we hand back the same object the app uses.

The only real work is Next bundler hygiene:

- mark `@dawn-ai/*` (and the store's own deps) as **`serverExternalPackages`** so
  Next never tries to bundle them;
- keep the config import a **runtime** `await import(pathToFileURL(configPath).href)`
  so webpack/turbopack cannot statically analyze and inline it.

Two caveats, documented for users (not blockers):

- The inspector is a **separate process** and therefore constructs its **own store
  instance** — a second SQLite handle / second PG pool. Custom stores with
  construction side effects (opening sockets, registering listeners) run them twice.
- The store must be constructible **from config alone** (no request-scoped state),
  which is true of any config-level store by definition.

This also removes the need for the inspector to depend on `@dawn-ai/memory-pgvector`:
a pgvector-configured app already has it in its own `node_modules`, and we load the
app's store object rather than rebuilding one.

### Store changes (in `@dawn-ai/memory`; benefit `dawn memory` too)

1. **Browse-list query — a REQUIRED `MemoryStore` method.** Add
   `browse({ namespacePrefix?, status?, kind?, source?, query?, limit?, offset? })`
   returning records across namespaces/statuses (ordered `updated_at DESC`), as an
   explicit method rather than overloading `search`'s query-less path — clear
   intent, and it keeps recall semantics untouched.

   It is **required, not optional** (`browse(...)`, not `browse?(...)`). Dawn is
   pre-1.0 and we are explicitly not carrying backwards compatibility here, so we
   take the one clean code path: no degraded "limited view" mode in the inspector,
   no capability sniffing, one implementation to test. Any custom `MemoryStore`
   must implement `browse` — called out in the upgrade notes and enforced by
   `runMemoryStoreConformance`, which every store (sqlite always, pgvector gated)
   runs. Implement for sqlite and pgvector with identical ordering/paging.
2. **Approve → supersede reconciliation.** Extract the auto-write reconciliation
   (identity match → supersede) from the capability (`memory.ts`) into the shared
   `reconcile.ts` seam, and call it from **both** the capability's approve path and
   a new store-level/CLI `approveWithReconcile(id)` used by the inspector API and
   `dawn memory approve`. Fixes the two-actives bug uniformly.

### Data flow

Browser (pretable grid + shadcn chrome) → Next route handlers (`app/api/memory/*`)
→ reconstructed `MemoryStore` → JSON. Mutations (approve/reject/forget) POST to the
same handlers. Live view: the list polls the browse endpoint every ~2s (toggleable)
so memories appear as the agent writes them.

## UI specification (layout B — two-pane + slide-in sheet)

- **Top bar:** summary badges (active / candidate / superseded counts) · search
  input (runs real `store.search` — keyword + vector RRF, so it mirrors the
  agent's `recall`) · Status filter · Kind filter.
- **Left rail:** namespace facets (with counts) + source facets.
- **Records grid (`@pretable/react`):** columns `status` (shadcn badge) ·
  `content` (wrapped, variable height — pretable's strength) · `namespace` · `kind`
  · `confidence` · `updated`. Sort by column; candidate rows tinted; superseded
  struck-through. **Live auto-refresh (~2s)** toggle. Keyboard/selection via
  pretable.
- **Detail sheet (shadcn Sheet, slides in on row click):** `content` · `data`
  (pretty JSON) · `tags` · `source` · `confidence` · `embedding` model + vector
  presence · `created`/`updated` timestamps · `supersedes` link(s) · **copy raw
  JSON** button.
  - Actions: **Approve** (candidate) — if the candidate's identity matches an
    active memory with different data, the button becomes **Approve & supersede**
    and an amber callout shows the before/after diff and the target id; **Reject**
    (candidate, destructive); **Forget** (any, destructive). Confirm destructive
    actions.

## JSON API (Next route handlers)

- `GET /api/memory/list` — browse (query params: namespacePrefix, status, kind,
  source, limit, offset) → records + facet counts + summary badges.
- `GET /api/memory/search?q=` — `store.search` hybrid recall.
- `GET /api/memory/:id` — full record (`store.get`).
- `POST /api/memory/:id/approve` — `approveWithReconcile` (returns what was
  superseded, for the UI to reflect).
- `POST /api/memory/:id/reject`, `POST /api/memory/:id/forget` — `store.delete`.
- `GET /healthz` — readiness.

## Error handling

- Inspector package not installed → CLI hint, exit 0.
- Config fails to load (missing/invalid `dawn.config.ts`) → actionable error naming
  the file and the parse failure; fall back to the default SQLite path only when the
  config is genuinely absent (matching `resolveMemoryStore`'s existing behaviour).
- Store missing `browse` (a custom store not yet updated) → actionable error naming
  the method and pointing at the upgrade note. `browse` is required, so this is a
  hard failure by design, not a degraded view.
- Store/DB connection failure → surfaced in the UI as an error state (not a blank
  grid); route handlers return structured error JSON.
- Empty store → explicit empty state, not an error.

## Testing strategy

1. **Store unit tests (`@dawn-ai/memory`):** the new `browse` query (cross-namespace,
   status/kind/source filters, ordering, paging); `approveWithReconcile` demotes a
   contradicting active row and links supersession. Add both to
   `runMemoryStoreConformance` → sqlite always, pgvector gated (parity).
2. **Descriptor round-trip:** `storeDescriptor(config)` → `storeFromDescriptor` for
   sqlite + pgvector; custom store → the documented refusal.
3. **CLI (`dawn inspect`):** package-absent hint; child spawn wiring incl. the
   `DAWN_APP_ROOT`/`DAWN_INSPECTOR_PORT` env contract (mock the spawn) — no real
   browser.
4. **Inspector component tests:** the Memory panel list + detail render against a
   seeded store fixture (React Testing Library); the Approve→supersede callout
   appears only on identity-contradiction; pretable grid renders wrapped rows.
5. **E2E (gated, offline):** boot the inspector standalone server against a
   temp-dir sqlite store seeded with candidate+active+superseded rows +
   `fakeEmbedder`; hit each API route; assert list/search/approve-with-reconcile
   behavior over HTTP. No key, no network — mirrors the memory offline lanes.
6. **Docs + a dogfood note** in `examples/memory` (add `@dawn-ai/inspector` devDep +
   a `pnpm inspect` script) so the standing memory example is the inspector's
   dogfood vehicle too.

Default CI validate never boots a browser; the gated e2e boots only the node
server + HTTP. pretable/Next add no key/network requirement.

## Distribution & release

- New public package `@dawn-ai/inspector` → **OIDC new-package bootstrap** at first
  publish (GOTCHA 1/7: bootstrap-publish from `changeset-release/main` + configure
  its trusted publisher BEFORE merging the Version PR; the #324 tag-backfill covers
  its git tag/Release automatically).
- Add `@dawn-ai/inspector` to `.changeset/config.json`'s `fixed[0]` group (versions
  with the group; **patch** changeset — GOTCHA 6, never minor).
- Add to the scaffold: `SCAFFOLD_PACKAGES` + `create-dawn-app` devDep threading +
  the generated-app fixtures (per the npm-release GOTCHA-4 scaffold-dep checklist).
- Changeset: **patch** for `@dawn-ai/memory` (browse + reconcile extraction),
  `@dawn-ai/testing` (conformance additions), `@dawn-ai/cli` (`dawn inspect`), and
  the new `@dawn-ai/inspector`. Patch even though `browse` is a **breaking**
  `MemoryStore` change — GOTCHA 6 (a `minor` in the fixed 0.x group inflates the
  whole group to 1.0.0). The changeset body must state the break plainly: *"`MemoryStore`
  now requires `browse`; custom stores must implement it."*
- Docs: a "Memory Inspector" page under the memory docs (enable via `dawn inspect`,
  the scaffold ships it, the browse/approve semantics), the two store-acquisition
  caveats (own process → own store instance; config-constructible only), and an
  **upgrade note** for the required `browse` method. Note in `docs/dev` too.

## Risks

- **`@pretable/react` is pre-1.0 (0.0.2).** API churn, rough edges, React-19-only.
  Mitigation: pin the exact version; keep grid usage to the documented `<Pretable
  rows columns>` + `usePretableModel` surface; the dogfooding feedback is a
  deliverable, not a cost. If it blocks, the grid is swappable behind our own thin
  wrapper component.
- **React 19 / Next standalone.** The inspector is React-19 (Next 15/16). Fine as an
  isolated package; ship size is acceptable because it's separate + optional.
- **Loading the app's config inside Next.** Requires `serverExternalPackages` for
  `@dawn-ai/*` and a genuinely-runtime dynamic import, or the bundler will try to
  inline user TS. This is the main integration risk of the whole design; prove it
  with a spike in the first task before building UI on top.
- **Second store instance.** The inspector process opens its own SQLite handle / PG
  pool alongside the running app. Fine for reads and for WAL-mode SQLite, but
  custom stores with construction side effects run them twice — documented.
- **`browse` is a required `MemoryStore` method** (deliberate, pre-1.0, no back-compat):
  every custom store must implement it or `dawn inspect` hard-fails with a pointed
  error. Enforced by `runMemoryStoreConformance` and called out in upgrade notes.
- **Next standalone spawn ergonomics** (port handoff, readiness, clean shutdown) —
  modeled on the existing `dawn dev` child-process supervision.

## Open questions (validate during build, not blockers)

- `browse` default ordering/paging defaults (reuse recall's `candidatePool`? or a
  plain `updated_at DESC` + offset — lean to the latter for a browse surface).
- Auto-refresh interval (2s default) + whether to pause when the tab is hidden.
- Whether `dawn inspect --panel <id>` is worth adding now (only one panel exists) —
  probably defer; default to Memory.
