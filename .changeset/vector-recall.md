---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
"@dawn-ai/testing": patch
---

Opt-in vector/semantic recall for long-term memory. Enable with
`memory: { vector: { embedder: openaiEmbedder() } }`: recall becomes hybrid —
keyword (IDF) and vector (cosine) candidate lists fused co-equally by Reciprocal
Rank Fusion, with a bounded recency/confidence second stage. Keyword recall is
never dropped (dense retrieval is weak on exact IDs/codes/names), and default
keyword-only recall is unchanged. Pluggable `Embedder` (`openaiEmbedder`,
`fakeEmbedder`); embeddings stored as Float32 BLOBs in the existing node:sqlite
store (zero new native deps), tagged by embedder id with graceful keyword-only
fallback on model change. pgvector is a planned follow-up backend.
