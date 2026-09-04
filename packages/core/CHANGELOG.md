# @dawn-ai/core

## 0.8.25

### Patch Changes

- @dawn-ai/permissions@0.8.25
- @dawn-ai/sdk@0.8.25
- @dawn-ai/sqlite-storage@0.8.25
- @dawn-ai/workspace@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/permissions@0.8.24
- @dawn-ai/sdk@0.8.24
- @dawn-ai/sqlite-storage@0.8.24
- @dawn-ai/workspace@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/permissions@0.8.23
  - @dawn-ai/sdk@0.8.23
  - @dawn-ai/sqlite-storage@0.8.23
  - @dawn-ai/workspace@0.8.23

## 0.8.22

### Patch Changes

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
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

- 3c68800: **Correction: the edge quickstart named the wrong module manifest, and
  `providerPackages` is not exported from `@dawn-ai/cli/fetch`.**

  Two errata against the docs and changelog that shipped with the `hono` build
  target. `dawn docs` carries the fixes.

  - **The `@dawn-ai/cli/fetch` snippet under _Edge runtimes_ imported
    `./.dawn/build/modules.mjs`.** That is the `node` target's manifest: it reaches
    `node:path`, `node:url` and `@dawn-ai/cli/runtime`, which pulls in tsx and
    esbuild. Bundled the way `wrangler` bundles — browser platform, Workers export
    conditions — it fails on fourteen unresolved builtins, several of them bare
    (`fs`, `child_process`), so `nodejs_compat` would not have rescued it either.
    The snippet now names `modules.edge.mjs`, which is what the generated
    `app.mjs` already imported. A new ungated test reads that snippet out of the
    docs page and bundles it under those exact conditions, so the two cannot drift
    again; a negative control bundles the `node` manifest and requires it to fail.

  - **The same section said the fetch entry and the `hono` target could each be
    used "on its own".** `modules.edge.mjs` is emitted only by the `hono` target,
    so the fetch entry alone leaves you with no edge-safe manifest. The two are
    layered, not alternatives: enable `hono`, then compose the pieces it writes
    however you like. Hand-building the manifest remains possible via the exported
    `buildStaticRouteModule` and `DawnStaticModules`, and the docs now say so
    instead of implying the target is optional.

  - **The `0.8.21` changelog entry said `seedModelImporter` and `providerPackages`
    are re-exported from `@dawn-ai/cli/fetch`.** Only `seedModelImporter` is.
    `providerPackages` maps a provider id to its package name — a build-time
    lookup the `hono` target uses to generate the static import switch, and of no
    use to a runtime that needs real static imports rather than package names. It
    is staying where it is rather than being added to the edge entry to make the
    sentence true; it remains public from `@dawn-ai/langchain` for anyone writing
    an import map by hand. Published changelogs are not being rewritten — this is
    the correction.

- 908d690: Carry the model's tool-call ID from a tool execution into the capability
  stream: `StreamTransformerInput` gains an optional `toolCallId`, and the
  planning capability echoes it as `tool_call_id` on `plan_update`. Child
  capability events keep their subagent's tool-call ID internal. This is the
  correlation plumbing behind presenting built-in orchestration work once; the
  presentation change that consumes it ships in this same release.
