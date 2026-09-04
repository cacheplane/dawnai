---
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Route skills, `plan.md`, and `memory.md` now work on the `hono` and `vercel` targets: `dawn build` bundles them into the static manifest and the runtime serves them through the new `staticMarkerFs` in `@dawn-ai/core`. The build no longer gates skills off those targets; instead `dawn build` and `dawn check` enforce a per-file size limit (32 KiB for `SKILL.md` and `memory.md`, 64 KiB for `plan.md`) and fail with `DAWN_E1005` by name. `@dawn-ai/core` also exports `MAX_PLAN_BYTES` and `MAX_MEMORY_BYTES`.
