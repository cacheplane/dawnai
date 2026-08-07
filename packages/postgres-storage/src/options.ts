import type { Pool } from "pg"

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
