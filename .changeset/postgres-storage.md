---
"@dawn-ai/postgres-storage": patch
"@dawn-ai/core": patch
"@dawn-ai/testing": patch
"@dawn-ai/cli": patch
---

**New package `@dawn-ai/postgres-storage`** — a Postgres backend for all three
of Dawn's durable runtime stores (deploy-anywhere B3, PR 2b). Dawn's defaults
(`.dawn/checkpoints.sqlite`, `.dawn/threads.sqlite`, `.dawn/permissions.json`)
assume one long-lived process with a writable disk; a multi-instance or
ephemeral-filesystem deploy has neither.

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export default config({
  checkpointer: postgresCheckpointer({ pool }),
  threadsStore: createPostgresThreadsStore({ pool }),
  permissions: {
    mode: "non-interactive",
    store: createPostgresPermissionsStore({ pool, mode: "non-interactive" }),
  },
})
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
