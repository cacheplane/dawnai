import { runMemoryStoreConformance } from "@dawn-ai/testing"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe } from "vitest"
import { type PgvectorMemoryStore, pgvectorMemoryStore } from "../src/index.js"

const enabled = process.env.DAWN_TEST_PGVECTOR === "1"
let container: StartedPostgreSqlContainer
let url: string

describe.skipIf(!enabled)("pgvector real-Postgres conformance", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    url = container.getConnectionUri()
  }, 120_000)

  afterAll(async () => {
    await container?.stop()
  })

  runMemoryStoreConformance({
    name: "pgvectorMemoryStore",
    // Fresh isolated store per test via a unique table prefix (no cross-test bleed).
    makeStore: () =>
      pgvectorMemoryStore({
        connectionString: url,
        dimensions: 3,
        tablePrefix: `t_${Math.random().toString(36).slice(2)}`,
      }),
    describe,
    close: (s) => (s as PgvectorMemoryStore).close(),
  })
})
