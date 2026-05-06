# Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign deployment config, retry, and middleware for production readiness with correct LangGraph Platform compatibility and clean DX.

**Architecture:** Three independent features. (1) `dawn build` produces valid `langgraph.json` with `dependencies: ["."]` and `env: ".env"` for `langgraph deploy`. (2) Retry is invisible infrastructure with per-agent escape hatch via `retry` field on `AgentConfig`. (3) Middleware moves to SDK as `defineMiddleware`/`reject`/`allow` helpers with parsed `MiddlewareRequest` and context injection into tools.

**Tech Stack:** TypeScript, Vitest, @dawn-ai/sdk, @dawn-ai/langchain, @dawn-ai/cli

---

### Task 1: Add `retry` field to `AgentConfig` in SDK

**Files:**
- Modify: `packages/sdk/src/agent.ts:13-16`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/agent.test.ts`

- [ ] **Step 1: Write the failing test for retry config**

In `packages/sdk/test/agent.test.ts`, add after the last test in the `describe("agent()")` block:

```ts
test("accepts optional retry config", () => {
  const descriptor = agent({
    model: "gpt-4o-mini",
    systemPrompt: "You are helpful.",
    retry: { maxAttempts: 5, baseDelay: 2000 },
  })

  expect(descriptor.model).toBe("gpt-4o-mini")
  expect(descriptor.retry).toEqual({ maxAttempts: 5, baseDelay: 2000 })
})

test("retry defaults to undefined when not provided", () => {
  const descriptor = agent({
    model: "gpt-4o-mini",
    systemPrompt: "Hello",
  })

  expect(descriptor.retry).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/sdk/test/agent.test.ts`
Expected: FAIL — `retry` does not exist on `AgentConfig`

- [ ] **Step 3: Add RetryConfig type and update AgentConfig and DawnAgent**

In `packages/sdk/src/agent.ts`, replace the entire file with:

```ts
const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent") as unknown as typeof DAWN_AGENT

declare const brand: unique symbol

export interface RetryConfig {
  readonly maxAttempts?: number
  readonly baseDelay?: number
}

export interface DawnAgent {
  readonly [brand]: "DawnAgent"
  readonly model: string
  readonly retry?: RetryConfig
  readonly systemPrompt: string
}

import type { KnownModelId } from "./known-model-ids.js"

export interface AgentConfig {
  readonly model: KnownModelId
  readonly retry?: RetryConfig
  readonly systemPrompt: string
}

export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
    ...(config.retry ? { retry: config.retry } : {}),
    systemPrompt: config.systemPrompt,
  } as unknown as DawnAgent
}

export function isDawnAgent(value: unknown): value is DawnAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    DAWN_AGENT in value &&
    (value as Record<symbol, unknown>)[DAWN_AGENT] === true
  )
}
```

- [ ] **Step 4: Export RetryConfig from SDK index**

In `packages/sdk/src/index.ts`, change the agent export line from:

```ts
export type { AgentConfig, DawnAgent } from "./agent.js"
```

to:

```ts
export type { AgentConfig, DawnAgent, RetryConfig } from "./agent.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/sdk/test/agent.test.ts`
Expected: PASS — all tests including new retry config tests

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/agent.test.ts
git commit -m "feat(sdk): add optional retry config to AgentConfig"
```

---

### Task 2: Wire per-agent retry config through agent-adapter

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts:35-69` (materializeAgent)
- Modify: `packages/langchain/src/agent-adapter.ts:148-236` (streamFromRunnable)
- Test: `packages/langchain/test/agent-adapter.test.ts` (create new)

- [ ] **Step 1: Write the failing test for retry config passthrough**

Create `packages/langchain/test/agent-adapter-retry.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest"

/**
 * These tests verify that per-agent retry config is respected.
 * We test the internal wiring by checking that withRetry receives
 * the correct options from the agent descriptor.
 */

import { isRetryableError, withRetry } from "../src/retry.js"

describe("per-agent retry config wiring", () => {
  test("withRetry respects custom maxAttempts", async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error("503 Service Unavailable")
        },
        { baseDelayMs: 10, maxAttempts: 5 },
      ),
    ).rejects.toThrow("503 Service Unavailable")

    expect(attempts).toBe(5)
  })

  test("withRetry respects custom baseDelayMs", async () => {
    let attempts = 0
    const start = Date.now()
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error("429 Too Many Requests")
        },
        { baseDelayMs: 10, maxAttempts: 2 },
      ),
    ).rejects.toThrow("429 Too Many Requests")

    expect(attempts).toBe(2)
    // With baseDelayMs=10, the delay should be very short
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
```

