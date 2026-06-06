---
"@dawn-ai/testing": minor
---

`@dawn-ai/testing`: close the fixture record→commit→replay loop with `loadFixtures(path)` / `writeFixtures(path, script()|FixtureSet)`, and add a gated live mode — `createAgentHarness({ live: true })` runs the real model via aimock proxy-record (real responses, with `run.systemPrompt` retained), requiring `OPENAI_API_KEY` and meant to be gated with `skipIf` (never in CI). Drift detection remains deferred to a future phase. (A `create-dawn-ai-app` scaffold sample test will follow once `@dawn-ai/testing` is published to npm.)
