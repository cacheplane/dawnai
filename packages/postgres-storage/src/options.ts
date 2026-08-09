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
  /**
   * Skip this store's migration pass entirely: `ready()` resolves immediately
   * and every method proceeds straight to its statement.
   *
   * Defaults to `false`. Set it only when THIS DATABASE has already been
   * migrated to this store's current schema version by something else in the
   * same process — the caller is asserting that, and a wrong assertion surfaces
   * as an `undefined_table` error on the first query.
   *
   * It exists for the per-request store lifetime an edge runtime forces. A
   * store's own memoization lives on the instance, so a factory that builds
   * fresh stores per request re-migrates on every request: three transactions,
   * each taking `pg_advisory_xact_lock`, which also SERIALIZES concurrent
   * requests on the same component key. The caller migrates once per isolate
   * (`ready()` on a first, unflagged set of stores) and passes this thereafter.
   *
   * It does not weaken the lock — the migration it skips is one already known
   * to have run, and the pass that did run took the lock as usual.
   */
  readonly assumeMigrated?: boolean
  /** Postgres schema to place tables in. Defaults to `public`. */
  readonly schema?: string
  /** Table name prefix. Defaults to `dawn`; vary it to share one database. */
  readonly tablePrefix?: string
}
