import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { initSchema, pgvectorMemoryStore } from "../src/index.js"

const enabled = process.env.DAWN_TEST_PGVECTOR === "1"
let container: StartedPostgreSqlContainer
let url: string

function rec(id: string, namespace: string, content: string) {
  return {
    id,
    kind: "semantic" as const,
    namespace,
    content,
    data: {},
    source: { type: "eval" as const, id: "seed" },
    confidence: 1,
    tags: [] as string[],
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe.skipIf(!enabled)("pgvector integration", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    url = container.getConnectionUri()
  }, 120_000)

  afterAll(async () => {
    await container?.stop()
  })

  test("survives Postgres terminating an idle pooled connection", async () => {
    // `pg` emits 'error' on the POOL when an IDLE client fails. With no listener,
    // Node treats an EventEmitter 'error' as an uncaught exception and takes the
    // process down. Managed Postgres terminates idle connections routinely
    // (restart, failover, idle_session_timeout), so an unhandled pool error is a
    // production crash — and it is what fails the CI lane after every test passes:
    // stopping the container terminates idle clients with 57P01.
    const store = pgvectorMemoryStore({
      connectionString: url,
      dimensions: 3,
      tablePrefix: "t_idle_kill",
    })
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on("uncaughtException", onUncaught)
    // Capture the warning too: without this the test would also pass if the pool
    // error never happened at all, which would quietly stop exercising the fix.
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "))

    try {
      // Round-trips a connection so the pool holds it IDLE.
      await store.put(rec("idle-a", "ns", "hello billing"))

      const admin = new Pool({ connectionString: url })
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database()",
        )
      } finally {
        await admin.end()
      }
      // Let the terminated client's 'error' reach the pool.
      await new Promise((resolve) => setTimeout(resolve, 250))

      expect(uncaught).toEqual([])
      // Proves the pool error actually fired and was handled, not that it never came.
      expect(warnings.some((w) => w.includes("pgvector pool client error"))).toBe(true)
      // pg discards the broken client, so the store keeps working on a new one.
      expect((await store.get("idle-a"))?.content).toBe("hello billing")
    } finally {
      console.warn = realWarn
      process.off("uncaughtException", onUncaught)
      await store.close()
    }
  })

  test("initSchema is idempotent (running twice does not error)", async () => {
    const pool = new Pool({ connectionString: url })
    try {
      const c = await pool.connect()
      try {
        const args = {
          prefix: "idem_a",
          schema: "public",
          dimensions: 3,
          m: 16,
          efConstruction: 64,
        }
        await initSchema(c, args)
        await initSchema(c, args)
      } finally {
        c.release()
      }
    } finally {
      await pool.end()
    }
  })

  test("dimension branch on real PG: 1536 vector + 3072 halfvec both init cleanly", async () => {
    const small = pgvectorMemoryStore({
      connectionString: url,
      dimensions: 1536,
      tablePrefix: "dim_small",
    })
    const large = pgvectorMemoryStore({
      connectionString: url,
      dimensions: 3072,
      tablePrefix: "dim_large",
    })
    try {
      await small.put(rec("s", "ns", "small vector row"))
      await large.put(rec("l", "ns", "halfvec row"))
      expect((await small.get("s"))?.id).toBe("s")
      expect((await large.get("l"))?.id).toBe("l")
    } finally {
      await small.close()
      await large.close()
    }
  })

  test("an HNSW index exists on the memories table", async () => {
    const store = pgvectorMemoryStore({
      connectionString: url,
      dimensions: 3,
      tablePrefix: "hnsw_check",
    })
    // Force schema init.
    await store.put(rec("x", "ns", "row"))
    const pool = new Pool({ connectionString: url })
    try {
      const res = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE '%hnsw%'",
        ["hnsw_check_memories"],
      )
      expect(res.rows.length).toBeGreaterThan(0)
    } finally {
      await pool.end()
      await store.close()
    }
  })

  test("initSchema creates the browse ordering and C-collated namespace indexes", async () => {
    const prefix = "browse_idx"
    const pool = new Pool({ connectionString: url })
    try {
      const client = await pool.connect()
      try {
        await initSchema(client, {
          prefix,
          schema: "public",
          dimensions: 3,
          m: 16,
          efConstruction: 64,
        })
        const res = await client.query<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
          [`${prefix}_memories`],
        )
        const byName = new Map(res.rows.map((r) => [r.indexname, r.indexdef]))
        expect(byName.has(`${prefix}_updated_id`)).toBe(true)
        expect(byName.get(`${prefix}_updated_id`)).toContain("updated_at DESC")
        // Which column carries the collation is the whole point: `id` must be
        // C-collated to match SQLite's BINARY tie-break, `updated_at` must not be
        // or the store's uncollated ORDER BY stops matching this index.
        expect(byName.get(`${prefix}_updated_id`)).toContain('id COLLATE "C"')
        expect(byName.get(`${prefix}_updated_id`)).not.toContain("updated_at COLLATE")
        expect(byName.has(`${prefix}_ns_c`)).toBe(true)
        expect(byName.get(`${prefix}_ns_c`)).toContain('namespace COLLATE "C"')
        // Idempotent: a second init must not throw.
        await initSchema(client, {
          prefix,
          schema: "public",
          dimensions: 3,
          m: 16,
          efConstruction: 64,
        })
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  })

  test("halfvec update round-trip: an embedding survives update() on a 3072-dim store", async () => {
    const store = pgvectorMemoryStore({
      connectionString: url,
      dimensions: 3072,
      tablePrefix: "halfvec_update",
    })
    try {
      // A 3072-dim halfvec embedding; only the first axis is 1 so a matching
      // query vector recalls it via the vector path.
      const embedding = Float32Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0))
      await store.put(rec("h", "ns", "faster shipping"), {
        embedding,
        embeddingModel: "fake:halfvec",
      })
      // Update an unrelated field — putRecord rewrites the full row, so this
      // exercises getEmbeddingRow's `embedding::text` parse for halfvec.
      await store.update("h", { confidence: 0.5 })
      const out = await store.search({
        namespace: "ns",
        query: "expedite delivery",
        queryEmbedding: embedding,
        embedderId: "fake:halfvec",
        now: "2026-07-05T00:00:00.000Z",
      })
      expect(out.map((r) => r.id)).toContain("h")
      expect((await store.get("h"))?.confidence).toBe(0.5)
    } finally {
      await store.close()
    }
  })

  test("concurrency: 10 parallel puts + a search all resolve", async () => {
    const store = pgvectorMemoryStore({
      connectionString: url,
      dimensions: 3,
      tablePrefix: "concurrency",
    })
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.put(rec(`p${i}`, "ns", `parallel row ${i}`))),
      )
      const out = await store.search({ namespace: "ns", query: "parallel" })
      expect(out.length).toBeGreaterThan(0)
    } finally {
      await store.close()
    }
  })
})
