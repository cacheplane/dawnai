---
"@dawn-ai/testing": minor
---

Consistent lifecycle API. Every harness/handle is now created with a `create*` factory and torn down with `close()` (plus `[Symbol.asyncDispose]`, so `await using` works everywhere). **Breaking renames:** `startAimock` → `createAimock` (type `AimockHandle` → `Aimock`, `.stop()` → `.close()`); `startSubprocessApp` → `createSubprocessApp` (`.stop()` → `.close()`); `injectAgentProtocol` → `createAgentProtocolInjector`. The `create*Harness` helpers and pure fixture functions are unchanged.