- d42774e: **Breaking:** scenario files must default export `scenarios("<route>")` from
  `@dawn-ai/sdk/testing`. A plain default-exported array now throws
  `RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
  migrate.

  Add route-scoped fluent `dawn test` scenarios with generated application-tool
  types, invocation-local in-process tool mocks, and declarative mock call
  assertions.

- Updated dependencies [bedad77]
- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [f317dd7]
- Updated dependencies [3c68800]
- Updated dependencies [d42774e]
- Updated dependencies [984c3ad]
- Updated dependencies [496b54c]
- Updated dependencies [67030fa]
- Updated dependencies [730b136]
  - @dawn-ai/permissions@0.8.22
  - @dawn-ai/workspace@0.8.22
  - @dawn-ai/sqlite-storage@0.8.22
  - @dawn-ai/sdk@0.8.22

## 0.8.21

### Patch Changes

- c2c19da: **Edge runtime: `process.env` reads no longer crash a worker.**

  `@dawn-ai/cli/fetch` links for Cloudflare workerd with no `node:` specifiers,
  which is why the emitted `wrangler.toml` omits `nodejs_compat` — and without
  that flag `process` is not defined, so a bare `process.env.X` is a
  `ReferenceError` rather than a quiet `undefined`. Six such reads were on the
  fetch graph. The worst sat in the openai model constructor, so it fired on the
  first turn of the app this target scaffolds.

  - New in `@dawn-ai/core`: `readRuntimeEnv(name)` and `seedRuntimeEnv(env)`.
    `readRuntimeEnv` consults `process.env` first and falls back to whatever an
    edge entry point seeded, so behavior under Node is unchanged. `seedRuntimeEnv`
    is re-exported from `@dawn-ai/cli/fetch` alongside `seedModelImporter`.
  - `OPENAI_BASE_URL` (in `createChatModel` and `openaiEmbedder`) reads through the
    seam rather than being guarded away. It is configuration, not debug output: a
    guard would have replaced a crash with a deployment whose base URL could not
    be set at all.
  - The `DAWN_DEBUG_MEMORY`, `DAWN_DEBUG_SUMMARIZATION`, `DAWN_DEBUG_INTERRUPTS`
    and `DAWN_DEBUG_CONSTRAINTS` reads use the same seam, so they stay off by
    default where there is no `process` and can still be switched on by seeding.
  - `test/fetch-entry-purity.test.ts` now gates Node-only globals, not just
    `node:` import edges — a bare global leaves no edge, which is why this class
    shipped past a green suite. The bundle is linked with each of `process`,
    `Buffer`, `global`, `__dirname`, `__filename` and `require` rewritten to a
    sentinel by esbuild's scope-aware `define`, so string literals, comments,
    property names and shadowed locals cannot produce a false hit. Dawn-owned code
    must reference none of them at all; the wider graph must contain no reference
    that lacks a `typeof` guard in the same statement.

- c2c19da: **New `hono` build target — a Dawn app that deploys to Cloudflare Workers.**

  `build: { targets: ["node", "hono"] }` makes `dawn build` emit an edge deploy
  alongside the usual ones: `.dawn/build/app.mjs` (a Hono app whose single
  catch-all hands every request to Dawn's web-standard fetch handler,
  `export default`ed — the shape Workers, Vercel and Bun all accept),
  `modules.edge.mjs` (the static module manifest, free of node builtins),
  `stores.mjs` (a per-request Postgres store factory), and a `wrangler.toml`
  scaffold at the app root. `wrangler deploy` is how you ship it; a gated CI lane
  boots those same artifacts under local workerd and shows them serving Agent
  Protocol and AG-UI with durable state in Postgres. No deploy to Cloudflare's
  platform has been exercised — see the caveats at the end of this note.

  The scaffold carries a bare `name` / `main` / `compatibility_date` and **no
  `nodejs_compat`**: the bundle links zero `node:` specifiers, so the flag would
  buy nothing, and setting it would mask a regression in the work that made the
  bundle node-free. A gated `edge-workerd` CI lane boots the emitted artifacts
  under real workerd — the same binary Cloudflare runs — with that `wrangler.toml`
  untouched, and drives four sequential AG-UI turns against Postgres over a
  `@neondatabase/serverless` WebSocket pool.

  The target is **opt-in and never a default**, because the edge serves a subset
  of Dawn rather than all of it.

  - **The stores are built per request, and that is not stylistic.** A pool held at
    module scope hands request N+1 an idle WebSocket bound to request N's dead I/O
    context; the request then hangs until workerd cancels it, in an alternating
    pattern that fails about half of all requests with nothing thrown. So
    `stores.mjs` builds the pool and all three stores inside the factory and ends
    the pool on dispose, with a module-scope flag recording that this isolate has
    already migrated so per-request instances do not re-run three migration
    transactions each time. That pool also gets an `'error'` listener:
    `@neondatabase/serverless` vendors `pg-pool` _and_ the `events` polyfill, so an
    idle client's failure re-emits on the pool and the shim throws when nothing is
    listening — the same uncaught-exception hazard node `pg` has, and one that
    `nodejs_compat` being off does nothing to remove. A per-request pool is still
    exposed: a client sits idle between every pair of store queries, and pg-pool's
    idle listener outlives `end()`.
  - **`requestStores`**, a new option on `createRuntimeFetchHandler`, is the seam
    that makes that possible: a `(request) => RequestStores` factory whose every
    field is optional and falls through to the boot-resolved store when omitted.
    `RequestStores` is exported from `@dawn-ai/cli/fetch`.
  - **The build fails, by name, on anything the edge cannot serve** — with the new
    `DAWN_E1005`, and reporting every offending feature at once rather than one
    build at a time: `sandbox`, `backends.filesystem`/`backends.exec`, a
    config-supplied `checkpointer` / `threadsStore` / `permissions.store` /
    `memory.store`, a `workspace/` directory, route skills, and route-level
    long-term memory. The store cases matter most: those handles cannot cross a
    build boundary, so before the gate the generated Postgres store quietly took
    their place. `dawn check` applies the identical gate whenever `hono` is a
    configured target.
  - **The provider import map is exhaustive or the build fails.** A bundler cannot
    follow a variable import specifier, so `app.mjs` emits a static `switch` over
    the model packages the app can reach; whatever is missing from it is missing
    from the bundle. A route that will not import, or an agent whose provider
    cannot be inferred, is therefore an error rather than a silently narrower map,
    and `summarization.model` is included.
  - **`dawn build` warns on stderr** when `@dawn-ai/cli`, `@dawn-ai/postgres-storage`,
    `@neondatabase/serverless` or `hono` is missing from the app's `package.json`.
    None of them is a dependency of `@dawn-ai/cli`, deliberately: the CLI does not
    import them, the app it generates does.
  - **Your config is inlined into `app.mjs` at build time**, minus every field that
    cannot survive a build boundary, rather than loaded from `dawn.config.ts` at
    runtime as the `node` target does. Keep secrets in bindings, not in config.

  Also new, both in service of the emitted entry: `seedModelImporter` and
  `providerPackages` from `@dawn-ai/langchain` (re-exported from
  `@dawn-ai/cli/fetch`), and `DAWN_E5301` on a runtime that reaches a store no
  layer supplied.

  Full walkthrough, the supported subset, and an explicit list of what the CI lane
  does **not** settle — no real Cloudflare deploy, Hyperdrive, production
  connection limits, per-query latency, cross-isolate cold starts, and the bundle
  size and startup CPU that `wrangler deploy` enforces and `wrangler dev --local`
  does not — are in the Deployment docs under Edge runtimes.

- c2c19da: fix(edge): resolve the `ctx.fs` filesystem backend at first use, not at route preparation

  `prepareRouteExecution` built the author-facing workspace handle (`ctx.fs`) for
  every route execution, and constructing it resolved a filesystem backend
  eagerly. On a runtime with no boot fallbacks and no `backends.filesystem` in
  config — i.e. every deployed `hono`-target worker — that threw during
  preparation, so every agent turn returned a 500 over a handle the turn never
  touched. A worker could not opt out: the emitted entry inlines only the
  serializable half of `dawn.config.ts`, and the edge capability gate rejects
  `backends.filesystem` because a live object cannot cross a build boundary.

  `createWorkspaceFs` now accepts a thunk for `backend` and resolves (and
  memoizes) it on the first filesystem operation, and the CLI runtime hands it
  one when — and only when — the runtime has no fallback to construct from. The
  failure is deferred, not defused: a route that genuinely reads the workspace
  still throws by name, at the operation that needed a filesystem, with the same
  message it raised before. The node lane is unchanged, backend included: it
  still resolves its process-shared `localFilesystem()` at preparation, since
  there the call cannot fail.

  The `workspaceRoot` guard in `createWorkspaceFs` stays eager — the root is
  known at construction time, so a host that passes a relative one hears about it
  immediately rather than on some later file operation.

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/sdk@0.8.21
  - @dawn-ai/permissions@0.8.21
  - @dawn-ai/workspace@0.8.21
  - @dawn-ai/sqlite-storage@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/permissions@0.8.20
- @dawn-ai/sdk@0.8.20
- @dawn-ai/sqlite-storage@0.8.20
- @dawn-ai/workspace@0.8.20

## 0.8.19

### Patch Changes

- 9dde7c6: **New package `@dawn-ai/postgres-storage`** — a Postgres backend for all three
  of Dawn's durable runtime stores (deploy-anywhere B3, PR 2b). Dawn's defaults
  (`.dawn/checkpoints.sqlite`, `.dawn/threads.sqlite`, `.dawn/permissions.json`)
  assume one long-lived process with a writable disk; a multi-instance or
  ephemeral-filesystem deploy has neither.

  ```ts
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  export default config({
    checkpointer: postgresCheckpointer({ pool }),
    threadsStore: createPostgresThreadsStore({ pool }),
    permissions: {
      mode: "non-interactive",
      store: createPostgresPermissionsStore({ pool, mode: "non-interactive" }),
    },
  });
  ```

  - `postgresCheckpointer()` — a LangGraph `BaseCheckpointSaver`. Checkpoints,
    metadata, and pending-write values are stored as opaque `bytea`, matching the
    SQLite backend's BLOB; `jsonb` is deliberately not used, because it rejects a
    NUL byte (SQLSTATE `22P05`) and a lone surrogate (`22P02`), both of which
    reach checkpoints through normal tool output.
  - `createPostgresThreadsStore()` — the Agent Protocol threads store. Two
    behaviors differ from SQLite because Postgres has concurrent writers:
    `createThread` upserts instead of throwing on a duplicate id, and
    `updateMetadata` merges in one statement (`metadata || $1::jsonb`) so a
    concurrent patch cannot be lost.
  - `createPostgresPermissionsStore()` — runtime grants in a shared table rather
    than a per-process JSON file. `match()` is synchronous, so the store is a
    cache with async hydration and delegates the decision to the same
    `matchPermission` the file store uses.

  Any Postgres 14+ database works; no extensions are required. Migrations are
  lazy, memoized per process, and taken under a `pg_advisory_xact_lock`, so N
  instances cold-starting against a virgin database converge rather than racing.
  Options are shared across the three stores (`PostgresStoreOptions`) so one `pg`
  pool can serve all of them. Each store exposes `close()`; a store built from an
  injected pool deliberately does not end that pool, and the runtime handler's
  `close()` never touches stores — the app owns store teardown.

  `pg` opens a raw TCP socket, so these stores run on Node, Bun, and Vercel
  functions. Cloudflare Workers provides no raw TCP and would need Hyperdrive or
  an HTTP-based driver; no Workers configuration is verified here.

  **`@dawn-ai/core`: `DawnConfig.permissions.store`** — a new optional field for
  supplying a custom `PermissionsStore`, additive and defaulting to the existing
  file-backed store. A custom store owns its own mode and allow/deny lists: Dawn
  deliberately does not re-apply the sibling `permissions.mode` / `allow` / `deny`
  fields or the `DAWN_PERMISSIONS_MODE` env override on top of it, since
  re-wrapping would double-apply them. `@dawn-ai/cli` honors the field on both the
  HTTP and direct-call route paths.

  **`@dawn-ai/testing`: three store conformance kits** —
  `runCheckpointerConformance`, `runThreadsStoreConformance`, and
  `runPermissionsStoreConformance`. Each encodes the incumbent SQLite/file store's
  contract and runs against any implementation, so a new backend is held to the
  same behavior rather than to its own. Legitimate capability differences are
  declared with flags rather than asserted away.

  - @dawn-ai/permissions@0.8.19
  - @dawn-ai/sdk@0.8.19
  - @dawn-ai/sqlite-storage@0.8.19
  - @dawn-ai/workspace@0.8.19

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

- Updated dependencies [c6b08a9]
  - @dawn-ai/sdk@0.8.18
  - @dawn-ai/permissions@0.8.18
  - @dawn-ai/workspace@0.8.18
  - @dawn-ai/sqlite-storage@0.8.18

## 0.8.17

### Patch Changes

- 713797f: Purge `node:` imports from the edge module graph (deploy-anywhere B3, PR 2a).

  A bundle built from `@dawn-ai/cli/fetch` now links **zero** `node:` specifiers —
  previously it linked 33 of them (including `node:fs` and `node:child_process`)
  via Dawn's own supporting packages. Because static imports resolve when a module
  graph is instantiated, those edges made the bundle require a `node:` shim layer
  (Cloudflare Workers with `nodejs_compat`) even though the injected request path
  never called them. The artifact is now runtime-agnostic, verified by an esbuild
  purity test that bundles on the `neutral` and `browser` platforms with no `node:`
  externals and asserts an empty graph, plus a negative control proving the check
  still fails against the CLI entry.

  **Node-only exports moved to `/node` subpaths.** They are unchanged in behavior;
  only the import specifier differs:

  - `@dawn-ai/core` → `@dawn-ai/core/node`: `discoverRoutes`, `findDawnApp`,
    `assertDawnRoutesDir`, `extractToolSchemasForRoute`, `extractToolTypesForRoute`,
    `registerTsxLoader`
  - `@dawn-ai/permissions` → `@dawn-ai/permissions/node`: `createPermissionsStore`
  - `@dawn-ai/workspace` → `@dawn-ai/workspace/node`: `localFilesystem`, `localExec`

  **New:** `@dawn-ai/sdk/pure` (pure path/hash helpers, parity-tested against
  `node:path`/`node:crypto`); `@dawn-ai/core` gains `registerConfigLoader` and the
  `DawnConfigLoader` type; `@dawn-ai/core/node` gains `registerNodeConfigLoader`,
  `loadDawnConfigUncached`, and `nodeLoadRouteDescription`. `CapabilityMarkerContext`
  gains optional `backendFactories` and `loadRouteDescription` — capability markers
  no longer reach for node implementations by static import, and throw a named error
  when a runtime supplies neither an instance nor a factory.

  **Behavior change:** `createWorkspaceFs` now requires an absolute, POSIX-normalized
  `workspaceRoot` and throws a named error otherwise. Previously a relative root
  silently resolved against `process.cwd()`. Every in-repo caller already passes an
  absolute path; the host lane canonicalizes before calling core. This is
  fail-closed — it cannot widen the workspace path jail, only reject earlier and
  more loudly.

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
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/permissions@0.8.17
  - @dawn-ai/workspace@0.8.17
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
  - @dawn-ai/permissions@0.8.16
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/sqlite-storage@0.8.16
  - @dawn-ai/workspace@0.8.16

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

  - @dawn-ai/permissions@0.8.15
  - @dawn-ai/sdk@0.8.15
  - @dawn-ai/sqlite-storage@0.8.15
  - @dawn-ai/workspace@0.8.15

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

- 83e5153: Load the app once per process. `dawn.config.ts` is memoized per app root; the
  runtime passes its boot-resolved checkpointer, threads store, and permissions
  store into route execution instead of reconstructing them per request (three
  SQLite opens per turn eliminated); the memory store opens lazily on first use
  and is shared between the memory HTTP routes and the memory capability; route
  modules, tools, state, and route memory load once per route and are cached for
  the process lifetime, and the per-request route rediscovery is gone. In
  `dawn dev`, tool/state/reducer edits now restart the child runtime — fixing a
  stale-module bug where such edits silently did not apply (the previous
  re-import mechanism was a no-op under tsx) — and the restart log names the
  reason. Groundwork for build-time static wiring and the edge deploy targets.
  - @dawn-ai/permissions@0.8.14
  - @dawn-ai/sdk@0.8.14
  - @dawn-ai/sqlite-storage@0.8.14
  - @dawn-ai/workspace@0.8.14

## 0.8.13

### Patch Changes

- 18df470: Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
  codes on the failure channels. `CliError` now carries an optional `code` and the
  CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
  permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
  The high-value families are wired (`dawn check` config errors, sandbox
  unavailable, permission denied, missing model provider / unknown model id, and
  tool-file shape errors), and a generated `/docs/errors` reference page is guarded
  against drift. Additive and backward-compatible.
- Updated dependencies [5bbd6e3]
- Updated dependencies [628d1c3]
- Updated dependencies [18df470]
  - @dawn-ai/sdk@0.8.13
  - @dawn-ai/permissions@0.8.13
  - @dawn-ai/sqlite-storage@0.8.13
  - @dawn-ai/workspace@0.8.13

## 0.8.12

### Patch Changes

- e413b05: Add a production serve path. `dawn build` now emits a Node/Docker target (a
  `server.mjs` over the Dawn runtime plus a hardened Dockerfile) alongside the existing
  LangSmith `langgraph.json`, selectable via `build.targets`. The new `dawn start`
  command serves the runtime on 0.0.0.0 (HOST/PORT configurable). This is the first
  server that runs the Dawn runtime in production, so a deployed app engages the
  execution sandbox and serves both Agent Protocol and AG-UI. The langgraphjs/LangSmith
  path does not run the runtime and does not engage the sandbox.
  - @dawn-ai/permissions@0.8.12
  - @dawn-ai/sdk@0.8.12
  - @dawn-ai/sqlite-storage@0.8.12
  - @dawn-ai/workspace@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/permissions@0.8.11
- @dawn-ai/sdk@0.8.11
- @dawn-ai/sqlite-storage@0.8.11
- @dawn-ai/workspace@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/permissions@0.8.10
- @dawn-ai/sdk@0.8.10
- @dawn-ai/sqlite-storage@0.8.10
- @dawn-ai/workspace@0.8.10

## 0.8.9

### Patch Changes

- d3d94af: Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing or off-contract predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.
- 1dd2147: Opt-in vector/semantic recall for long-term memory. Enable with
  `memory: { vector: { embedder: openaiEmbedder() } }`: recall becomes hybrid —
  keyword (IDF) and vector (cosine) candidate lists fused co-equally by Reciprocal
  Rank Fusion, with a bounded recency/confidence second stage. Keyword recall is
  never dropped (dense retrieval is weak on exact IDs/codes/names), and default
  keyword-only recall is unchanged. Pluggable `Embedder` (`openaiEmbedder`,
  `fakeEmbedder`); embeddings stored as Float32 BLOBs in the existing node:sqlite
  store (zero new native deps), tagged by embedder id with graceful keyword-only
  fallback on model change. pgvector is a planned follow-up backend.
- Updated dependencies [d3d94af]
- Updated dependencies [628f0c1]
  - @dawn-ai/sdk@0.8.9
  - @dawn-ai/workspace@0.8.9
  - @dawn-ai/permissions@0.8.9
  - @dawn-ai/sqlite-storage@0.8.9

## 0.8.8

### Patch Changes

- dd02f56: New memory write-governance mode `writes: "ask"`: memory supersedes (belief contradictions) prompt a HITL Once/Always/Deny interrupt with old-vs-new detail; ADDs and idempotent updates flow silently; headless behaves as `auto`. New `kind: "memory"` permission interrupt, `gateMemorySupersede`, `suggestedMemoryPattern`, and a `dawn check` warning for the `ask` + `approve: ["remember"]` double-gate overlap.
- 5ccae68: Memory `remember`/`recall` tools now return the `{ result }` wrapper shape (like other capability tools) instead of a bare string. Previously the langchain bridge JSON-stringified their returns, so the agent saw quoted, backslash-escaped content — most visibly `recall`'s multi-line list arriving as one quoted string with literal `\n`. The wrapper makes the string the ToolMessage content verbatim.
- Updated dependencies [dd02f56]
- Updated dependencies [57e8cd9]
  - @dawn-ai/permissions@0.8.8
  - @dawn-ai/workspace@0.8.8
  - @dawn-ai/sdk@0.8.8
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
  - @dawn-ai/permissions@0.8.7
  - @dawn-ai/sdk@0.8.7
  - @dawn-ai/sqlite-storage@0.8.7
  - @dawn-ai/workspace@0.8.7

## 0.8.6

### Patch Changes

- 4ede7b8: Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
  with a Docker reference (`dockerSandbox`), giving each conversation thread a
  hard-isolated workspace (filesystem + shell + network). Enable via
  `dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
  behavior is unchanged. Adds a typed `config()` helper. When sandboxed, the
  materialized agent cache is bypassed so tools bind per-thread. Honest scope:
  Docker's boundary (not a microVM); `allow`-mode network denylist is best-effort
  in the Docker reference. New package `@dawn-ai/sandbox` (+ `@dawn-ai/sandbox/testing`
  `fakeSandbox` and a provider conformance kit).
