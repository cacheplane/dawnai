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
