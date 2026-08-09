import type { SqlClient, SqlPool } from "../sql.js"

/** Roll back best-effort — a failing ROLLBACK must not mask the original error. */
export async function rollbackQuietly(client: SqlClient): Promise<void> {
  try {
    await client.query("ROLLBACK")
  } catch {
    // Swallow: propagate the root-cause error from the caller's catch instead.
  }
}

/** Run `fn` on a pooled client inside BEGIN/COMMIT, rolling back on any throw. */
export async function withTransaction<T>(
  pool: SqlPool,
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await rollbackQuietly(client)
    throw err
  } finally {
    client.release()
  }
}
