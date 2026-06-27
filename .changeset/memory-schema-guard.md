---
"@dawn-ai/core": patch
---

Guard the route memory schema before use: a non-Zod `context.memory.schema` value now falls back to a permissive `data` shape for the `remember` tool instead of being cast and failing opaquely at tool-schema use time.
