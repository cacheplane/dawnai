---
"@dawn-ai/memory": patch
"@dawn-ai/testing": patch
"@dawn-ai/langchain": patch
"@dawn-ai/memory-pgvector": patch
---

Add `@dawn-ai/memory-pgvector` — a Postgres + pgvector MemoryStore backend for
production/multi-instance vector memory. Enable with
`memory: { store: pgvectorMemoryStore({ connectionString, dimensions }) }`. HNSW
(cosine) vector retrieval; reuses the exact same pure hybrid ranking (RRF +
recency/confidence) as the default sqlite backend, so recall ordering is
identical across backends. Adds a shared `runMemoryStoreConformance` kit
(@dawn-ai/testing) run against both backends. Dimensions ≤2000 use `vector`,
≤4000 use `halfvec` (text-embedding-3-large); pgvectorscale/DiskANN and in-SQL
RRF are deferred. Also pins `openaiEmbedder` to float embedding encoding
(`encodingFormat: "float"`) — avoids a base64 decode interop quirk that could
yield wrong embedding dimensionality against some proxies/mocks.
