import { runThreadsStoreConformance } from "@dawn-ai/testing"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createPostgresThreadsStore, type PostgresThreadsStore } from "../src/index.js"

const enabled = process.env.DAWN_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let url: string

/** Fresh, never-migrated table set per store — no truncation, no teardown. */
const freshPrefix = () => `t_${Math.random().toString(36).slice(2)}`

describe.skipIf(!enabled)("postgres threads store against real Postgres", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start()
    url = container.getConnectionUri()
  }, 120_000)

  afterAll(async () => {
    await container?.stop()
  })

  runThreadsStoreConformance({
    name: "createPostgresThreadsStore",
    makeStore: () =>
      createPostgresThreadsStore({ connectionString: url, tablePrefix: freshPrefix() }),
    describe,
    close: (store) => (store as PostgresThreadsStore).close(),
  })

  test("concurrent createThread on the same id yields one intact thread", async () => {
    // The cross-instance race the sqlite store cannot survive: callers
    // check-then-create, so N instances can all miss and all insert.
    const prefix = freshPrefix()
    const stores = Array.from({ length: 8 }, () =>
      createPostgresThreadsStore({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      const results = await Promise.all(
        stores.map((s, i) => s.createThread({ thread_id: "t-race", metadata: { writer: i } })),
      )
      // Every caller gets the same thread back, not a partial or a failure.
      const [first] = results
      for (const r of results) expect(r).toEqual(first)
      const all = await stores[0]?.listThreads()
      expect(all).toHaveLength(1)
      expect(await stores[0]?.getThread("t-race")).toEqual(first)
    } finally {
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 60_000)

  test("concurrent updateMetadata patches do not lose each other", async () => {
    // Read-modify-write in JS would drop all but one of these; the jsonb `||`
    // merge is a single statement, so every key survives.
    const store = createPostgresThreadsStore({ connectionString: url, tablePrefix: freshPrefix() })
    try {
      await store.createThread({ thread_id: "t-merge" })
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.updateMetadata("t-merge", { [`k${i}`]: i })),
      )
      const fetched = await store.getThread("t-merge")
      expect(fetched?.metadata).toEqual(
        Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])),
      )
    } finally {
      await store.close()
    }
  }, 60_000)

  test("an injected pool is shared, not owned: close() leaves it usable", async () => {
    const pool = new Pool({ connectionString: url })
    try {
      const store = createPostgresThreadsStore({ pool, tablePrefix: freshPrefix() })
      await store.createThread({ thread_id: "t-shared" })
      await store.close()
      const res = await pool.query("SELECT 1 AS ok")
      expect(res.rows[0]).toEqual({ ok: 1 })
    } finally {
      await pool.end()
    }
  }, 60_000)

  test("two prefixes in one database do not see each other's threads", async () => {
    const a = createPostgresThreadsStore({ connectionString: url, tablePrefix: freshPrefix() })
    const b = createPostgresThreadsStore({ connectionString: url, tablePrefix: freshPrefix() })
    try {
      await a.createThread({ thread_id: "t-only-a" })
      expect(await b.getThread("t-only-a")).toBeUndefined()
      expect(await b.listThreads()).toEqual([])
    } finally {
      await a.close()
      await b.close()
    }
  }, 60_000)

  test("concurrent cold-start threads migrations against a virgin database all succeed", async () => {
    // Separate stores means separate pools and separate memoized ready()s, so
    // only the advisory lock inside runMigrations prevents 23505 here.
    const prefix = freshPrefix()
    const stores = Array.from({ length: 8 }, () =>
      createPostgresThreadsStore({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      const results = await Promise.allSettled(stores.map((s) => s.ready()))
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
    } finally {
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 60_000)
})

describe("postgres threads store construction", () => {
  test("rejects an unsafe schema or table prefix before any connection is made", () => {
    expect(() => createPostgresThreadsStore({ schema: "public; DROP TABLE x" })).toThrow(/schema/)
    expect(() => createPostgresThreadsStore({ tablePrefix: "bad-prefix" })).toThrow(/tablePrefix/)
  })
})
