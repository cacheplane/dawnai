import type { Pool } from "pg"
import { withTransaction } from "./internal/tx.js"

/**
 * Guard SQL identifiers that are interpolated into DDL (Postgres cannot bind
 * them as `$1` placeholders). `prefix`/`schema` come from the store's own
 * config, not untrusted query input, but a malformed config must not produce
 * broken/injected DDL — so reject anything that isn't a plain identifier.
 */
export function assertIdentifier(name: string, value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value))
    throw new Error(
      `postgres-storage: ${name} must be a valid SQL identifier (/^[a-z_][a-z0-9_]*$/i), got ${JSON.stringify(value)}`,
    )
}

/** Default table/index prefix. Two apps can share one database by varying it. */
export const DEFAULT_TABLE_PREFIX = "dawn"

/** Default Postgres schema the stores create their tables in. */
export const DEFAULT_SCHEMA = "public"

/** Where a store's tables live. Both parts are identifier-checked on construction. */
export interface TableNaming {
  readonly schema: string
  readonly prefix: string
}

/** Fully-qualified name for one of a store's logical tables. */
export function qualify(naming: TableNaming, table: string): string {
  return `${naming.schema}.${naming.prefix}_${table}`
}

/**
 * One forward-only schema step. Versioned rather than "CREATE IF NOT EXISTS and
 * hope", mirroring `@dawn-ai/sqlite-storage`'s migrate.ts, so later shape
 * changes are expressible.
 */
export interface Migration {
  readonly version: number
  readonly up: (naming: TableNaming) => string
}

/** Namespaces Dawn's advisory locks away from any the host application takes. */
const ADVISORY_LOCK_CLASS = 0x4441574e

/** FNV-1a 32-bit, coerced to the signed int4 `pg_advisory_xact_lock` accepts. */
function advisoryLockId(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash | 0
}

/**
 * Apply every migration newer than what the database already has.
 *
 * The whole thing runs inside ONE transaction holding `pg_advisory_xact_lock`.
 * That is not belt-and-braces: an edge deploy scaling 0→N cold-starts N
 * processes that migrate simultaneously, and concurrent `CREATE TABLE IF NOT
 * EXISTS` / migration-row inserts against a virgin database fail with 23505 on
 * the `pg_type` catalog index and on the migrations primary key. A memoized
 * in-process `ready()` only covers the single-process race.
 *
 * `component` gives each store its own migrations table and its own lock, so
 * the three stores in this package version independently and do not serialize
 * against each other.
 */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[],
  opts: { readonly schema: string; readonly prefix: string; readonly component: string },
): Promise<void> {
  const { schema, prefix, component } = opts
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  assertIdentifier("component", component)
  const naming: TableNaming = { schema, prefix }
  const versions = qualify(naming, `${component}_migrations`)
  const sorted = [...migrations].sort((a, b) => a.version - b.version)

  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      ADVISORY_LOCK_CLASS,
      advisoryLockId(`${schema}.${prefix}.${component}`),
    ])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${versions} (version integer PRIMARY KEY)`)
    const res = await client.query<{ v: number | null }>(
      `SELECT max(version) AS v FROM ${versions}`,
    )
    const current = res.rows[0]?.v ?? 0
    for (const migration of sorted) {
      if (migration.version <= current) continue
      await client.query(migration.up(naming))
      await client.query(`INSERT INTO ${versions} (version) VALUES ($1)`, [migration.version])
    }
  })
}

/**
 * `created_at`/`updated_at` are app-generated ISO-8601 strings kept as `text`,
 * not `timestamptz`: a `Thread` is serialized straight to JSON on the wire, so
 * the exact string the store handed out must come back unchanged. ISO-8601
 * sorts lexicographically, so `ORDER BY updated_at DESC` is still chronological
 * — under `COLLATE "C"`, which is byte ordering and therefore independent of
 * the database's locale.
 *
 * `metadata` is `jsonb` so a merge is one atomic `||` rather than a
 * read-modify-write. Note that `pg` parses jsonb on read: the driver hands back
 * an object, and `JSON.parse`-ing it again would throw.
 */
export const THREADS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (naming) => `
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "threads")} (
        thread_id text PRIMARY KEY,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'idle'
      );
      CREATE INDEX IF NOT EXISTS ${naming.prefix}_threads_updated_idx
        ON ${qualify(naming, "threads")} (updated_at COLLATE "C" DESC);
    `,
  },
]

/**
 * Checkpoint and metadata are BYTEA, not jsonb. Dawn serializes both with
 * LangGraph's `JsonPlusSerializer` and stores the resulting bytes opaquely,
 * exactly as the SQLite saver stores a BLOB. jsonb cannot hold a NUL byte
 * (22P05) or a lone surrogate (22P02), and both reach checkpoints for real via
 * sandbox stdout flowing into tool results.
 */
export const CHECKPOINTER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (naming) => `
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "checkpoints")} (
        thread_id text NOT NULL,
        checkpoint_ns text NOT NULL DEFAULT '',
        checkpoint_id text NOT NULL,
        parent_checkpoint_id text,
        type text,
        checkpoint bytea NOT NULL,
        metadata bytea NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "writes")} (
        thread_id text NOT NULL,
        checkpoint_ns text NOT NULL DEFAULT '',
        checkpoint_id text NOT NULL,
        task_id text NOT NULL,
        idx integer NOT NULL,
        channel text NOT NULL,
        type text,
        value bytea,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `,
  },
]
