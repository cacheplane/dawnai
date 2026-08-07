import { Pool } from "pg"

/**
 * Connection + table-naming options shared by every store in this package.
 *
 * The three stores are configured identically at the Postgres level, so the
 * checkpointer's and the threads store's option types are aliases of this and
 * the permissions store's extends it. Keeping one declaration is what makes
 * "share one pool across all three" a single documented rule rather than three
 * copies that can drift.
 */
export interface PostgresStoreOptions {
  /** Postgres connection string; used to build an owned pool. */
  readonly connectionString?: string
  /**
   * An existing pool to use instead of building one from `connectionString`.
   * Share one pool across the checkpointer, threads and permissions stores to
   * stay inside a managed Postgres connection cap.
   */
  readonly pool?: Pool
  /** Postgres schema to place tables in. Defaults to `public`. */
  readonly schema?: string
  /** Table name prefix. Defaults to `dawn`; vary it to share one database. */
  readonly tablePrefix?: string
}

/**
 * Resolves the pool a store should use: the caller's, or one built from
 * `connectionString`.
 *
 * An owned pool gets an `'error'` listener. `pg` emits that event on the POOL when
 * an IDLE client fails, and an EventEmitter `'error'` with no listener is an uncaught
 * exception — the process dies. Idle connections are dropped as a matter of course
 * (server restart, failover, `idle_session_timeout`, a container stopping), so
 * without a listener a routine Postgres blip takes the whole app down instead of the
 * pool quietly replacing one connection. That matters most precisely here, where the
 * stores hold durable state for long-running and edge deployments.
 *
 * Nothing to recover: pg has already discarded the broken client and the next query
 * opens a new one. Warn rather than swallow, so an unhealthy database stays visible.
 *
 * A caller-supplied pool is left alone — its owner controls its lifecycle and its
 * error handling, and pg requires every pool to have a listener, so attaching one to
 * someone else's pool would mask that contract.
 */
export function resolvePool(options: PostgresStoreOptions): {
  readonly ownsPool: boolean
  readonly pool: Pool
} {
  if (options.pool) return { ownsPool: false, pool: options.pool }

  const pool = new Pool(
    options.connectionString ? { connectionString: options.connectionString } : {},
  )
  pool.on("error", (error) => {
    console.warn(`[dawn:storage] postgres pool client error (connection dropped): ${String(error)}`)
  })
  return { ownsPool: true, pool }
}