- 1d51b75: Per-tool approval gating: `agent({ tools: { approve: ["deployProd"] } })` makes any named tool require a HITL permission prompt per call (`kind: "tool"` interrupt). Decisions persist name-level under the reserved `tool` key in `.dawn/permissions.json` (exact-name matching); pre-approve via `permissions.allow.tool`. `dawn check` validates `approve` names and warns on overlap with the internally-gated workspace tools, `deny`, and the unsupported `task` case.
- Updated dependencies [4ede7b8]
- Updated dependencies [1d51b75]
  - @dawn-ai/workspace@0.8.6
  - @dawn-ai/sdk@0.8.6
  - @dawn-ai/permissions@0.8.6
  - @dawn-ai/sqlite-storage@0.8.6

## 0.8.5

### Patch Changes

- f195096: Guard the route memory schema before use: a non-Zod `context.memory.schema` value now falls back to a permissive `data` shape for the `remember` tool instead of being cast and failing opaquely at tool-schema use time.
  - @dawn-ai/permissions@0.8.5
  - @dawn-ai/sdk@0.8.5
  - @dawn-ai/sqlite-storage@0.8.5
  - @dawn-ai/workspace@0.8.5

## 0.8.4

### Patch Changes

- 4e3e020: Fix long-term memory being unusable by real agents: the generated `remember`/`recall`
  tools now expose input schemas to the model. `remember.data` is the route's own
  `defineMemory()` zod schema (threaded through `MemoryContext.schema`), so the model
  knows exactly what to pass; previously both tools shipped without a schema, so a real
  model called them with empty/invalid args and every write was rejected by validation.
  Found by a live smoke test against a real model — the deterministic aimock suite
  couldn't catch it because it scripts exact tool arguments.
  - @dawn-ai/permissions@0.8.4
  - @dawn-ai/sdk@0.8.4
  - @dawn-ai/sqlite-storage@0.8.4
  - @dawn-ai/workspace@0.8.4

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
- 7339ded: Tool scoping: `agent({ tools: { allow, deny } })` restricts which tools a route's agent may call. `deny` revokes a tool; `allow` grants a withheld capability tool; deny wins.

  **Behavior change (pre-1.0):** subagents are now least-privilege by default — a subagent gets only its own route-local `tools/*.ts`; ambient capability tools (`writeFile`, `runBash`, `task`, `writeTodos`, `remember`/`recall`, …) are withheld unless named in `tools.allow`. A subagent that relied on inheriting these must add `tools: { allow: [...] }`. `dawn check` validates scope names. This scopes the tool surface, not execution (not a sandbox).

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/sdk@0.8.3
  - @dawn-ai/permissions@0.8.3
  - @dawn-ai/sqlite-storage@0.8.3
  - @dawn-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- @dawn-ai/permissions@0.8.2
