# @dawn-ai/testing

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

- Updated dependencies [6fb2b10]
- Updated dependencies [dd02f56]
- Updated dependencies [26780ab]
- Updated dependencies [5ccae68]
- Updated dependencies [57e8cd9]
  - @dawn-ai/cli@0.8.8
  - @dawn-ai/core@0.8.8
  - @dawn-ai/memory@0.8.8
  - @dawn-ai/workspace@0.8.8
  - @dawn-ai/sdk@0.8.8

## 0.8.7

### Patch Changes

- Updated dependencies [6a683c8]
  - @dawn-ai/memory@0.8.7
  - @dawn-ai/core@0.8.7
  - @dawn-ai/cli@0.8.7
  - @dawn-ai/sdk@0.8.7
  - @dawn-ai/workspace@0.8.7

## 0.8.6

### Patch Changes

- Updated dependencies [9d115de]
- Updated dependencies [4ede7b8]
- Updated dependencies [1d51b75]
  - @dawn-ai/cli@0.8.6
  - @dawn-ai/workspace@0.8.6
  - @dawn-ai/core@0.8.6
  - @dawn-ai/sdk@0.8.6
  - @dawn-ai/memory@0.8.6

## 0.8.5

### Patch Changes

- Updated dependencies [91d999c]
- Updated dependencies [f195096]
  - @dawn-ai/cli@0.8.5
  - @dawn-ai/core@0.8.5
  - @dawn-ai/memory@0.8.5
  - @dawn-ai/sdk@0.8.5
  - @dawn-ai/workspace@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [f8c3a21]
- Updated dependencies [4e3e020]
  - @dawn-ai/cli@0.8.4
  - @dawn-ai/core@0.8.4
  - @dawn-ai/memory@0.8.4
  - @dawn-ai/sdk@0.8.4
  - @dawn-ai/workspace@0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.
- 7339ded: Tool scoping: `agent({ tools: { allow, deny } })` restricts which tools a route's agent may call. `deny` revokes a tool; `allow` grants a withheld capability tool; deny wins.

  **Behavior change (pre-1.0):** subagents are now least-privilege by default — a subagent gets only its own route-local `tools/*.ts`; ambient capability tools (`writeFile`, `runBash`, `task`, `writeTodos`, `remember`/`recall`, …) are withheld unless named in `tools.allow`. A subagent that relied on inheriting these must add `tools: { allow: [...] }`. `dawn check` validates scope names. This scopes the tool surface, not execution (not a sandbox).

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/memory@0.8.3
  - @dawn-ai/core@0.8.3
  - @dawn-ai/cli@0.8.3
  - @dawn-ai/sdk@0.8.3
  - @dawn-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- 5372180: Add `dawn eval --record`. Records replayable aimock fixtures from a real-model
  eval run into per-case sibling `<evalBasename>.<caseSlug>.fixtures.json` files,
  auto-loaded on a plain (replay) `dawn eval`. Inline `script()` fixtures stay
  authoritative (record skips those cases); the gate still applies during record
  but captured fixtures are flushed per-case before the verdict. New
  `@dawn-ai/testing` harness capability: `createAgentHarness({ record: true })` +
  `harness.getRecordedFixtures()`.
- f62b555: Consistent lifecycle API. Every harness/handle is now created with a `create*` factory and torn down with `close()` (plus `[Symbol.asyncDispose]`, so `await using` works everywhere). **Breaking renames:** `startAimock` → `createAimock` (type `AimockHandle` → `Aimock`, `.stop()` → `.close()`); `startSubprocessApp` → `createSubprocessApp` (`.stop()` → `.close()`); `injectAgentProtocol` → `createAgentProtocolInjector`. The `create*Harness` helpers and pure fixture functions are unchanged.
- 1241d21: Unit-test harnesses for tools, middleware, and the workspace. `createToolHarness(tool)` invokes a route tool against a real, temp-backed `ctx.fs` (reusable `invoke()` for cumulative-state assertions); `createMiddlewareHarness(mw)` exercises a `FilesystemMiddleware` over a temp `localFilesystem` and offers `assertForwardsAll()` to catch dropped backend methods; `createWorkspaceHarness()` is the shared temp-`WorkspaceFs` fixture, also usable to test `ctx.fs` code directly. All are async `create*Harness` factories with `.close()` and `[Symbol.asyncDispose]` (for `await using`), matching `createAgentHarness`. Adds `@dawn-ai/workspace` and `@dawn-ai/sdk` as peer dependencies.
- Updated dependencies [5372180]
  - @dawn-ai/cli@0.8.2
  - @dawn-ai/core@0.8.2
  - @dawn-ai/sdk@0.8.2
  - @dawn-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- 306380e: Fix test-harness scenario isolation. `createAgentHarness().reset()` now clears
  the accumulated aimock fixtures (restoring the constructor baseline) instead of
  only swapping the thread id. Previously fixtures were registered additively and
  aimock's matcher is first-match-in-array-order, so a loosely-matched fixture
  from an earlier scenario (a raw `FixtureSet` without a `userMessage`, e.g. the
  offload pattern) could shadow a later run's first model call. This surfaced as a
  HITL permission interrupt that "only fired on the first run." The research
  scaffold's HITL test now shares one harness with `reset()` between tests instead
  of constructing a dedicated one.
