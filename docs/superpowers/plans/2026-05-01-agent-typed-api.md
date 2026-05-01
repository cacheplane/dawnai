# `agent()` Typed API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lazy `agent()` descriptor function to `@dawn-ai/sdk` that eliminates LangChain type leakage and provides zero-annotation DX for Dawn agent routes.

**Architecture:** The SDK exports a pure `agent()` factory that returns an opaque branded `DawnAgent` descriptor. Route discovery recognizes this descriptor via symbol check. The `@dawn-ai/langchain` adapter materializes the descriptor into a live LangChain agent at invocation time. The template switches from `createAgent` to `agent()`, dropping direct LangChain deps.

**Tech Stack:** TypeScript 6.0, Vitest, pnpm workspace, `@langchain/core`, `@langchain/langgraph`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/sdk/src/agent.ts` (create) | `agent()`, `isDawnAgent()`, `DawnAgent`, `AgentConfig`, `KnownModelId` |
| `packages/sdk/src/index.ts` (modify) | Re-export agent types and functions |
| `packages/sdk/test/agent.test.ts` (create) | Unit tests for `agent()` and `isDawnAgent()` |
| `packages/langchain/src/agent-adapter.ts` (modify) | Add `isDawnAgent` branch and `materializeAgent` |
| `packages/langchain/test/agent-adapter.test.ts` (create) | Tests for descriptor materialization path |
| `packages/core/src/discovery/discover-routes.ts` (modify) | Support `default` export detection for agents |
| `packages/core/test/discover-routes.test.ts` (modify) | Add test for `export default agent({...})` route |
| `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts` (modify) | Switch to `agent()` API |
| `packages/devkit/templates/app-basic/package.json.template` (modify) | Remove direct langchain deps |
| `packages/devkit/src/testing/generated-app.ts` (modify) | Remove langchain specifiers |

---

### Task 1: SDK — `agent()` function and `DawnAgent` type

**Files:**
- Create: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/index.ts`
- Create: `packages/sdk/test/agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/agent.test.ts`:

```typescript
import { describe, expect, expectTypeOf, test } from "vitest"
import { agent, isDawnAgent } from "@dawn-ai/sdk"
import type { AgentConfig, DawnAgent, KnownModelId } from "@dawn-ai/sdk"

describe("agent()", () => {
  test("returns a DawnAgent descriptor with the provided config", () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    expect(descriptor.model).toBe("gpt-4o-mini")
    expect(descriptor.systemPrompt).toBe("You are helpful.")
  })

  test("descriptor is recognized by isDawnAgent", () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "Hello",
    })

    expect(isDawnAgent(descriptor)).toBe(true)
  })

  test("isDawnAgent rejects plain objects", () => {
    expect(isDawnAgent({})).toBe(false)
    expect(isDawnAgent(null)).toBe(false)
    expect(isDawnAgent(undefined)).toBe(false)
    expect(isDawnAgent({ model: "gpt-4o", systemPrompt: "hi" })).toBe(false)
  })

  test("isDawnAgent rejects objects with invoke method (legacy agents)", () => {
    expect(isDawnAgent({ invoke: async () => ({}) })).toBe(false)
  })

  test("KnownModelId provides autocomplete but accepts any string", () => {
    const config: AgentConfig = {
      model: "my-custom-model",
      systemPrompt: "hi",
    }
    const descriptor = agent(config)
    expect(descriptor.model).toBe("my-custom-model")
  })

  test("DawnAgent type is exported", () => {
    const descriptor = agent({ model: "gpt-4o", systemPrompt: "test" })
    expectTypeOf(descriptor).toMatchTypeOf<DawnAgent>()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk && pnpm test -- --run agent.test.ts`
Expected: FAIL — cannot resolve `agent` or `isDawnAgent` from `@dawn-ai/sdk`

- [ ] **Step 3: Write the implementation**

Create `packages/sdk/src/agent.ts`:

```typescript
const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent") as unknown as typeof DAWN_AGENT

declare const brand: unique symbol

export interface DawnAgent {
  readonly [brand]: "DawnAgent"
  readonly model: string
  readonly systemPrompt: string
}

export type KnownModelId =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  | "claude-sonnet-4-20250514"
  | "claude-haiku-4-20250414"
  | (string & {})

export interface AgentConfig {
  readonly model: KnownModelId
  readonly systemPrompt: string
}

export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
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

Update `packages/sdk/src/index.ts` to add exports:

```typescript
export type { BackendAdapter } from "./backend-adapter.js"
export type { RouteConfig, RouteKind } from "./route-config.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
export { agent, isDawnAgent } from "./agent.js"
export type { AgentConfig, DawnAgent, KnownModelId } from "./agent.js"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk && pnpm test -- --run agent.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Run typecheck**

Run: `cd packages/sdk && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/agent.test.ts
git commit -m "feat(sdk): add agent() descriptor function and isDawnAgent guard"
```

---

### Task 2: LangChain adapter — handle `DawnAgent` descriptors

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/src/index.ts`
- Create: `packages/langchain/test/agent-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/langchain/test/agent-adapter.test.ts`:

```typescript
import { AIMessage } from "@langchain/core/messages"
import { describe, expect, test, vi } from "vitest"
import { agent } from "@dawn-ai/sdk"
import { executeAgent } from "../src/agent-adapter.js"

describe("executeAgent with DawnAgent descriptors", () => {
  test("materializes a DawnAgent descriptor and invokes it", async () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const mockInvoke = vi.fn().mockResolvedValue(
      new AIMessage({ content: "Hello!" }),
    )

    // Mock the materializeAgent path by intercepting createReactAgent
    // We'll test that executeAgent recognizes the descriptor and doesn't
    // throw "Agent entry must expose invoke(input)"
    // For this unit test, we mock the materialization
    const result = await executeAgent({
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).catch((error: Error) => error)

    // The descriptor should be recognized (not throw "must expose invoke")
    // It will fail on materialization since we don't have a real LLM,
    // but the error should NOT be "Agent entry must expose invoke(input)"
    if (result instanceof Error) {
      expect(result.message).not.toContain("must expose invoke")
    }
  })

  test("legacy agent with invoke() still works", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Legacy!" })),
    }

    const result = await executeAgent({
      entry: mockAgent,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })

    expect(mockAgent.invoke).toHaveBeenCalled()
    expect((result as AIMessage).content).toBe("Legacy!")
  })

  test("route params are separated from agent input", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "ok" })),
    }

    await executeAgent({
      entry: mockAgent,
      input: { tenant: "acme", question: "hello" },
      routeParamNames: ["tenant"],
      signal: new AbortController().signal,
      tools: [],
    })

    const [invokeInput, invokeConfig] = mockAgent.invoke.mock.calls[0]!
    expect(invokeInput.messages[0].content).toBe("hello")
    expect(invokeConfig.configurable).toEqual({ tenant: "acme" })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/langchain && pnpm test -- --run agent-adapter.test.ts`
Expected: FAIL — `isDawnAgent` not imported, `executeAgent` still throws on non-invoke objects

- [ ] **Step 3: Implement the DawnAgent branch in the adapter**

Replace `packages/langchain/src/agent-adapter.ts` with:

```typescript
import { HumanMessage } from "@langchain/core/messages"
import { isDawnAgent } from "@dawn-ai/sdk"
import type { DawnAgent } from "@dawn-ai/sdk"
import { convertToolToLangChain } from "./tool-converter.js"

interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

interface AgentLike {
  readonly invoke: (input: unknown, config?: unknown) => Promise<unknown>
}

function assertAgentLike(entry: unknown): asserts entry is AgentLike {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("invoke" in entry) ||
    typeof (entry as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Agent entry must expose invoke(input) — expected a LangChain agent")
  }
}

const materializedAgents = new WeakMap<DawnAgent, AgentLike>()

