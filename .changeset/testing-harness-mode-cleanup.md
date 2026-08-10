---
"@dawn-ai/testing": patch
---

Remove the unsupported `mode` property from `createAgentHarness()` options. The
harness remains the in-process testing API; use the existing
`createAgentProtocolInjector()` or `createSubprocessApp()` factory when testing
those execution boundaries.