- [ ] **Step 2: Run test to verify it passes (these test existing behavior)**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/langchain/test/agent-adapter-retry.test.ts`
Expected: PASS — these verify existing withRetry behavior with custom options

- [ ] **Step 3: Update materializeAgent to accept and forward retry config**

In `packages/langchain/src/agent-adapter.ts`, update the `materializeAgent` function signature and the `streamFromRunnable` function to accept retry config.

First, add the import at the top of the file (after existing imports):

```ts
import type { RetryConfig } from "@dawn-ai/sdk"
```

Then update the `AgentOptions` interface (around line 76) to add retry:

```ts
export interface AgentOptions {
  readonly entry: unknown
  readonly input: unknown
  readonly retry?: RetryConfig
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly DawnToolDefinition[]
}
```

Update `streamAgent` (around line 95) to pass retry config when materializing:

In the DawnAgent descriptor path inside `streamAgent`, change:

```ts
  if (isDawnAgent(options.entry)) {
    const materializedAgent = await materializeAgent(
      options.entry,
      options.tools,
      options.stateFields,
    )
    yield* streamFromRunnable(materializedAgent, { messages }, config)
    return
  }
```

to:

```ts
  if (isDawnAgent(options.entry)) {
    const materializedAgent = await materializeAgent(
      options.entry,
      options.tools,
      options.stateFields,
    )
    const retryConfig = options.entry.retry
    yield* streamFromRunnable(materializedAgent, { messages }, config, retryConfig)
    return
  }
```

Update the legacy path to also pass retry:

```ts
  yield* streamFromRunnable(options.entry, { messages }, config, options.retry)