- @dawn-ai/sdk@0.8.2
- @dawn-ai/sqlite-storage@0.8.2
- @dawn-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- 89b2a73: Harden the workspace path jail against symlink escapes. `FilesystemBackend` gains a required `realPath(path, ctx)` method; `localFilesystem` implements it (resolving symlinks via the deepest existing ancestor so not-yet-created write targets work), and `createWorkspaceFs` canonicalizes both the candidate path and the workspace root before the permission gate. A symlink inside `workspace/` that points outside is now correctly gated instead of being silently classified as inside.

  **Action for custom `FilesystemBackend` implementations:** add a `realPath` method — return the path unchanged (`async (p) => p`) if your backend has no symlink semantics. (Shipped as a patch since `localFilesystem`, the only built-in backend, already implements it; custom backends are not expected at this 0.x stage.)

  **Behavior note:** allow rules for paths outside the workspace are now matched against the canonical (symlink-resolved) path. If your workspace or an allowed target lives under a symlink, express allow-rule paths in canonical form; rules written against a non-canonical alias will fail closed. (No effect when your paths contain no symlinks.)

- Updated dependencies [407303f]
- Updated dependencies [89b2a73]
  - @dawn-ai/sqlite-storage@0.8.1
  - @dawn-ai/workspace@0.8.1
  - @dawn-ai/permissions@0.8.1
  - @dawn-ai/sdk@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- a38ff61: Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.

