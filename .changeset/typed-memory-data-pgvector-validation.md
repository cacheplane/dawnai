---
"@dawn-ai/cli": patch
"@dawn-ai/memory-pgvector": patch
---

Type generated `remember.data` from each route's `defineMemory()` Zod schema
instead of `Record<string, unknown>`, so route code gets compile-time memory fact
shape checks that match runtime validation. `pgvectorMemoryStore()` now validates
the dimension ceiling during construction, failing invalid configs before opening
a pool or initializing schema.
