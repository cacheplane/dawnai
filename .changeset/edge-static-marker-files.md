---
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Bundle route skills, `plan.md`, and `memory.md` into the `hono` and `vercel` static manifests and serve them at request time through a new `staticMarkerFs`, so those capabilities work on edge targets. The build no longer gates skills off those targets; it instead enforces each marker's size limit by name before writing artifacts. `@dawn-ai/core` also exports `MAX_PLAN_BYTES` and `MAX_MEMORY_BYTES`.
