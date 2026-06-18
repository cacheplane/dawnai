---
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Add `dawn eval --record`. Records replayable aimock fixtures from a real-model
eval run into per-case sibling `<evalBasename>.<caseSlug>.fixtures.json` files,
auto-loaded on a plain (replay) `dawn eval`. Inline `script()` fixtures stay
authoritative (record skips those cases); the gate still applies during record
but captured fixtures are flushed per-case before the verdict. New
`@dawn-ai/testing` harness capability: `createAgentHarness({ record: true })` +
`harness.getRecordedFixtures()`.
