---
"@dawn-ai/testing": minor
---

Add `expectToolSequence(run, names, opts?)` and `expectNoToolErrors(run)` matchers,
plus a derived `toolResults` field on `AgentRunResult` (and a `deriveToolResults`
helper). `expectToolSequence` asserts tool call order (subsequence by default,
`{ strict: true }` for contiguous); `expectNoToolErrors` catches tools that
returned an error result while correctly treating HITL permission interrupts as
non-errors.