```

Update `streamFromRunnable` signature (around line 148) to accept retry config:

```ts
async function* streamFromRunnable(
  runnable: AgentLike,
  input: unknown,
  config: Record<string, unknown>,
  retryConfig?: RetryConfig,
): AsyncGenerator<AgentStreamChunk> {
```

In the `streamFromRunnable` fallback invoke path (around line 163), update the `withRetry` call to use per-agent config:

```ts
    const retryOptions: import("./retry.js").RetryOptions = {
      ...(retryConfig?.maxAttempts ? { maxAttempts: retryConfig.maxAttempts } : {}),
      ...(retryConfig?.baseDelay ? { baseDelayMs: retryConfig.baseDelay } : {}),
      ...(signal ? { signal } : {}),
    }
    const result = await withRetry(
      () => runnable.invoke(input, config),
      Object.keys(retryOptions).length > 0 ? retryOptions : undefined,
    )
```

In the streaming retry loop (around line 177), update the max attempts to use per-agent config:

```ts
  const maxStreamAttempts = retryConfig?.maxAttempts ?? 3
```

- [ ] **Step 4: Run all langchain tests**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/langchain/test/`
Expected: PASS — all existing tests plus new retry wiring tests

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter-retry.test.ts
git commit -m "feat(langchain): wire per-agent retry config through agent-adapter"
```

---

### Task 3: Add middleware SDK exports (defineMiddleware, reject, allow)

**Files:**
- Create: `packages/sdk/src/middleware.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/middleware.test.ts` (create new)

- [ ] **Step 1: Write the failing test for middleware helpers**

Create `packages/sdk/test/middleware.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import {
  allow,
  defineMiddleware,
  reject,
  type MiddlewareRequest,
  type MiddlewareResult,
} from "../src/middleware.js"

describe("reject()", () => {
  test("returns a reject result with status and body", () => {
    const result = reject(401, { error: "Unauthorized" })
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("body defaults to undefined", () => {
    const result = reject(403)
    expect(result).toEqual({
      action: "reject",
      status: 403,
      body: undefined,
    })
  })
})

describe("allow()", () => {
  test("returns a continue result with context", () => {
    const result = allow({ userId: "user-1", orgId: "org-1" })
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1", orgId: "org-1" },
    })
  })

  test("context defaults to undefined", () => {
    const result = allow()
    expect(result).toEqual({
      action: "continue",
      context: undefined,
    })
  })
})

describe("defineMiddleware()", () => {
  test("returns the function as-is (type-safe identity wrapper)", () => {
    const fn = async (req: MiddlewareRequest): Promise<MiddlewareResult> => {
      return allow()
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })

  test("works with a sync function", () => {
    const fn = (req: MiddlewareRequest): MiddlewareResult => {
      return reject(401)
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/sdk/test/middleware.test.ts`
Expected: FAIL — module `../src/middleware.js` does not exist

- [ ] **Step 3: Implement middleware types and helpers**

Create `packages/sdk/src/middleware.ts`:

```ts
export interface MiddlewareRequest {
  readonly assistantId: string
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  readonly params: Readonly<Record<string, string>>
  readonly routeId: string
  readonly url: string
}

export interface ContinueResult {
  readonly action: "continue"
  readonly context?: Record<string, unknown>
}

export interface RejectResult {
  readonly action: "reject"
  readonly body?: unknown
  readonly status: number
}

export type MiddlewareResult = ContinueResult | RejectResult

export type DawnMiddleware = (
  req: MiddlewareRequest,
) => Promise<MiddlewareResult> | MiddlewareResult

export function defineMiddleware(fn: DawnMiddleware): DawnMiddleware {
  return fn
}

export function reject(status: number, body?: unknown): RejectResult {
  return { action: "reject", body, status }
}

export function allow(context?: Record<string, unknown>): ContinueResult {
  return { action: "continue", context }
}
```

- [ ] **Step 4: Export middleware types and helpers from SDK index**

In `packages/sdk/src/index.ts`, add these lines at the end:

```ts
export type {
  ContinueResult,
  DawnMiddleware,
  MiddlewareRequest,
  MiddlewareResult,
  RejectResult,
} from "./middleware.js"
export { allow, defineMiddleware, reject } from "./middleware.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/sdk/test/middleware.test.ts`
Expected: PASS — all middleware helper tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/middleware.ts packages/sdk/src/index.ts packages/sdk/test/middleware.test.ts
git commit -m "feat(sdk): add defineMiddleware, reject, allow helpers"
```

---

### Task 4: Rewrite CLI middleware to use SDK types

**Files:**
- Modify: `packages/cli/src/lib/dev/middleware.ts`
- Modify: `packages/cli/test/middleware.test.ts`

- [ ] **Step 1: Rewrite the middleware test to use SDK types**

Replace the entire content of `packages/cli/test/middleware.test.ts`:

```ts
import { describe, expect, test } from "vitest"

import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import { loadMiddleware, runMiddleware } from "../src/lib/dev/middleware.js"

function createMockRequest(overrides?: Partial<MiddlewareRequest>): MiddlewareRequest {
  return {
    assistantId: "/hello/[tenant]#agent",
    headers: {},
    method: "POST",
    params: {},
    routeId: "/hello/[tenant]",
    url: "/runs/wait",
    ...overrides,
  }
}

describe("runMiddleware", () => {
  test("returns continue when middleware is undefined", async () => {
    const result = await runMiddleware(undefined, createMockRequest())
    expect(result.action).toBe("continue")
  })

  test("returns continue when middleware passes", async () => {
    const mw: DawnMiddleware = async () => ({ action: "continue" })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result.action).toBe("continue")
  })

  test("returns reject when middleware rejects", async () => {
    const mw: DawnMiddleware = async () => ({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("passes context through on continue", async () => {
    const mw: DawnMiddleware = async () => ({
      action: "continue",
      context: { userId: "user-1" },
    })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1" },
    })
  })

  test("receives parsed request with headers and params", async () => {
    let receivedReq: MiddlewareRequest | undefined

    const mw: DawnMiddleware = async (req) => {
      receivedReq = req
      return { action: "continue" }
    }

    await runMiddleware(
      mw,
      createMockRequest({
        headers: { authorization: "Bearer tok-123" },
        params: { tenant: "acme" },
        routeId: "/api/chat",
      }),
    )

    expect(receivedReq?.headers.authorization).toBe("Bearer tok-123")
    expect(receivedReq?.params.tenant).toBe("acme")
    expect(receivedReq?.routeId).toBe("/api/chat")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/cli/test/middleware.test.ts`
Expected: FAIL — `runMiddleware` signature no longer matches (single function vs array)

- [ ] **Step 3: Rewrite the middleware module to use SDK types**

Replace the entire content of `packages/cli/src/lib/dev/middleware.ts`:

```ts
import type { DawnMiddleware, MiddlewareRequest, MiddlewareResult } from "@dawn-ai/sdk"

/**
 * Load middleware from the app's middleware.ts file.
 * Convention: src/middleware.ts exports a default function (using defineMiddleware).
 */
export async function loadMiddleware(appRoot: string): Promise<DawnMiddleware | undefined> {
  const middlewarePaths = [
    `${appRoot}/src/middleware.ts`,
    `${appRoot}/src/middleware.js`,
    `${appRoot}/middleware.ts`,
    `${appRoot}/middleware.js`,
  ]

  for (const path of middlewarePaths) {
    try {
      const mod = await import(path)
      const exported = mod.default ?? mod.middleware

      if (typeof exported === "function") {
        return exported as DawnMiddleware
      }
    } catch {
      // File doesn't exist or can't be loaded — try next
    }
  }

  return undefined
}

/**
 * Run middleware. Returns continue (with optional context) or reject.
 */
export async function runMiddleware(
  middleware: DawnMiddleware | undefined,
  request: MiddlewareRequest,
): Promise<MiddlewareResult> {
  if (!middleware) {
    return { action: "continue" }
  }

  return await middleware(request)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/cli/test/middleware.test.ts`
Expected: PASS — all middleware tests pass with new single-function model

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/middleware.ts packages/cli/test/middleware.test.ts
git commit -m "refactor(cli): rewrite middleware to use SDK types (single function model)"
```

---

### Task 5: Update runtime-server to use new middleware API

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts:1-12` (imports)
- Modify: `packages/cli/src/lib/dev/runtime-server.ts:25-30` (startRuntimeServer)
- Modify: `packages/cli/src/lib/dev/runtime-server.ts:115-177` (handleRequest middleware block)
- Modify: `packages/cli/src/lib/dev/runtime-server.ts:247-294` (handleStreamRequest middleware block)

- [ ] **Step 1: Update imports in runtime-server**

In `packages/cli/src/lib/dev/runtime-server.ts`, replace the middleware import (lines 6-11):

```ts
import {
  type DawnMiddleware,
  type MiddlewareContext,
  loadMiddleware,
  runMiddleware,
} from "./middleware.js"
```

with:

```ts
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import { loadMiddleware, runMiddleware } from "./middleware.js"
```

- [ ] **Step 2: Update startRuntimeServer to use single middleware**

In `startRuntimeServer` (around line 29), change:

```ts
  const middlewares = await loadMiddleware(options.appRoot)
```

to:

```ts
  const middleware = await loadMiddleware(options.appRoot)
```

Then update all references in the function from `middlewares` to `middleware`. This means changing the `handleRequest` call (around line 45) from:

```ts
      await handleRequest({
        middlewares,
        registry,
        request,
        response,
        signal: shutdownController.signal,
      })
```

to:

```ts
      await handleRequest({
        middleware,
        registry,
        request,
        response,
        signal: shutdownController.signal,
      })
```

- [ ] **Step 3: Update handleRequest signature and middleware block**

Update the `handleRequest` function signature (around line 115) from:

```ts
async function handleRequest(options: {
  readonly middlewares: readonly DawnMiddleware[]
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
}): Promise<void> {
  const { middlewares, request, response, registry, signal } = options
```

to:

```ts
async function handleRequest(options: {
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
}): Promise<void> {
  const { middleware, request, response, registry, signal } = options
```

Replace the middleware execution block (around lines 166-177) from:

```ts
  // Run middleware before execution
  if (middlewares.length > 0) {
    const mwContext: MiddlewareContext = {
      request,
      routeId: route.routeId,
      assistantId: route.assistantId,
    }
    const mwResult = await runMiddleware(middlewares, mwContext)
    if (mwResult.action === "reject") {
      sendJson(response, mwResult.status, mwResult.body)
      return
    }
  }
```

to:

```ts
  // Run middleware before execution
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: parseHeaders(request),
    method: request.method ?? "POST",
    params: extractRouteParams(route.routeId, validatedBody.value.input),
    routeId: route.routeId,
    url: request.url ?? "/runs/wait",
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    sendJson(response, mwResult.status, mwResult.body)
    return
  }
```

- [ ] **Step 4: Update handleStreamRequest similarly**

Update the `handleStreamRequest` function signature (around line 247) from:

```ts
async function handleStreamRequest(options: {
  readonly middlewares: readonly DawnMiddleware[]
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
}): Promise<void> {
  const { middlewares, request, response, registry, signal } = options
```

to:

```ts
async function handleStreamRequest(options: {
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
}): Promise<void> {
  const { middleware, request, response, registry, signal } = options
```

Replace the middleware execution block in `handleStreamRequest` (around lines 282-294) from:

```ts
  // Run middleware before streaming
  if (middlewares.length > 0) {
    const mwContext: MiddlewareContext = {
      request,
      routeId: route.routeId,
      assistantId: route.assistantId,
    }
    const mwResult = await runMiddleware(middlewares, mwContext)
    if (mwResult.action === "reject") {
      sendJson(response, mwResult.status, mwResult.body)
      return
    }
  }
```

to:

```ts
  // Run middleware before streaming
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: parseHeaders(request),
    method: request.method ?? "POST",
    params: extractRouteParams(route.routeId, validatedBody.value.input),
    routeId: route.routeId,
    url: request.url ?? "/runs/stream",
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    sendJson(response, mwResult.status, mwResult.body)
    return
  }
```

Update the `handleStreamRequest` call in `handleRequest` (around line 130) from:

```ts
    await handleStreamRequest({ middlewares, registry, request, response, signal })
```

to:

```ts
    await handleStreamRequest({ middleware, registry, request, response, signal })
```

- [ ] **Step 5: Add helper functions at the bottom of runtime-server.ts**

Add these helper functions before the closing of the file (before or after `isRecord`):

```ts
function parseHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ")
    }
  }
  return headers
}

function extractRouteParams(
  routeId: string,
  input: unknown,
): Record<string, string> {
  const params: Record<string, string> = {}
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  const inputRecord = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >

  for (const match of matches) {
    const name = match[1]
    if (name && name in inputRecord) {
      params[name] = String(inputRecord[name])
    }
  }

  return params
}
```

- [ ] **Step 6: Run full CLI test suite**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/cli/test/`
Expected: PASS — all tests including middleware tests

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/blove/repos/dawn && pnpm typecheck`
Expected: PASS — no type errors

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts
git commit -m "refactor(cli): update runtime-server to new middleware API with parsed request"
```

---

### Task 6: Rewrite deployment-config for correct langgraph.json format

**Files:**
- Modify: `packages/cli/src/lib/build/deployment-config.ts`
- Modify: `packages/cli/test/deployment-config.test.ts`

- [ ] **Step 1: Rewrite the deployment-config test**

Replace the entire content of `packages/cli/test/deployment-config.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  extractDeploymentConfig,
  type LangGraphConfig,
} from "../src/lib/build/deployment-config.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-deploy-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("extractDeploymentConfig", () => {
  test("returns dependencies as ['.'] (project root path)", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@dawn-ai/cli": "0.1.6",
          "@langchain/openai": "0.5.0",
        },
      }),
    )

    const config = extractDeploymentConfig(tempDir)

    expect(config.dependencies).toEqual(["."])
  })

  test("returns env as path to .env file when .env exists", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=sk-test\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env")
  })

  test("returns env as path to .env.example when it exists", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env.example"), "OPENAI_API_KEY=\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env.example")
  })

  test("prefers .env.example over .env", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=real-key\nSECRET=value\n")
    writeFileSync(join(tempDir, ".env.example"), "OPENAI_API_KEY=\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env.example")
  })

  test("returns env as .env when no env files exist (will be created)", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env")
  })

  test("returns node_version 22", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const config = extractDeploymentConfig(tempDir)

    expect(config.node_version).toBe("22")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/cli/test/deployment-config.test.ts`
Expected: FAIL — `dependencies` is `["@dawn-ai/cli@0.1.6", ...]` not `["."]`

- [ ] **Step 3: Rewrite deployment-config.ts**

Replace the entire content of `packages/cli/src/lib/build/deployment-config.ts`:

```ts
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Configuration for LangGraph Platform deployment.
 * Produces fields compatible with langgraph.json schema.
 */

export interface LangGraphConfig {
  /** Paths to local directories/tarballs to install. Always ["."] for Dawn apps. */
  readonly dependencies: readonly string[]
  /** Path to env file relative to build output. */
  readonly env: string
  /** Node.js version. */
  readonly node_version: string
}

export function extractDeploymentConfig(appRoot: string): LangGraphConfig {
  return {
    dependencies: ["."],
    env: detectEnvFilePath(appRoot),
    node_version: "22",
  }
}

function detectEnvFilePath(appRoot: string): string {
  // Prefer .env.example (canonical list of required vars, no secrets)
  if (existsSync(join(appRoot, ".env.example"))) {
    return ".env.example"
  }

  // Fall back to .env (may contain secrets — LangGraph Platform reads var names only)
  return ".env"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/cli/test/deployment-config.test.ts`
Expected: PASS — all deployment config tests pass with corrected format

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/build/deployment-config.ts packages/cli/test/deployment-config.test.ts
git commit -m "fix(cli): correct langgraph.json format — dependencies as paths, env as file path"
```

---

### Task 7: Rewrite build command to produce correct langgraph.json (no Dockerfile)

**Files:**
- Modify: `packages/cli/src/commands/build.ts`

- [ ] **Step 1: Rewrite the build command**

Replace the entire content of `packages/cli/src/commands/build.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { discoverRoutes } from "@dawn-ai/core"
import type { Command } from "commander"
import { extractDeploymentConfig } from "../lib/build/deployment-config.js"
import { type CommandIo, writeLine } from "../lib/output.js"
import {
  type DiscoveredToolDefinition,
  discoverToolDefinitions,
  injectGeneratedSchemas,
} from "../lib/runtime/tool-discovery.js"
import { runTypegen } from "../lib/typegen/run-typegen.js"

interface BuildOptions {
  readonly clean?: boolean
  readonly cwd?: string
}

export function registerBuildCommand(program: Command, io: CommandIo): void {
  program
    .command("build")
    .description("Generate deployment artifacts for LangGraph Platform")
    .option("--clean", "Remove .dawn/build/ before generating")
    .option("--cwd <path>", "Path to the Dawn app root")
    .action(async (options: BuildOptions) => {
      await runBuildCommand(options, io)
    })
}

export async function runBuildCommand(options: BuildOptions, io: CommandIo): Promise<void> {
  const manifest = await discoverRoutes({
    ...(options.cwd ? { appRoot: options.cwd } : {}),
  })

  // Run typegen as pre-step to produce .dawn/routes/<id>/tools.json and .dawn/dawn.generated.d.ts
  await runTypegen({ appRoot: manifest.appRoot, manifest })

  const buildDir = resolve(manifest.appRoot, ".dawn", "build")

  if (options.clean) {
    await rm(buildDir, { recursive: true, force: true })
  }

  await mkdir(buildDir, { recursive: true })

  const graphs: Record<string, string> = {}

  for (const route of manifest.routes) {
    const discoveredTools = await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })

    // Inject codegen-generated schemas (same as runtime path)
    const routeSlug =
      route.id.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
      "index"
    const schemaManifestPath = join(manifest.appRoot, ".dawn", "routes", routeSlug, "tools.json")
    let tools = discoveredTools
    if (existsSync(schemaManifestPath)) {
      try {
        const schemaManifest = JSON.parse(readFileSync(schemaManifestPath, "utf-8")) as Record<
          string,
          unknown
        >
        tools = injectGeneratedSchemas(discoveredTools, schemaManifest)
      } catch {
        // Best-effort — fall through on parse errors
      }
    }

    const entryFilePath = join(buildDir, `${routeSlug}.ts`)
    const relativeRoutePath = relative(dirname(entryFilePath), route.routeDir)
    const routeImportPath = `${relativeRoutePath}/index.js`

    let entryContent: string

    if (route.kind === "agent" && tools.length > 0) {
      const toolImports = tools.map((tool) => {
        const relToolPath = relative(dirname(entryFilePath), dirname(tool.filePath))
        const toolFileName =
          tool.filePath.split("/").pop()?.replace(/\.ts$/, ".js") ?? `${tool.name}.js`
        return `import ${tool.name} from "${relToolPath}/${toolFileName}"`
      })

      const toolBindings = tools.map((tool) => {
        const description = tool.description ?? ""
        const schema = toolSchemaToZodSource(tool)
        return `const ${tool.name}Tool = tool(${tool.name}, {\n  name: "${tool.name}",\n  description: "${description}",\n  schema: ${schema},\n})`
      })

      const toolNames = tools.map((tool) => `${tool.name}Tool`)

      entryContent = [
        `import { agent } from "${routeImportPath}"`,
        ...toolImports,
        `import { tool } from "@langchain/core/tools"`,
        `import { z } from "zod"`,
        ``,
        ...toolBindings,
        ``,
        `export const graph = agent.bindTools([${toolNames.join(", ")}])`,
        ``,
      ].join("\n")
    } else {
      const exportName = route.kind
      entryContent = [
        `import { ${exportName} } from "${routeImportPath}"`,
        ``,
        `export const graph = ${exportName}`,
        ``,
      ].join("\n")
    }

    await writeFile(entryFilePath, entryContent, "utf8")

    const assistantId = `${route.id}#${route.kind}`
    const relativeEntryPath = `./${relative(manifest.appRoot, entryFilePath)}`
    graphs[assistantId] = `${relativeEntryPath}:graph`
  }

  const userLanggraphPath = resolve(manifest.appRoot, "langgraph.json")
  let userConfig: Record<string, unknown> = {}

  try {
    const raw = await readFile(userLanggraphPath, "utf8")
    userConfig = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // No user langgraph.json — start with empty config
  }

  const deployment = extractDeploymentConfig(manifest.appRoot)

  const mergedConfig = {
    ...userConfig,
    dependencies: deployment.dependencies,
    env: deployment.env,
    graphs,
    node_version: deployment.node_version,
  }

  const outputLanggraphPath = join(buildDir, "langgraph.json")
  await writeFile(outputLanggraphPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8")

  writeLine(io.stdout, `Build complete: ${relative(process.cwd(), buildDir)}`)
  writeLine(io.stdout, `  ${Object.keys(graphs).length} route(s) compiled`)
  writeLine(
    io.stdout,
    `  langgraph.json written to ${relative(process.cwd(), outputLanggraphPath)}`,
  )
}

interface JsonSchemaProperty {
  readonly type?: string
  readonly items?: { readonly type?: string }
}

function toolSchemaToZodSource(tool: DiscoveredToolDefinition): string {
  const schema = tool.schema as
    | {
        readonly type?: string
        readonly properties?: Record<string, JsonSchemaProperty>
        readonly required?: readonly string[]
      }
    | undefined

  if (
    !schema ||
    typeof schema !== "object" ||
    schema.type !== "object" ||
    !schema.properties ||
    Object.keys(schema.properties).length === 0
  ) {
    return "z.record(z.string(), z.unknown())"
  }

  const required = new Set(schema.required ?? [])
  const fields = Object.entries(schema.properties).map(([key, prop]) => {
    let zodType = jsonSchemaTypeToZod(prop)
    if (!required.has(key)) {
      zodType += ".optional()"
    }
    return `  ${key}: ${zodType}`
  })

  return `z.object({\n${fields.join(",\n")},\n})`
}

function jsonSchemaTypeToZod(prop: JsonSchemaProperty): string {
  switch (prop.type) {
    case "string":
      return "z.string()"
    case "number":
    case "integer":
      return "z.number()"
    case "boolean":
      return "z.boolean()"
    case "array": {
      const itemType = prop.items?.type
      if (itemType === "string") return "z.array(z.string())"
      if (itemType === "number" || itemType === "integer") return "z.array(z.number())"
      if (itemType === "boolean") return "z.array(z.boolean())"
      return "z.array(z.unknown())"
    }
    default:
      return "z.unknown()"
  }
}
```

Key changes from the original:
- Removed `generateDockerfile` import and Dockerfile generation
- Changed `mergedConfig` to use correct field ordering (`dependencies`, `env`, `graphs`, `node_version`)
- Removed Dockerfile output message

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/blove/repos/dawn && pnpm typecheck`
Expected: PASS — no type errors (generateDockerfile is no longer imported)

- [ ] **Step 3: Run full CLI test suite**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run packages/cli/test/`
Expected: PASS — all tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/build.ts
git commit -m "refactor(cli): remove Dockerfile generation, build produces langgraph.json only"
```

---

### Task 8: Clean up old deployment-config exports and dead code

**Files:**
- Modify: `packages/cli/src/lib/build/deployment-config.ts` (remove generateDockerfile if still present)

- [ ] **Step 1: Verify generateDockerfile is unused**

Run: `cd /Users/blove/repos/dawn && grep -r "generateDockerfile" packages/`

Expected: No matches (it was removed from build.ts in Task 7 and from deployment-config.ts in Task 6)

- [ ] **Step 2: Verify old DeploymentConfig type is unused**

Run: `cd /Users/blove/repos/dawn && grep -r "DeploymentConfig" packages/`

Expected: No matches (replaced by `LangGraphConfig` in Task 6)

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/blove/repos/dawn && pnpm test`
Expected: PASS — all tests across all packages pass

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/blove/repos/dawn && pnpm typecheck`
Expected: PASS — no type errors

- [ ] **Step 5: Commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: clean up dead deployment config code"
```

---

### Task 9: End-to-end validation

**Files:**
- None modified — validation only

- [ ] **Step 1: Build SDK package**

Run: `cd /Users/blove/repos/dawn && pnpm build`
Expected: PASS — all packages build successfully

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/blove/repos/dawn && pnpm test`
Expected: PASS — all tests across all packages pass

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/blove/repos/dawn && pnpm typecheck`
Expected: PASS — no type errors

- [ ] **Step 4: Run lint**

Run: `cd /Users/blove/repos/dawn && pnpm lint`
Expected: PASS — no lint errors

- [ ] **Step 5: Verify SDK exports include new types**

Run: `cd /Users/blove/repos/dawn && grep -A 5 "middleware" packages/sdk/src/index.ts`

Expected output should show `defineMiddleware`, `reject`, `allow`, `MiddlewareRequest`, `MiddlewareResult`, `ContinueResult`, `RejectResult`, `DawnMiddleware` exports.

Run: `cd /Users/blove/repos/dawn && grep "RetryConfig" packages/sdk/src/index.ts`

Expected output should show `RetryConfig` in the agent type export line.

- [ ] **Step 6: Verify langgraph.json format is correct**

Inspect the deployment config test assertions to confirm:
- `dependencies` is `["."]`
- `env` is a file path string (`.env` or `.env.example`)
- `node_version` is `"22"`

These were validated in Task 6 tests. No additional action needed if tests pass.

---

## Deferred: Middleware Context Flow to Tools

The spec describes middleware-injected context flowing into tool `context` parameters. This requires changes across the tool execution pipeline (`runtime-server.ts` → `executeResolvedRoute`/`streamResolvedRoute` → `agent-adapter.ts` → tool `run` callbacks). The current `RuntimeTool` signature is `(input) => output` with signal provided separately.

This is deferred because:
1. Middleware gating (reject/allow) works without context flow
2. Context flow requires coordinated changes across 4+ files and multiple interfaces
3. It deserves its own design pass to get the `context` parameter shape right

The middleware infrastructure built in this plan is designed to support this — `allow({ userId, orgId })` returns context that can be threaded through once the plumbing exists.
