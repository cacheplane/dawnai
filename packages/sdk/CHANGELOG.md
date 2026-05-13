# @dawn-ai/sdk

## 0.1.9

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

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.