- Updated dependencies [407303f]
- Updated dependencies [89b2a73]
  - @dawn-ai/cli@0.8.1
  - @dawn-ai/core@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward. This package is renumbered down from its previous independent 5.x line; the old higher versions were removed from npm.

## 5.0.0

### Minor Changes

- 2be46a4: Add `expectToolSequence(run, names, opts?)` and `expectNoToolErrors(run)` matchers,
  plus a derived `toolResults` field on `AgentRunResult` (and a `deriveToolResults`
  helper). `expectToolSequence` asserts tool call order (subsequence by default,
  `{ strict: true }` for contiguous); `expectNoToolErrors` catches tools that
  returned an error result while correctly treating HITL permission interrupts as
  non-errors.

### Patch Changes

- Updated dependencies [9fd967f]
- Updated dependencies [a38ff61]
  - @dawn-ai/cli@0.7.0
  - @dawn-ai/core@0.7.0

## 4.0.0

### Patch Changes

- @dawn-ai/cli@0.6.0
- @dawn-ai/core@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies [b4a2295]
  - @dawn-ai/cli@0.5.0
  - @dawn-ai/core@0.5.0

## 2.0.0

### Patch Changes

- @dawn-ai/cli@0.4.0
- @dawn-ai/core@0.4.0

## 1.0.0

### Minor Changes

- b51de58: Add `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents.

  The model is mocked at the HTTP wire via `@copilotkit/aimock`, so tests exercise the real agent loop, tool calls, streaming, state, offloading, and summarization without a live API key. Three layers, one package:

  - **In-process (default):** `createAgentHarness({ appRoot, route })` runs your route through Dawn's runtime; the fastest layer and the one most users reach for.
  - **http-inject:** `injectAgentProtocol({ appRoot })` drives the full Agent-Protocol request→response pipeline in-process via `light-my-request` (no port bound) — for framework/SSE coverage.
  - **subprocess:** `startSubprocessApp({ appRoot })` boots a real `dawn dev` — for restart/persistence scenarios.

  A fluent `script()` builder compiles multi-turn tool-call conversations to aimock fixtures (auto `turnIndex`/`hasToolResult`, fixed `tool_call_id`s), and `expect*` matchers assert agent behavior: `expectToolCalled().withArgs()`, `expectFinalMessage()`, `expectStreamedTokens()`, `expectState().field()`, `expectOffloaded()`. A local-only `record()` helper captures real interactions into fixtures (CI replays strict/read-only).

  `@dawn-ai/cli` gains a `@dawn-ai/cli/runtime` programmatic export subpath (`streamResolvedRoute`, `createRuntimeRegistry`, `runTypegen`, `createRuntimeRequestListener`, …) and `buildOffload` now resolves the workspace relative to the app root (no behavior change under `dawn dev`, where cwd is the app root).

  `@dawn-ai/langchain` fixes a bug where the streamed `tool_call` event carried `undefined` tool arguments — `on_tool_start` now reads `event.data.input` (the field LangChain populates with tool args), so stream consumers (e.g. UI tool-call displays) receive the real arguments.

  Dawn's own aimock e2e lane (SP5 union schema, SP6a tool-output offloading, conversation summarization) was migrated onto this package in-process, removing the per-test `pnpm pack` + install + dev-server boot.

- d4efa2a: `@dawn-ai/core`: the workspace and AGENTS.md capabilities now activate relative to the **app root** instead of `process.cwd()`, so they work when an app is run from any working directory (e.g. in-process tests, embedded use). No behavior change under `dawn dev` (where cwd is the app root). `CapabilityMarkerContext` gained a required `appRoot: string` field — if you construct that type in a custom capability marker or its tests, add `appRoot`.

  Extend `@dawn-ai/testing` to cover the rest of Dawn's agent capabilities. `AgentRunResult` now captures interrupts, plan updates, subagent runs, and the composed system prompt (read from aimock's request journal via `AimockHandle.getRequests()`); `harness.resume({ decision })` drives HITL interrupt→resume flows. New matchers: `expectInterrupt`/`expectNoInterrupt`, `expectSubagent`, `expectPlan`, `expectSystemPrompt` (and `expectPlan().toHaveLength`, `expectSystemPrompt().toMatch`). Dawn's own chat/coordinator example apps are now dogfooded with in-process e2e for HITL permissions, subagents, planning, skills, and AGENTS.md memory. The dogfood surfaced and fixed a harness bug: gpt-5/reasoning routes send the system prompt under the `developer` role, which the system-prompt capture now recognizes. No framework changes — all capability events were already emitted by the runtime. CI now runs the `@dawn-ai/testing` package suite and the chat-example capability e2e (both were previously absent from the vitest workspace).

- 64ca1c7: `@dawn-ai/testing`: close the fixture record→commit→replay loop with `loadFixtures(path)` / `writeFixtures(path, script()|FixtureSet)`, and add a gated live mode — `createAgentHarness({ live: true })` runs the real model via aimock proxy-record (real responses, with `run.systemPrompt` retained), requiring `OPENAI_API_KEY` and meant to be gated with `skipIf` (never in CI). Drift detection remains deferred to a future phase. (A `create-dawn-ai-app` scaffold sample test will follow once `@dawn-ai/testing` is published to npm.)

### Patch Changes

- Updated dependencies [b51de58]
- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/cli@0.3.0
  - @dawn-ai/core@0.3.0
