# Scenario Tool Mocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain-array `run.test.ts` files with a discoverable route-scoped builder and add typed, invocation-local application-tool mocks with first-class call assertions for in-process scenarios.

**Architecture:** `@dawn-ai/sdk/testing` owns the fluent builder, its branded suite descriptor, and an open `RouteScenarioMap`; Core typegen augments that exact module with route paths and application-tool signatures. The CLI loads only branded suites, validates them before execution, threads explicit tool overrides into per-request route preparation without mutating caches, records mock calls, and evaluates call assertions after ordinary route expectations. Server-backed scenarios remain unmocked.

**Tech Stack:** TypeScript 6/7, NodeNext ESM, pnpm, Vitest, Dawn typegen, Changesets, generated Markdown documentation

---

## File Structure

- `packages/sdk/src/testing/scenario-builder.ts` owns the runtime builder, descriptor brand, immutable draft transitions, and descriptor guard.
- `packages/sdk/src/testing/scenario-types.ts` owns the generic fluent type-state machinery, deep-partial argument type, and public descriptor types.
- `packages/sdk/src/testing/index.ts` directly declares `RouteScenarioMap`, exposes the typed `scenarios()` wrapper, and retains existing assertion helpers.
- `packages/sdk/test/scenario-builder.test.ts` covers builder normalization and JavaScript/runtime misuse.
- `packages/sdk/test/scenario-builder.contract.ts` proves route, mock, and fluent-state inference through the public testing entry point.
- `packages/core/src/typegen/render-scenario-types.ts` renders the `@dawn-ai/sdk/testing` module augmentation for every route.
- `packages/core/src/typegen/render-route-types.ts` references the separate scenario augmentation without converting the virtual `dawn:routes` declaration into an external module.
- `packages/core/src/index.ts` exports the scenario renderer to typegen consumers.
- `packages/core/test/render-route-types.test.ts` locks generated route-scenario types with snapshots.
- `packages/cli/src/lib/typegen/run-typegen.ts` writes application-only scenario declarations alongside ordinary Dawn types.
- `packages/cli/test/run-typegen.test.ts` proves CLI typegen emits both files and excludes capability tools from scenario completion.
- `packages/cli/test/scenario-typegen-contract.test.ts` compiles a generated augmentation with the real SDK testing entry point.
- `packages/vite-plugin/src/index.ts` writes the same declaration pair during Vite typegen.
- `packages/vite-plugin/test/plugin.test.ts` proves the Vite path emits a real package augmentation.
- `packages/devkit/templates/{app-basic,app-research}/.dawn/` contains the regenerated declaration pair shipped to new apps.
- `packages/cli/src/lib/runtime/load-run-scenarios.ts` accepts branded suites, validates route identity and mock names, and returns normalized scenarios.
- `packages/cli/src/lib/runtime/scenario-tool-overrides.ts` applies invocation-local mock functions to discovered tool definitions and records calls.
- `packages/cli/src/lib/runtime/scenario-tool-expectations.ts` evaluates mock-call counts and argument matchers.
- `packages/cli/src/lib/runtime/execute-route-core.ts` applies overrides to a copied tool array during request preparation.
- `packages/cli/src/lib/runtime/execute-route.ts` exposes the override and journal options only on the disk-first in-process entry.
- `packages/cli/src/commands/test.ts` creates one journal per scenario and evaluates call expectations.
- `packages/cli/test/scenario-tool-overrides.test.ts` covers the pure replacement primitive.
- `packages/cli/test/test-command.test.ts` covers suite loading, validation, builder migration, workflow mocks, and assertion reporting.
- `packages/cli/test/scenario-tool-mocking-agent.test.ts` covers an agent route, prepared-module cache isolation, and subagent non-propagation.
- `test/generated/harness.ts` and `test/generated/fixtures/handwritten-runtime-app/**/run.test.ts` emit/use the canonical builder.
- `test/generated/fixtures/*.expected.json` records the new generated `RouteScenarioMap` block.
- `apps/web/content/docs/testing.mdx`, `apps/web/content/docs/cli.mdx`, and `apps/web/content/docs/deployment.mdx` document the builder and server boundary.
- `apps/web/content/templates/AGENTS.md` and `apps/web/content/prompts/index.ts` stop teaching unsupported arrays.
- `.changeset/scenario-tool-mocking.md` records patch releases for SDK, Core, CLI, the Vite plugin, and Devkit.

## Execution Prerequisite

The repository requires Node 24 or newer, while an interactive shell resolves
Node 22 in this worktree. Every Node or pnpm command below therefore carries a
self-contained `env PATH=...` prefix; keep that prefix when commands run in
separate shells or fresh subagents. Use Corepack's repository-pinned
`pnpm@10.33.0`:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 24) process.exit(1); console.log(process.version)'
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --version
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm build
```

Expected: Node prints `v24` or newer, pnpm prints `10.33.0`, and the workspace
build passes. The fresh build is required before tests that import sibling
packages through gitignored `dist/` output.

### Task 1: Add the route-scoped fluent scenario builder

**Files:**
- Create: `packages/sdk/src/testing/scenario-types.ts`
- Create: `packages/sdk/src/testing/scenario-builder.ts`
- Create: `packages/sdk/test/scenario-builder.test.ts`
- Create: `packages/sdk/test/scenario-builder.contract.ts`
- Modify: `packages/sdk/src/testing/index.ts`

- [ ] **Step 1: Write failing runtime builder tests**

Create `packages/sdk/test/scenario-builder.test.ts`. Augment the source module
for the test route, then cover normalized descriptors and runtime validation:

```ts
import { describe, expect, test } from "vitest"

import { isScenarioSuite, readScenarioSuite, scenarios } from "../src/testing/index.js"

declare module "../src/testing/index.js" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly ping: () => Promise<string>
        readonly searchWeb: (input: { readonly query: string }) => Promise<{
          readonly results: readonly string[]
        }>
      }
    }
  }
}

