---
"@dawn-ai/ag-ui": patch
"@dawn-ai/cli": patch
"@dawn-ai/config-biome": patch
"@dawn-ai/config-typescript": patch
"@dawn-ai/core": patch
"@dawn-ai/devkit": patch
"@dawn-ai/evals": patch
"@dawn-ai/inspector": patch
"@dawn-ai/langchain": patch
"@dawn-ai/langgraph": patch
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/permissions": patch
"@dawn-ai/sandbox": patch
"@dawn-ai/sdk": patch
"@dawn-ai/sqlite-storage": patch
"@dawn-ai/testing": patch
"@dawn-ai/vite-plugin": patch
"@dawn-ai/workspace": patch
"create-dawn-ai-app": patch
---

Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
cannot install Dawn's scaffold dependency graph (its resolver crashes), while
Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
refuses to scaffold on older Node with an actionable message, `dawn verify`'s
runtime preflight enforces the same floor, and the `dawn build` node target
uses a `node:24-slim` base. Scaffolded apps also no longer declare
`@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
(it arrives transitively via the CLI and SDK).
