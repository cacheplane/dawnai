---
"@dawn-ai/testing": minor
"create-dawn-ai-app": minor
---

`@dawn-ai/testing`: close the fixture record→commit→replay loop with `loadFixtures(path)` / `writeFixtures(path, script()|FixtureSet)`, and add a gated live mode — `createAgentHarness({ live: true })` runs the real model via aimock proxy-record (real responses, with `run.systemPrompt` retained), requiring `OPENAI_API_KEY` and meant to be gated with `skipIf` (never in CI). `create-dawn-ai-app` now scaffolds a sample `test/agent.test.ts` + the `@dawn-ai/testing` devDependency so new apps ship with a passing agent test. Drift detection remains deferred to a future phase.
