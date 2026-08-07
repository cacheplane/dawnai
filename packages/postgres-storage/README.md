<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/postgres-storage

Postgres backend for Dawn's durable runtime state — the checkpointer, the Agent
Protocol threads store, and the permissions store. Use it when the default
SQLite/file stores are too local for your deployment: multiple app instances, a
shared production database, or a host with no writable filesystem.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Configuration](https://dawnai.org/docs/configuration).

## Install

```bash
pnpm add @dawn-ai/postgres-storage pg
```

## Postgres Requirements

Any Postgres 14+ database works; no extensions are required. How the stores
reach it depends on which entry point you use — see
[Two entry points](#two-entry-points).

The `/node` entry talks to Postgres over the standard `pg` driver, which opens a
raw TCP connection: Node, Bun, and Vercel functions. workerd has no raw TCP
socket for `pg` to use, so an edge deploy uses the **main** entry and injects a
pool built by a driver that speaks something workerd does have.
`@neondatabase/serverless` over WebSocket is that driver — it is what Dawn's
`hono` build target emits, and the only combination that has actually been run
(see [Limitations](#limitations)). Hyperdrive should work the same way; it is
untested here.

For local development:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres"
```

## Usage

Wire all three stores in `dawn.config.ts`, sharing one pool:

```ts
import { config } from "@dawn-ai/core"
import {
  createPostgresPermissionsStore,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@dawn-ai/postgres-storage"
import { Pool } from "pg"

// One pool for all three stores — managed Postgres caps connections, and three
// owned pools burn three times the budget for no benefit.
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

Adopt them one at a time if you prefer — each store migrates and operates
independently.

### Two entry points

The main entry does not import `pg` at all — not even for types — so it links on
an edge runtime, where a raw TCP driver cannot be bundled at all. `pool` is
therefore required there; the stores throw if it is missing.

`@dawn-ai/postgres-storage/node` is the same three factories with a
`connectionString` convenience layered on, and it does import `pg`:

```ts
import { postgresCheckpointer } from "@dawn-ai/postgres-storage/node"

// Builds and owns a pg pool; close() ends it.
const checkpointer = postgresCheckpointer({ connectionString: process.env.DATABASE_URL })
```

Use the `/node` entry on Node, Bun, and Vercel functions when you want the
convenience. Use the main entry — passing your own pool — everywhere else,
including any edge deploy.

### Your app owns teardown

The Dawn runtime handler's `close()` stops accepting requests, drains in-flight
work, and releases sandboxes. It does **not** close these stores: the runtime
never created them, so it does not own their lifetime.

Each store exposes `close()`. A store built from `connectionString` (via the
`/node` entry) owns its pool and `close()` ends it; a store built from an
injected `pool` deliberately leaves that pool alone. With the shared-pool config
above, end the pool yourself:

```ts
await handler.close()
await pool.end()
```

## Public API

### `PostgresStoreOptions`

Connection and table-naming options shared by all three stores:

- `pool` — **required.** The pool every store call goes through, typed
  structurally as `SqlPool` (`{ query, connect, end }`) so a `pg.Pool` and a
  `@neondatabase/serverless` WebSocket pool both satisfy it. Share one pool
  across every Dawn store to stay inside a managed Postgres connection cap.
- `ownsPool` (default `false`) — whether `close()` should `end()` the pool. An
  injected pool is the caller's to close; the `/node` entry sets this when it
  builds the pool itself.
- `schema` (default `public`) and `tablePrefix` (default `dawn`).

`PostgresCheckpointerOptions` and `PostgresThreadsStoreOptions` are aliases of
this type; `PostgresPermissionsStoreOptions` extends it with `mode` and
`config`. The `/node` entry's `NodePostgresStoreOptions` adds
`connectionString`.

`SqlPool`, `SqlClient`, and `SqlResult` are exported for anyone wiring a driver
that is neither `pg` nor Neon. The type is deliberately narrow: `neon()`'s HTTP
query function has no `connect()`, so it fails to satisfy `SqlPool` at compile
time — correctly, because it has no session and cannot run the checkpointer's
`BEGIN`/`COMMIT`.

### `postgresCheckpointer(options)`

A LangGraph `BaseCheckpointSaver` backed by Postgres, for
`DawnConfig.checkpointer`.

Migrations run lazily on first use and are memoized **on the store instance**.
Call `checkpointer.ready()` to migrate at boot instead. Migrations take a
`pg_advisory_xact_lock`, so N instances cold-starting against a virgin database
converge rather than racing.

The memo being per instance rather than per process is why `assumeMigrated`
exists: a store built once per process migrates once, but an edge deploy builds
its stores per request, and without the opt-out every request would pay a
migration pass and serialize on the advisory lock.

The serialized checkpoint, its metadata, and pending-write values are stored as
opaque `bytea`, matching the SQLite backend's BLOB. `jsonb` is deliberately not
used: it rejects a NUL byte (SQLSTATE 22P05) and a lone surrogate (22P02), both
of which reach checkpoints in normal operation via tool output. Checkpoint
ordering uses `COLLATE "C"` so it does not depend on the database's locale.

### `createPostgresThreadsStore(options)`

The Agent Protocol threads store — thread ids, status, timestamps and metadata —
for `DawnConfig.threadsStore`. Same options and the same `ready()` / `close()`
lifecycle. Its migrations are tracked separately from
the checkpointer's, so a threads-only deployment never creates checkpoint
tables.

Two behaviors differ from the SQLite store, because Postgres is shared by
several writers:

- `createThread` upserts (`ON CONFLICT DO NOTHING`, then read back) rather than
  throwing on a duplicate id. Callers check-then-create, which races when more
  than one instance is serving.
- `updateMetadata` merges in a single statement (`metadata || $1::jsonb`), so a
  concurrent patch cannot be lost the way a read-modify-write loses it. The
  merge is shallow — a nested object is replaced wholesale — matching SQLite.

`created_at` / `updated_at` are app-generated ISO-8601 strings kept in `text`
columns, not `timestamptz`: a thread is serialized straight to JSON on the wire,
so the exact string handed out comes back unchanged. ISO-8601 sorts
lexicographically, and ordering uses `COLLATE "C"` so it does not depend on the
database's locale. `metadata` is `jsonb`.

### `createPostgresPermissionsStore(options)`

A `PermissionsStore` for `DawnConfig.permissions.store`, sharing runtime grants
across instances instead of writing a per-process `.dawn/permissions.json`.
Takes the shared options plus:

- `mode` (default `"interactive"`) — the resolved permission mode.
- `config` — the `allow`/`deny` lists from `dawn.config.ts`, applied in memory
  on every construction and never written to Postgres. Config stays the source
  of truth for itself, exactly as in the file-backed store.

`PermissionsStore.match()` is synchronous — it is called from inside tool
execution and cannot await a query — so this store is a cache with async
hydration. `load()` pulls the runtime grants into memory, `match()` reads memory
and delegates the decision to the same `matchPermission` the file store uses (so
deny-wins and prefix-except-`tool` semantics cannot drift), and `addAllow`
inserts one row and updates the map in the same call. Because the insert is
atomic, the file store's in-process write queue is not needed at all; and
because grants live in a shared table, a second instance sees them after its
next `load()`.

**Pass `mode` explicitly.** A custom store owns its own mode and allow/deny
lists: Dawn does not re-apply the sibling `permissions.mode` / `allow` / `deny`
config fields, or the `DAWN_PERMISSIONS_MODE` env override, on top of a store
you supplied — re-wrapping would silently double-apply them.

### `assertIdentifier(name, value)`

Validates a schema or table-prefix identifier before it is interpolated into
DDL. Postgres cannot bind identifiers as `$1` placeholders, so anything that is
not a plain `/^[a-z_][a-z0-9_]*$/i` identifier is rejected outright.

### `DEFAULT_SCHEMA` / `DEFAULT_TABLE_PREFIX`

The schema (`public`) and table/index prefix (`dawn`) the stores use when the
caller does not override them. Vary the prefix to run two Dawn apps against one
database.

## Limitations

- **Run under workerd; never deployed to Cloudflare.** The main entry links and
  keeps durable state inside real workerd: Dawn's gated `edge-workerd` lane
  builds an app on the `hono` target and drives four sequential AG-UI turns
  through all three of these stores against a real Postgres, over an injected
  `@neondatabase/serverless` pool. That lane is `wrangler dev --local`, which
  runs the same workerd binary the platform runs — so what it does **not**
  settle is everything only `wrangler deploy` and a live account exercise:
  bundle-size and startup-CPU limits, Cloudflare's ~6-simultaneous-outbound-
  connection cap, and the 1000-subrequest limit (in production each pooled
  connection is a subrequest). Hyperdrive is untested for the same reason — it
  needs an account.
- **Unchanged channel values repeat per checkpoint.** Each checkpoint stores its
  channel values as one payload rather than deduplicating across checkpoints.
  The SQLite backend has the same property and Dawn has lived with it; the same
  shape costs more on Postgres, because every repeat crosses the network and
  lands in TOAST storage. This has not been benchmarked — size your database
  accordingly for long threads carrying large state.
- **The per-thread run gate stays in process memory.** The Dawn runtime's "one
  run at a time per thread" check is instance-local, so two instances can each
  start a run on the same thread. A shared store makes that visible; it does not
  cause it. Serialize at the routing layer if you need a hard guarantee.
- The backend requires a reachable Postgres database. It does not fall back to
  SQLite.
- Data is stored as plaintext Postgres rows. Treat the database as sensitive
  application data.

## License

MIT
