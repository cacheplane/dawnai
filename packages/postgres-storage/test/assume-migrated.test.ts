import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createPostgresPermissionsStore,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "../src/index.js"
import { createPostgresThreadsStore as createNodeThreadsStore } from "../src/node.js"
import type { SqlClient, SqlPool } from "../src/sql.js"

/**
 * A pool that answers nothing and records everything.
 *
 * `runMigrations` is pure statement issuing — a transaction, an advisory lock,
 * DDL, and a `max(version)` select — so "did the migration pass run" is exactly
 * "were any statements issued", with no database required.
 */
function recordingPool(): { pool: SqlPool; sql: string[] } {
  const sql: string[] = []
  const client: SqlClient = {
    query: async <R>(text: string) => {
      sql.push(text)
      return { rows: [] as R[] }
    },
    release: () => {},
  }
  return {
    sql,
    pool: {
      connect: async () => client,
      end: async () => {},
      query: async <R>(text: string) => {
        sql.push(text)
        return { rows: [] as R[] }
      },
    },
  }
}

/**
 * `assumeMigrated` is what makes a PER-REQUEST store set affordable: without it
 * a factory that rebuilds stores every request re-runs three migration
 * transactions per request, each taking `pg_advisory_xact_lock` — which also
 * serializes concurrent requests on the same component key.
 *
 * It skips a migration already known to have run. It does NOT weaken the lock:
 * the pass that did run took it exactly as before, which is what the
 * unflagged half of each case below pins.
 */
describe("assumeMigrated", () => {
  it("skips the threads migration pass entirely", async () => {
    const { pool, sql } = recordingPool()
    await createPostgresThreadsStore({ pool, assumeMigrated: true }).ready()
    expect(sql).toEqual([])
  })

  it("skips the permissions migration pass entirely", async () => {
    const { pool, sql } = recordingPool()
    await createPostgresPermissionsStore({ pool, assumeMigrated: true }).ready()
    expect(sql).toEqual([])
  })

  it("skips the checkpointer migration pass entirely", async () => {
    const { pool, sql } = recordingPool()
    await postgresCheckpointer({ pool, assumeMigrated: true }).ready()
    expect(sql).toEqual([])
  })

  it("still migrates — under the advisory lock — when unset", async () => {
    const factories: readonly ((pool: SqlPool) => { ready: () => Promise<void> })[] = [
      (pool) => createPostgresThreadsStore({ pool }),
      (pool) => createPostgresPermissionsStore({ pool }),
      (pool) => postgresCheckpointer({ pool }),
    ]
    for (const make of factories) {
      const { pool, sql } = recordingPool()
      await make(pool).ready()
      expect(sql[0]).toBe("BEGIN")
      expect(sql[1]).toContain("pg_advisory_xact_lock")
      expect(sql.at(-1)).toBe("COMMIT")
    }
  })
})

/**
 * The flow the hono target's generated `stores.mjs` actually performs: one
 * unflagged store set migrates on cold start, every later set skips. Pinned
 * against real Postgres because the fake-pool cases above can only show that no
 * statements were issued — not that the resulting store still works.
 */
describe.skipIf(process.env.DAWN_TEST_PGSTORAGE !== "1")(
  "assumeMigrated against real Postgres",
  () => {
    let container: StartedPostgreSqlContainer
    let url: string

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
      url = container.getConnectionUri()
    }, 240_000)

    afterAll(async () => {
      await container?.stop()
    })

    it("serves a store built after another instance migrated", async () => {
      const tablePrefix = `t_${Math.random().toString(36).slice(2)}`
      const cold = createNodeThreadsStore({ connectionString: url, tablePrefix })
      try {
        await cold.ready()
        await cold.createThread({ thread_id: "t-cold" })
      } finally {
        await cold.close()
      }

      const warm = createNodeThreadsStore({
        connectionString: url,
        tablePrefix,
        assumeMigrated: true,
      })
      try {
        expect(await warm.getThread("t-cold")).toMatchObject({ thread_id: "t-cold" })
        await warm.createThread({ thread_id: "t-warm" })
        expect(await warm.listThreads()).toHaveLength(2)
      } finally {
        await warm.close()
      }
    }, 60_000)

    it("fails loudly when the assertion is wrong", async () => {
      // The flag is a caller assertion, not a guess — a wrong one must surface
      // as an undefined_table error, never as a silent empty result.
      const store = createNodeThreadsStore({
        connectionString: url,
        tablePrefix: `t_${Math.random().toString(36).slice(2)}`,
        assumeMigrated: true,
      })
      try {
        await expect(store.listThreads()).rejects.toThrow(/does not exist/i)
      } finally {
        await store.close()
      }
    }, 60_000)
  },
)
