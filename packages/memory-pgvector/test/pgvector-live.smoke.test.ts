import { openaiEmbedder } from "@dawn-ai/langchain"
import type { MemoryRecord } from "@dawn-ai/memory"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type PgvectorMemoryStore, pgvectorMemoryStore } from "../src/index.js"

// Doubly gated: needs BOTH a running Docker (DAWN_TEST_PGVECTOR=1) AND a real
// OPENAI_API_KEY. This is the top-tier dogfood proof — real OpenAI embeddings +
// real Postgres + pgvector recall across a zero-shared-token paraphrase.
const enabled = process.env.DAWN_TEST_PGVECTOR === "1" && Boolean(process.env.OPENAI_API_KEY)

let container: StartedPostgreSqlContainer
let store: PgvectorMemoryStore

function rec(
  over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace" | "content">,
): MemoryRecord {
  return {
    kind: "semantic",
    data: {},
    source: { type: "eval", id: "seed" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

describe.skipIf(!enabled)("pgvector live real-embedder paraphrase smoke", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    store = pgvectorMemoryStore({
      connectionString: container.getConnectionUri(),
      dimensions: 1536,
    })
  }, 120_000)

  afterAll(async () => {
    // close() ends the pool BEFORE the container stops, avoiding the 57P01
    // "terminating connection due to administrator command" idle-connection error.
    await store?.close()
    await container?.stop()
  })

  test("real OpenAI embeddings recall 'faster shipping' from a 0-shared-token paraphrase through pgvector", async () => {
    const embedder = openaiEmbedder()
    const namespace = "smoke"
    const content = "the customer wants faster shipping on their orders"

    // Embed + store the memory with a REAL 1536-dim OpenAI vector.
    const [embedding] = await embedder.embed([content])
    expect(embedding).toBeDefined()
    // Validates the encodingFormat:"float" fix against real OpenAI. A base64
    // interop regression would surface as the wrong dimensionality (e.g. 384),
    // which would fail here or throw on put against the vector(1536) column.
    expect(embedding?.length).toBe(1536)

    await store.put(rec({ id: "ship", namespace, content }), {
      embedding,
      embeddingModel: embedder.id,
    })

    // Embed the paraphrase query — ZERO lexical overlap with the stored content.
    const query = "expedite delivery options"
    const [queryEmbedding] = await embedder.embed([query])
    expect(queryEmbedding?.length).toBe(1536)

    const out = await store.search({
      namespace,
      query,
      queryEmbedding,
      embedderId: embedder.id,
      now: "2026-07-05T00:00:00.000Z",
    })

    const hit = out.find((r) => r.id === "ship")
    // The vector list surfaced the memory across zero lexical overlap, through
    // real pgvector + real embeddings.
    expect(hit).toBeDefined()
    expect(hit?.content).toBe(content)
  }, 60_000)
})
