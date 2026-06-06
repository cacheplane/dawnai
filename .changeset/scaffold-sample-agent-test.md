---
"create-dawn-ai-app": minor
"@dawn-ai/devkit": patch
---

`create-dawn-ai-app` now scaffolds a working `test/agent.test.ts` in new apps: it imports `@dawn-ai/testing`, adds it (plus `vitest`) to devDependencies, and wires a `"test": "vitest run"` script. The sample drives the generated `hello/[tenant]` agent route through `createAgentHarness` with an inline `script()` fixture, so a freshly scaffolded app has a passing, CI-safe agent test out of the box. This was deferred until `@dawn-ai/testing` was published to npm (now at 1.0.0).
