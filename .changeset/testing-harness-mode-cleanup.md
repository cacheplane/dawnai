---
"@dawn-ai/testing": patch
---

**Breaking for callers that passed it, though it had no effect:** remove the
unsupported `mode` property from `createAgentHarness()` options — a call site
that set it stops type-checking, and should simply drop the property. The
harness remains the in-process testing API; use the existing
`createAgentProtocolInjector()` or `createSubprocessApp()` factory when testing
those execution boundaries.
