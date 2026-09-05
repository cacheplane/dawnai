# @dawn-ai/postgres-storage

## 0.8.26

### Patch Changes

- @dawn-ai/permissions@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/permissions@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/permissions@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/permissions@0.8.23

## 0.8.22

### Patch Changes

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 3c68800: Say which Vercel runtime the `/node` entry works on. The README listed "Vercel
  functions" among the hosts where `pg` opens a raw TCP connection, which is true
  of Vercel's Node.js runtime and false of its Edge runtime — the latter has no
  raw TCP socket, exactly like workerd, and needs the injected
  `@neondatabase/serverless` pool instead. The configuration docs carried the same
  unqualified claim in a _Works_ column and now also record that nothing here has
  been run on Vercel: it is inference from the driver, not a measurement.
- Updated dependencies [bedad77]
  - @dawn-ai/permissions@0.8.22

## 0.8.21

### Patch Changes

- c2c19da: **`@dawn-ai/postgres-storage`: `assumeMigrated`** — a new opt-out on every store
  option type. `ready()` resolves immediately instead of opening a transaction,
  taking `pg_advisory_xact_lock` and re-running the `CREATE … IF NOT EXISTS` pass.
  Set it only when the same process has already migrated that database to the
  store's current version. It exists for per-request store lifetimes: a store
  memoizes its migration on the instance, so a factory that rebuilds stores every
  request paid three migration transactions per request — and the three advisory
  locks serialized concurrent requests on the same component key. The lock itself
  is unchanged; what is skipped is a pass already known to have completed.

  **`hono` build target fixes.**

  - The generated `stores.mjs` now migrates once per isolate behind a module-scope
    flag and passes `assumeMigrated` thereafter.
  - `wrangler.toml`: the generated marker is read back, so a rebuild recognizes
    its own scaffold instead of warning about it, writing a duplicate into
    `.dawn/build/`, and reporting that duplicate as the artifact. A marked file is
    still never overwritten.
  - The build now fails, naming the config key, when `checkpointer`,
    `threadsStore`, `permissions.store` or `memory.store` is configured: the
    handle cannot cross the build boundary, and the emitted Postgres store was
    taking its place with nothing said.
  - The provider import map is exhaustive or the build fails. A route that cannot
    be imported, or an agent whose provider cannot be inferred, is an error rather
    than a silently narrower map; `summarization.model` is included, so an app
    with openai routes and an anthropic summarization model no longer builds green
    and fails at request time on a package that was never bundled.
  - All validation now runs before the first artifact is written.
  - The emitted entry throws, naming the cause, when no Workers env is bound to a
    request or `DATABASE_URL` is unset, rather than building a pool with no
    connection string.
  - Worker names generated from a package name now start with a letter, which
    Cloudflare requires.
  - `hono` is no longer a dependency of `@dawn-ai/cli`, which does not import it.
    The generated app does, and the build's dependency notice names it along with
    `@dawn-ai/postgres-storage` and `@neondatabase/serverless`.

- c2c19da: **Breaking (shipped as a patch): `pool` is now required on
  `@dawn-ai/postgres-storage`'s main entry, and `connectionString` has moved to
  `@dawn-ai/postgres-storage/node`.**

  In `0.8.19` the main entry accepted either, and built its own `pg` pool from a
  `connectionString` when you passed one. It no longer does: the main entry
  imports `pg` for _types only_, so it links on a runtime where a raw TCP driver
  cannot be bundled at all — which is what makes Cloudflare Workers possible.
  `connectionString` is no longer part of the main entry's option type, so passing
  it there is a type error, and the factory throws at construction naming the
  missing pool and pointing at the `/node` subpath. It does not fail silently or
  later.

  Two ways to migrate, both mechanical:

  ```ts
  // 1. Change the import. Same three factories, connectionString still works,
  //    the store still builds and owns its pool.
  import {
    createPostgresPermissionsStore,
    createPostgresThreadsStore,
    postgresCheckpointer,
  } from "@dawn-ai/postgres-storage/node";

  // 2. Or build the pool yourself and keep the main entry — which is what you
  //    want anyway if you are sharing one pool across all three stores.
  import { Pool } from "pg";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // Do not skip this. See below.
  pool.on("error", (error) => {
    console.error("postgres pool client error (connection dropped):", error);
  });
  postgresCheckpointer({ pool });
  ```

  **If you take option 2, attach an `'error'` listener to the pool you build.**
  `0.8.19` shipped that listener as a fix, and it attached it to the pool it built
  for you; now that you own the pool, you own its error handling, and these stores
  deliberately do not attach one to a pool you passed in — `pg` puts that
  responsibility on the pool owner, and attaching one silently would mask it.
  `pg` emits `'error'` on the **pool** when an **idle** client fails, and an
  EventEmitter `'error'` with no listener is an uncaught exception that ends the
  process. Idle connections are dropped as a matter of course (server restart,
  failover, `idle_session_timeout`), so a pool without one turns a routine
  Postgres blip into an outage. The `/node` entry in option 1 still attaches it to
  pools it builds.

  The `/node` entry is the same three factories with the `connectionString`
  convenience layered on, and it re-exports everything the main entry does, so
  option 1 is usually a one-line change. Pool ownership is unchanged in both
  shapes: a pool the store built is ended by `close()`, an injected pool is left
  alone (`ownsPool`, default `false`).

  This is a breaking change against a published version, and it is going out as a
  **patch** deliberately: the packages are in a fixed `0.x` group, where a minor
  bump would move the entire group to `1.0.0`.