describe("scenarios", () => {
  test("builds a branded immutable suite descriptor", () => {
    const suite = scenarios("/research").scenario("searches", (s) =>
      s
        .input({ messages: [] })
        .mockTool("searchWeb", async ({ query }) => ({ results: [query] }))
        .expectPassed()
        .expectOutput({ answer: "Dawn" })
        .expectTool("searchWeb", (call) =>
          call.calledOnce().withArgs({ query: "Dawn" }),
        ),
    )

    expect(isScenarioSuite(suite)).toBe(true)
    expect(readScenarioSuite(suite)).toMatchObject({
      route: "/research",
      scenarios: [
        {
          execution: "in-process",
          expectedStatus: "passed",
          name: "searches",
          toolCallExpectations: [
            { count: { kind: "exact", value: 1 }, name: "searchWeb" },
          ],
          toolMocks: [{ name: "searchWeb" }],
        },
      ],
    })
  })

  test("rejects duplicate scenario names", () => {
    const suite = scenarios("/research").scenario("duplicate", (s) =>
      s.input({}).expectPassed(),
    )
    expect(() =>
      suite.scenario("duplicate", (s) => s.input({}).expectPassed()),
    ).toThrow(/duplicate scenario name/i)
  })

  test("rejects incomplete and conflicting states at runtime", () => {
    const suite = scenarios("/research") as unknown as {
      scenario(name: string, configure: (builder: any) => any): unknown
    }
    expect(() => suite.scenario("missing status", (s) => s.input({}))).toThrow(
      /expected status/i,
    )
    expect(() =>
      suite.scenario("server mock", (s) =>
        s.input({}).server("http://localhost:3000").mockTool("searchWeb", async () => ({
          results: [],
        })).expectPassed(),
      ),
    ).toThrow(/server.*tool mock/i)
    expect(() =>
      suite.scenario("passed error", (s) =>
        s.input({}).expectPassed().expectError({ message: "invalid" }),
      ),
    ).toThrow(/passing.*error expectation/i)
    expect(() =>
      suite.scenario("failed output", (s) =>
        s.input({}).expectFailed().expectOutput({ invalid: true }),
      ),
    ).toThrow(/failing.*output expectation/i)
    expect(() =>
      suite.scenario("duplicate input", (s) =>
        s.input({}).input({ again: true }).expectPassed(),
      ),
    ).toThrow(/input.*once/i)
    expect(() =>
      suite.scenario("duplicate status", (s) =>
        s.input({}).expectPassed().expectFailed(),
      ),
    ).toThrow(/status.*once/i)
    expect(() =>
      suite.scenario("unmocked expectation", (s) =>
        s.input({}).expectPassed().expectTool("searchWeb", (call) => call.called()),
      ),
    ).toThrow(/mock.*before.*expect/i)
    expect(() =>
      suite.scenario("contradictory call", (s) =>
        s
          .input({})
          .mockTool("searchWeb", async () => ({ results: [] }))
          .expectPassed()
          .expectTool("searchWeb", (call) => call.notCalled().withArgs({ query: "Dawn" })),
      ),
    ).toThrow(/notCalled.*arguments/i)
    expect(() =>
      suite.scenario("reverse contradictory call", (s) =>
        s
          .input({})
          .mockTool("searchWeb", async () => ({ results: [] }))
          .expectPassed()
          .expectTool("searchWeb", (call) =>
            call.withArgs({ query: "Dawn" }).notCalled(),
          ),
      ),
    ).toThrow(/notCalled.*arguments/i)
  })

  test("rejects a forged brand carrying a malformed descriptor", () => {
    const suite = scenarios("/research").scenario("valid", (s) =>
      s.input({}).expectPassed(),
    )
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")

    const forged = {
      [brand]: {
        route: "/research",
        scenarios: [{ input: {}, name: "missing required fields" }],
      },
    }

    expect(isScenarioSuite(forged)).toBe(false)
    expect(() => readScenarioSuite(forged)).toThrow(/malformed scenario suite/i)
  })
})
```

Use a local `type UnsafeBuilder = Record<string, (...args: any[]) => any>` only
inside the deliberate JavaScript-misuse test if Biome rejects inline `any`;
add the narrow lint suppression directly above that test type, not production
code.

- [ ] **Step 2: Write the failing public contract test**

Create `packages/sdk/test/scenario-builder.contract.ts` with a local module
augmentation and these compile-time proofs:

```ts
import { scenarios } from "../src/testing/index.js"

declare module "../src/testing/index.js" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly ping: () => Promise<string>
        readonly searchWeb: (input: { readonly query: string; readonly limit: number }) => Promise<{
          readonly results: readonly string[]
        }>
      }
    }
    "/without-tools": { readonly tools: Record<never, never> }
  }
}

scenarios("/research").scenario("typed", (s) =>
  s
    .input({ any: "shape remains unknown" })
    .mockTool("searchWeb", async ({ query, limit }) => ({
      results: [`${query}:${limit}`],
    }))
    .mockTool("ping", () => "pong")
    .expectPassed()
    .expectOutput({ any: "shape remains unknown" })
    .expectTool("searchWeb", (call) =>
      call.calledOnce().withArgs({ query: "Dawn" }),
    )
    .expectTool("ping", (call) => call.called()),
)

// @ts-expect-error generated route paths are closed.
scenarios("/missing")

// @ts-expect-error a scenario callback must return a builder with input and status set.
scenarios("/research").scenario("missing status", (s) => s.input({}))

// @ts-expect-error a scenario callback must return a builder with input and status set.
scenarios("/research").scenario("missing input", (s) => s.expectPassed())

scenarios("/research").scenario("unknown tool", (s) =>
  s
    .input({})
    // @ts-expect-error only generated application tools are mockable.
    .mockTool("missing", async () => undefined)
    .expectPassed(),
)

scenarios("/research").scenario("wrong input", (s) =>
  s
    .input({})
    // @ts-expect-error mock parameters come from generated tool types.
    .mockTool("searchWeb", async ({ missing }: { missing: boolean }) => ({ results: [] }))
    .expectPassed(),
)

scenarios("/research").scenario("wrong return", (s) =>
  s
    .input({})
    // @ts-expect-error mock returns the awaited generated tool result.
    .mockTool("searchWeb", async () => ({ wrong: true }))
    .expectPassed(),
)

scenarios("/research").scenario("server", (s) => {
  const server = s.input({}).server("http://localhost:3000")
  // @ts-expect-error server scenarios cannot add tool mocks.
  return server.mockTool("searchWeb", async () => ({ results: [] })).expectPassed()
})

scenarios("/research").scenario("mock then server", (s) => {
  const mocked = s.input({}).mockTool("ping", () => "pong")
  // @ts-expect-error mocked scenarios cannot switch to server execution.
  return mocked.server("http://localhost:3000").expectPassed()
})

scenarios("/research").scenario("status-specific expectations", (s) => {
  const passed = s.input({}).expectPassed()
  // @ts-expect-error passing scenarios cannot declare an error expectation.
  passed.expectError({ message: "no" })
  const failed = s.input({}).expectFailed()
  // @ts-expect-error failing scenarios cannot declare an output expectation.
  failed.expectOutput({ no: true })
  return failed.expectError({ message: "expected" })
})

scenarios("/research").scenario("zero args", (s) =>
  s.input({}).mockTool("ping", () => "pong").expectPassed().expectTool("ping", (call) => {
    // @ts-expect-error zero-argument tools do not expose argument matching.
    call.withArgs(undefined)
    return call.calledOnce()
  }),
)

scenarios("/research").scenario("unmocked expectation", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    // @ts-expect-error only tools mocked earlier in this scenario are assertable.
    .expectTool("searchWeb", (call) => call.called()),
)

scenarios("/research").scenario("incomplete call expectation", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    // @ts-expect-error the nested builder must add a count or argument assertion.
    .expectTool("ping", (call) => call),
)

