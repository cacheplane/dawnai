import type { Embedder } from "@dawn-ai/core"
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
// The loader (`loadDawnConfig`) evaluates this module with `await import(...)`,
// so a top-level `await import("@dawn-ai/memory-pgvector")` would also work —
// but a plain static import is simpler and the example depends on the package
// directly. Both the store and the embedder connect/authenticate lazily, so
// constructing them here does no I/O until the first remember/recall.
const url = process.env.DATABASE_URL

// Network-free test seam for the continuous dogfood: a deterministic
// bag-of-token-hash embedder (mirrors @dawn-ai/testing's fakeEmbedder) so the
// hybrid vector path can be exercised without a real OpenAI key or network. Off
// by default — real usage goes through `openaiEmbedder` above.
function fakeEmbedder(dims = 1536): Embedder {
  const hash = (s: string): number => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  return {
    id: `fake:${dims}`,
    dims,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dims)
        for (const tok of t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((x) => x.length > 1)) {
          const idx = hash(tok) % dims
          v[idx] = (v[idx] as number) + 1
        }
        let n = 0
        for (const x of v) n += x * x
        n = Math.sqrt(n) || 1
        for (let i = 0; i < dims; i++) v[i] = (v[i] as number) / n
        return v
      })
    },
  }
}

const embedder: Embedder | undefined = process.env.DAWN_MEMORY_FAKE_EMBEDDER
  ? fakeEmbedder(1536)
  : process.env.OPENAI_API_KEY
    ? openaiEmbedder()
    : undefined

export default {
  appDir: "src/app",
  memory: {
    writes: "auto",
    ...(embedder ? { vector: { embedder } } : {}),
    ...(url ? { store: pgvectorMemoryStore({ connectionString: url, dimensions: 1536 }) } : {}),
  },
}
