---
"@dawn-ai/core": minor
"@dawn-ai/langchain": minor
---

Support nested structures in tool input schemas: nested objects, arrays of objects, `Record<string,T>` maps, and object unions (arbitrary depth, capped at 8 levels). Previously any non-flat input type was silently coerced to `string` in both the generated JSON Schema and the runtime Zod schema. Schemas are emitted fully inlined (no `$ref`); `Record` maps and object unions are incompatible with provider strict mode (documented), which Dawn does not currently enable.
