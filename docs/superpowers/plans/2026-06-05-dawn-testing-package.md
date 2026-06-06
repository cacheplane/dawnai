# `@dawn-ai/testing` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents — and dogfood it by migrating Dawn's own aimock e2e lane onto it.

**Architecture:** Three execution layers in one package: (A) **in-process** — runs the user's route through Dawn's runtime (`streamResolvedRoute`) with aimock at the model HTTP boundary; (B) **http-inject** — drives the full Agent-Protocol request→SSE pipeline in-process via `light-my-request` (no port); (C) **subprocess** — boots a real `dawn dev` for the one restart-resume scenario. A `script()` fluent builder compiles multi-turn conversations to aimock fixtures; `expect*` matchers assert over an `AgentRunResult`.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, vitest, biome, `@copilotkit/aimock`, `light-my-request`, `@dawn-ai/cli` runtime entries, `@langchain/langgraph` checkpointer.

**Worktree:** `/Users/blove/repos/dawn-testing` (branch `feat/dawn-testing`, off `origin/main`).

**Spec:** `docs/superpowers/specs/2026-06-05-dawn-testing-package-design.md`.

---

## Background facts (verified against the codebase — trust these)

- **Route resolution:** `createRuntimeRegistry(appRoot)` (from `packages/cli/src/lib/dev/runtime-registry.ts`) returns a `RuntimeRegistry` with `.lookup(routeKey)` → `{ routeFile, routeId, routePath, assistantId }`. `routeKey` is the AP form like `"/chat#agent"`.
- **In-process run:** `streamResolvedRoute({ appRoot, input, routeFile, routeId, routePath, threadId?, signal?, resumeDecision? })` is an `async function*` yielding `StreamChunk`s: `{ type: "chunk", data }` (token), `{ type: "tool_call", name, input }`, `{ type: "tool_result", name, output }`, `{ type: "done", output }`, `{ type: "interrupt", data }`. (Source: `packages/cli/src/lib/runtime/execute-route.ts`.)
- **Checkpointer:** `resolveCheckpointer(appRoot): Promise<BaseCheckpointSaver>` (same file) — honors `dawn.config.ts` `checkpointer` or defaults to `.dawn/checkpoints.sqlite`.
- **Typegen:** `runTypegen({ appRoot, manifest })` (`packages/cli/src/lib/typegen/run-typegen.ts`); `manifest` comes from `discoverRoutes({ appRoot })` (exported from `@dawn-ai/core`).
- **Model→aimock wiring:** `createChatModel` honors `OPENAI_BASE_URL` (added in PR #190). Set `OPENAI_BASE_URL`/`OPENAI_API_KEY` env **before** the route runs (Dawn materializes the model lazily at execution time, so setting env in the harness constructor is sufficient).
- **aimock API:** `new LLMock({ port: 0, chunkSize: 4096 })`; `mock.addFixturesFromJSON(entries)`; `await mock.start()`; `mock.port`; `mock.url`; `await mock.stop()`. Base URL for the OpenAI SDK is `` `${mock.url}/v1` ``. The matcher reads the **last** user message and matches `match.userMessage` as a **substring** (when no `requestTransform` is set), plus `match.turnIndex` (= count of `assistant`-role messages in the request) and `match.hasToolResult` (= any `tool`-role message present). Response shape: `{ content: string }` or `{ toolCalls: [{ id, name, arguments }] }`.
- **AP state shape:** `GET /threads/:id/state` returns `{ values: <checkpoint.channel_values> }`; messages are JsonPlusSerializer-shaped: `{ id: ["langchain_core","messages","HumanMessage"|"AIMessage"|"ToolMessage"], kwargs: { name?, content } }`.
- **Existing internal harness to replace:** `test/runtime/run-aimock-e2e.test.ts` (5 `it()`s: boot smoke, SP5 union, SP6a retrieve, SP6a fallback, SUMM) + `test/runtime/support/aimock-runner.ts`. The runtime lane is `pnpm exec vitest --run --config test/runtime/vitest.config.ts`; its `include` list lives in `test/runtime/vitest.config.ts`.
- **Package scaffold template:** copy `packages/sqlite-storage/{package.json,tsconfig.json,vitest.config.ts}` shape. Engines `>=22.13.0`. `tsconfig.json` extends `../config-typescript/node.json` with `outDir: dist`, `rootDir: src`. Lint via `biome check --config-path ../config-biome/biome.json …`.
- **Existing testing homes (do not reuse for aimock):** `@dawn-ai/sdk/testing` (`expectOutput`/`expectMeta`/`expectError` — route-output unit helpers) and the deprecated `@dawn-ai/cli/testing` re-export. The new aimock matchers (`expectToolCalled`, …) are distinct and live in `@dawn-ai/testing` to avoid pulling aimock/runtime into `@dawn-ai/sdk`.

---

## File Structure

**New package `packages/testing/` (`@dawn-ai/testing`):**
- `package.json`, `tsconfig.json`, `vitest.config.ts` — scaffold.
- `src/index.ts` — public barrel.
- `src/aimock-runner.ts` — `startAimock({ fixtures })` → `{ baseUrl, port, stop() }` (port 0).
- `src/fixture-builder.ts` — `script()` fluent builder → `FixtureSet`; `AimockFixture`/`FixtureSet` types.
- `src/run-result.ts` — `AgentRunResult` type + `collectRunResult(stream)` reducer.
- `src/harness.ts` — `createAgentHarness(options)` → `AgentHarness` (`run`/`reset`/`close`), Layer A wiring + mode dispatch.
- `src/matchers.ts` — `expectToolCalled`/`expectFinalMessage`/`expectStreamedTokens`/`expectState`/`expectOffloaded`.
- `src/record.ts` — `record()` wrapping the aimock recorder.
- `src/http-inject.ts` — Layer B `light-my-request` driver.
- `src/subprocess.ts` — Layer C `dawn dev` boot + AP base URL.
- `test/*.test.ts` — unit tests per unit.

**Framework seams (existing packages):**
- `packages/cli/src/runtime-exports.ts` (new) — programmatic re-exports; wired as `@dawn-ai/cli/runtime` subpath in `packages/cli/package.json`.
- `packages/cli/src/lib/dev/runtime-server.ts` (modify) — extract `createRuntimeRequestListener`.

**Dogfood (repo-level tests):**
- `test/runtime/run-aimock-e2e.test.ts` (rewrite onto `@dawn-ai/testing`), `test/runtime/vitest.config.ts` (update includes), `test/runtime/fixtures/aimock/*` (retire/convert).

---

## Task 1: Add the `@dawn-ai/cli/runtime` programmatic export subpath

**Files:**
- Create: `packages/cli/src/runtime-exports.ts`
- Modify: `packages/cli/package.json` (exports map)
- Test: `packages/cli/test/runtime-exports.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/runtime-exports.test.ts
import { expect, it } from "vitest"
import * as rt from "../src/runtime-exports.js"

it("surfaces the programmatic runtime entries", () => {
  expect(typeof rt.streamResolvedRoute).toBe("function")
  expect(typeof rt.executeResolvedRoute).toBe("function")
  expect(typeof rt.invokeResolvedRoute).toBe("function")
  expect(typeof rt.resolveCheckpointer).toBe("function")
  expect(typeof rt.resolveThreadsStore).toBe("function")
  expect(typeof rt.createRuntimeRegistry).toBe("function")
  expect(typeof rt.runTypegen).toBe("function")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run test/runtime-exports.test.ts`
Expected: FAIL — cannot find `../src/runtime-exports.js`.

- [ ] **Step 3: Create the re-export module**

```ts
// packages/cli/src/runtime-exports.ts
/**
 * Programmatic runtime surface for tooling (e.g. @dawn-ai/testing).
 * Kept separate from the `dawn` CLI bin entry (src/index.ts) so importing
 * the runtime never triggers the commander program. Exposed as the
 * `@dawn-ai/cli/runtime` subpath.
 */
export {
  executeResolvedRoute,
  invokeResolvedRoute,
  resolveCheckpointer,
  resolveThreadsStore,
  streamResolvedRoute,
} from "./lib/runtime/execute-route.js"
export { createRuntimeRegistry, type RuntimeRegistry } from "./lib/dev/runtime-registry.js"
export { runTypegen } from "./lib/typegen/run-typegen.js"
export type { StreamChunk } from "./lib/runtime/stream-types.js"
```

- [ ] **Step 4: Wire the subpath export in `packages/cli/package.json`**

Add to the `exports` object (after the `"./testing"` entry) and to `tsconfig.build.json`'s output (no change needed if it already builds all of `src`). The `exports` map becomes:

```jsonc
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./runtime": { "types": "./dist/runtime-exports.d.ts", "default": "./dist/runtime-exports.js" },
  "./testing": { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" }
}
```

- [ ] **Step 5: Run test + build to verify it passes**

Run: `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli exec vitest --run test/runtime-exports.test.ts`
Expected: PASS; build emits `dist/runtime-exports.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/runtime-exports.ts packages/cli/package.json packages/cli/test/runtime-exports.test.ts
git commit -m "feat(cli): add @dawn-ai/cli/runtime programmatic export subpath"
```

---

## Task 2: Extract an injectable request listener from `startRuntimeServer`

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/src/runtime-exports.ts` (export the new factory)
- Test: `packages/cli/test/runtime-request-listener.test.ts`

This is a pure refactor: the inline `createServer(async (req,res) => …)` closure becomes a named `createRuntimeRequestListener(opts)` returning `(req, res) => void`, and `startRuntimeServer` wraps it. No behavior change to the running server. Layer B (Task 13) drives this listener with `light-my-request`.

- [ ] **Step 1: Read the current `startRuntimeServer` body**

Run: `sed -n '47,130p' packages/cli/src/lib/dev/runtime-server.ts`
Note the closure passed to `createServer`, the `state`/`shutdownController`/`routes`/`dispatch` it closes over, and the `listen` call.

- [ ] **Step 2: Write the failing test**

```ts
// packages/cli/test/runtime-request-listener.test.ts
import { expect, it } from "vitest"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.js"

it("builds a request listener without binding a port", async () => {
  const appRoot = process.cwd() // any dir; we only assert the factory shape
  const { listener, close } = await createRuntimeRequestListener({ appRoot })
  expect(typeof listener).toBe("function")
  expect(listener.length).toBe(2) // (req, res)
  await close()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run test/runtime-request-listener.test.ts`
Expected: FAIL — `createRuntimeRequestListener` is not exported.

- [ ] **Step 4: Refactor — extract the factory**

In `packages/cli/src/lib/dev/runtime-server.ts`, introduce the exported factory that builds everything `startRuntimeServer` currently builds (registry, middleware, threadsStore, checkpointer, state, shutdownController, routes) and returns `{ listener, close }`. Then make `startRuntimeServer` consume it.

```ts
export interface RuntimeRequestListener {
  readonly listener: (req: IncomingMessage, res: ServerResponse) => void
  readonly close: () => Promise<void>
}

export async function createRuntimeRequestListener(
  options: StartRuntimeServerOptions,
): Promise<RuntimeRequestListener> {
  const registry = await createRuntimeRegistry(options.appRoot)
  const middleware = await loadMiddleware(options.appRoot)
  const threadsStore = await resolveThreadsStore(options.appRoot)
  const checkpointer = await resolveCheckpointer(options.appRoot)

  const state = { acceptingRequests: true, activeRequests: 0, closed: false }
  const shutdownController = new AbortController()

  const routes = buildRouteTable({
    appRoot: options.appRoot,
    checkpointer,
    middleware,
    registry,
    signal: shutdownController.signal,
    threadsStore,
  })

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    // Move the EXACT body of the current `createServer(async (req,res) => {…})`
    // closure here, verbatim — it already closes over `state`, `routes`,
    // `shutdownController`, `dispatch`. Keep it an async IIFE if it currently
    // awaits, e.g.:  void (async () => { … })()
    void handleRequest(request, response, { state, routes, shutdownController })
  }

  const close = async (): Promise<void> => {
    if (state.closed) return
    state.closed = true
    state.acceptingRequests = false
    shutdownController.abort()
    // (no server to close here; the HTTP server wrapper owns socket teardown)
  }

  return { listener, close }
}
```

Refactor `startRuntimeServer` to wrap it:

```ts
export async function startRuntimeServer(
  options: StartRuntimeServerOptions,
): Promise<RuntimeServer> {
  const { listener, close: closeListener } = await createRuntimeRequestListener(options)
  const server = createServer(listener)
  await listen(server, options.port)
  const addr = server.address()
  const url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : ""
  return {
    url,
    close: async () => {
      await closeListener()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
```

Implementation note for the implementer: the current closure body (request-counting, `acceptingRequests` gate, `dispatch(routes, …)`, error handling) must be moved **verbatim** into a `handleRequest(request, response, ctx)` helper or inlined into `listener`. Do not change its logic. Run the existing server tests to prove parity (Step 6).

- [ ] **Step 5: Export the factory from the runtime subpath**

Add to `packages/cli/src/runtime-exports.ts`:

```ts
export {
  createRuntimeRequestListener,
  type RuntimeRequestListener,
  startRuntimeServer,
} from "./lib/dev/runtime-server.js"
```

- [ ] **Step 6: Run tests to verify pass + no regression**

Run:
```
pnpm --filter @dawn-ai/cli exec vitest --run test/runtime-request-listener.test.ts
pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli typecheck
```
Then the AP server test lane (proves the refactor didn't change behavior):
```
pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/run-agent-protocol.test.ts
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/runtime-exports.ts packages/cli/test/runtime-request-listener.test.ts
git commit -m "refactor(cli): extract createRuntimeRequestListener for in-process HTTP injection"
```

---

## Task 3: Scaffold the `@dawn-ai/testing` package

**Files:**
- Create: `packages/testing/package.json`
- Create: `packages/testing/tsconfig.json`
- Create: `packages/testing/vitest.config.ts`
- Create: `packages/testing/src/index.ts`
- Test: `packages/testing/test/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@dawn-ai/testing",
  "version": "0.2.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/cacheplane/dawnai/tree/main/packages/testing#readme",
  "repository": { "type": "git", "url": "git+https://github.com/cacheplane/dawnai.git", "directory": "packages/testing" },
  "bugs": { "url": "https://github.com/cacheplane/dawnai/issues" },
  "engines": { "node": ">=22.13.0" },
  "files": ["dist"],
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@copilotkit/aimock": "^1.28.0",
    "light-my-request": "^6.6.0"
  },
  "peerDependencies": {
    "@dawn-ai/cli": "workspace:*",
    "@dawn-ai/core": "workspace:*"
  },
  "devDependencies": {
    "@dawn-ai/cli": "workspace:*",
    "@dawn-ai/config-typescript": "workspace:*",
    "@dawn-ai/core": "workspace:*",
    "@langchain/langgraph-checkpoint": "^1.0.2",
    "@types/node": "25.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../config-typescript/node.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"], passWithNoTests: true },
})
```

- [ ] **Step 4: Create a placeholder barrel + smoke test**

```ts
// packages/testing/src/index.ts
export const DAWN_TESTING_PACKAGE = "@dawn-ai/testing"
```

```ts
// packages/testing/test/smoke.test.ts
import { expect, it } from "vitest"
import { DAWN_TESTING_PACKAGE } from "../src/index.js"

it("package barrel loads", () => {
  expect(DAWN_TESTING_PACKAGE).toBe("@dawn-ai/testing")
})
```

- [ ] **Step 5: Install + build + test**

Run:
```
pnpm install
pnpm --filter @dawn-ai/testing build
pnpm --filter @dawn-ai/testing test
```
Expected: install links the workspace package; build emits `dist/index.js`; smoke test PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/testing pnpm-lock.yaml
git commit -m "feat(testing): scaffold @dawn-ai/testing package"
```

---

## Task 4: `startAimock` runner

**Files:**
- Create: `packages/testing/src/aimock-runner.ts`
- Test: `packages/testing/test/aimock-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/aimock-runner.test.ts
import { expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"

it("boots an aimock server on an OS-assigned port and serves /v1 base url", async () => {
  const mock = await startAimock({
    fixtures: [{ match: {}, response: { content: "ok" } }],
  })
  try {
    expect(mock.port).toBeGreaterThan(0)
    expect(mock.baseUrl).toMatch(/\/v1$/)
    const res = await fetch(new URL("/v1/chat/completions", mock.baseUrl.replace(/\/v1$/, "")), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
  } finally {
    await mock.stop()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/aimock-runner.test.ts`
Expected: FAIL — cannot find `../src/aimock-runner.js`.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/aimock-runner.ts
import { LLMock } from "@copilotkit/aimock"
import type { AimockFixture } from "./fixture-builder.js"

export interface AimockHandle {
  readonly port: number
  /** Base URL with the `/v1` suffix the OpenAI SDK expects. */
  readonly baseUrl: string
  stop(): Promise<void>
}

export async function startAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
}): Promise<AimockHandle> {
  const mock = new LLMock({ port: 0, chunkSize: 4096 })
  if (opts.fixtures.length > 0) {
    mock.addFixturesFromJSON(opts.fixtures as never)
  }
  await mock.start()
  let stopped = false
  return {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    async stop() {
      if (stopped) return
      stopped = true
      await mock.stop()
    },
  }
}
```

(Defines `AimockFixture` is imported from Task 5; if implementing out of order, temporarily type `fixtures` as `readonly unknown[]` and tighten in Task 5.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/aimock-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/aimock-runner.ts packages/testing/test/aimock-runner.test.ts
git commit -m "feat(testing): startAimock runner (port:0, /v1 base url)"
```

