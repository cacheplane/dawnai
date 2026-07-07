import { openaiEmbedder } from "@dawn-ai/langchain"
import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"

// Backend-switchable memory example.
//
//   default (no env)          → SQLite store, keyword-only recall. Zero setup.
//   OPENAI_API_KEY set        → adds vector/semantic recall via OpenAI embeddings
//                               (text-embedding-3-small, 1536 dims).
//   DATABASE_URL set          → swaps the SQLite store for Postgres + pgvector.
//
// The two toggles are independent: DATABASE_URL alone gives you keyword recall
// through Postgres; add OPENAI_API_KEY to light up the hybrid keyword+vector
// path. See README.md for the `docker run` one-liner.
//
// Both the store and the embedder connect/authenticate lazily, so constructing
// them here does no I/O until the first remember/recall.
const url = process.env.DATABASE_URL
const embedder = process.env.OPENAI_API_KEY ? openaiEmbedder() : undefined

export default {
  appDir: "src/app",
  memory: {
    writes: "auto",
    ...(embedder ? { vector: { embedder } } : {}),
    ...(url ? { store: pgvectorMemoryStore({ connectionString: url, dimensions: 1536 }) } : {}),
  },
}