scenarios("/research").scenario("conflicting counts", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    .expectTool("ping", (call) => {
      const counted = call.calledOnce()
      // @ts-expect-error a tool expectation accepts only one count constraint.
      return counted.calledTimes(2)
    }),
)

scenarios("/research").scenario("duplicate input", (s) => {
  const input = s.input({})
  // @ts-expect-error input is required exactly once.
  return input.input({ again: true }).expectPassed()
})

scenarios("/research").scenario("duplicate status", (s) => {
  const passed = s.input({}).expectPassed()
  // @ts-expect-error expected status is required exactly once.
  return passed.expectFailed()
})

scenarios("/research").scenario("not called with args", (s) =>
  s
    .input({})
    .mockTool("searchWeb", async () => ({ results: [] }))
    .expectPassed()
    .expectTool("searchWeb", (call) => {
      const absent = call.notCalled()
      // @ts-expect-error notCalled cannot be combined with argument matching.
      return absent.withArgs({ query: "Dawn" })
    }),
)

scenarios("/research").scenario("args then not called", (s) =>
  s
    .input({})
    .mockTool("searchWeb", async () => ({ results: [] }))
    .expectPassed()
    .expectTool("searchWeb", (call) => {
      const matched = call.withArgs({ query: "Dawn" })
      // @ts-expect-error argument matching cannot be followed by notCalled.
      return matched.notCalled()
    }),
)

scenarios("/without-tools").scenario("none", (s) => {
  const local = s.input({})
  // @ts-expect-error a route with no application tools has no mockable names.
  return local.mockTool("anything", async () => undefined).expectPassed()
})
```

- [ ] **Step 3: Run the focused red tests**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk test scenario-builder
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk typecheck
```

Expected: FAIL because `scenarios`, the descriptor guard, and the fluent type
states do not exist.

- [ ] **Step 4: Implement the descriptor and fluent type states**

In `packages/sdk/src/testing/scenario-types.ts`, define the internal/public
boundary with these exact concepts:

```ts
import type {
  RuntimeErrorExpectation,
  RuntimeMetaExpectation,
} from "./index.js"
import type { RuntimeExecutionResult } from "../runtime-result.js"

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface ScenarioToolMockDescriptor {
  readonly implementation: (input: unknown) => unknown
  readonly name: string
}

export interface ScenarioToolCallRecord {
  readonly args: unknown
  readonly name: string
  readonly sequence: number
}

export interface ScenarioToolCallExpectationDescriptor {
  readonly argumentMatchers: readonly unknown[]
  readonly count?:
    | { readonly kind: "at-least"; readonly value: 1 }
    | { readonly kind: "exact"; readonly value: number }
  readonly name: string
}

export interface ScenarioDescriptor {
  readonly assert?: (result: RuntimeExecutionResult) => unknown | Promise<unknown>
  readonly execution: "in-process" | { readonly serverUrl: string }
  readonly expectedError?: RuntimeErrorExpectation
  readonly expectedMeta?: RuntimeMetaExpectation
  readonly expectedOutput?: unknown
  readonly expectedStatus: "failed" | "passed"
  readonly input: unknown
  readonly name: string
  readonly toolCallExpectations: readonly ScenarioToolCallExpectationDescriptor[]
  readonly toolMocks: readonly ScenarioToolMockDescriptor[]
}

export interface ScenarioSuiteDescriptor {
  readonly route: string
  readonly scenarios: readonly ScenarioDescriptor[]
}
```

Do not constrain generated tool maps through a string index signature; a
generated interface has only known route-tool properties. Instead derive
function keys conditionally:

```ts
type ToolName<TTools> = Extract<{
  [K in keyof TTools]: TTools[K] extends (...args: never[]) => unknown ? K : never
}[keyof TTools], string>

type MockFor<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => Awaited<TResult> | Promise<Awaited<TResult>>
  : never

type ToolArgs<T> = T extends (...args: infer TArgs) => unknown ? TArgs : never
type FirstArg<T> = ToolArgs<T>[0]
type HasArgs<T> = ToolArgs<T> extends [] ? false : true

type PartialFirstArg<T> = DeepPartial<FirstArg<T>>
```

Model scenario builder state with `TInputSet`, `TStatus`, `TExecution`, and
`TMocked`. The public type is an intersection of conditional method groups:

```ts
export type ScenarioBuilder<
  TTools,
  TInputSet extends boolean = false,
  TStatus extends "failed" | "passed" | "unset" = "unset",
  TExecution extends "in-process" | "mocked" | "server" = "in-process",
  TMocked extends ToolName<TTools> = never,
> = ScenarioCommonMethods<TTools, TInputSet, TStatus, TExecution, TMocked>
  & ScenarioInputMethods<...>
  & ScenarioStatusMethods<...>
  & ScenarioExecutionMethods<...>
  & ScenarioExpectationMethods<...>
  & ScenarioCompletionMarker<TInputSet, TStatus>
```

Use a non-exported `unique symbol` completion marker. The configure callback
accepted by `.scenario()` must return a state with both `TInputSet=true` and a
non-`unset` status. `mockTool<K>()` excludes `TMocked`, adds `K` to it, and
switches execution to `"mocked"`. `server()` exists only before any mock and
returns `"server"`. `expectTool<K>()` accepts only `K extends TMocked`.

The call builder tracks whether it has at least one assertion, whether a count
has already been selected, and whether an argument matcher has been added. For
zero-argument functions, omit `.withArgs()`. After `.notCalled()`, omit
`.withArgs()`; after `.withArgs()`, omit `.notCalled()`. The callback return
must carry a non-exported completion marker. For a tool with an input,
`.withArgs(value)` accepts `PartialFirstArg<TTool>` and appends that value to
`argumentMatchers`; multiple calls append independent matchers.

In `packages/sdk/src/testing/scenario-builder.ts`, use a `Symbol.for` brand so
the guard survives normal package duplication. Store the frozen descriptor as
the symbol's value; do not treat possession of the symbol alone as proof that
the value is valid. Keep method transitions
immutable: each method clones its draft arrays and returns a new facade. The
runtime facade implements every method so untyped JavaScript misuse receives a
domain error; the exported conditional types decide which methods TypeScript
callers can see. The
runtime implementation erases a typed mock to `(input: unknown) => unknown`
only when storing the descriptor. It must validate:

- non-empty route and scenario names;
- one input and one expected status;
- no duplicate input or expected-status transition;
- one server selection;
- no server/mock combination;
- no duplicate mock name;
- no output expectation on failed status or error expectation on passed status;
- no tool expectation unless that tool was mocked in the same scenario;
- one count constraint per tool expectation;
- a non-negative safe integer for `.calledTimes(count)`;
- at least one assertion per `expectTool` callback; and
- no combination of `.notCalled()` and argument matchers in either order; and
- no duplicate scenario name in a suite.