---

## Task 5: `script()` fixture builder

**Files:**
- Create: `packages/testing/src/fixture-builder.ts`
- Test: `packages/testing/test/fixture-builder.test.ts`

Compilation model (verified against aimock's matcher):
- `.user(text)` opens a turn group; its `text` is the `userMessage` substring discriminator for every fixture in the group.
- Within a group, each model response gets an incrementing `turnIndex` (0,1,2,…). Any response at index ≥1 sets `hasToolResult: true` (it follows a tool round).
- `.callsTool(name, args, opts?)` → `response.toolCalls: [{ id, name, arguments: args }]` with a fixed deterministic `id` (`opts.id ?? \`call_${name}_${groupIndex}_${stepIndex}\``).
- `.replies(content)` → `response.content`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/fixture-builder.test.ts
import { expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"

it("compiles a single-turn tool round to aimock fixtures with auto turnIndex + fixed ids", () => {
  const fixtures = script()
    .user("Filter open items")
    .callsTool("applyFilter", { status: "open" })
    .replies("Found 2.")
    .build()

  expect(fixtures).toEqual([
    {
      match: { userMessage: "Filter open items", turnIndex: 0, hasToolResult: false },
      response: { toolCalls: [{ id: "call_applyFilter_0_0", name: "applyFilter", arguments: { status: "open" } }] },
    },
    {
      match: { userMessage: "Filter open items", turnIndex: 1, hasToolResult: true },
      response: { content: "Found 2." },
    },
  ])
})

it("supports a plain reply with no tools", () => {
  const fixtures = script().user("hi").replies("hello").build()
  expect(fixtures).toEqual([
    { match: { userMessage: "hi", turnIndex: 0, hasToolResult: false }, response: { content: "hello" } },
  ])
})

it("supports multiple user-turn groups", () => {
  const fixtures = script().user("a").replies("ra").user("b").replies("rb").build()
  expect(fixtures.map((f) => f.match.userMessage)).toEqual(["a", "b"])
  expect(fixtures.every((f) => f.match.turnIndex === 0)).toBe(true)
})

it("honors an explicit tool_call id override", () => {
  const fixtures = script().user("x").callsTool("t", {}, { id: "call_custom" }).build()
  const tc = (fixtures[0].response as { toolCalls: { id: string }[] }).toolCalls[0]
  expect(tc.id).toBe("call_custom")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/fixture-builder.test.ts`
Expected: FAIL — cannot find `../src/fixture-builder.js`.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/fixture-builder.ts

export interface AimockToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export type AimockResponse = { content: string } | { toolCalls: AimockToolCall[] }

export interface AimockFixture {
  readonly match: {
    readonly userMessage?: string
    readonly turnIndex?: number
    readonly hasToolResult?: boolean
  }
  readonly response: AimockResponse
}

export type FixtureSet = AimockFixture[]

export interface ScriptBuilder {
  user(text: string): ScriptBuilder
  callsTool(name: string, args: Record<string, unknown>, opts?: { id?: string }): ScriptBuilder
  replies(content: string): ScriptBuilder
  build(): FixtureSet
}

export function script(): ScriptBuilder {
  const fixtures: AimockFixture[] = []
  let groupIndex = -1
  let currentUser: string | undefined
  let stepInGroup = 0

  function pushResponse(response: AimockResponse): void {
    if (currentUser === undefined) {
      throw new Error("script(): call .user(text) before .callsTool()/.replies()")
    }
    fixtures.push({
      match: { userMessage: currentUser, turnIndex: stepInGroup, hasToolResult: stepInGroup > 0 },
      response,
    })
    stepInGroup += 1
  }

  const builder: ScriptBuilder = {
    user(text) {
      groupIndex += 1
      currentUser = text
      stepInGroup = 0
      return builder
    },
    callsTool(name, args, opts) {
      const id = opts?.id ?? `call_${name}_${groupIndex}_${stepInGroup}`
      pushResponse({ toolCalls: [{ id, name, arguments: args }] })
      return builder
    },
    replies(content) {
      pushResponse({ content })
      return builder
    },
    build() {
      return fixtures.slice()
    },
  }
  return builder
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/fixture-builder.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Tighten `startAimock`'s param type**

If Task 4 used `readonly unknown[]`, change its import to `import type { AimockFixture } from "./fixture-builder.js"` and the param to `readonly AimockFixture[]`. Re-run `test/aimock-runner.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/testing/src/fixture-builder.ts packages/testing/src/aimock-runner.ts packages/testing/test/fixture-builder.test.ts
git commit -m "feat(testing): script() fluent fixture builder → aimock fixtures"
```

---

## Task 6: `AgentRunResult` + stream collector

**Files:**
- Create: `packages/testing/src/run-result.ts`
- Test: `packages/testing/test/run-result.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/run-result.test.ts
import { expect, it } from "vitest"
import { collectRunResult } from "../src/run-result.js"

async function* fakeStream() {
  yield { type: "tool_call", name: "applyFilter", input: { status: "open" } }
  yield { type: "tool_result", name: "applyFilter", output: { matched: 2 } }
  yield { type: "chunk", data: "Found " }
  yield { type: "chunk", data: "2." }
  yield {
    type: "done",
    output: { messages: [{ id: ["x", "y", "AIMessage"], kwargs: { content: "Found 2." } }], runningSummary: null },
  }
}

it("reduces a stream into an AgentRunResult", async () => {
  const r = await collectRunResult(fakeStream(), "thread-1")
  expect(r.threadId).toBe("thread-1")
  expect(r.tokens).toEqual(["Found ", "2."])
  expect(r.finalMessage).toBe("Found 2.")
  expect(r.toolCalls).toEqual([{ name: "applyFilter", args: { status: "open" }, id: undefined }])
  expect(r.state.messages).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/run-result.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/run-result.ts
import type { StreamChunk } from "@dawn-ai/cli/runtime"

export interface ObservedToolCall {
  readonly name: string
  readonly args: unknown
  readonly id?: string
}

export interface AgentRunResult {
  readonly finalMessage: string
  readonly messages: ReadonlyArray<Record<string, unknown>>
  readonly toolCalls: ReadonlyArray<ObservedToolCall>
  readonly tokens: ReadonlyArray<string>
  readonly state: Record<string, unknown>
  readonly threadId: string
}

function finalMessageFrom(state: Record<string, unknown>): string {
  const messages = Array.isArray(state.messages) ? (state.messages as Record<string, unknown>[]) : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { id?: string[]; kwargs?: { content?: unknown }; content?: unknown; type?: string }
    const isAi = (Array.isArray(m.id) && m.id[2] === "AIMessage") || m.type === "ai"
    if (!isAi) continue
    const content = m.kwargs?.content ?? m.content
    if (typeof content === "string") return content
  }
  return ""
}

export async function collectRunResult(
  stream: AsyncIterable<StreamChunk>,
  threadId: string,
): Promise<AgentRunResult> {
  const tokens: string[] = []
  const toolCalls: ObservedToolCall[] = []
  let state: Record<string, unknown> = {}

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "chunk":
        if (typeof chunk.data === "string") tokens.push(chunk.data)
        break
      case "tool_call": {
        const c = chunk as unknown as { name: string; input?: unknown; id?: string }
        toolCalls.push({ name: c.name, args: c.input, id: c.id })
        break
      }
      case "done": {
        const out = (chunk as unknown as { output?: unknown }).output
        if (out && typeof out === "object") state = out as Record<string, unknown>
        break
      }
      default:
        break
    }
  }

  return {
    threadId,
    tokens,
    toolCalls,
    state,
    messages: Array.isArray(state.messages) ? (state.messages as Record<string, unknown>[]) : [],
    finalMessage: finalMessageFrom(state),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/run-result.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/run-result.ts packages/testing/test/run-result.test.ts
git commit -m "feat(testing): AgentRunResult + collectRunResult stream reducer"
```

---

## Task 7: Assertion matchers

**Files:**
- Create: `packages/testing/src/matchers.ts`
- Test: `packages/testing/test/matchers.test.ts`

Matchers throw `AssertionError` (from `node:assert`) so they work under any runner.

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/matchers.test.ts
import { expect, it } from "vitest"
import {
  expectFinalMessage,
  expectState,
  expectStreamedTokens,
  expectToolCalled,
} from "../src/matchers.js"
import type { AgentRunResult } from "../src/run-result.js"

const base: AgentRunResult = {
  threadId: "t",
  tokens: ["Found ", "2."],
  toolCalls: [{ name: "applyFilter", args: { status: "open" }, id: "call_1" }],
  finalMessage: "Found 2 items.",
  messages: [{}, {}, {}, {}],
  state: { messages: [{}, {}, {}, {}], runningSummary: { summary: "s" } },
}

it("expectToolCalled passes for a called tool and withArgs subset", () => {
  expectToolCalled(base, "applyFilter").withArgs({ status: "open" })
})

it("expectToolCalled .never() throws when the tool WAS called", () => {
  expect(() => expectToolCalled(base, "applyFilter").never()).toThrow()
})

it("expectToolCalled throws for an uncalled tool", () => {
  expect(() => expectToolCalled(base, "readFile")).toThrow(/readFile/)
})

it("expectFinalMessage.toContain", () => {
  expectFinalMessage(base).toContain("Found 2")
  expect(() => expectFinalMessage(base).toContain("nope")).toThrow()
})

it("expectStreamedTokens passes when tokens present", () => {
  expectStreamedTokens(base)
  expect(() => expectStreamedTokens({ ...base, tokens: [] })).toThrow()
})

it("expectState messages length + field", () => {
  expectState(base).messages.toHaveLength(4)
  expectState(base).field("runningSummary").toBeTruthy()
  expect(() => expectState(base).messages.toHaveLength(2)).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/matchers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/matchers.ts
import { AssertionError } from "node:assert"
import type { AgentRunResult } from "./run-result.js"

function fail(message: string): never {
  throw new AssertionError({ message })
}

function isSubset(subset: Record<string, unknown>, actual: unknown): boolean {
  if (typeof actual !== "object" || actual === null) return false
  const a = actual as Record<string, unknown>
  return Object.entries(subset).every(([k, v]) =>
    typeof v === "object" && v !== null ? isSubset(v as Record<string, unknown>, a[k]) : a[k] === v,
  )
}

export function expectToolCalled(run: AgentRunResult, name: string) {
  const calls = run.toolCalls.filter((c) => c.name === name)
  if (calls.length === 0) {
    fail(`expected tool "${name}" to be called; tools called: ${run.toolCalls.map((c) => c.name).join(", ") || "(none)"}`)
  }
  return {
    withArgs(partial: Record<string, unknown>) {
      if (!calls.some((c) => isSubset(partial, c.args))) {
        fail(`expected "${name}" called withArgs ⊇ ${JSON.stringify(partial)}; got ${JSON.stringify(calls.map((c) => c.args))}`)
      }
    },
    times(n: number) {
      if (calls.length !== n) fail(`expected "${name}" called ${n}× but was ${calls.length}×`)
    },
    never() {
      fail(`expected "${name}" to NOT be called, but it was ${calls.length}×`)
    },
  }
}

export function expectFinalMessage(run: AgentRunResult) {
  return {
    toContain(s: string) {
      if (!run.finalMessage.includes(s)) fail(`final message ${JSON.stringify(run.finalMessage)} does not contain ${JSON.stringify(s)}`)
    },
    toMatch(re: RegExp) {
      if (!re.test(run.finalMessage)) fail(`final message ${JSON.stringify(run.finalMessage)} does not match ${re}`)
    },
    toEqual(s: string) {
      if (run.finalMessage !== s) fail(`final message ${JSON.stringify(run.finalMessage)} !== ${JSON.stringify(s)}`)
    },
  }
}

export function expectStreamedTokens(run: AgentRunResult): void {
  if (run.tokens.length === 0) fail("expected ≥1 streamed token, got none")
}

export function expectState(run: AgentRunResult) {
  const messages = Array.isArray(run.state.messages) ? (run.state.messages as unknown[]) : []
  return {
    messages: {
      toHaveLength(n: number) {
        if (messages.length !== n) fail(`expected state.messages length ${n}, got ${messages.length}`)
      },
    },
    field(name: string) {
      const value = run.state[name]
      return {
        toBeTruthy() {
          if (!value) fail(`expected state.${name} to be truthy, got ${JSON.stringify(value)}`)
        },
        toEqual(expected: unknown) {
          if (JSON.stringify(value) !== JSON.stringify(expected)) {
            fail(`expected state.${name} = ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`)
          }
        },
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/matchers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/matchers.ts packages/testing/test/matchers.test.ts
git commit -m "feat(testing): runner-agnostic agent assertion matchers"
```

---

## Task 8: `expectOffloaded` matcher (Dawn-specific)

**Files:**
- Modify: `packages/testing/src/matchers.ts`
- Modify: `packages/testing/test/matchers.test.ts`

Asserts a tool's output became an offload stub in the conversation (6a), i.e. the tool's `ToolMessage` content contains the offload marker and a later `readFile` retrieval is NOT itself offloaded.

- [ ] **Step 1: Add the failing test**

```ts
// append to packages/testing/test/matchers.test.ts
import { expectOffloaded } from "../src/matchers.js"

it("expectOffloaded asserts the tool output was offloaded to a stub", () => {
  const run = {
    ...base,
    messages: [
      { id: ["lc", "messages", "ToolMessage"], kwargs: { name: "generateReport", content: "Tool output offloaded — 50000 chars. Full output saved to: tool-outputs/x.txt" } },
    ],
    state: { messages: [] },
  } as unknown as AgentRunResult
  expectOffloaded(run, "generateReport")
  expect(() => expectOffloaded(run, "applyFilter")).toThrow()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/matchers.test.ts`
Expected: FAIL — `expectOffloaded` not exported.

- [ ] **Step 3: Implement (append to `matchers.ts`)**

```ts
export function expectOffloaded(run: AgentRunResult, toolName: string): void {
  const msg = run.messages.find((m) => {
    const id = (m as { id?: string[] }).id
    const kw = (m as { kwargs?: { name?: string } }).kwargs
    return Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === toolName
  }) as { kwargs?: { content?: string } } | undefined
  const content = msg?.kwargs?.content ?? ""
  if (!content.includes("Tool output offloaded")) {
    fail(`expected "${toolName}" output to be offloaded (stub marker), got: ${content.slice(0, 120)}`)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/matchers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/matchers.ts packages/testing/test/matchers.test.ts
git commit -m "feat(testing): expectOffloaded matcher for tool-output offloading"
```

---

## Task 9: `createAgentHarness` — Layer A (in-process) construction

**Files:**
- Create: `packages/testing/src/harness.ts`
- Test: `packages/testing/test/harness-construct.test.ts`
- Test fixture app: `packages/testing/test/fixtures/probe-app/` (a minimal Dawn app)

- [ ] **Step 1: Create the probe fixture app**

Create a minimal Dawn app under `packages/testing/test/fixtures/probe-app/`:

`dawn.config.ts`:
```ts
export default {}
```
`src/app/chat/index.ts`:
```ts
import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-4o-mini", systemPrompt: "You are a test agent." })
```
`src/app/chat/tools/applyFilter.ts`:
```ts
/** Apply a status filter and report how many matched. */
export default async function applyFilter(input: { status: "open" | "closed" }): Promise<{ matched: number }> {
  return { matched: input.status === "open" ? 2 : 0 }
}
```
`package.json` (minimal — the harness only needs the files; no install required because the harness imports the runtime from the workspace):
```json
{ "name": "probe-app", "private": true, "type": "module" }
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/testing/test/harness-construct.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("constructs: boots aimock, runs typegen, resolves the route", () => {
  expect(h.baseUrl).toMatch(/\/v1$/)
  expect(process.env.OPENAI_BASE_URL).toBe(h.baseUrl)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-construct.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the harness constructor (Layer A only for now)**

```ts
// packages/testing/src/harness.ts
import { randomUUID } from "node:crypto"
import { discoverRoutes } from "@dawn-ai/core"
import {
  createRuntimeRegistry,
  runTypegen,
  streamResolvedRoute,
} from "@dawn-ai/cli/runtime"
import { startAimock, type AimockHandle } from "./aimock-runner.js"
import type { FixtureSet } from "./fixture-builder.js"
import { collectRunResult, type AgentRunResult } from "./run-result.js"

export interface AgentHarnessOptions {
  readonly appRoot: string
  readonly route: string
  readonly fixtures?: FixtureSet
  readonly mode?: "in-process" | "http-inject" | "subprocess"
}

export interface AgentHarness {
  readonly baseUrl: string
  run(opts: { input: string; fixtures?: FixtureSet }): Promise<AgentRunResult>
  reset(): void
  close(): Promise<void>
}

export async function createAgentHarness(options: AgentHarnessOptions): Promise<AgentHarness> {
  const mode = options.mode ?? "in-process"
  if (mode !== "in-process") {
    // http-inject and subprocess modes are added in Tasks 13 and 14.
    throw new Error(`createAgentHarness: mode "${mode}" not yet implemented`)
  }

  // Boot aimock and patch env BEFORE any model client is constructed.
  const aimock: AimockHandle = await startAimock({ fixtures: options.fixtures ?? [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"

  // Typegen once so generated tool schemas exist (dev-boot fidelity).
  const manifest = await discoverRoutes({ appRoot: options.appRoot })
  await runTypegen({ appRoot: options.appRoot, manifest })

  // Resolve the route key → { routeFile, routeId, routePath }.
  const registry = await createRuntimeRegistry(options.appRoot)
  const resolved = registry.lookup(options.route)
  if (!resolved) {
    await aimock.stop()
    throw new Error(`createAgentHarness: unknown route "${options.route}"`)
  }

  let threadId = randomUUID()
  let registeredFixtures: FixtureSet = (options.fixtures ?? []).slice()

  return {
    baseUrl: aimock.baseUrl,
    async run(runOpts) {
      // Per-run fixtures augment the harness-level set; aimock matches by
      // userMessage substring across the whole registered set.
      if (runOpts.fixtures && runOpts.fixtures.length > 0) {
        registeredFixtures = [...registeredFixtures, ...runOpts.fixtures]
        // Re-register on a fresh aimock would require a restart; instead we
        // register everything up-front via a single addFixturesFromJSON at
        // construction OR restart. See Task 10 for the chosen registration model.
      }
      const stream = streamResolvedRoute({
        appRoot: options.appRoot,
        input: { messages: [{ role: "user", content: runOpts.input }] },
        routeFile: resolved.routeFile,
        routeId: resolved.routeId,
        routePath: resolved.routePath,
        threadId,
      })
      return await collectRunResult(stream, threadId)
    },
    reset() {
      threadId = randomUUID()
    },
    async close() {
      await aimock.stop()
    },
  }
}
```

NOTE for the implementer: the per-run fixture registration is resolved properly in Task 10 (aimock must have fixtures before the run; re-adding requires a restart-or-register-all model). For THIS task, only the constructor + `close()` need to pass the test; the `run()` fixture-merge comment is a forward reference. Keep `run()` compiling but it is exercised in Task 11.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-construct.test.ts`
Expected: PASS. (Generates `.dawn/` inside the probe app — add `packages/testing/test/fixtures/probe-app/.dawn/` to `.gitignore`.)

- [ ] **Step 6: Gitignore generated typegen output**

Append to the repo root `.gitignore`:
```
packages/testing/test/fixtures/**/.dawn/
```

- [ ] **Step 7: Commit**

```bash
git add packages/testing/src/harness.ts packages/testing/test/harness-construct.test.ts packages/testing/test/fixtures/probe-app .gitignore
git commit -m "feat(testing): createAgentHarness Layer A construction (aimock + typegen + route resolve)"
```

---

## Task 10: Fixture registration model (register-all-at-construction)

**Files:**
- Modify: `packages/testing/src/aimock-runner.ts` (no change expected; confirm `addFixturesFromJSON` accepts the full set)
- Modify: `packages/testing/src/harness.ts`
- Test: `packages/testing/test/harness-fixtures.test.ts`

Decision: aimock fixtures must be present before a request arrives, and re-registering means restarting the mock. To keep one long-lived mock per harness, **all fixtures are registered at construction**; `run({ fixtures })` for a NEW turn restarts aimock with the union (cheap: `port:0`, sub-ms). This keeps multi-turn (matched by `userMessage`) working while letting tests add per-turn fixtures.

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/harness-fixtures.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { script } from "../src/fixture-builder.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("runs a scripted turn end-to-end in-process", async () => {
  const run = await h.run({
    input: "Filter open items",
    fixtures: script().user("Filter open items").callsTool("applyFilter", { status: "open" }).replies("Found 2."),
  })
  expect(run.finalMessage).toContain("Found 2")
}, 60_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-fixtures.test.ts`
Expected: FAIL (per-run fixtures not actually registered with aimock yet).

- [ ] **Step 3: Implement the restart-on-new-fixtures model**

Refactor `harness.ts` so aimock is restartable. Extract a `restartAimock(fixtures)` that stops the current handle and starts a new one, re-patching `OPENAI_BASE_URL`. In `run()`:

```ts
if (runOpts.fixtures && runOpts.fixtures.length > 0) {
  registeredFixtures = [...registeredFixtures, ...runOpts.fixtures]
  await restartAimock(registeredFixtures) // stop old, start new on a fresh port, repatch env
}
```

`restartAimock`:
```ts
async function restartAimock(fixtures: FixtureSet): Promise<void> {
  await aimock.stop()
  aimock = await startAimock({ fixtures })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
}
```
(Change `const aimock` to `let aimock`, and `baseUrl` getter on the returned harness should read the live value if exposed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-fixtures.test.ts`
Expected: PASS (real in-process agent loop: model→aimock returns the applyFilter tool call, Dawn runs the real `applyFilter` tool, model→aimock returns "Found 2.").

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/harness.ts packages/testing/test/harness-fixtures.test.ts
git commit -m "feat(testing): per-run fixture registration via aimock restart (port:0)"
```

---

## Task 11: Public barrel + first full-loop assertion test

**Files:**
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/end-to-end.test.ts`

- [ ] **Step 1: Replace the placeholder barrel**

```ts
// packages/testing/src/index.ts
export { startAimock, type AimockHandle } from "./aimock-runner.js"
export { script, type AimockFixture, type FixtureSet, type ScriptBuilder } from "./fixture-builder.js"
export { collectRunResult, type AgentRunResult, type ObservedToolCall } from "./run-result.js"
export { createAgentHarness, type AgentHarness, type AgentHarnessOptions } from "./harness.js"
export {
  expectFinalMessage,
  expectOffloaded,
  expectState,
  expectStreamedTokens,
  expectToolCalled,
} from "./matchers.js"
```

- [ ] **Step 2: Write the end-to-end test using the public API + matchers**

```ts
// packages/testing/test/end-to-end.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, it } from "vitest"
import { createAgentHarness, expectFinalMessage, expectToolCalled, script } from "../src/index.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("asserts tool call + final message via the public matchers", async () => {
  const run = await h.run({
    input: "Filter open items",
    fixtures: script().user("Filter open items").callsTool("applyFilter", { status: "open" }).replies("Found 2 items."),
  })
  expectToolCalled(run, "applyFilter").withArgs({ status: "open" })
  expectFinalMessage(run).toContain("Found 2")
}, 60_000)
```

- [ ] **Step 3: Run + build + typecheck + lint**

Run:
```
pnpm --filter @dawn-ai/testing exec vitest --run test/end-to-end.test.ts
pnpm --filter @dawn-ai/testing build
pnpm --filter @dawn-ai/testing typecheck
pnpm --filter @dawn-ai/testing lint
```
Expected: all PASS/green.

- [ ] **Step 4: Commit**

```bash
git add packages/testing/src/index.ts packages/testing/test/end-to-end.test.ts
git commit -m "feat(testing): public barrel + end-to-end Layer A test"
```

---

## Task 12: `record()` helper

**Files:**
- Create: `packages/testing/src/record.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/record.test.ts`

`record()` wraps the aimock recorder CLI. It is local-only (needs a real key); the unit test mocks `spawnSync` and asserts the argv.

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/record.test.ts
import { expect, it, vi } from "vitest"

const spawnSync = vi.fn(() => ({ status: 0 }))
vi.mock("node:child_process", () => ({ spawnSync }))

it("invokes the aimock recorder with the right argv", async () => {
  const { record } = await import("../src/record.js")
  record({ out: "/tmp/x.fixture.json", provider: "https://api.openai.com" })
  expect(spawnSync).toHaveBeenCalledWith(
    "npx",
    ["-p", "@copilotkit/aimock", "llmock", "--record", "--provider-openai", "https://api.openai.com", "--out", "/tmp/x.fixture.json"],
    expect.objectContaining({ stdio: "inherit" }),
  )
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/record.ts
import { spawnSync } from "node:child_process"

export interface RecordOptions {
  readonly out: string
  /** Upstream provider base, default OpenAI. */
  readonly provider?: string
}

/**
 * Records a real provider interaction into an aimock fixture file. LOCAL ONLY —
 * requires a real OPENAI_API_KEY in env. Never run in CI (CI replays strict
 * read-only). Throws on a non-zero recorder exit.
 */
export function record(opts: RecordOptions): void {
  const provider = opts.provider ?? "https://api.openai.com"
  const result = spawnSync(
    "npx",
    ["-p", "@copilotkit/aimock", "llmock", "--record", "--provider-openai", provider, "--out", opts.out],
    { stdio: "inherit", env: process.env },
  )
  if (result.status !== 0) {
    throw new Error(`aimock recorder exited with status ${result.status ?? "null"}`)
  }
}
```

Add `export { record, type RecordOptions } from "./record.js"` to `src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/record.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/record.ts packages/testing/src/index.ts packages/testing/test/record.test.ts
git commit -m "feat(testing): record() helper wrapping the aimock recorder"
```

---

## Task 13: Layer B — `http-inject` mode

**Files:**
- Create: `packages/testing/src/http-inject.ts`
- Modify: `packages/testing/src/harness.ts` (dispatch `mode: "http-inject"`)
- Test: `packages/testing/test/http-inject.test.ts`

Layer B drives the full AP request→SSE pipeline in-process via `light-my-request` against `createRuntimeRequestListener` (Task 2). No port is bound. It exists for Dawn's own SSE-envelope coverage.

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/http-inject.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { injectAgentProtocol } from "../src/http-inject.js"
import { startAimock } from "../src/aimock-runner.js"
import { script } from "../src/fixture-builder.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("creates a thread + runs/wait over the in-process AP pipeline (no port)", async () => {
  const mock = await startAimock({
    fixtures: script().user("hello").replies("hi there").build(),
  })
  process.env.OPENAI_BASE_URL = mock.baseUrl
  process.env.OPENAI_API_KEY = "test-not-used"
  const ap = await injectAgentProtocol({ appRoot })
  try {
    const created = await ap.inject({ method: "POST", url: "/threads", payload: {} })
    expect(created.statusCode).toBe(200)
    const threadId = (JSON.parse(created.body) as { thread_id: string }).thread_id

    const run = await ap.inject({
      method: "POST",
      url: `/threads/${threadId}/runs/wait`,
      payload: { route: "/chat#agent", input: { messages: [{ role: "user", content: "hello" }] } },
    })
    expect(run.statusCode).toBe(200)
    expect(run.body).toContain("hi there")
  } finally {
    await ap.close()
    await mock.stop()
  }
}, 60_000)
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/http-inject.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/http-inject.ts
import { createRuntimeRequestListener } from "@dawn-ai/cli/runtime"
import { inject, type DispatchFunc } from "light-my-request"

export interface InjectResult {
  readonly statusCode: number
  readonly body: string
  readonly headers: Record<string, unknown>
}

export interface AgentProtocolInjector {
  inject(opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<InjectResult>
  close(): Promise<void>
}

export async function injectAgentProtocol(options: { appRoot: string }): Promise<AgentProtocolInjector> {
  const { listener, close } = await createRuntimeRequestListener({ appRoot: options.appRoot })
  const dispatch = listener as unknown as DispatchFunc
  return {
    async inject(opts) {
      const res = await inject(dispatch, {
        method: opts.method as never,
        url: opts.url,
        headers: { "content-type": "application/json", ...opts.headers },
        payload: opts.payload === undefined ? undefined : JSON.stringify(opts.payload),
      })
      return { statusCode: res.statusCode, body: res.body, headers: res.headers }
    },
    close,
  }
}
```

For streaming (`runs/stream`) assertions, add a `injectStream` variant later if needed using `light-my-request`'s `payloadAsStream`; `runs/wait` (buffered) is sufficient for this task.

Wire `mode: "http-inject"` in `harness.ts` to construct via `injectAgentProtocol` instead of `streamResolvedRoute` (the harness `run()` posts to `/threads/:id/runs/wait` and adapts the AP body into an `AgentRunResult`). Keep the in-process path as default.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/http-inject.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/http-inject.ts packages/testing/src/harness.ts packages/testing/test/http-inject.test.ts
git commit -m "feat(testing): Layer B http-inject mode via light-my-request"
```

---

## Task 14: Layer C — `subprocess` mode

**Files:**
- Create: `packages/testing/src/subprocess.ts`
- Modify: `packages/testing/src/harness.ts` (dispatch `mode: "subprocess"`)
- Modify: `packages/testing/src/index.ts`
- Test: covered by the dogfood SP7 migration (Task 16); a unit test here asserts the boot/teardown contract with a stubbed app is optional and skipped if heavy.

- [ ] **Step 1: Implement the subprocess booter**

```ts
// packages/testing/src/subprocess.ts
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

export interface SubprocessApp {
  readonly baseUrl: string
  stop(): Promise<void>
}

/** Bind to port 0, read the OS-assigned port, release it. */
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
      if (res.ok || res.status === 400 || res.status === 404) return
    } catch {
      // not up yet
    }
    await delay(300)
  }
  throw new Error(`subprocess app not ready at ${url} within ${timeoutMs}ms`)
}

export async function startSubprocessApp(opts: {
  readonly appRoot: string
  readonly env: Record<string, string>
  readonly port?: number
  readonly readyTimeoutMs?: number
}): Promise<SubprocessApp> {
  const port = opts.port ?? (await getFreePort())
  const child: ChildProcess = spawn("pnpm", ["exec", "dawn", "dev", "--port", String(port)], {
    cwd: opts.appRoot,
    env: { ...process.env, ...opts.env },
    stdio: "pipe",
    detached: true,
  })
  const baseUrl = `http://127.0.0.1:${port}`
  await waitReady(`${baseUrl}/threads`, opts.readyTimeoutMs ?? 60_000)
  let stopped = false
  return {
    baseUrl,
    async stop() {
      if (stopped) return
      stopped = true
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM")
        } catch {
          child.kill("SIGTERM")
        }
      }
    },
  }
}
```

Wire `mode: "subprocess"` in `harness.ts`: construct via `startSubprocessApp` (env carries `OPENAI_BASE_URL` from a harness-owned aimock) and `run()`/`reset()` operate over the real AP `baseUrl` (create thread, runs/wait, GET state). `close()` stops the app + aimock.

Export `startSubprocessApp` + `SubprocessApp` from `src/index.ts`.

- [ ] **Step 2: Build + typecheck**

Run: `pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint`
Expected: green. (Behavioral coverage comes from the SP7 migration in Task 16.)

- [ ] **Step 3: Commit**

```bash
git add packages/testing/src/subprocess.ts packages/testing/src/harness.ts packages/testing/src/index.ts
git commit -m "feat(testing): Layer C subprocess mode (dawn dev boot + AP)"
```

---

## Task 15: Dogfood — migrate SP5 / SP6a / SUMM to Layer A

**Files:**
- Create: `test/runtime/dawn-testing/agent-behavior.test.ts`
- Create: `test/runtime/dawn-testing/probe-app/` (committed fixture app with the union + report tools)
- Modify: `test/runtime/vitest.config.ts` (add the new file to `include`)
- Delete (later, Task 17): the migrated scenarios from `test/runtime/run-aimock-e2e.test.ts`

- [ ] **Step 1: Build the probe app**

Create `test/runtime/dawn-testing/probe-app/` with:
- `dawn.config.ts` → `export default {}`
- `src/app/chat/index.ts` → `agent({ model: "gpt-4o-mini", systemPrompt: "test agent" })`
- `src/app/chat/tools/applyFilter.ts` — the discriminated-union tool from the current `run-aimock-e2e.test.ts` `applyFilterSource()` (copy verbatim).
- `src/app/chat/tools/generateReport.ts` — the large-output tool from `generateReportSource()` (copy verbatim).
- `workspace/` dir (so offload activates).
- a summarization config variant is NOT needed inline — instead a second probe app `probe-app-summarize/` with `dawn.config.ts` enabling summarization (`{ summarization: { enabled: true, maxTokens: 10, keepRecentTurns: 1, tokenCounter: (t) => t.length, summarize: async () => "DETERMINISTIC_SUMMARY_OF_OLD_TURNS" } }`), reusing the same route/tools.

- [ ] **Step 2: Write the migrated SP5 test (Layer A)**

```ts
// test/runtime/dawn-testing/agent-behavior.test.ts
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness, expectFinalMessage, expectOffloaded, expectState, expectToolCalled, script } from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("./probe-app", import.meta.url))

it("SP5: discriminated-union tool arg is accepted (runtime + generated anyOf schema)", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    // Schema-shape assertion (closes the false-green gap from #188).
    const routesDir = join(appRoot, ".dawn", "routes")
    const routeDir = readdirSync(routesDir).find((d) => d.startsWith("chat"))
    const tools = JSON.parse(readFileSync(join(routesDir, routeDir as string, "tools.json"), "utf-8")) as Record<string, { parameters?: { properties?: Record<string, { anyOf?: unknown[] }> } }>
    const sort = tools.applyFilter?.parameters?.properties?.sort
    expect(Array.isArray(sort?.anyOf) && (sort?.anyOf?.length ?? 0) >= 2).toBe(true)
    expect(JSON.stringify(sort)).not.toContain("charAt")

    const run = await h.run({
      input: "Filter the open urgent items, newest first.",
      fixtures: script()
        .user("Filter the open urgent items, newest first.")
        .callsTool("applyFilter", { filter: { status: "open", tags: ["urgent"] }, sort: { by: "date", dir: "desc" } })
        .replies("Filtered."),
    })
    expectToolCalled(run, "applyFilter")
    expectFinalMessage(run).toContain("Filtered")
  } finally {
    await h.close()
  }
}, 60_000)
```

(Use the exact `applyFilter` arg shape the union tool expects — copy from the current test's request.)

- [ ] **Step 3: Add the SP6a (offload) migrated test**

```ts
it("SP6a: a large tool output is offloaded to a retrievable stub", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({
      input: "Make a 2000-row report.",
      fixtures: script().user("Make a 2000-row report.").callsTool("generateReport", { rows: 2000 }).replies("done"),
    })
    expectToolCalled(run, "generateReport")
    expectOffloaded(run, "generateReport")
  } finally {
    await h.close()
  }
}, 60_000)
```

- [ ] **Step 4: Add the SUMM migrated test (second probe app)**

```ts
it("SUMM: summarization preserves full history + populates runningSummary", async () => {
  const summAppRoot = fileURLToPath(new URL("./probe-app-summarize", import.meta.url))
  const h = await createAgentHarness({ appRoot: summAppRoot, route: "/chat#agent" })
  try {
    const turns = ["APPLE_TURN", "BANANA_TURN", "CHERRY_TURN"]
    let run = undefined as Awaited<ReturnType<typeof h.run>> | undefined
    for (const token of turns) {
      run = await h.run({
        input: `Question ${token} please.`,
        fixtures: script().user(token).replies(`Noted ${token}.`),
      })
    }
    expectState(run!).field("runningSummary").toBeTruthy()
    // full history preserved: 3 HumanMessages
    const humans = run!.messages.filter((m) => Array.isArray((m as { id?: string[] }).id) && (m as { id: string[] }).id[2] === "HumanMessage")
    expect(humans.length).toBe(3)
    expect(JSON.stringify(run!.messages)).not.toContain("DETERMINISTIC_SUMMARY_OF_OLD_TURNS")
  } finally {
    await h.close()
  }
}, 120_000)
```

- [ ] **Step 5: Add to the runtime lane includes**

In `test/runtime/vitest.config.ts`, add `"test/runtime/dawn-testing/agent-behavior.test.ts"` to the `include` array.

- [ ] **Step 6: Build the package, then run the migrated lane**

Run:
```
pnpm --filter @dawn-ai/testing build
pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/dawn-testing/agent-behavior.test.ts
```
Expected: all 3 PASS — **with no `pnpm pack`/`pnpm install`** (the harness imports the runtime from the workspace; vitest aliases resolve `@dawn-ai/*` to source per `test/runtime/vitest.config.ts`). If `@dawn-ai/testing` isn't aliased, add it to the `resolve.alias` map in that config pointing at `packages/testing/src/index.ts`.

- [ ] **Step 7: Commit**

```bash
git add test/runtime/dawn-testing test/runtime/vitest.config.ts
git commit -m "test(runtime): migrate SP5/SP6a/SUMM scenarios onto @dawn-ai/testing (Layer A, no install)"
```

---

## Task 16: Dogfood — migrate the SP7 restart-resume to Layer C

**Files:**
- Modify/Create: `test/runtime/dawn-testing/restart-resume.test.ts`
- Reference: the existing SP7 subprocess restart test (`test/runtime/run-agent-protocol.test.ts` real-LLM `skipIf` test, or the dedicated SP7 test) for the scenario shape.

- [ ] **Step 1: Identify the current SP7 restart-resume test**

Run: `grep -rln "restart\|resume\|kill" test/runtime/*.test.ts`
Read the interrupt→kill→restart→resume scenario it implements.

- [ ] **Step 2: Re-express it via the subprocess harness**

Write `test/runtime/dawn-testing/restart-resume.test.ts` using `createAgentHarness({ appRoot, route, mode: "subprocess" })`, exercising: run that triggers a permission interrupt → `close()` the app process → re-`createAgentHarness` against the same `appRoot` (same SQLite checkpoint) → resume → assert completion. Use a probe app with a permission-gated tool (copy the permissions seed from the chat example's `dawn.config.ts`). Keep it `skipIf(!process.env.OPENAI_API_KEY)`-free — it uses aimock fixtures, so it runs in CI.

(The detailed scenario mirrors the existing SP7 test; reuse its fixture app and assertions, swapping the manual `spawn`/`fetch` plumbing for the harness's subprocess mode.)

- [ ] **Step 3: Add to includes + run**

Add the file to `test/runtime/vitest.config.ts` `include`. Run:
```
pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/dawn-testing/restart-resume.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/runtime/dawn-testing/restart-resume.test.ts test/runtime/vitest.config.ts
git commit -m "test(runtime): migrate SP7 restart-resume onto @dawn-ai/testing subprocess mode"
```

---

## Task 17: Retire the old monolithic harness

**Files:**
- Delete: `test/runtime/run-aimock-e2e.test.ts`
- Delete: `test/runtime/support/aimock-runner.ts` (if unused after migration)
- Delete: `test/runtime/fixtures/aimock/*` (the hand-authored JSON, now generated by `script()`)
- Modify: `test/runtime/vitest.config.ts` (remove the deleted file from `include`)

- [ ] **Step 1: Confirm nothing else imports the old harness**

Run: `grep -rn "run-aimock-e2e\|support/aimock-runner\|fixtures/aimock" test/ packages/ --include="*.ts"`
Expected: only the files slated for deletion + the vitest config reference.

- [ ] **Step 2: Delete + update config**

```bash
git rm test/runtime/run-aimock-e2e.test.ts test/runtime/support/aimock-runner.ts
git rm -r test/runtime/fixtures/aimock
```
Remove `"test/runtime/run-aimock-e2e.test.ts"` from `test/runtime/vitest.config.ts` `include`.

- [ ] **Step 3: Run the full runtime lane to prove parity**

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
Expected: all runtime tests PASS, including the new `dawn-testing/*` files; the old monolith is gone; total wall-clock is lower (no per-test pack+install).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(runtime): retire buildProbeApp monolith (replaced by @dawn-ai/testing)"
```

---

## Task 18: Docs + chat-example sample test

**Files:**
- Create: `docs/testing.md` (or the repo's docs convention — check `docs/` layout first)
- Create: `examples/chat/server/test/agent.test.ts` (sample using the package)
- Modify: `examples/chat/server/package.json` (add `@dawn-ai/testing` devDependency + a `test` script if absent)

- [ ] **Step 1: Check the docs convention**

Run: `ls docs/ && sed -n '1,30p' docs/README.md 2>/dev/null`
Place the testing doc where the others live.

- [ ] **Step 2: Write the docs page**

A "Testing your Dawn agent" page: the 10-line first test (copy the Task 11 end-to-end shape), then recipes — tool-call assertion, streaming (`expectStreamedTokens`), multi-turn (repeated `run()`), offload (`expectOffloaded`), and the record-first workflow (`record()` then trim). State the CI policy: replay strict & read-only; re-record locally; `git diff --exit-code` guard. Note the three modes and when to use each.

- [ ] **Step 3: Add a sample test to the chat example**

```ts
// examples/chat/server/test/agent.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, it } from "vitest"
import { createAgentHarness, expectFinalMessage, script } from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("greets the user", async () => {
  const run = await h.run({ input: "hello", fixtures: script().user("hello").replies("Hi! How can I help?") })
  expectFinalMessage(run).toContain("help")
}, 60_000)
```

Add `"@dawn-ai/testing": "workspace:*"` to `examples/chat/server/package.json` devDependencies and a `"test": "vitest --run"` script if missing. Run `pnpm install`.

- [ ] **Step 4: Run the sample test**

Run: `pnpm --filter <chat-example-pkg-name> test` (find the name via `node -p "require('./examples/chat/server/package.json').name"`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs examples/chat/server pnpm-lock.yaml
git commit -m "docs(testing): testing guide + chat-example sample test"
```

---

## Task 19: Changeset, full validate, PR

**Files:**
- Create: `.changeset/dawn-testing-package.md`

- [ ] **Step 1: Write the changeset**

```md
---
"@dawn-ai/testing": minor
"@dawn-ai/cli": minor
---

Add `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents. Three layers: in-process (default; runs your route through Dawn's runtime with aimock at the model boundary), http-inject (full Agent-Protocol pipeline via light-my-request, no port), and subprocess (real `dawn dev` for restart-resume). A `script()` fluent builder compiles multi-turn tool-call conversations to aimock fixtures; `expect*` matchers assert tool calls, final message, streamed tokens, state, and tool-output offloading. `@dawn-ai/cli` gains a `@dawn-ai/cli/runtime` programmatic export subpath and an extracted `createRuntimeRequestListener` for in-process HTTP injection. Dawn's own aimock e2e lane is migrated onto the package (no more per-test pack+install).
```

- [ ] **Step 2: Full validate across affected packages**

Run:
```
pnpm -r --filter "@dawn-ai/*" build
pnpm --filter @dawn-ai/testing --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/testing --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/testing test
pnpm exec vitest --run --config test/runtime/vitest.config.ts
```
Expected: all green (the known macOS-only `/private/tmp` `run-command.test.ts` artifact is the only acceptable failure; it passes on Linux CI).

- [ ] **Step 3: Commit + push + open PR**

```bash
git add .changeset/dawn-testing-package.md
git commit -m "chore: changeset for @dawn-ai/testing (minor: testing, cli)"
git push -u origin feat/dawn-testing
gh pr create --title "feat: @dawn-ai/testing — aimock agent-testing package (in-process default, dogfooded)" --body-file <(printf '%s\n' "See docs/superpowers/specs/2026-06-05-dawn-testing-package-design.md. Productizes the aimock e2e approach (PR #190) as a shipped package; three layers (in-process / http-inject / subprocess); script() fixture builder + expect* matchers; migrates Dawn's own lane off the pack+install monolith." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)") --base main --head feat/dawn-testing
```

- [ ] **Step 4: Enable auto-merge + update phase memory**

```bash
gh pr merge --auto --squash
```
Update `memory/project_phase_status.md` noting `@dawn-ai/testing` shipped (post-Phase-3 testing infrastructure; productized aimock e2e; drift-detection workflow deferred to a follow-up).

---

## Self-review notes (for the executor)

- **Type consistency:** `AimockFixture`/`FixtureSet` (Task 5) are consumed by `startAimock` (Task 4) and `createAgentHarness` (Task 9). `AgentRunResult` (Task 6) is consumed by every matcher (Tasks 7–8) and returned by `harness.run` (Tasks 9–10). `StreamChunk` is imported from `@dawn-ai/cli/runtime` (Task 1).
- **Ordering caveat:** Task 4 forward-references `AimockFixture` from Task 5 — implement 5 before fully tightening 4, or use the temporary `unknown[]` type noted in Task 4 Step 3.
- **`registry.lookup` return shape:** confirm the exact property names (`routeFile`/`routeId`/`routePath`) against `packages/cli/src/lib/dev/runtime-registry.ts` before Task 9; adjust the destructuring if they differ.
- **aimock `chunkSize`/streaming:** the default `chunkSize: 4096` returns the model response in few chunks; `expectStreamedTokens` only needs ≥1. If a test needs many tokens, lower `chunkSize` in `startAimock`.
- **Env bleed:** `createAgentHarness` mutates `process.env.OPENAI_BASE_URL`. `close()` should restore the prior value to avoid cross-test bleed — add that to Task 9/10 if tests in the same file construct multiple harnesses.