### Patch Changes

- Updated dependencies [917a99f]
- Updated dependencies [a38ff61]
- Updated dependencies [fa8bdd4]
  - @dawn-ai/workspace@0.3.0
  - @dawn-ai/sdk@0.7.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.6.0

### Patch Changes

- @dawn-ai/sdk@0.6.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0
- @dawn-ai/workspace@0.2.0

## 0.5.0

### Patch Changes

- @dawn-ai/sdk@0.5.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0
- @dawn-ai/workspace@0.2.0

## 0.4.0

### Patch Changes

- @dawn-ai/sdk@0.4.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0
- @dawn-ai/workspace@0.2.0

## 0.3.0

### Minor Changes

- 8133553: Add opt-in conversation summarization (Phase 3 sub-project 6b). When a thread's history exceeds a token threshold, the agent is fed a condensed view — a running summary of older turns plus the most recent turns verbatim — while the **full history stays intact in the checkpoint**. This is non-destructive: summarization runs as a LangGraph `preModelHook` that returns `llmInputMessages` for the turn only and never rewrites saved `messages`, so `GET /threads/:id/state`, resume, and restart always see the complete history (and there is no tool-call/result pairing hazard).

  Enable it in `dawn.config.ts`:

  ```ts
  export default {
    summarization: {
      enabled: true, // default false
      maxTokens: 12_000, // threshold over which older turns are summarized
      keepRecentTurns: 6, // most-recent turns kept verbatim
      // model defaults to the route's model
      // tokenCounter defaults to a lazy gpt-tokenizer (o200k_base) counter
      // summarize defaults to a built-in single-LLM-call running-summary fold
    },
  };
  ```

  Both the token counter and the summarizer are pluggable (`tokenCounter`, `summarize`). The running summary is cached in agent state and refreshed incrementally — each turn folds only the newly-aged messages, so cost stays bounded. The turn-boundary split is pairing-safe (a tool-call message is never separated from its results). When summarization is disabled (the default), behavior is unchanged and `gpt-tokenizer` is never loaded. If the summarizer call fails on a given turn, the agent falls back to the full history for that turn rather than failing the run.

