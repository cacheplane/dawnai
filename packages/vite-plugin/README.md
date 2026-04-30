# @dawn-ai/vite-plugin

Vite plugin for build-time Dawn tool schema inference.

Public surface:
- `dawnToolSchemaPlugin()` — Vite plugin that watches tool files and runs typegen
- `transformToolSource()` — injects `description` and `schema` exports from TypeScript types and JSDoc
- `extractJsDoc()` — extracts JSDoc descriptions and `@param` tags
- `extractParameterType()` — extracts TypeScript function parameter types
- `generateZodSchema()` — generates Zod schema code from extracted type info

This plugin enables zero-boilerplate tool authoring by inferring Zod schemas from TypeScript function signatures at build time.
