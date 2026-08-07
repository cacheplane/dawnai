/**
 * Node-only entry: the `connectionString` convenience.
 *
 * Kept out of the main entry because a *value* import of `pg` pulls net/tls/dns
 * into the module graph, which makes the package unlinkable on an edge runtime
 * (verified: 17 unresolved-builtin errors bundling on platform: browser).
 *
 * Every export here is the main entry's factory with the pool filled in, so
 * behaviour is otherwise identical — including pool ownership: a store that
 * builds its own pool from `connectionString` ends it on `close()`, and a pool
 * passed in stays the caller's.
 */
import { Pool } from "pg"
import { postgresCheckpointer as baseCheckpointer, type DawnPostgresSaver } from "./checkpointer.js"
import type { PostgresStoreOptions } from "./options.js"
import {
  createPostgresPermissionsStore as baseCreatePermissionsStore,
  type PostgresPermissionsStore,
  type PostgresPermissionsStoreOptions,
} from "./permissions.js"
import type { SqlPool } from "./sql.js"
import {
  createPostgresThreadsStore as baseCreateThreadsStore,
  type PostgresThreadsStore,
} from "./threads.js"

/** Main-entry options plus the connection string this entry can act on. */
export interface NodePostgresStoreOptions extends PostgresStoreOptions {
  /** Postgres connection string; used to build an owned pool when `pool` is absent. */
  readonly connectionString?: string
}

/** Permissions-store options plus the connection string this entry can act on. */
export interface NodePostgresPermissionsStoreOptions extends PostgresPermissionsStoreOptions {
  /** Postgres connection string; used to build an owned pool when `pool` is absent. */
  readonly connectionString?: string
}

/**
 * Supply the pool the main entry now requires, and say who owns it.
 *
 * `ownsPool` carries the lifecycle decision explicitly rather than being
 * inferred from "was a pool passed in": from the base store's point of view a
 * pool is always passed in now, so without this flag `close()` would silently
 * stop ending the pool a connection string built.
 *
 * A pool built HERE also gets an `'error'` listener. `pg` emits that event on
 * the POOL when an IDLE client fails, and an EventEmitter `'error'` with no
 * listener is an uncaught exception — the process dies. Idle connections are
 * dropped as a matter of course (server restart, failover,
 * `idle_session_timeout`, a container stopping), so without a listener a
 * routine Postgres blip takes the whole app down instead of the pool quietly
 * replacing one connection. That matters most precisely here, where the stores
 * hold durable state for long-running deployments.
 *
 * Nothing to recover: pg has already discarded the broken client and the next
 * query opens a new one. Warn rather than swallow, so an unhealthy database
 * stays visible.
 *
 * A caller-supplied pool is left alone — its owner controls its lifecycle and
 * its error handling, and pg requires every pool to have a listener, so
 * attaching one to someone else's pool would mask that contract. This is the
 * only place in the package that constructs a pool, so that rule cannot drift
 * between the checkpointer, threads and permissions stores.
 */
function poolFor(options: NodePostgresStoreOptions): {
  readonly pool: SqlPool
  readonly ownsPool: boolean
} {
  if (options.pool) return { pool: options.pool, ownsPool: options.ownsPool ?? false }
  const pool = new Pool(
    options.connectionString ? { connectionString: options.connectionString } : {},
  )
  pool.on("error", (error) => {
    console.warn(`[dawn:storage] postgres pool client error (connection dropped): ${String(error)}`)
  })
  return { pool, ownsPool: true }
}

/** Build a Postgres-backed LangGraph checkpointer, optionally from a connection string. */
export function postgresCheckpointer(options: NodePostgresStoreOptions = {}): DawnPostgresSaver {
  return baseCheckpointer({ ...options, ...poolFor(options) })
}

/** Build a Postgres-backed threads store, optionally from a connection string. */
export function createPostgresThreadsStore(
  options: NodePostgresStoreOptions = {},
): PostgresThreadsStore {
  return baseCreateThreadsStore({ ...options, ...poolFor(options) })
}

/** Build a Postgres-backed permissions store, optionally from a connection string. */
export function createPostgresPermissionsStore(
  options: NodePostgresPermissionsStoreOptions = {},
): PostgresPermissionsStore {
  return baseCreatePermissionsStore({ ...options, ...poolFor(options) })
}

export * from "./index.js"