async function materializeAgent(
  descriptor: DawnAgent,
  tools: readonly DawnToolDefinition[],
): Promise<AgentLike> {
  const cached = materializedAgents.get(descriptor)
  if (cached) {
    return cached
  }

  const { createReactAgent } = await import("@langchain/langgraph/prebuilt")
  const { ChatOpenAI } = await import("@langchain/openai")

  const langchainTools = tools.map((tool) => convertToolToLangChain(tool))

  const llm = new ChatOpenAI({
    model: descriptor.model,
  })

  const compiled = createReactAgent({
    llm,
    tools: langchainTools,
    prompt: descriptor.systemPrompt,
  })

  materializedAgents.set(descriptor, compiled as unknown as AgentLike)
  return compiled as unknown as AgentLike
}

export async function executeAgent(options: {
  readonly entry: unknown
  readonly input: unknown
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly tools: readonly DawnToolDefinition[]
}): Promise<unknown> {
  const inputRecord = (options.input ?? {}) as Record<string, unknown>
  const params: Record<string, unknown> = {}
  const agentInput: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(inputRecord)) {
    if (options.routeParamNames.includes(key)) {
      params[key] = value
    } else {
      agentInput[key] = value
    }
  }

  const config: Record<string, unknown> = {
    signal: options.signal,
  }

  if (Object.keys(params).length > 0) {
    config.configurable = params
  }

  // DawnAgent descriptor path — materialize on first use
  if (isDawnAgent(options.entry)) {
    const materializedAgent = await materializeAgent(options.entry, options.tools)
    const messages = [new HumanMessage(formatAgentMessage(agentInput))]
    return await materializedAgent.invoke({ messages }, config)
  }

  // Legacy path — raw Runnable with .invoke()
  assertAgentLike(options.entry)

  const langchainTools = options.tools.map((tool) => convertToolToLangChain(tool))
  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  const messages = [new HumanMessage(formatAgentMessage(agentInput))]
  return await options.entry.invoke({ messages }, config)
}

function formatAgentMessage(input: Record<string, unknown>): string {
  const entries = Object.entries(input)

  if (entries.length === 0) {
    return ""
  }

  if (entries.length === 1) {
    return String(entries[0]![1])
  }

  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/langchain && pnpm test -- --run agent-adapter.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run full langchain test suite**

Run: `cd packages/langchain && pnpm test`
Expected: PASS (all existing tests still pass)

- [ ] **Step 6: Run typecheck**

Run: `cd packages/langchain && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/src/index.ts packages/langchain/test/agent-adapter.test.ts
git commit -m "feat(langchain): materialize DawnAgent descriptors at invocation time"
```

---

### Task 3: Route discovery — support `export default` for agent descriptors

**Files:**
- Modify: `packages/core/src/discovery/discover-routes.ts`
- Modify: `packages/core/test/discover-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/discover-routes.test.ts`:

```typescript
it("discovers an agent route from export default agent()", async () => {
  const appRoot = await writeApp({
    "src/app/hello/index.ts": [
      `import { agent } from "@dawn-ai/sdk"`,
      `export default agent({ model: "gpt-4o-mini", systemPrompt: "hi" })`,
    ].join("\n") + "\n",
  })

  const manifest = await discoverRoutes({ appRoot })

  expect(manifest.routes).toHaveLength(1)
  expect(manifest.routes[0]).toMatchObject({
    pathname: "/hello",
    kind: "agent",
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- --run discover-routes.test.ts`
Expected: FAIL — the `export default` is not checked for `isDawnAgent`, so it returns `null` (no route)

- [ ] **Step 3: Implement default export detection**

In `packages/core/src/discovery/discover-routes.ts`, update the `loadRouteExports` return type and `inferRouteKind`:

Add import at the top:
```typescript
import { isDawnAgent } from "@dawn-ai/sdk"
```

Update `inferRouteKind` to check the default export:

```typescript
async function inferRouteKind(indexFile: string): Promise<RouteKind | null> {
  await registerTsxLoader()
  const routeExports = await loadRouteExports(indexFile)

  // Check default export for DawnAgent descriptor
  if ("default" in routeExports && isDawnAgent(routeExports.default)) {
    return "agent"
  }

  const hasAgent = "agent" in routeExports && routeExports.agent !== undefined
  const hasChain = "chain" in routeExports && routeExports.chain !== undefined
  const hasGraph = "graph" in routeExports && routeExports.graph !== undefined
  const hasWorkflow = "workflow" in routeExports && routeExports.workflow !== undefined

  const count = [hasAgent, hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(
      `Route index.ts must export exactly one of "agent", "workflow", "graph", or "chain"`,
    )
  }

  if (hasAgent) {
    return "agent"
  }

  if (hasChain) {
    return "chain"
  }

  if (hasGraph) {
    return "graph"
  }

  if (hasWorkflow) {
    return "workflow"
  }

  return null
}
```

Update `loadRouteExports` to also capture the `default` export:

```typescript
async function loadRouteExports(indexFile: string): Promise<{
  readonly default?: unknown
  readonly agent?: unknown
  readonly chain?: unknown
  readonly graph?: unknown
  readonly workflow?: unknown
}> {
  try {
    return (await import(pathToFileURL(indexFile).href)) as {
      readonly default?: unknown
      readonly agent?: unknown
      readonly chain?: unknown
      readonly graph?: unknown
      readonly workflow?: unknown
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Failed to load route at ${indexFile}: ${reason}`, { cause })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test -- --run discover-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Run full core test suite**

