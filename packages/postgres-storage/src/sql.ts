/**
 * The minimal Postgres driver surface these stores actually use.
 *
 * Typed structurally rather than as `pg.Pool` so an edge deploy can pass
 * `@neondatabase/serverless`'s WebSocket pool with no driver abstraction and no
 * extra dependency here. The narrowness is deliberate and load-bearing:
 * `neon()`'s HTTP function exposes no `connect()`, so it fails to satisfy
 * `SqlPool` at compile time — which is exactly right, because it has no
 * sessions and therefore cannot serve the checkpointer's BEGIN/COMMIT.
 *
 * Verified 2026-08-07 against pg 8.22.0 and @neondatabase/serverless 1.1.0;
 * `test/driver-structural.test.ts` pins it so a driver bump cannot drift it.
 */
export interface SqlResult<R> {
  readonly rows: R[]
}

/** A checked-out connection: what `withTransaction` holds for BEGIN/COMMIT. */
export interface SqlClient {
  query<R = unknown>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>>
  release(): void
}

/** A connection pool. */
export interface SqlPool {
  query<R = unknown>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>>
  connect(): Promise<SqlClient>
  end(): Promise<void>
}

/** No pool, no store — say which entry point supplies one. */
export function throwNoPool(): never {
  throw new Error(
    "postgres-storage: `pool` is required. Pass a pg.Pool (or any driver with " +
      "{ query, connect, end }), or import from `@dawn-ai/postgres-storage/node` " +
      "to build one from a connection string.",
  )
}