Expose `createScenarioSuiteBuilder(route)`, `isScenarioSuite(value)`, and
`readScenarioSuite(value)`. Implement one internal parser that checks the
brand payload and every descriptor field, including function-valued mocks and
assertions, execution/status discriminants, count descriptors, arrays,
non-empty names, duplicate names, and server/mock conflicts. `isScenarioSuite`
returns whether that parser succeeds. `readScenarioSuite` uses the same parser,
throws `Malformed scenario suite: ...` for invalid or forged values, and
returns a recursively frozen descriptor snapshot. This validation must not
trust a recoverable `Symbol.for` key by itself, and must reject a parsed exact
zero count when `argumentMatchers` is non-empty.

In `packages/sdk/src/testing/index.ts`, directly declare the augmentation
target and typed wrapper:

```ts
export interface RouteScenarioMap {}

type RouteScenarioTools<TRoute extends keyof RouteScenarioMap> =
  RouteScenarioMap[TRoute] extends { readonly tools: infer TTools }
    ? TTools
    : Record<never, never>

export function scenarios<TRoute extends Extract<keyof RouteScenarioMap, string>>(
  route: TRoute,
): ScenarioSuiteBuilder<RouteScenarioTools<TRoute>> {
  return createScenarioSuiteBuilder(route) as ScenarioSuiteBuilder<RouteScenarioTools<TRoute>>
}

export { isScenarioSuite, readScenarioSuite }
export type {
  ScenarioDescriptor,
  ScenarioSuiteDescriptor,
  ScenarioToolCallExpectationDescriptor,
  ScenarioToolCallRecord,
  ScenarioToolMockDescriptor,
}
```

Keep `RouteScenarioMap` in this file, not a re-export, so generated
`declare module "@dawn-ai/sdk/testing"` blocks augment the symbol used by the
builder. Update the file's JSDoc example to the fluent API.

- [ ] **Step 5: Run SDK tests and type contracts**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk test scenario-builder
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk lint
```

Expected: PASS. Every `@ts-expect-error` is consumed, and runtime tests see a
frozen branded descriptor. The build refreshes `packages/sdk/dist/testing` for
the CLI fixture imports used by later tasks.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/testing/index.ts \
  packages/sdk/src/testing/scenario-builder.ts \
  packages/sdk/src/testing/scenario-types.ts \
  packages/sdk/test/scenario-builder.test.ts \
  packages/sdk/test/scenario-builder.contract.ts
git commit -m "feat(sdk): add fluent route scenarios"
```

### Task 2: Generate route-aware scenario tool types

**Files:**
- Create: `packages/core/src/typegen/render-scenario-types.ts`
- Modify: `packages/core/src/typegen/render-route-types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/render-route-types.test.ts`

- [ ] **Step 1: Add failing typegen snapshots**

Extend `packages/core/test/render-route-types.test.ts` with a focused
`renderScenarioTypes()` snapshot. The expected declaration must be an external
module augmentation, not a bare ambient module:

```ts
import "@dawn-ai/sdk/testing"

declare module "@dawn-ai/sdk/testing" {
  interface RouteScenarioMap {
    "/hello/[tenant]": {
      readonly tools: {
        readonly "greet": (input: { readonly tenant: string }) => Promise<{ name: string }>
      }
    }
  }
}
```

Add a second assertion for a manifest route with no tools:

```ts
expect(output).toContain(`"/without-tools": {
      readonly tools: Record<never, never>
    }`)
```

Also assert a `void` input renders `readonly "ping": () => Promise<string>`.
Finally, assert `renderDawnTypes()` starts with:

```ts
/// <reference path="./scenarios.generated.d.ts" />
```

This split is required: putting the package augmentation bare in the same
global declaration file as `dawn:routes` would shadow the real testing package
and hide exports such as `scenarios`.

- [ ] **Step 2: Run the red Core test**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core test render-route-types
```

Expected: FAIL because the scenario renderer and sibling-file reference do not
exist.

- [ ] **Step 3: Implement `renderScenarioTypes`**

Create `packages/core/src/typegen/render-scenario-types.ts`:

```ts
import type { RouteManifest, RouteToolTypes } from "../types.js"

export const SCENARIO_TYPES_FILE = "scenarios.generated.d.ts"

export function renderScenarioTypes(
  manifest: RouteManifest,
  routeTools: readonly RouteToolTypes[],
): string {
  const toolsByPath = new Map(routeTools.map((route) => [route.pathname, route.tools]))
  const lines = [
    'import "@dawn-ai/sdk/testing"',
    "",
    'declare module "@dawn-ai/sdk/testing" {',
    "  interface RouteScenarioMap {",
  ]

  for (const route of manifest.routes) {
    const tools = toolsByPath.get(route.pathname) ?? []
    lines.push(`    ${JSON.stringify(route.pathname)}: {`)
    if (tools.length === 0) {
      lines.push("      readonly tools: Record<never, never>")
    } else {
      lines.push("      readonly tools: {")
      for (const tool of tools) {
        const signature = tool.inputType === "void"
          ? `() => Promise<${tool.outputType}>`
          : `(input: ${tool.inputType}) => Promise<${tool.outputType}>`
        lines.push(`        readonly ${JSON.stringify(tool.name)}: ${signature}`)
      }
      lines.push("      }")
    }
    lines.push("    }")
  }

  lines.push("  }")
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}
```

Sort order comes from `manifest.routes` and each route's already deterministic
extracted tool order; do not perform a second order transformation.

In `renderDawnTypes()`, prepend the triple-slash path reference plus a blank
line before `declare module "dawn:routes"`. Do not place an import or the
package augmentation in this file: it must remain a global declaration file
that defines the virtual module. Leave `renderRouteTypes()` unchanged because
it does not write the companion file.

Export `SCENARIO_TYPES_FILE` and `renderScenarioTypes` from
`packages/core/src/index.ts`.

- [ ] **Step 4: Run Core typegen checks**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core test render-route-types
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core lint
```

Expected: PASS. Snapshots include every route, use
`Record<never, never>` for routes without application tools, and keep the
augmentation in an external declaration file.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts \
  packages/core/src/typegen/render-scenario-types.ts \
  packages/core/src/typegen/render-route-types.ts \
  packages/core/test/render-route-types.test.ts