- c2c19da: **`@dawn-ai/postgres-storage` runs on Cloudflare Workers.** That was an open
  question when the package shipped in `0.8.19`, and its README said so: workerd
  provides no raw TCP socket, so `pg` is unusable there.

  What changed is the main entry's typing. The pool is now structural —
  `SqlPool = { query, connect, end }` — which both `pg.Pool` and a
  `@neondatabase/serverless` WebSocket `Pool` satisfy with no driver abstraction in
  between. Injecting the latter runs the full contract, transactions included. The
  narrowness is itself the guard: `neon()`'s transaction-incapable HTTP query
  function fails to satisfy `SqlPool` at compile time, correctly, because the
  checkpointer needs real `BEGIN`/`COMMIT`. `dawn build`'s `hono` target generates
  that wiring for you. Hyperdrive should also work but is untested — it needs a
  Cloudflare account.

  Three separate pieces of evidence back this, and they are worth keeping apart:

  - **A throwaway spike** ran this package's built `dist` inside real workerd
    against `postgres:16-alpine` plus a `wsproxy`. It is the only thing that has
    checked the driver's transaction semantics there: `BEGIN`/`COMMIT`/`ROLLBACK`
    are genuine session transactions, `pg_advisory_xact_lock` really blocks a
    second session, and eight concurrent cold-start migrations converged. The spike
    was not retained; its findings are recorded in
    `docs/superpowers/specs/2026-08-05-edge-targets-design.md`.
  - **The package's own suite** is the standing regression guard for the migration
    behavior — concurrent cold starts against a virgin database, for all three
    stores — but it runs on Node with `pg` and Testcontainers, gated on
    `DAWN_TEST_PGSTORAGE`, not inside workerd.
  - **The gated `edge-workerd` CI lane** is what runs continuously inside workerd,
    and it asserts at the application level rather than the SQL level: four
    sequential AG-UI turns each carrying the model's reply, identical event shapes
    across turns, `/healthz`, and out-of-band `psql` checks that the thread,
    checkpoint, and pending-write rows are really in Postgres. It exercises the
    stores through the runtime; it does not assert on transactions, the advisory
    lock, or concurrent cold starts.

  One rule that lane settled the hard way: on workerd, **build the pool and the
  stores per request**. A connection is bound to the I/O context of the request
  that opened it, so a module-scope pool hands the next request a dead socket and
  hangs rather than erroring. `assumeMigrated` exists for exactly that lifetime —
  it lets a per-request store skip the migration pass that a module-scope boolean
  has already completed for the isolate.

  Correcting one line of `0.8.19`'s entry while it is fresh: migrations are
  memoized **on the store instance**, not per process. That distinction did not
  matter when a process built its stores once; it is the whole reason
  `assumeMigrated` had to exist once stores are per request.

  - @dawn-ai/permissions@0.8.21

## 0.8.20

### Patch Changes

- 99ca088: Republish with the `pg` pool `'error'` handler.

  **`@dawn-ai/postgres-storage@0.8.19` does not contain that fix, despite its changelog
  entry saying so.** 0.8.19 was the package's first release, so it had to be published
  by hand to create the name on npm before OIDC trusted publishing could take over — and
  that tarball was built from a release branch that had not yet absorbed the fix. npm does
  not allow a published version to be replaced, and the automated release skips any
  version already on the registry, so 0.8.19 shipped and stayed the pre-fix build.

  This release is the first one whose published artifact actually carries it. Anyone on
  `@dawn-ai/postgres-storage@0.8.19` should upgrade: without the listener, `pg` raises an
  unhandled `'error'` when an idle client is dropped — a server restart, failover,
  `idle_session_timeout` — and an EventEmitter `'error'` with no listener terminates the
  process. See the 0.8.19 entry for the full description of the fix itself.

  - @dawn-ai/permissions@0.8.20

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
