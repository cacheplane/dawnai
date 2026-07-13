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
  (store + resolution seam), `@dawn-ai/core` (config types). `@dawn-ai/memory-pgvector`
  is an **optional** dep (only needed to reconstruct a pgvector store).

### `dawn inspect` command (in `@dawn-ai/cli`)

`packages/cli/src/commands/inspect.ts`:
1. Resolve `@dawn-ai/inspector` from the app's `node_modules`. Absent → print the
   install hint and exit 0.
2. Load the user's config (`loadDawnConfig`, already in the CLI) and resolve the
   **store descriptor** (see below).
3. Spawn the inspector's standalone Next server (`node <inspector>/server.js`)
   with env: `DAWN_APP_ROOT`, `DAWN_INSPECTOR_PORT` (flag `--port`, else an
   allocated free port), and the resolved store descriptor.
4. Wait for readiness (`/healthz`), print `Dawn Inspector ready at http://…`, open
   the browser. SIGINT/SIGTERM → tear down the child.

`cli → inspector` is a **dynamic import / spawn only** (optional dep), so there is
no build-time cycle even though `inspector → cli` is avoided entirely (see next).

### Store acquisition — the central design point

The Next server must read the app's `MemoryStore`. Loading the user's
`dawn.config.ts` *inside* the Next process (tsx loader + arbitrary TS import)
fights Next's bundling and is fragile. Instead:

- **`dawn inspect` (CLI side, which already loads config natively) resolves the
  store to a serializable descriptor** and passes it to the Next server via env:
  - sqlite → `{ kind: "sqlite", path }`
  - pgvector → `{ kind: "pgvector", connectionString, dimensions, … }`
- **The inspector's Next server reconstructs the store from the descriptor** using
  `@dawn-ai/memory` (sqlite) or the optional `@dawn-ai/memory-pgvector`, and reads
  it directly in route handlers/server components. No tsx, no config load in Next.
- **Custom live-object stores** (`config.memory.store` set to a bespoke instance)
  can't be serialized. v1 limitation: `dawn inspect` detects this and prints a
  clear message ("custom MemoryStore instances aren't inspectable yet; built-in
  sqlite/pgvector are"). Covers the 95% case; a CLI-hosted API fallback for custom
  stores is a noted follow-up.

Descriptor construction lives where config is resolved (CLI); descriptor →
store reconstruction lives in `@dawn-ai/memory` (+ pgvector) so it's shared and
testable. Extract a small `storeDescriptor(config)` + `storeFromDescriptor(desc)`
pair.

### Store changes (in `@dawn-ai/memory`; benefit `dawn memory` too)

1. **Browse-list query.** Add a browse path to `MemoryStore` — either a new
   `browse({ namespacePrefix?, status?, kind?, source?, query?, limit?, offset? })`
   returning records across namespaces/statuses (ordered `updated_at DESC`), or an
   extension of `search`'s query-less path to accept a namespace *prefix* + any
   status and no required namespace. Prefer an explicit `browse` method (clear
   intent, doesn't overload recall semantics). Implement for sqlite; implement for
   pgvector; add to `runMemoryStoreConformance` so parity holds.
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
- Custom live-object store → clear "not inspectable yet" message (see above).
- pgvector descriptor but `@dawn-ai/memory-pgvector` not installed in the app →
  actionable error naming the missing optional dep.
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
3. **CLI (`dawn inspect`):** package-absent hint; descriptor resolution; child
   spawn wiring (mock the spawn) — no real browser.
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
  the new `@dawn-ai/inspector`.
- Docs: a "Memory Inspector" page under the memory docs (enable via `dawn inspect`,
  the scaffold ships it, the browse/approve semantics), and note in `docs/dev`.

## Risks

- **`@pretable/react` is pre-1.0 (0.0.2).** API churn, rough edges, React-19-only.
  Mitigation: pin the exact version; keep grid usage to the documented `<Pretable
  rows columns>` + `usePretableModel` surface; the dogfooding feedback is a
  deliverable, not a cost. If it blocks, the grid is swappable behind our own thin
  wrapper component.
- **React 19 / Next standalone.** The inspector is React-19 (Next 15/16). Fine as an
  isolated package; ship size is acceptable because it's separate + optional.
- **Store acquisition via descriptor** limits v1 to built-in sqlite/pgvector stores.
  Documented; custom-store API fallback is a noted follow-up.
- **Next standalone spawn ergonomics** (port handoff, readiness, clean shutdown) —
  modeled on the existing `dawn dev` child-process supervision.

## Open questions (validate during build, not blockers)

- `browse` default ordering/paging defaults (reuse recall's `candidatePool`? or a
  plain `updated_at DESC` + offset — lean to the latter for a browse surface).
- Auto-refresh interval (2s default) + whether to pause when the tab is hidden.
- Whether `dawn inspect --panel <id>` is worth adding now (only one panel exists) —
  probably defer; default to Memory.