git commit -m "feat(core): generate scenario tool types"
```

### Task 3: Emit scenario declarations from CLI and Vite typegen

**Files:**
- Modify: `packages/cli/src/lib/typegen/run-typegen.ts`
- Modify: `packages/cli/test/run-typegen.test.ts`
- Create: `packages/cli/test/scenario-typegen-contract.test.ts`
- Modify: `packages/vite-plugin/src/index.ts`
- Modify: `packages/vite-plugin/test/plugin.test.ts`
- Modify: `test/generated/run-generated-app.test.ts`
- Modify: `test/generated/fixtures/basic.expected.json`
- Modify: `test/generated/fixtures/custom-app-dir.expected.json`
- Modify: `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts`
- Create: `packages/devkit/templates/app-basic/.dawn/scenarios.generated.d.ts`
- Modify: `packages/devkit/templates/app-research/.dawn/dawn.generated.d.ts`
- Create: `packages/devkit/templates/app-research/.dawn/scenarios.generated.d.ts`

- [ ] **Step 1: Add failing CLI emission tests**

Extend the first `runTypegen` test to assert both files exist and the scenario
file contains the testing-package import, the route, and `greet`. Extend the
existing `plan.md` test to prove capability tools stay out of scenario
completion:

```ts
const scenarioTypes = await readFile(
  join(appRoot, ".dawn", "scenarios.generated.d.ts"),
  "utf8",
)
expect(scenarioTypes).toContain('import "@dawn-ai/sdk/testing"')
expect(scenarioTypes).toContain('"/hello/[tenant]"')
expect(scenarioTypes).toContain('readonly "greet"')
expect(scenarioTypes).not.toContain("writeTodos")
```

Repeat the exclusion assertions in the existing subagent, workspace, and
memory capability cases for `task`, `readFile`, `remember`, and `recall`. The
ordinary `dawn.generated.d.ts` assertions remain unchanged, proving capability
tools still exist in `dawn:routes`.

Create `packages/cli/test/scenario-typegen-contract.test.ts` as a real compiler
integration. It must:

1. create a temporary app with a `/hello` route and typed `greet` application
   tool;
2. write a `run.test.ts` that imports both `scenarios` and `expectOutput` from
   `@dawn-ai/sdk/testing`, mocks `greet` with its generated input/result shape,
   and uses `expectOutput` in `.assert()`;
3. run `runTypegen()`;
4. write a temporary `tsconfig.json` that includes `run.test.ts` and both
   `.dawn/*.d.ts` files and maps `@dawn-ai/sdk/testing` to the worktree's
   `packages/sdk/src/testing/index.ts`; and
5. spawn `pnpm exec tsc -p <temporary tsconfig>` and require exit code `0`.

This one test proves the generated external declaration augments the real
entry point: the route/tool types are present and the package's existing
`scenarios` and `expectOutput` exports remain visible. Register the temporary
directory for `afterEach` cleanup and include compiler stderr in assertion
failures.

- [ ] **Step 2: Add a failing Vite emission test**

In `packages/vite-plugin/test/plugin.test.ts`, create a temporary Dawn app with
one typed application tool, invoke the plugin's `buildStart` hook, and assert
`.dawn/dawn.generated.d.ts` references `scenarios.generated.d.ts` while the
sibling file imports and augments `@dawn-ai/sdk/testing`. Reuse the test's
existing filesystem helpers where useful, add `afterEach` cleanup for the new
temporary directory, and do not export a production-only test hook.

- [ ] **Step 3: Run the red typegen tests**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test run-typegen scenario-typegen-contract
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin test plugin
```

Expected: FAIL because neither typegen path writes the scenario declaration,
and the compiler integration cannot resolve the generated route map.

- [ ] **Step 4: Write the declaration pair in CLI typegen**

Import `renderScenarioTypes` and `SCENARIO_TYPES_FILE` from `@dawn-ai/core`.
Maintain two route-tool arrays inside `runTypegen()`:

```ts
const routeToolTypes: RouteToolTypes[] = []
const scenarioToolTypes: RouteToolTypes[] = []
```

Immediately after extracting `tools`, push `{ pathname, tools }` to
`scenarioToolTypes`. Continue pushing `{ pathname, tools: [...tools,
...extraTools] }` to `routeToolTypes` after capability detection. At the end,
render and write both files after creating `.dawn`:

```ts
await Promise.all([
  writeFile(join(dawnDir, "dawn.generated.d.ts"), renderDawnTypes(
    manifest,
    routeToolTypes,
    routeStateFields,
  ), "utf8"),
  writeFile(join(dawnDir, SCENARIO_TYPES_FILE), renderScenarioTypes(
    manifest,
    scenarioToolTypes,
  ), "utf8"),
])
```

This separation is the compile-time enforcement that built-in capability
tools cannot be mocked.

- [ ] **Step 5: Write the declaration pair in Vite typegen**

The Vite plugin's `toolTypesPerRoute` already contains application tools only.
Import the Core renderer and file constant, render both strings, and write both
files with `Promise.all` after creating `.dawn`. Keep the plugin's current
best-effort error behavior and file watcher behavior.

- [ ] **Step 6: Record generated-app output**

Add `scenarioTypegenOutput` to `GeneratedAppScenarioResult` in
`test/generated/run-generated-app.test.ts`, assert the sibling file exists,
and read it into the returned result. Regenerate the exact fixture values in:

- `test/generated/fixtures/basic.expected.json`
- `test/generated/fixtures/custom-app-dir.expected.json`

The existing `typegenOutput` gains the triple-slash reference and
`verifyJson`'s `renderedBytes` changes. Use actual harness output; do not
calculate byte counts by hand.

Regenerate the tracked declaration pair under both Devkit starter templates
with the same renderer. Do not hand-maintain a different scaffold-only shape;
each `dawn.generated.d.ts` must reference its sibling, and each sibling must
contain the routes and application tools actually present in that template.

- [ ] **Step 7: Run typegen and generated-app checks**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test run-typegen scenario-typegen-contract
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin test plugin
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-app.test.ts
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/devkit test generated-app
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin typecheck
```

Expected: PASS, with the same application-only map emitted by both typegen
paths. The workspace build is required immediately before the generated-app
lane because that lane packages `dist` artifacts for SDK, Core, CLI, and the
Vite plugin.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/typegen/run-typegen.ts \
  packages/cli/test/run-typegen.test.ts \
  packages/cli/test/scenario-typegen-contract.test.ts \
  packages/vite-plugin/src/index.ts \
  packages/vite-plugin/test/plugin.test.ts \
  test/generated/run-generated-app.test.ts \
  test/generated/fixtures/basic.expected.json \
  test/generated/fixtures/custom-app-dir.expected.json \
  packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts \
  packages/devkit/templates/app-basic/.dawn/scenarios.generated.d.ts \
  packages/devkit/templates/app-research/.dawn/dawn.generated.d.ts \
  packages/devkit/templates/app-research/.dawn/scenarios.generated.d.ts
git commit -m "feat(typegen): emit scenario declarations"
```

### Task 4: Make the CLI loader consume only scenario suites

**Files:**
- Modify: `packages/cli/src/lib/runtime/load-run-scenarios.ts`
- Modify: `packages/cli/test/test-command.test.ts`

- [ ] **Step 1: Add failing loader-boundary tests**

Add focused cases to `packages/cli/test/test-command.test.ts` for:

1. a branded suite whose declared route matches its directory;
2. a plain default-exported array rejected with the canonical builder hint;
3. a suite declaring another valid route rejected as a route mismatch;
4. duplicate scenario names rejected while importing/building the suite;
5. `.server()` plus `.mockTool()` rejected as a scenario-load failure; and
6. an unknown application tool rejected with sorted available names.

Build fixture source with the workspace SDK output:

```ts
const SDK_TESTING_URL = pathToFileURL(
  resolve(import.meta.dirname, "../../sdk/dist/testing/index.js"),
).href

interface BuilderScenarioFixture {
  readonly expect: {
    readonly error?: unknown
    readonly meta?: unknown
    readonly output?: unknown
    readonly status: "failed" | "passed"
  }
  readonly input: unknown
  readonly name: string
  readonly run?: { readonly url: string }
}

function scenarioModule(route: string, scenarios: readonly BuilderScenarioFixture[]): string {
  let source = `import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}\n\n`
  source += `export default scenarios(${JSON.stringify(route)})`
  for (const scenario of scenarios) {
    let chain = `s.input(${JSON.stringify(scenario.input)})`
    if (scenario.run?.url) chain += `.server(${JSON.stringify(scenario.run.url)})`
    chain += scenario.expect.status === "passed" ? ".expectPassed()" : ".expectFailed()"
    if (Object.hasOwn(scenario.expect, "output")) {
      chain += `.expectOutput(${JSON.stringify(scenario.expect.output)})`
    }
    if (scenario.expect.meta) chain += `.expectMeta(${JSON.stringify(scenario.expect.meta)})`
    if (scenario.expect.error) chain += `.expectError(${JSON.stringify(scenario.expect.error)})`
    source += `.scenario(${JSON.stringify(scenario.name)}, (s) => ${chain})`
  }
  return `${source}\n`
}
```

Use explicit source strings for malformed-builder and custom-assert tests.
Tests that intentionally omit input/status cannot use
`BuilderScenarioFixture`; express them through a narrowly cast builder in the
fixture source so SDK runtime validation remains the behavior under test.
Change every existing `scenarioModule([...])` call to
`scenarioModule("/route", [...])`. Convert existing `scenarioModuleSource`
arrays to the fluent builder; do not leave a hidden array compatibility path in
test helpers.

- [ ] **Step 2: Run the CLI command test and confirm the migration is red**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test test-command
```

Expected: FAIL because the loader still requires an array and does not know
the suite descriptor.

- [ ] **Step 3: Replace raw-record loading with suite loading**

In `load-run-scenarios.ts`:

- import `isScenarioSuite`, `readScenarioSuite`, and descriptor types from
  `@dawn-ai/sdk/testing`;
- retain filesystem discovery, sibling `index.ts` validation, route-kind
  loading, and route identity derivation;
- reject non-suites with:

```text
Scenario file <path> must default export scenarios("<route>")...
Plain scenario arrays are not supported.
```

- compare `suite.route` with `routeIdentity.routeId`;
- discover application tools once using `discoverToolDefinitions({ appRoot,
  routeDir })` when any scenario contains mocks;
- reject unknown mock names before returning loaded scenarios, listing sorted
  available names;
- map descriptors to `LoadedRunScenario` without re-parsing the removed object
  format; and
- preserve `assert`, `run.url`, declarative expectations, route metadata, and
  scenario file context.

Catch errors thrown while importing/building a suite and wrap them in
`RunScenarioLoadError` with the scenario file path. Remove obsolete raw-record
validators instead of retaining dead compatibility code.

- [ ] **Step 4: Run loader and command regression tests**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test test-command
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli typecheck
```

Expected: PASS for all existing discovery, narrowing, in-process, server,
failure, and custom-assert behavior through the builder format.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/load-run-scenarios.ts \
  packages/cli/test/test-command.test.ts
git commit -m "feat(cli): load fluent route scenarios"
```

### Task 5: Add the invocation-local tool override primitive

**Files:**
- Create: `packages/cli/src/lib/runtime/scenario-tool-overrides.ts`
- Create: `packages/cli/test/scenario-tool-overrides.test.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Write failing pure override tests**

Create `packages/cli/test/scenario-tool-overrides.test.ts` with real
`DiscoveredToolDefinition` fixtures. Cover:

- replacing one named tool while leaving another definition referentially
  unchanged;
- preserving name, schema, description, file path, and scope;
- recording arguments before a successful return;
- recording arguments before a thrown error and rethrowing the same error;
- assigning monotonically increasing sequence values across mocked tools;
- rejecting unknown names with sorted available names; and
- not mutating the source tool array or definitions.

The core successful assertion should be:

```ts
const journal: ScenarioToolCallRecord[] = []
const result = applyScenarioToolOverrides({
  journal,
  overrides: [{ name: "search", implementation: async ({ query }) => `mock:${query}` }],
  tools: [searchTool, saveTool],
})

expect(result.ok).toBe(true)
if (!result.ok) throw new Error(result.message)
expect(result.tools[1]).toBe(saveTool)
await expect(result.tools[0]?.run({ query: "Dawn" }, context)).resolves.toBe("mock:Dawn")
expect(journal).toEqual([{ args: { query: "Dawn" }, name: "search", sequence: 0 }])
expect(searchTool.run).toBe(realSearchRun)
```

- [ ] **Step 2: Run the red primitive test**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test scenario-tool-overrides
```

Expected: FAIL because `applyScenarioToolOverrides` does not exist.

- [ ] **Step 3: Implement the pure replacement function**

Create `scenario-tool-overrides.ts` and reuse the erased SDK descriptor and
journal record types:

```ts
import type {
  ScenarioToolCallRecord,
  ScenarioToolMockDescriptor,
} from "@dawn-ai/sdk/testing"
import type { DiscoveredToolDefinition } from "./tool-shape.js"

export type ScenarioToolOverride = ScenarioToolMockDescriptor
export type ScenarioToolCallJournal = ScenarioToolCallRecord[]
```

`applyScenarioToolOverrides()` returns `{ ok: true, tools }` or
`{ ok: false, message }`. Validate all override names before wrapping any
definition. Build a new array with `tools.map`; return the original definition
for unmocked tools and `{ ...tool, run }` for mocked tools. The wrapper pushes
`{ name, args: input, sequence: journal.length }` before invoking
`implementation(input)`. The SDK builder has already erased the statically
typed zero-or-one-argument function to this runtime shape; JavaScript ignores
the input passed to a generated zero-argument mock.

- [ ] **Step 4: Thread overrides through only the disk-first execution path**

Add optional `toolOverrides` and `toolCallJournal` to `ExecuteRouteOptions` and
the request-level `PrepareRouteExecutionOptions`. Pass them from
`executeRoute()` into `executeRouteAtResolvedPath()`.

Immediately after `getPreparedRouteModules()` in `prepareRouteExecution()`,
apply overrides to `prepared.tools` and assign the result to the existing local
`tools` variable:

```ts
let tools = prepared.tools
if (options.toolOverrides && options.toolOverrides.length > 0) {
  const applied = applyScenarioToolOverrides({
    journal: options.toolCallJournal ?? [],
    overrides: options.toolOverrides,
    tools,
  })
  if (!applied.ok) return { message: applied.message, ok: false }
  tools = applied.tools
}
```

Do not add overrides to `BootResolvedInstances`, server request bodies,
prepared module payloads, or static module manifests. Child subagent
preparation receives explicit child options and therefore must not inherit the
root override fields.

- [ ] **Step 5: Add a prepared-module cache isolation regression**

Extend `packages/cli/test/scenario-tool-overrides.test.ts` or
`route-load-cache.test.ts` to prepare the same route twice without clearing
caches: first with an override, then without one. Assert the second prepared
route has the original tool implementation and the first journal receives no
later calls.

- [ ] **Step 6: Run focused runtime checks**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test scenario-tool-overrides route-load-cache
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli typecheck
```

Expected: PASS with no mutation of cached `PreparedRouteModules`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/runtime/scenario-tool-overrides.ts \
  packages/cli/src/lib/runtime/execute-route-core.ts \
  packages/cli/src/lib/runtime/execute-route.ts \
  packages/cli/test/scenario-tool-overrides.test.ts \
  packages/cli/test/route-load-cache.test.ts
git commit -m "feat(cli): apply scenario tool overrides"
```

Only stage `route-load-cache.test.ts` if Step 5 modifies it.

### Task 6: Execute mocks and evaluate call expectations

**Files:**
- Create: `packages/cli/src/lib/runtime/scenario-tool-expectations.ts`
- Modify: `packages/cli/src/commands/test.ts`
- Modify: `packages/cli/src/lib/runtime/load-run-scenarios.ts`
- Modify: `packages/cli/test/test-command.test.ts`

- [ ] **Step 1: Add failing end-to-end command cases**

Add a workflow fixture with real shared `greet` and route-local `lookup`
tools. Its scenario must mock only `lookup`, retain real `greet`, and assert:

```ts
.mockTool("lookup", async ({ tenant }) => ({ plan: `mock:${tenant}` }))
.expectPassed()
.expectOutput({
  greeting: { source: "real-shared" },
  plan: "mock:acme",
})
.expectTool("lookup", (call) =>
  call.calledOnce().withArgs({ tenant: "acme" }),
)
```

Add separate scenarios/tests for:

- `.calledTimes(2)` success;
- `.notCalled()` success;
- count mismatch output naming the tool, expected count, and actual calls;
- primitive exact argument matching;
- nested object deep-partial matching with arrays exact;
- multiple compatible `.withArgs()` matchers satisfied by one call;
- argument mismatch output showing expected and observed arguments; and
- a mock throw following ordinary route failure behavior.

- [ ] **Step 2: Run the red command tests**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test test-command
```

Expected: FAIL because command execution does not pass overrides or inspect a
call journal.

- [ ] **Step 3: Implement call expectation evaluation**

Create `scenario-tool-expectations.ts`. Export:

```ts
export function evaluateScenarioToolExpectations(
  expectations: readonly ScenarioToolCallExpectationDescriptor[],
  calls: readonly ScenarioToolCallRecord[],
): string | null
```

Group/filter records by exact tool name. For each expectation:

1. enforce total count independently;
2. for each entry in `argumentMatchers`, require at least one call to match;
3. use recursive object-subset matching;
4. require primitive `Object.is` equality and exact arrays; and
5. return the first deterministic mismatch string, or `null`.

Do not add matcher methods to `RuntimeExecutionResult`; the journal is
scenario-runner state, not route output.

- [ ] **Step 4: Integrate journals into `dawn test`**

Extend `LoadedRunScenario` with normalized `toolMocks` and
`toolCallExpectations`. In `runScenario()`:

```ts
const toolCalls: ScenarioToolCallRecord[] = []
result = scenario.run?.url
  ? await executeRouteServer(...)
  : await executeRoute({
      appRoot: scenario.appRoot,
      input: scenario.input,
      routeFile: scenario.routeFile,
      ...(scenario.toolMocks.length > 0
        ? { toolOverrides: scenario.toolMocks, toolCallJournal: toolCalls }
        : {}),
    })
```

Pass `toolCalls` into `evaluateScenario()`. Preserve evaluation order:

1. status;
2. metadata;
3. output or modeled error;
4. tool calls; and
5. custom assertion.

If an unexpected route failure occurs, return it before evaluating missing
tool calls. If route expectations pass but a call expectation fails, return an
`assertion` outcome with the matcher message.

- [ ] **Step 5: Run CLI behavior tests**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test test-command scenario-tool-overrides
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli lint
```

Expected: PASS and failure output remains `FAIL <name> [assertion] <detail>`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/test.ts \
  packages/cli/src/lib/runtime/load-run-scenarios.ts \
  packages/cli/src/lib/runtime/scenario-tool-expectations.ts \
  packages/cli/test/test-command.test.ts
git commit -m "feat(cli): assert scenario tool calls"
```

### Task 7: Prove agent behavior and subagent isolation

**Files:**
- Create: `packages/cli/test/scenario-tool-mocking-agent.test.ts`

- [ ] **Step 1: Write a deterministic mocked-agent test**

Use `createAimock` and `script` from `packages/testing/dist/index.js`, following
existing CLI tests. Build an agent fixture with a real `searchWeb` tool whose
body throws if called. Point `OPENAI_BASE_URL` at an aimock script that asks the
agent to call `searchWeb`, receives the mocked result, and replies. Run
`dawn test` against a builder scenario that mocks `searchWeb`, then assert:

- exit code `0`;
- the scenario passes;
- `.expectTool("searchWeb", ...calledOnce...)` passes; and
- the real throwing implementation was never reached.

- [ ] **Step 2: Write a same-name subagent non-propagation test**

Create parent and child agent routes that both define an application tool named
`lookup`. The parent scenario mocks its own `lookup` and marks it
`.notCalled()`. Script the parent model to dispatch the child and script the
child model to call its own `lookup`. Make the child's real tool increment a
test-owned global marker and return a recognizable value.

Assert the scenario passes, the parent mock remains uncalled, and the child
marker is incremented exactly once. This proves root override options are not
threaded into child route preparation even when names collide.

- [ ] **Step 3: Run the red tests before adding any missing wiring**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test scenario-tool-mocking-agent
```

Expected: the first test should pass after Tasks 5-6. If the subagent test
fails because overrides propagate, fix only the explicit child preparation
argument threading; do not add name-based exceptions.

- [ ] **Step 4: Run focused agent and subagent regressions**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test \
  scenario-tool-mocking-agent subagent-runtime subagent-registry-runtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/scenario-tool-mocking-agent.test.ts \
  packages/cli/src/lib/runtime/execute-route-core.ts
git commit -m "test(cli): cover scenario mock isolation"
```

Only stage `execute-route-core.ts` if the red subagent test exposed missing
isolation wiring.

### Task 8: Migrate generated fixtures and developer guidance

**Files:**
- Modify: `test/generated/harness.ts`
- Modify: `test/generated/run-generated-runtime-contract.test.ts`
- Modify: `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts`
- Modify: `apps/web/content/templates/AGENTS.md`
- Modify: `apps/web/content/prompts/index.ts`

- [ ] **Step 1: Make generated-fixture tests fail on the old format**

In the first non-handwritten case in
`test/generated/run-generated-runtime-contract.test.ts`, read the
`run.test.ts` created by `prepareGeneratedRuntimeApp()` and assert it contains:

```ts
import { expectMeta, expectOutput, scenarios } from "@dawn-ai/sdk/testing"
export default scenarios("/hello/[tenant]")
```

and does not contain `export default [`.

- [ ] **Step 2: Run the generated fixture test and confirm red**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-runtime-contract.test.ts
```

Expected: FAIL because `writeRunScenarioFile()` still emits an array.

- [ ] **Step 3: Rewrite generated and handwritten scenarios**

Change `writeRunScenarioFile()` to emit:

```ts
import { expectMeta, expectOutput, scenarios } from "@dawn-ai/sdk/testing"

export default scenarios("/hello/[tenant]")
  .scenario("<in-process name>", (s) =>
    s
      .input(<input>)
      .expectPassed()
      .expectOutput(<output>)
      .expectMeta(<meta>),
  )
  .scenario("<server name>", (s) =>
    s
      .input(<input>)
      .server("__SERVER_URL__")
      .expectPassed()
      .expectOutput(<output>)
      .expectMeta(<meta>)
      .assert((result) => {
        expectMeta(result, <asserted meta>)
        expectOutput(result, <asserted output>)
      }),
  )
```

Rewrite the checked-in handwritten fixture to the same builder API. Update the
template `AGENTS.md` and app-generation prompt so they describe the builder,
not a default-exported array.

- [ ] **Step 4: Run generated and prompt/template checks**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-runtime-contract.test.ts
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node scripts/check-docs.mjs
```

Expected: PASS. Rebuilding first ensures the packaged runtime fixture consumes
the builder and loader implementation from Tasks 1 and 4-7 rather than stale
`dist` output.

- [ ] **Step 5: Commit**

```bash
git add test/generated/harness.ts \
  test/generated/run-generated-runtime-contract.test.ts \
  'test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts' \
  apps/web/content/templates/AGENTS.md \
  apps/web/content/prompts/index.ts
git commit -m "chore(testing): migrate scenario fixtures"
```

### Task 9: Document the canonical builder and release impact

**Files:**
- Modify: `apps/web/content/docs/testing.mdx`
- Modify: `apps/web/content/docs/cli.mdx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Create: `.changeset/scenario-tool-mocking.md`
- Generate only: `packages/cli/docs/testing.md`

- [ ] **Step 1: Replace the scenario guide with builder-first examples**

Update `apps/web/content/docs/testing.mdx` so every example uses
`scenarios("/route")`. Document:

- `.scenario()`, `.input()`, and explicit `.expectPassed()` /
  `.expectFailed()`;
- `.server(url)` instead of `run: { url }`;
- `.assert()` and existing assertion helpers;
- typed partial `.mockTool()` replacement;
- `.expectTool()` count and argument assertions;
- unmocked tools retaining real implementations;
- mocks applying only to application route/shared tools;
- no capability-tool or subagent propagation;
- invocation and cache isolation; and
- why `.server()` and `.mockTool()` cannot be combined.

Include a short “When to use a server-backed scenario” section covering HTTP
serialization, middleware, runtime boot wiring, packaged static modules, and
staging infrastructure. Recommend local fake services or model proxies for
server dependencies.

Update CLI and deployment docs from `run.url` object terminology to
`.server(url)`.

- [ ] **Step 2: Add the patch changeset**

Create `.changeset/scenario-tool-mocking.md`:

```md
---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/devkit": patch
"@dawn-ai/sdk": patch
"@dawn-ai/vite-plugin": patch
---

Add route-scoped fluent `dawn test` scenarios with generated application-tool
types, invocation-local in-process tool mocks, and declarative mock call
assertions. Scenario files now use `scenarios("/route")`; plain default-exported
arrays are no longer supported.
```

Do not use a minor changeset because Dawn's fixed 0.x group would advance to
1.0.0.

- [ ] **Step 3: Generate and inspect CLI docs**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli build
rg -n 'mockTool|expectTool|server-backed scenario' packages/cli/docs/testing.md
git check-ignore packages/cli/docs/testing.md
```

Expected: generated CLI docs contain the new API, are ignored, and do not
appear in `git status`.

- [ ] **Step 4: Run documentation and changeset checks**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test docs-bundle
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node scripts/check-docs.mjs
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node scripts/check-changesets.mjs
```

Expected: PASS. The changeset check runs after the changeset is staged or
committed if its base comparison requires committed changes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/content/docs/testing.mdx \
  apps/web/content/docs/cli.mdx \
  apps/web/content/docs/deployment.mdx \
  .changeset/scenario-tool-mocking.md
git commit -m "docs(testing): document fluent tool mocks"
```

- [ ] **Step 6: Re-run the committed changeset check**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node scripts/check-changesets.mjs
```

Expected: PASS against `origin/main`.

### Task 10: Complete package and repository verification

**Files:**
- Verify only; no expected source changes

- [ ] **Step 1: Rebuild the complete workspace from source**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm build
```

Expected: PASS. This refreshes every `dist/` consumer before final tests.

- [ ] **Step 2: Run SDK, Core, CLI, Vite plugin, and Devkit package gates**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk lint
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/sdk test

env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core lint
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/core test

env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli lint
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/cli test

env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin lint
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/vite-plugin test

env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/devkit build
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/devkit typecheck
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/devkit lint
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm --filter @dawn-ai/devkit test
```

Expected: all commands PASS.

- [ ] **Step 3: Run the repository Definition of Done**

Run:

```bash
env PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" corepack pnpm ci:validate
```

Expected: lint, build-cache, build, typecheck, source tests, docs checks,
pack checks, release-script tests, and all framework/runtime/smoke harness
lanes PASS.

- [ ] **Step 4: Inspect final scope**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
rg -n 'export default \[' \
  apps/web/content/docs/testing.mdx \
  apps/web/content/templates/AGENTS.md \
  apps/web/content/prompts/index.ts \
  test/generated/harness.ts \
  'test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts'
```

Expected: no whitespace errors, a clean worktree, only planned commits, and no
remaining canonical guidance or generated fixture that teaches plain scenario
arrays.

- [ ] **Step 5: Commit verification-only fixes if required**

If verification required a narrowly scoped correction, rerun its focused red
and green test, then commit only that correction with a descriptive message.
Do not create an empty verification commit.
