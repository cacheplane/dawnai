---
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/inspector": patch
"@dawn-ai/testing": patch
---

Episodic memory: Dawn apps can now remember what happened. An opt-in runtime
recorder (`memory.episodes.enabled`) writes one episode per agent run from the
trace — input, outcome, tools used, duration — with TTL + per-namespace cap
retention; routes can also author episodes via `defineMemory({ kind: "episodic" })`
(append-only, never superseded). `recall` gains `since`/`until` time windows
(ISO or relative like "-24h"); the Inspector gains a timeline view; `dawn memory
prune` runs retention manually.

BREAKING: `MemoryStore` now requires `prune(opts)`; `search`/`browse` accept
`since`/`until` and exclude expired rows when `now` is supplied. Custom stores
must implement `prune` (`runMemoryStoreConformance` enforces the contract).
