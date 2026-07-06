---
"@dawn-ai/core": patch
"@dawn-ai/permissions": patch
"@dawn-ai/cli": patch
---

New memory write-governance mode `writes: "ask"`: memory supersedes (belief contradictions) prompt a HITL Once/Always/Deny interrupt with old-vs-new detail; ADDs and idempotent updates flow silently; headless behaves as `auto`. New `kind: "memory"` permission interrupt, `gateMemorySupersede`, `suggestedMemoryPattern`, and a `dawn check` warning for the `ask` + `approve: ["remember"]` double-gate overlap.
