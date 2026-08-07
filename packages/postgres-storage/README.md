<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/postgres-storage

Postgres backend for Dawn's durable runtime state. Use it when the default
SQLite/file stores are too local for your deployment: multiple app instances, a
shared production database, or a host with no writable filesystem.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Configuration](https://dawnai.org/docs/configuration).

## Install

```bash
pnpm add @dawn-ai/postgres-storage pg
```

## Postgres Requirements

Any Postgres 14+ database works; no extensions are required. The stores talk to
Postgres over the standard `pg` driver, which opens a TCP connection — so this
package runs on Node, Bun, and Vercel functions. Cloudflare Workers has no raw
TCP socket for `pg` to use; a Workers deploy needs Hyperdrive or an HTTP-based
driver in front of the database.

For local development:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres"
```

## Public API

```ts
import { postgresCheckpointer } from "@dawn-ai/postgres-storage"

const checkpointer = postgresCheckpointer({ connectionString: process.env.DATABASE_URL })
```

### `postgresCheckpointer(options)`

A LangGraph `BaseCheckpointSaver` backed by Postgres. Options:

- `connectionString` — builds a pool this store owns and `close()` ends.
- `pool` — an existing `pg` pool to use instead. Share one pool across every
  Dawn store to stay inside a managed Postgres connection cap; `close()` leaves
  an injected pool alone.
- `schema` (default `public`) and `tablePrefix` (default `dawn`).

Migrations run lazily on first use and are memoized per process. Call
`checkpointer.ready()` to migrate at boot instead. Migrations take a
`pg_advisory_xact_lock`, so N instances cold-starting against a virgin database
converge rather than racing.

The serialized checkpoint, its metadata, and pending-write values are stored as
opaque `bytea`, matching the SQLite backend's BLOB. `jsonb` is deliberately not
used: it rejects a NUL byte (SQLSTATE 22P05) and a lone surrogate (22P02), both
of which reach checkpoints in normal operation via tool output. Checkpoint
ordering uses `COLLATE "C"` so it does not depend on the database's locale.

Like the SQLite backend, each checkpoint stores its channel values as one
payload rather than deduplicating unchanged channels across checkpoints. Large
unchanged values therefore repeat per checkpoint.

### `createPostgresThreadsStore(options)`

The threads store — thread ids, status, timestamps and metadata. Takes the same
`connectionString` / `pool` / `schema` / `tablePrefix` options, with the same
`ready()` and `close()` lifecycle. Its migrations are tracked separately from
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

### `assertIdentifier(name, value)`

Validates a schema or table-prefix identifier before it is interpolated into
DDL. Postgres cannot bind identifiers as `$1` placeholders, so anything that is
not a plain `/^[a-z_][a-z0-9_]*$/i` identifier is rejected outright.

### `DEFAULT_SCHEMA` / `DEFAULT_TABLE_PREFIX`

The schema (`public`) and table/index prefix (`dawn`) the stores use when the
caller does not override them. Vary the prefix to run two Dawn apps against one
database.

## Limitations

- The backend requires a reachable Postgres database. It does not fall back to
  SQLite.
- Data is stored as plaintext Postgres rows. Treat the database as sensitive
  application data.

## License

MIT
