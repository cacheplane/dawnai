# @dawn-ai/langchain

## 0.8.5

### Patch Changes

- Updated dependencies [f195096]
  - @dawn-ai/core@0.8.5
  - @dawn-ai/sdk@0.8.5
  - @dawn-ai/workspace@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [4e3e020]
  - @dawn-ai/core@0.8.4
  - @dawn-ai/sdk@0.8.4
  - @dawn-ai/workspace@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/core@0.8.3
  - @dawn-ai/sdk@0.8.3
  - @dawn-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- @dawn-ai/core@0.8.2
- @dawn-ai/sdk@0.8.2
- @dawn-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [89b2a73]
  - @dawn-ai/workspace@0.8.1
  - @dawn-ai/core@0.8.1
  - @dawn-ai/sdk@0.8.1

## 0.8.0

### Minor Changes

- Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`. Note: the narrow `GoogleModelId` union dropped the vendor-retired `gemini-3-pro-preview` (replaced by `gemini-3.1-pro-preview`).

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Patch Changes

- Updated dependencies [917a99f]
- Updated dependencies [a38ff61]
- Updated dependencies [fa8bdd4]
  - @dawn-ai/workspace@0.3.0
  - @dawn-ai/core@0.7.0
  - @dawn-ai/sdk@0.7.0

## 0.6.0

### Patch Changes

- @dawn-ai/core@0.6.0
- @dawn-ai/sdk@0.6.0
- @dawn-ai/workspace@0.2.0

## 0.5.0

### Patch Changes

- b6e71a7: Tool-output offload stubs now show a readable multi-line preview when the offloaded content is a single-line JSON blob (e.g. a tool that returned an object, whose newlines were escaped). `buildStub` pretty-prints JSON for the preview slice only — the stored file, its content hash, the size threshold, and the tool message content are all unchanged. Plain-text outputs are unaffected.
  - @dawn-ai/core@0.5.0
  - @dawn-ai/sdk@0.5.0
  - @dawn-ai/workspace@0.2.0

## 0.4.0

### Patch Changes

- @dawn-ai/core@0.4.0
- @dawn-ai/sdk@0.4.0
- @dawn-ai/workspace@0.2.0

## 0.3.0

### Minor Changes

- 8133553: Add opt-in conversation summarization (Phase 3 sub-project 6b). When a thread's history exceeds a token threshold, the agent is fed a condensed view — a running summary of older turns plus the most recent turns verbatim — while the **full history stays intact in the checkpoint**. This is non-destructive: summarization runs as a LangGraph `preModelHook` that returns `llmInputMessages` for the turn only and never rewrites saved `messages`, so `GET /threads/:id/state`, resume, and restart always see the complete history (and there is no tool-call/result pairing hazard).

  Enable it in `dawn.config.ts`:

  ```ts
  export default {
    summarization: {
      enabled: true, // default false
      maxTokens: 12_000, // threshold over which older turns are summarized
      keepRecentTurns: 6, // most-recent turns kept verbatim
      // model defaults to the route's model
      // tokenCounter defaults to a lazy gpt-tokenizer (o200k_base) counter
      // summarize defaults to a built-in single-LLM-call running-summary fold
    },
  };
  ```

  Both the token counter and the summarizer are pluggable (`tokenCounter`, `summarize`). The running summary is cached in agent state and refreshed incrementally — each turn folds only the newly-aged messages, so cost stays bounded. The turn-boundary split is pairing-safe (a tool-call message is never separated from its results). When summarization is disabled (the default), behavior is unchanged and `gpt-tokenizer` is never loaded. If the summarizer call fails on a given turn, the agent falls back to the full history for that turn rather than failing the run.

- 027b1cc: Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool (which bypasses the size cap for `tool-outputs/` paths). Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`. The `FilesystemBackend` interface gains optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods and an optional per-call `maxBytes` override on `readFile`.

### Patch Changes

