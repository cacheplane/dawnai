---
"@dawn-ai/inspector": patch
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
memories with supersede-aware approval. Ships as a scaffold devDependency.

BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
must implement them (the built-in sqlite/pgvector stores already do, and
`runMemoryStoreConformance` enforces the contract). The config-facing store type is
now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
contradicting active row instead of leaving two actives.
