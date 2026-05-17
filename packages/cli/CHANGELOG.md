# @dawn-ai/cli

## 1.0.0

### Minor Changes

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).
- dd242ac: Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- 2ba0773: Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

  - An always-on `# Skills` section in the system prompt listing each skill's name + description
  - A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

  Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).

### Patch Changes

- 13bc466: Fix SSE event payload double-wrap. `toSseEvent` used to emit `data: {"data": <value>}` for the built-in `chunk` event and for capability-contributed events like `plan_update`, when it should emit `data: <value>` directly. The shaped events (`tool_call`, `tool_result`, `done`) are unchanged.
- 36552c1: docs: rebrand "LangGraph Platform" → "LangSmith" in user-visible CLI strings, README, and comments. The `langgraph.json` artifact format is unchanged.
- Updated dependencies [ad17e85]
- Updated dependencies [dd242ac]
- Updated dependencies [34e615b]
- Updated dependencies [2ba0773]
- Updated dependencies [affeb46]
- Updated dependencies [12ee95f]
- Updated dependencies [e8462db]
  - @dawn-ai/langchain@1.0.0
  - @dawn-ai/core@1.0.0
  - @dawn-ai/langgraph@1.0.0

## 0.1.8

### Patch Changes

- 8c63c1a: Move testing helpers to `@dawn-ai/sdk/testing`.

  `expectError`, `expectMeta`, `expectOutput`, and the `RuntimeExecutionResult` type family now live at `@dawn-ai/sdk/testing` — the canonical home users have been intuitively reaching for. The old `@dawn-ai/cli/testing` subpath continues to work as a re-export for back-compat (and is now JSDoc-deprecated).

  ```ts
  // Preferred
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/sdk/testing";

  // Still works (re-exports from sdk)
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/cli/testing";
  ```

  No behavior change. The packed runtime contract test now exercises both subpaths.

  - @dawn-ai/core@0.1.8
  - @dawn-ai/langchain@0.1.8
  - @dawn-ai/langgraph@0.1.8

## 0.1.7

### Patch Changes

- db635b1: Docs overhaul.

  - **Public package READMEs** (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`) fleshed out with overview, install, key APIs, and links to the website.
  - All package READMEs include the Dawn brand image header.

  No code or runtime behavior changes — README content only.

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
  - @dawn-ai/langchain@0.1.7
  - @dawn-ai/core@0.1.7
  - @dawn-ai/langgraph@0.1.7

## 0.1.6

### Patch Changes

- Use codegen schemas in dawn build output — tool descriptions and JSON Schema from .dawn/routes/<id>/tools.json are now injected into generated entry files for LangGraph Platform deployment.
  - @dawn-ai/core@0.1.6
  - @dawn-ai/langchain@0.1.6
  - @dawn-ai/langgraph@0.1.6

## 0.1.5

### Patch Changes

- 0127c57: Fix tool schema wiring so OpenAI receives valid function parameters from codegen-generated tools.json
- Updated dependencies [0127c57]
  - @dawn-ai/langchain@0.1.5
  - @dawn-ai/core@0.1.5
  - @dawn-ai/langgraph@0.1.5

## 0.1.4

### Patch Changes

- 86e24c0: Switch to pure OIDC trusted publishing (no npm token required)
  - @dawn-ai/core@0.1.4
  - @dawn-ai/langchain@0.1.4
  - @dawn-ai/langgraph@0.1.4

## 0.1.3

### Patch Changes

- 78745f6: chore: validate trusted publishing pipeline
  - @dawn-ai/core@0.1.3
  - @dawn-ai/langchain@0.1.3
  - @dawn-ai/langgraph@0.1.3

## 0.1.2

### Patch Changes

- Fix watch-mode typegen not picking up file changes due to ESM import cache
  - @dawn-ai/core@0.1.2
  - @dawn-ai/langchain@0.1.2
  - @dawn-ai/langgraph@0.1.2

## 0.1.0

### Minor Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

### Patch Changes

- Updated dependencies [fbe7770]
  - @dawn-ai/core@0.1.0

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/core@0.0.2
  - @dawn-ai/langchain@0.0.2
  - @dawn-ai/langgraph@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/core@0.0.1
  - @dawn-ai/langchain@0.0.1
  - @dawn-ai/langgraph@0.0.1
