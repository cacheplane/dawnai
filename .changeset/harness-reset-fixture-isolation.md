---
"@dawn-ai/testing": patch
"create-dawn-ai-app": patch
"@dawn-ai/devkit": patch
---

Fix test-harness scenario isolation. `createAgentHarness().reset()` now clears
the accumulated aimock fixtures (restoring the constructor baseline) instead of
only swapping the thread id. Previously fixtures were registered additively and
aimock's matcher is first-match-in-array-order, so a loosely-matched fixture
from an earlier scenario (a raw `FixtureSet` without a `userMessage`, e.g. the
offload pattern) could shadow a later run's first model call. This surfaced as a
HITL permission interrupt that "only fired on the first run." The research
scaffold's HITL test now shares one harness with `reset()` between tests instead
of constructing a dedicated one.
