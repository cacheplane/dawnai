import type { SqlPool } from "./sql.js"

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
  /**
   * The pool every store call goes through. Required on this entry — build one
   * with `pg` yourself, or import from `@dawn-ai/postgres-storage/node` for the
   * `connectionString` convenience. On an edge runtime pass a per-request pool
   * (see the edge deployment docs): a module-scope pool hangs on workerd.
   *
   * Share one pool across the checkpointer, threads and permissions stores to
   * stay inside a managed Postgres connection cap.
   *
   * Its error handling is YOURS, and `pg` requires a pool to have some: `pg`
   * emits `'error'` on the POOL when an IDLE client fails, and an EventEmitter
   * `'error'` with no listener is an uncaught exception that ends the process.
   * Idle connections drop as a matter of course — server restart, failover,
   * `idle_session_timeout`, a container stopping — so a pool without an
   * `'error'` listener turns a routine Postgres blip into an outage. These
   * stores deliberately do not attach one to a pool they were handed: that
   * would mask the contract from the owner who controls the lifecycle.
   * `@dawn-ai/postgres-storage/node` attaches one to pools IT builds.
   */
  readonly pool?: SqlPool
  /**
   * Whether the store owns `pool` and should `end()` it on `close()`. Defaults
   * to `false`: a pool handed in here is the caller's to close, so `close()` is
   * a no-op and the pool stays usable. `@dawn-ai/postgres-storage/node` sets it
   * when it builds the pool itself from a connection string.
   */
  readonly ownsPool?: boolean
  /** Postgres schema to place tables in. Defaults to `public`. */
  readonly schema?: string
  /** Table name prefix. Defaults to `dawn`; vary it to share one database. */
  readonly tablePrefix?: string
}