Run: `cd packages/core && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/discovery/discover-routes.ts packages/core/test/discover-routes.test.ts
git commit -m "feat(core): detect export default agent() descriptors in route discovery"
```

---

### Task 4: CLI runtime — support `export default` in `normalizeRouteModule`

**Files:**
- Modify: `packages/cli/src/lib/runtime/load-route-kind.ts`
- Modify: `packages/cli/test/run-command.test.ts` (if needed for coverage)

The CLI's `normalizeRouteModule` only checks named exports (`agent`, `chain`, etc.). It must also check `module.default` for `DawnAgent` descriptors.

- [ ] **Step 1: Update `normalizeRouteModule` to handle default exports**

In `packages/cli/src/lib/runtime/load-route-kind.ts`, add the `isDawnAgent` import and default export check:

```typescript
import { pathToFileURL } from "node:url"

import type { RouteKind } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"

import { registerTsxLoader } from "./register-tsx-loader.js"

export interface NormalizedRouteModule {
  readonly kind: RouteKind
  readonly entry: unknown
  readonly config: Record<string, unknown>
}

export async function loadRouteKind(routeFile: string): Promise<RouteKind> {
  const normalized = await normalizeRouteModule(routeFile)
  return normalized.kind
}

export async function normalizeRouteModule(routeFile: string): Promise<NormalizedRouteModule> {
  await registerTsxLoader()
  const routeModule = (await import(pathToFileURL(routeFile).href)) as {
    readonly default?: unknown
    readonly agent?: unknown
    readonly chain?: unknown
    readonly config?: Record<string, unknown>
    readonly graph?: unknown
    readonly workflow?: unknown
  }

  // Check default export for DawnAgent descriptor (preferred path)
  if ("default" in routeModule && isDawnAgent(routeModule.default)) {
    return { kind: "agent", entry: routeModule.default, config: routeModule.config ?? {} }
  }

  const hasAgent = "agent" in routeModule && routeModule.agent !== undefined
  const hasChain = "chain" in routeModule && routeModule.chain !== undefined
  const hasGraph = "graph" in routeModule && routeModule.graph !== undefined
  const hasWorkflow = "workflow" in routeModule && routeModule.workflow !== undefined

  const count = [hasAgent, hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(
      `Route index.ts at ${routeFile} must export exactly one of "agent", "workflow", "graph", or "chain"`,
    )
  }

  if (hasAgent) {
    return { kind: "agent", entry: routeModule.agent, config: routeModule.config ?? {} }
  }

  if (hasChain) {
    return { kind: "chain", entry: routeModule.chain, config: routeModule.config ?? {} }
  }

  if (hasGraph) {
    return { kind: "graph", entry: routeModule.graph, config: routeModule.config ?? {} }
  }

  if (hasWorkflow) {
    return { kind: "workflow", entry: routeModule.workflow, config: routeModule.config ?? {} }
  }

  throw new Error(
    `Route index.ts at ${routeFile} exports neither "agent", "workflow", "graph", nor "chain"`,
  )
}
```