- 027b1cc: Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool (which bypasses the size cap for `tool-outputs/` paths). Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`. The `FilesystemBackend` interface gains optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods and an optional per-call `maxBytes` override on `readFile`.
- d4efa2a: `@dawn-ai/core`: the workspace and AGENTS.md capabilities now activate relative to the **app root** instead of `process.cwd()`, so they work when an app is run from any working directory (e.g. in-process tests, embedded use). No behavior change under `dawn dev` (where cwd is the app root). `CapabilityMarkerContext` gained a required `appRoot: string` field — if you construct that type in a custom capability marker or its tests, add `appRoot`.

  Extend `@dawn-ai/testing` to cover the rest of Dawn's agent capabilities. `AgentRunResult` now captures interrupts, plan updates, subagent runs, and the composed system prompt (read from aimock's request journal via `AimockHandle.getRequests()`); `harness.resume({ decision })` drives HITL interrupt→resume flows. New matchers: `expectInterrupt`/`expectNoInterrupt`, `expectSubagent`, `expectPlan`, `expectSystemPrompt` (and `expectPlan().toHaveLength`, `expectSystemPrompt().toMatch`). Dawn's own chat/coordinator example apps are now dogfooded with in-process e2e for HITL permissions, subagents, planning, skills, and AGENTS.md memory. The dogfood surfaced and fixed a harness bug: gpt-5/reasoning routes send the system prompt under the `developer` role, which the system-prompt capture now recognizes. No framework changes — all capability events were already emitted by the runtime. CI now runs the `@dawn-ai/testing` package suite and the chat-example capability e2e (both were previously absent from the vitest workspace).

### Patch Changes

- 55b69f0: Fix tool-output offloading so retrieval tools are exempt. Previously the workspace `readFile` tool — the very tool the agent uses to read back an offloaded output — had its own (large) result offloaded again, replacing it with a second pointer stub. The agent could never see the retrieved content. Retrieval/inspection tools (`readFile`, `listDir`) are now never offloaded; the new `dawn.config.ts` `toolOutput.noOffloadTools` option adds further exemptions (merged with the always-exempt built-ins). Found by a live-API smoke test.
- 2e3bc8d: Fix tool-input schema extraction for standalone literal types. A single string-literal type (e.g. a discriminated-union discriminant like `by: "date"`) was not recognized as an enum (only multi-member literal unions were), so it fell through to object extraction and was misread as an object carrying `String.prototype` methods (`charAt`, `toString`, …). This produced a bogus schema that rejected the correct argument, breaking every discriminated/object-union tool parameter end-to-end. Standalone string/number/boolean literals now extract correctly, and object extraction is guarded to genuine object types. Found by a live-API smoke test.
- Updated dependencies [027b1cc]
  - @dawn-ai/workspace@0.2.0
  - @dawn-ai/sdk@0.3.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.2.0

### Minor Changes

- 17fa4aa: Configurable env loading for `dawn dev` and `dawn verify`. The env file is now resolved by precedence: `--env-file <path>` flag > `dawn.config.ts` `env` field > default `./.env`. Shell-exported variables still win over file contents.

  - New optional `DawnConfig.env` field (a path relative to the app root). Local-only — it does not affect the deploy artifact; `langgraph.json` env detection (`.env.example` → `.env`) is unchanged.
  - New `--env-file <path>` flag on `dawn dev` and `dawn verify`.
  - A shared `resolveEnvPath` resolver now backs both `dev` and `verify`, so they agree on which file they read.
  - `loadEnvFile(dir)` is refactored to `loadEnvFiles(absPaths)` with a back-compat wrapper retained; the LangSmith auto-trace and shell-wins behaviors are preserved.

  This unblocks monorepo apps: a nested app can set `env: "../../.env"` to load the workspace-root env file.

- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.

- dd242ac: Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
- c777569: Support nested structures in tool input schemas: nested objects, arrays of objects, `Record<string,T>` maps, and object unions (arbitrary depth, capped at 8 levels). Previously any non-flat input type was silently coerced to `string` in both the generated JSON Schema and the runtime Zod schema. Schemas are emitted fully inlined (no `$ref`); `Record` maps and object unions are incompatible with provider strict mode (documented), which Dawn does not currently enable.
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- 2ba0773: Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

  - An always-on `# Skills` section in the system prompt listing each skill's name + description
  - A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

  Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).

