---
"@dawn-ai/testing": minor
---

Unit-test harnesses for tools, middleware, and the workspace. `createToolHarness(tool)` invokes a route tool against a real, temp-backed `ctx.fs` (reusable `invoke()` for cumulative-state assertions); `createMiddlewareHarness(mw)` exercises a `FilesystemMiddleware` over a temp `localFilesystem` and offers `assertForwardsAll()` to catch dropped backend methods; `createWorkspaceHarness()` is the shared temp-`WorkspaceFs` fixture, also usable to test `ctx.fs` code directly. All are async `create*Harness` factories with `.close()` and `[Symbol.asyncDispose]` (for `await using`), matching `createAgentHarness`. Adds `@dawn-ai/workspace` and `@dawn-ai/sdk` as peer dependencies.
