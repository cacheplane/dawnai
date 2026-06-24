---
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Fix long-term memory being unusable by real agents: the generated `remember`/`recall`
tools now expose input schemas to the model. `remember.data` is the route's own
`defineMemory()` zod schema (threaded through `MemoryContext.schema`), so the model
knows exactly what to pass; previously both tools shipped without a schema, so a real
model called them with empty/invalid args and every write was rejected by validation.
Found by a live smoke test against a real model — the deterministic aimock suite
couldn't catch it because it scripts exact tool arguments.
