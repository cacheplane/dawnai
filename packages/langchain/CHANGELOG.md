# @dawn-ai/langchain

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