- 30db6ed: Offloaded tool-output filenames are now deterministic — keyed on the originating `tool_call_id` (with a content-hash fallback when absent) instead of `timestamp+random`. This makes offloaded paths stable and traceable and enables deterministic agent e2e tests. The openai chat model now also honors `OPENAI_BASE_URL`, allowing a local mock provider (used by the new CI-safe aimock-based agent e2e regression tests for the discriminated-union tool-input and tool-output-offload-retrieval paths).
- b51de58: Add `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents.

  The model is mocked at the HTTP wire via `@copilotkit/aimock`, so tests exercise the real agent loop, tool calls, streaming, state, offloading, and summarization without a live API key. Three layers, one package:

  - **In-process (default):** `createAgentHarness({ appRoot, route })` runs your route through Dawn's runtime; the fastest layer and the one most users reach for.
  - **http-inject:** `injectAgentProtocol({ appRoot })` drives the full Agent-Protocol request→response pipeline in-process via `light-my-request` (no port bound) — for framework/SSE coverage.
  - **subprocess:** `startSubprocessApp({ appRoot })` boots a real `dawn dev` — for restart/persistence scenarios.

  A fluent `script()` builder compiles multi-turn tool-call conversations to aimock fixtures (auto `turnIndex`/`hasToolResult`, fixed `tool_call_id`s), and `expect*` matchers assert agent behavior: `expectToolCalled().withArgs()`, `expectFinalMessage()`, `expectStreamedTokens()`, `expectState().field()`, `expectOffloaded()`. A local-only `record()` helper captures real interactions into fixtures (CI replays strict/read-only).

  `@dawn-ai/cli` gains a `@dawn-ai/cli/runtime` programmatic export subpath (`streamResolvedRoute`, `createRuntimeRegistry`, `runTypegen`, `createRuntimeRequestListener`, …) and `buildOffload` now resolves the workspace relative to the app root (no behavior change under `dawn dev`, where cwd is the app root).

  `@dawn-ai/langchain` fixes a bug where the streamed `tool_call` event carried `undefined` tool arguments — `on_tool_start` now reads `event.data.input` (the field LangChain populates with tool args), so stream consumers (e.g. UI tool-call displays) receive the real arguments.

  Dawn's own aimock e2e lane (SP5 union schema, SP6a tool-output offloading, conversation summarization) was migrated onto this package in-process, removing the per-test `pnpm pack` + install + dev-server boot.

- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/core@0.3.0
  - @dawn-ai/workspace@0.2.0
  - @dawn-ai/sdk@0.3.0

## 0.2.0

### Minor Changes

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).
- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.

- c777569: Support nested structures in tool input schemas: nested objects, arrays of objects, `Record<string,T>` maps, and object unions (arbitrary depth, capped at 8 levels). Previously any non-flat input type was silently coerced to `string` in both the generated JSON Schema and the runtime Zod schema. Schemas are emitted fully inlined (no `$ref`); `Record` maps and object unions are incompatible with provider strict mode (documented), which Dawn does not currently enable.
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- affeb46: Capability tools can now mutate state channels via a Dawn-native `{result, state}` wrapped return shape — `result` becomes the agent-visible ToolMessage; `state` is a partial channel update applied via reducers. The langchain bridge translates this into a LangGraph `Command({update})` internally; capability authors don't import from `@langchain/langgraph`. Plain tool returns (anything not matching the strict wrapper shape) work unchanged.

  Planning's `write_todos` adopts the new shape, fixing the previously-documented re-emission loop: the `todos` state channel now actually reflects the agent's writes between turns, so the agent stops re-calling `write_todos` with the same content. The `plan_update` stream transformer also reads defensively from both legacy and Command-shaped tool outputs so the SSE event keeps firing.

- 1005b3a: Add provider-aware agent materialization. Agent configs can now carry an optional `provider`, and the LangChain runtime infers providers for known model families or lazy-loads the explicit provider integration package for built-in provider IDs.
- e8462db: `agent({...})` now accepts an optional `reasoning: { effort }` field. Maps to OpenAI's `reasoningEffort` parameter (`none | minimal | low | medium | high | xhigh`). Non-reasoning models silently ignore it. Useful for tool-use-heavy agents that aren't following directives at the default reasoning depth.

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- Updated dependencies [17fa4aa]
- Updated dependencies [82dd52f]
- Updated dependencies [8e02fe1]
- Updated dependencies [cfc3e8c]
- Updated dependencies [dd242ac]
- Updated dependencies [c777569]
- Updated dependencies [34e615b]
- Updated dependencies [2ba0773]
- Updated dependencies [affeb46]
- Updated dependencies [12ee95f]
- Updated dependencies [1005b3a]
- Updated dependencies [e8462db]
  - @dawn-ai/core@0.2.0
  - @dawn-ai/sdk@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [8c63c1a]
  - @dawn-ai/sdk@0.1.8

## 0.1.7

### Patch Changes

- db635b1: Middleware context now flows through to tools.

  A tool's second argument is now `{ middleware?: Readonly<Record<string, unknown>>, signal: AbortSignal }`. Whatever the global middleware passes via `allow({ ... })` is available to every tool invocation as `ctx.middleware` — for both `/runs/wait` and `/runs/stream` paths.

  Example:

  ```ts
  // src/middleware.ts
  export default defineMiddleware(async (req) => {
    const userId = await verifyToken(req.headers.authorization);
    return allow({ userId });
  });

  // src/app/.../tools/lookup.ts
  export default async (input, { middleware }) => {
    const userId = middleware?.userId;
    return await db.lookup(userId, input);
  };
  ```

- db635b1: Production readiness: deployment config, LLM retry, request middleware.

  - **@dawn-ai/sdk:** `agent()` descriptor now accepts an optional `retry: { maxAttempts, baseDelay }`. Adds `defineMiddleware`, `reject(status, body?)`, `allow(context?)` for request middleware, plus `MiddlewareRequest`, `MiddlewareResult`, and `RetryConfig` types.
  - **@dawn-ai/cli:** `dawn build` produces a correctly-shaped `langgraph.json` for LangGraph Platform (`dependencies: ["."]`, `env` as file path). `dawn verify` adds an advisory `deps` check (4 checks total). Dev server loads `.env` files and runs middleware before route execution.
  - **@dawn-ai/langchain:** Per-agent retry config (`maxAttempts`, `baseDelayMs`) is wired through the agent adapter and applies to streaming and non-streaming paths.

- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
  - @dawn-ai/sdk@0.1.7

## 0.1.6

### Patch Changes

- @dawn-ai/sdk@0.1.6

## 0.1.5

### Patch Changes

- 0127c57: Fix tool schema wiring so OpenAI receives valid function parameters from codegen-generated tools.json
  - @dawn-ai/sdk@0.1.5

## 0.1.4

### Patch Changes

- @dawn-ai/sdk@0.1.4

## 0.1.3

### Patch Changes

- @dawn-ai/sdk@0.1.3

## 0.1.2

### Patch Changes

- @dawn-ai/sdk@0.1.2

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/sdk@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/sdk@0.0.1