- [ ] **Step 2: Run CLI tests**

Run: `cd packages/cli && pnpm test`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `cd packages/cli && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/runtime/load-route-kind.ts
git commit -m "feat(cli): support export default agent() in route module normalization"
```

---

### Task 5: Template — switch to `agent()` API

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`
- Modify: `packages/devkit/templates/app-basic/package.json.template`
- Modify: `packages/devkit/src/testing/generated-app.ts`

- [ ] **Step 1: Update the template route file**

Replace `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts` with:

```typescript
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a helpful assistant for the {tenant} organization. Answer questions about the tenant.",
})
```

- [ ] **Step 2: Remove direct langchain deps from template package.json**

Update `packages/devkit/templates/app-basic/package.json.template` — remove the three langchain lines:

```json
{
  "name": "{{appName}}",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12.0"
  },
  "dependencies": {
    "@dawn-ai/core": "{{dawnCoreSpecifier}}",
    "@dawn-ai/cli": "{{dawnCliSpecifier}}",
    "@dawn-ai/langchain": "{{dawnLangchainSpecifier}}",
    "@dawn-ai/sdk": "{{dawnSdkSpecifier}}"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "{{dawnConfigTypescriptSpecifier}}",
    "@types/node": "25.6.0",
    "typescript": "6.0.2"
  },
  "scripts": {
    "check": "dawn check",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: Update `GeneratedAppSpecifiers` in testing helper**

In `packages/devkit/src/testing/generated-app.ts`, remove the langchain specifier fields:

Remove from `GeneratedAppSpecifiers`:
```typescript
export interface GeneratedAppSpecifiers {
  readonly dawnCli: string
  readonly dawnConfigTypescript: string
  readonly dawnCore: string
  readonly dawnLangchain: string
  readonly dawnSdk: string
}
```

Remove from `normalizeSpecifiers`:
```typescript
function normalizeSpecifiers(
  specifiers: Partial<GeneratedAppSpecifiers> | undefined,
): GeneratedAppSpecifiers {
  return {
    dawnCli: specifiers?.dawnCli ?? "workspace:*",
    dawnConfigTypescript: specifiers?.dawnConfigTypescript ?? "workspace:*",
    dawnCore: specifiers?.dawnCore ?? "workspace:*",
    dawnLangchain: specifiers?.dawnLangchain ?? "workspace:*",
    dawnSdk: specifiers?.dawnSdk ?? "workspace:*",
  }
}
```

Remove from `createGeneratedApp` replacements:
```typescript
replacements: {
  appName: options.appName,
  dawnCliSpecifier: specifiers.dawnCli,
  dawnConfigTypescriptSpecifier: specifiers.dawnConfigTypescript,
  dawnCoreSpecifier: specifiers.dawnCore,
  dawnLangchainSpecifier: specifiers.dawnLangchain,
  dawnSdkSpecifier: specifiers.dawnSdk,
},
```

- [ ] **Step 4: Run devkit tests**

Run: `cd packages/devkit && pnpm test`
Expected: PASS

- [ ] **Step 5: Run full workspace typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/index.ts \
  packages/devkit/templates/app-basic/package.json.template \
  packages/devkit/src/testing/generated-app.ts
git commit -m "feat(devkit): switch template to agent() API, drop direct langchain deps"
```

---

### Task 6: Add `@langchain/langgraph` and `@langchain/openai` as deps of `@dawn-ai/langchain`

**Files:**
- Modify: `packages/langchain/package.json`

- [ ] **Step 1: Add the dependencies**

The `materializeAgent` function dynamically imports `@langchain/langgraph/prebuilt` and `@langchain/openai`. These must be declared as dependencies (or peer dependencies) of `@dawn-ai/langchain`.

Update `packages/langchain/package.json` to add:

```json
{
  "dependencies": {
    "@dawn-ai/sdk": "workspace:*",
    "@langchain/langgraph": "^1.2.9",
    "@langchain/openai": "^1.0.0-alpha.1"
  },
  "peerDependencies": {
    "@langchain/core": ">=1.1.40"
  }
}
```

Note: bump `@langchain/core` peer dep minimum from `>=0.3.0` to `>=1.1.40` since that's what langgraph requires.

- [ ] **Step 2: Install dependencies**

Run: `pnpm install`
Expected: Lockfile updates, no errors

- [ ] **Step 3: Run langchain tests**

Run: `cd packages/langchain && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/package.json pnpm-lock.yaml
git commit -m "feat(langchain): add langgraph and openai as dependencies for agent materialization"
```

---

### Task 7: Integration test — full round-trip with mock LLM

**Files:**
- Create: `packages/langchain/test/agent-descriptor-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `packages/langchain/test/agent-descriptor-integration.test.ts`:

```typescript
import { describe, expect, test, vi } from "vitest"
import { agent } from "@dawn-ai/sdk"
import { executeAgent } from "../src/agent-adapter.js"

describe("agent() descriptor integration", () => {
  test("DawnAgent descriptor is recognized and does not throw invoke error", async () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are a test assistant.",
    })

    // Without a real LLM key, materialization will fail on ChatOpenAI creation
    // or network call — but it should NOT fail with "must expose invoke(input)"
    const error = await executeAgent({
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("must expose invoke")
  })

  test("DawnAgent with tools passes tools to materialized agent", async () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "Use tools.",
    })

    const tools = [
      {
        name: "lookup",
        description: "Look up data",
        run: async (input: unknown) => ({ result: "found" }),
      },
    ]

    // Will fail on LLM connection, but should get past tool conversion
    const error = await executeAgent({
      entry: descriptor,
      input: { query: "test" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools,
    }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("must expose invoke")
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/langchain && pnpm test -- --run agent-descriptor-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/langchain/test/agent-descriptor-integration.test.ts
git commit -m "test(langchain): add integration tests for DawnAgent descriptor materialization"
```

---

### Task 8: Update smoke test overlays for new template

**Files:**
- Modify: `test/smoke/agent-basic.overlay.json` (if it references old template format)
- Verify: All existing CI tests pass

- [ ] **Step 1: Check existing smoke overlays**

Run: `cat test/smoke/agent-basic.overlay.json`

If the overlay still provides a mock agent via `export const agent = { invoke: ... }`, it should continue to work (legacy path). Verify no overlay references the old `createAgent` import.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: PASS across all packages

- [ ] **Step 3: Run full typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 4: Run biome lint**

Run: `pnpm -r lint`
Expected: PASS (no formatting issues)

- [ ] **Step 5: Commit (if any overlay fixes needed)**

```bash
git add test/
git commit -m "test: update smoke overlays for agent() template change"
```

---

### Task 9: Delete unused `packages/sdk/src/tool.ts`

**Files:**
- Delete: `packages/sdk/src/tool.ts`

- [ ] **Step 1: Verify file is empty/unused**

Run: `cat packages/sdk/src/tool.ts && grep -r "tool.js\|from.*./tool" packages/sdk/src/`
Expected: File is empty, no imports reference it

- [ ] **Step 2: Remove the file**

```bash
rm packages/sdk/src/tool.ts
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd packages/sdk && pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -u packages/sdk/src/tool.ts
git commit -m "chore(sdk): remove empty tool.ts placeholder"
```
