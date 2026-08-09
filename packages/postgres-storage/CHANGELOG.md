# @dawn-ai/postgres-storage

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