- affeb46: Capability tools can now mutate state channels via a Dawn-native `{result, state}` wrapped return shape — `result` becomes the agent-visible ToolMessage; `state` is a partial channel update applied via reducers. The langchain bridge translates this into a LangGraph `Command({update})` internally; capability authors don't import from `@langchain/langgraph`. Plain tool returns (anything not matching the strict wrapper shape) work unchanged.

  Planning's `write_todos` adopts the new shape, fixing the previously-documented re-emission loop: the `todos` state channel now actually reflects the agent's writes between turns, so the agent stops re-calling `write_todos` with the same content. The `plan_update` stream transformer also reads defensively from both legacy and Command-shaped tool outputs so the SSE event keeps firing.

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- 8e02fe1: Move `@dawn-ai/sqlite-storage` from `peerDependencies` to `dependencies`. It backs the default SQLite checkpointer/threads store that `@dawn-ai/core` ships, so a direct dependency reflects the real relationship and avoids requiring consumers to install it separately.
- 12ee95f: Two fixes surfaced by live LLM smoke testing the chat example end-to-end:

  - **Planning `write_todos` now declares a real zod schema.** Previously the tool's `schema` field was undefined; the LangChain bridge fell back to `z.record(z.string(), z.unknown())`, which produced JSON Schema without `properties`. OpenAI strict-mode tool calling rejected the tool with `400 Invalid schema for function 'write_todos': object schema missing properties`. Now the planning marker exports an explicit zod schema for `{ todos: Array<{ content, status }> }`. Adds `zod` as a runtime dependency of `@dawn-ai/core`.
  - **`# Memory` block now includes orientation text.** The agents-md prompt fragment used to inject `# Memory\n\n<content>` only. With both planning and memory loaded, the model often called `listDir` and `readFile` to look at AGENTS.md even though Dawn had already injected its contents. The fragment now opens with a short paragraph telling the agent the block IS the memory file, re-rendered each turn, and that the way to update it is `writeFile`. Existing unit tests still pass — the `# Memory` heading and content substrings are unchanged.

- Updated dependencies [82dd52f]
- Updated dependencies [cfc3e8c]
- Updated dependencies [1005b3a]
- Updated dependencies [e8462db]
  - @dawn-ai/sdk@0.2.0
  - @dawn-ai/sqlite-storage@0.2.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/workspace@0.1.8

## 0.1.8

### Patch Changes

- Updated dependencies [8c63c1a]
  - @dawn-ai/sdk@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
  - @dawn-ai/sdk@0.1.7

## 0.1.6

### Patch Changes

- @dawn-ai/sdk@0.1.6

## 0.1.5

### Patch Changes

- @dawn-ai/sdk@0.1.5

## 0.1.4

### Patch Changes

- @dawn-ai/sdk@0.1.4

## 0.1.3

### Patch Changes

- @dawn-ai/sdk@0.1.3

## 0.1.2

### Patch Changes

- @dawn-ai/sdk@0.1.2

## 0.1.0

### Minor Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/sdk@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/sdk@0.0.1
