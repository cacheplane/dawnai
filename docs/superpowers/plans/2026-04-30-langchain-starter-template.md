# Agent Route Kind & LangChain Starter Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `agent` as a fourth route kind in Dawn, update the default template to use LangChain's `createAgent()`, add auto tool injection for agent routes, and implement `dawn build` for LangGraph Platform deployment.

**Architecture:** `RouteKind` expands to `"agent" | "chain" | "graph" | "workflow"`. Discovery detects `export const agent`. A new agent adapter in `@dawn-ai/langchain` handles input splitting (route params vs. agent input) and auto tool injection. The default template ships with `createAgent()` targeting a real LLM; harness tests use overlays with mock agents for deterministic output. A new `dawn build` command generates compiled entries and a merged `langgraph.json` in `.dawn/build/`.

**Tech Stack:** TypeScript, LangChain v1 (`createAgent`), `@dawn-ai/langchain` adapter, Dawn filesystem tool discovery, `commander` (CLI)

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `packages/sdk/src/route-config.ts` | Modify | Add `"agent"` to `RouteKind` type |
| `packages/cli/src/lib/runtime/result.ts` | Modify | Add `"agent"` to `RuntimeExecutionMode` |
| `packages/cli/src/lib/runtime/route-identity.ts` | Modify | Add `"agent"` to `createRouteAssistantId` mode param |
| `packages/cli/src/lib/runtime/load-route-kind.ts` | Modify | Detect `export const agent` in `normalizeRouteModule()` |
| `packages/cli/src/lib/runtime/execute-route.ts` | Modify | Add agent branch in `invokeEntry()`, update `isBoundaryError()` |
| `packages/cli/src/lib/dev/runtime-registry.ts` | Modify | Add `"agent"` to `RuntimeRegistryEntry.mode` |
| `packages/cli/src/lib/dev/runtime-server.ts` | Modify | Add `"agent"` to `RunsWaitRequest.metadata.dawn.mode` |
| `packages/cli/src/lib/runtime/execute-route-server.ts` | Modify | Add `"agent"` to `ExecuteRouteServerOptions.mode` |
| `packages/core/src/discovery/discover-routes.ts` | Modify | Add `hasAgent` check in `inferRouteKind()` and `loadRouteExports()` |
| `packages/langchain/src/agent-adapter.ts` | Create | Agent adapter with input splitting + tool injection |
| `packages/langchain/src/index.ts` | Modify | Export `executeAgent` |
| `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts` | Modify | Replace chain with `createAgent()` export |
| `packages/devkit/templates/app-basic/package.json.template` | Modify | Add `langchain`, remove `zod` |
| `packages/create-dawn-app/src/index.ts` | Modify | Add `langchainSpecifier`, remove `zodSpecifier` |
| `packages/cli/src/commands/build.ts` | Create | `dawn build` command implementation |
| `packages/cli/src/index.ts` | Modify | Register build command |
| `test/generated/harness.ts` | Modify | Update types and basic fixture to `"agent"` mode |
| `test/generated/fixtures/basic.expected.json` | Modify | Change `kind` from `"chain"` to `"agent"` |
| `test/generated/fixtures/basic-runtime.expected.json` | Modify | Change `mode` from `"chain"` to `"agent"`, `assistant_id` suffix |
| `test/runtime/run-runtime-contract.test.ts` | Modify | Add `"agent-basic"` and `"agent-failure"` fixtures |
| `test/runtime/fixtures/agent-basic.overlay.json` | Create | Mock agent overlay for passing test |
| `test/runtime/fixtures/agent-failure.overlay.json` | Create | Mock agent overlay for failing test |
| `test/smoke/run-smoke.test.ts` | Modify | Add `"agent"` to `SmokeRouteKind`, add `"agent-basic"` fixture |
| `test/smoke/agent-basic.overlay.json` | Create | Mock agent overlay for smoke test |

---

### Task 1: Extend `RouteKind` type to include `"agent"`

**Files:**
- Modify: `packages/sdk/src/route-config.ts`
- Modify: `packages/cli/src/lib/runtime/result.ts`
- Modify: `packages/cli/src/lib/runtime/route-identity.ts`
- Modify: `packages/cli/src/lib/dev/runtime-registry.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route-server.ts`

- [ ] **Step 1: Add `"agent"` to the canonical `RouteKind` type**

In `packages/sdk/src/route-config.ts`, change:

```typescript
export type RouteKind = "agent" | "chain" | "graph" | "workflow"
```

- [ ] **Step 2: Add `"agent"` to `RuntimeExecutionMode`**

In `packages/cli/src/lib/runtime/result.ts`, change:

```typescript
export type RuntimeExecutionMode = "agent" | "chain" | "graph" | "workflow"
```

- [ ] **Step 3: Add `"agent"` to `createRouteAssistantId` mode param**

In `packages/cli/src/lib/runtime/route-identity.ts`, change:

```typescript
export function createRouteAssistantId(
  routeId: string,
  mode: "agent" | "chain" | "graph" | "workflow",
): string {
  return `${routeId}#${mode}`
}
```

- [ ] **Step 4: Add `"agent"` to `RuntimeRegistryEntry.mode`**

In `packages/cli/src/lib/dev/runtime-registry.ts`, change:

```typescript
export interface RuntimeRegistryEntry {
  readonly assistantId: string
  readonly mode: "agent" | "chain" | "graph" | "workflow"
  readonly routeId: string
  readonly routePath: string
  readonly routeFile: string
}
```

- [ ] **Step 5: Add `"agent"` to `RunsWaitRequest.metadata.dawn.mode`**

In `packages/cli/src/lib/dev/runtime-server.ts`, change the `RunsWaitRequest` interface:

```typescript
interface RunsWaitRequest {
  readonly assistant_id: string
  readonly input: unknown
  readonly metadata: {
    readonly dawn: {
      readonly mode: "agent" | "chain" | "graph" | "workflow"
      readonly route_id: string
      readonly route_path: string
    }
  }
  readonly on_completion: "delete"
}
```

- [ ] **Step 6: Add `"agent"` to `ExecuteRouteServerOptions.mode`**

In `packages/cli/src/lib/runtime/execute-route-server.ts`, change:

```typescript
export interface ExecuteRouteServerOptions {
  readonly appRoot: string
  readonly baseUrl: string
  readonly input: unknown
  readonly mode: "agent" | "chain" | "graph" | "workflow"
  readonly routeId: string
  readonly routePath: string
  readonly timeoutMs?: number
}
```

- [ ] **Step 7: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/sdk typecheck && pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS — all literal union types now include `"agent"`

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/route-config.ts packages/cli/src/lib/runtime/result.ts packages/cli/src/lib/runtime/route-identity.ts packages/cli/src/lib/dev/runtime-registry.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/runtime/execute-route-server.ts
git commit -m "feat: add agent to RouteKind and all mode union types"
```

---

### Task 2: Update route discovery to detect `export const agent`

**Files:**
- Modify: `packages/core/src/discovery/discover-routes.ts`
- Modify: `packages/cli/src/lib/runtime/load-route-kind.ts`

- [ ] **Step 1: Add `agent` to `inferRouteKind()` in core discovery**

In `packages/core/src/discovery/discover-routes.ts`, update `inferRouteKind()`:

```typescript
async function inferRouteKind(indexFile: string): Promise<RouteKind | null> {
  await registerTsxLoader()
  const routeExports = await loadRouteExports(indexFile)
  const hasAgent = "agent" in routeExports && routeExports.agent !== undefined
  const hasChain = "chain" in routeExports && routeExports.chain !== undefined
  const hasGraph = "graph" in routeExports && routeExports.graph !== undefined
  const hasWorkflow = "workflow" in routeExports && routeExports.workflow !== undefined

  const count = [hasAgent, hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(`Route index.ts must export exactly one of "agent", "workflow", "graph", or "chain"`)
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

- [ ] **Step 2: Add `agent` to `loadRouteExports()` return type**

In the same file, update `loadRouteExports()`:

```typescript
async function loadRouteExports(indexFile: string): Promise<{
  readonly agent?: unknown
  readonly chain?: unknown
  readonly graph?: unknown
  readonly workflow?: unknown
}> {
  try {
    return (await import(pathToFileURL(indexFile).href)) as {
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

- [ ] **Step 3: Add `agent` to `normalizeRouteModule()` in CLI**

In `packages/cli/src/lib/runtime/load-route-kind.ts`, update:

```typescript
export async function normalizeRouteModule(routeFile: string): Promise<NormalizedRouteModule> {
  await registerTsxLoader()
  const routeModule = (await import(pathToFileURL(routeFile).href)) as {
    readonly agent?: unknown
    readonly chain?: unknown
    readonly config?: Record<string, unknown>
    readonly graph?: unknown
    readonly workflow?: unknown
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

  throw new Error(`Route index.ts at ${routeFile} exports neither "agent", "workflow", "graph", nor "chain"`)
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/discovery/discover-routes.ts packages/cli/src/lib/runtime/load-route-kind.ts
git commit -m "feat: detect export const agent in route discovery"
```

---

### Task 3: Add agent execution branch in `invokeEntry()`

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Update `invokeEntry()` kind param and add agent branch**

In `packages/cli/src/lib/runtime/execute-route.ts`, update `invokeEntry()`:

```typescript
async function invokeEntry(
  kind: "agent" | "chain" | "graph" | "workflow",
  entry: unknown,
  input: unknown,
  context: unknown,
): Promise<unknown> {
  if (kind === "agent") {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "invoke" in entry &&
      typeof (entry as { invoke?: unknown }).invoke === "function"
    ) {
      return await (entry as { invoke: (input: unknown) => unknown }).invoke(input)
    }
    throw new Error("Agent entry must expose invoke(input)")
  }

  if (kind === "workflow") {
    if (typeof entry !== "function") {
      throw new Error("Workflow entry must be a function")
    }
    return await entry(input, context)
  }

  if (kind === "chain") {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "invoke" in entry &&
      typeof (entry as { invoke?: unknown }).invoke === "function"
    ) {
      return await (entry as { invoke: (input: unknown) => unknown }).invoke(input)
    }
    throw new Error("Chain entry must expose invoke(input)")
  }

  if (typeof entry === "function") {
    return await entry(input, context)
  }

  if (
    typeof entry === "object" &&
    entry !== null &&
    "invoke" in entry &&
    typeof (entry as { invoke?: unknown }).invoke === "function"
  ) {
    return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
      input,
      context,
    )
  }

  throw new Error("Graph entry must be a function or expose invoke(input)")
}
```

- [ ] **Step 2: Update `isBoundaryError()` to include agent error message**

In the same file, update `isBoundaryError()`:

```typescript
function isBoundaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    /must export exactly one of/.test(error.message) ||
    /exports neither/.test(error.message) ||
    error.message === "Workflow entry must be a function" ||
    error.message === "Graph entry must be a function or expose invoke(input)" ||
    error.message === "Chain entry must expose invoke(input)" ||
    error.message === "Agent entry must expose invoke(input)"
  )
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat: add agent execution branch in invokeEntry"
```

---

### Task 4: Create agent adapter in `@dawn-ai/langchain`

**Files:**
- Create: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/src/index.ts`

- [ ] **Step 1: Create `agent-adapter.ts` with input splitting and tool injection**

Create `packages/langchain/src/agent-adapter.ts`:

```typescript
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

export async function executeAgent(options: {
  readonly entry: unknown
  readonly input: unknown
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly tools: readonly DawnToolDefinition[]
}): Promise<unknown> {
  assertAgentLike(options.entry)

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

  const langchainTools = options.tools.map((tool) => convertToolToLangChain(tool))

  const config: Record<string, unknown> = {
    signal: options.signal,
  }

  if (Object.keys(params).length > 0) {
    config.configurable = params
  }

  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  return await options.entry.invoke(agentInput, config)
}
```

- [ ] **Step 2: Export `executeAgent` from index**

In `packages/langchain/src/index.ts`, add the export:

```typescript
export { executeAgent } from "./agent-adapter.js"
export { chainAdapter } from "./chain-adapter.js"
export { convertToolToLangChain } from "./tool-converter.js"
export { executeWithToolLoop } from "./tool-loop.js"
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/langchain typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/src/index.ts
git commit -m "feat: add agent adapter with input splitting and tool injection"
```

---

### Task 5: Wire agent adapter into `execute-route.ts` with route param flow

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

This task replaces the simple agent branch from Task 3 with the full adapter integration that handles input splitting and tool injection.

- [ ] **Step 1: Add `executeAgent` import**

In `packages/cli/src/lib/runtime/execute-route.ts`, add at the top with other imports:

```typescript
import { executeAgent } from "@dawn-ai/langchain"
```

- [ ] **Step 2: Pass `routeId` to `invokeEntry()` for param name extraction**

Update the call to `invokeEntry()` inside `executeRouteAtResolvedPath()` to pass `routeId`:

```typescript
    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context, {
      routeId: options.routeId,
      signal: options.signal,
      tools,
    })
```

- [ ] **Step 3: Update `invokeEntry()` signature and agent branch**

```typescript
async function invokeEntry(
  kind: "agent" | "chain" | "graph" | "workflow",
  entry: unknown,
  input: unknown,
  context: unknown,
  agentContext?: {
    readonly routeId: string
    readonly signal?: AbortSignal
    readonly tools: readonly import("./tool-discovery.js").DiscoveredToolDefinition[]
  },
): Promise<unknown> {
  if (kind === "agent") {
    const routeParamNames = extractRouteParamNames(agentContext?.routeId ?? "")
    return await executeAgent({
      entry,
      input,
      routeParamNames,
      signal: agentContext?.signal ?? new AbortController().signal,
      tools: agentContext?.tools ?? [],
    })
  }

  if (kind === "workflow") {
    if (typeof entry !== "function") {
      throw new Error("Workflow entry must be a function")
    }
    return await entry(input, context)
  }

  if (kind === "chain") {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "invoke" in entry &&
      typeof (entry as { invoke?: unknown }).invoke === "function"
    ) {
      return await (entry as { invoke: (input: unknown) => unknown }).invoke(input)
    }
    throw new Error("Chain entry must expose invoke(input)")
  }

  if (typeof entry === "function") {
    return await entry(input, context)
  }

  if (
    typeof entry === "object" &&
    entry !== null &&
    "invoke" in entry &&
    typeof (entry as { invoke?: unknown }).invoke === "function"
  ) {
    return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
      input,
      context,
    )
  }

  throw new Error("Graph entry must be a function or expose invoke(input)")
}

function extractRouteParamNames(routeId: string): string[] {
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  return [...matches].map((match) => match[1])
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat: wire agent adapter into execute-route with input splitting"
```

---

### Task 6: Update default template to use agent route kind

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`
- Modify: `packages/devkit/templates/app-basic/package.json.template`
- Modify: `packages/create-dawn-app/src/index.ts`

- [ ] **Step 1: Replace template `index.ts` with `createAgent()` export**

Replace `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts` with:

```typescript
import { createAgent } from "langchain"

export const agent = createAgent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant for the {tenant} organization ({plan} plan). Answer questions about the tenant.",
})
```

- [ ] **Step 2: Update `package.json.template` — add `langchain`, remove `zod`**

Replace `packages/devkit/templates/app-basic/package.json.template` with:

```json
{
  "name": "{{appName}}",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "dawn check",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dawn-ai/core": "{{dawnCoreSpecifier}}",
    "@dawn-ai/cli": "{{dawnCliSpecifier}}",
    "@dawn-ai/langchain": "{{dawnLangchainSpecifier}}",
    "@dawn-ai/sdk": "{{dawnSdkSpecifier}}",
    "@langchain/core": "{{langchainCoreSpecifier}}",
    "@langchain/openai": "{{langchainOpenaiSpecifier}}",
    "langchain": "{{langchainSpecifier}}"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "{{dawnConfigTypescriptSpecifier}}",
    "@types/node": "25.6.0",
    "typescript": "6.0.2"
  }
}
```

- [ ] **Step 3: Update `createTemplateReplacements()` in `create-dawn-app`**

In `packages/create-dawn-app/src/index.ts`, update the return type and both return statements in `createTemplateReplacements()`:

Change the return type to:
```typescript
function createTemplateReplacements(
  appRoot: string,
  options: CliOptions,
): {
  readonly appName: string
  readonly dawnCliSpecifier: string
  readonly dawnConfigTypescriptSpecifier: string
  readonly dawnCoreSpecifier: string
  readonly dawnLangchainSpecifier: string
  readonly dawnLanggraphSpecifier: string
  readonly dawnSdkSpecifier: string
  readonly langchainCoreSpecifier: string
  readonly langchainOpenaiSpecifier: string
  readonly langchainSpecifier: string
}
```

In the `internal` mode return, replace `zodSpecifier` with:
```typescript
      langchainSpecifier: "0.3.14",
```

In the `external` mode return, replace `zodSpecifier` with:
```typescript
    langchainSpecifier: "0.3.14",
```

Remove `zodSpecifier` from both returns entirely.

- [ ] **Step 4: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/create-dawn-app typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/index.ts packages/devkit/templates/app-basic/package.json.template packages/create-dawn-app/src/index.ts
git commit -m "feat: update default template to use createAgent with agent route kind"
```

---

### Task 7: Update generated harness test fixtures for agent route kind

**Files:**
- Modify: `test/generated/harness.ts`
- Modify: `test/generated/fixtures/basic.expected.json`
- Modify: `test/generated/fixtures/basic-runtime.expected.json`

- [ ] **Step 1: Update `RuntimeFixtureSpec.mode` type in harness**

In `test/generated/harness.ts`, find the `RuntimeFixtureSpec` interface and update the `mode` field:

```typescript
  readonly mode: "agent" | "chain" | "graph" | "workflow"
```

- [ ] **Step 2: Update `GeneratedRuntimeScenarioResult` mode type**

In the same file, find `GeneratedRuntimeScenarioResult` and update:

```typescript
      readonly mode: "agent" | "chain" | "graph" | "workflow"
```

- [ ] **Step 3: Update the `basic` fixture spec to use `"agent"` mode**

In the `runtimeFixtures` object, change the `basic` entry's `mode`:

```typescript
  basic: {
    expectedFixturePath: join(FIXTURE_ROOT, "basic-runtime.expected.json"),
    fixtureName: "basic",
    input: {
      tenant: "basic-tenant",
    },
    mode: "agent",
    routeDir: "src/app/(public)/hello/[tenant]",
    routeId: "/hello/[tenant]",
    routePath: "src/app/(public)/hello/[tenant]/index.ts",
    scenarioNames: {
      inProcess: "basic in-process scenario",
      server: "basic server scenario",
    },
    source: "generated",
  },
```

- [ ] **Step 4: Update `basic.expected.json` fixture**

In `test/generated/fixtures/basic.expected.json`, change the route kind:

```json
        "kind": "agent",
```

Also remove `"zod": "3.24.4"` from `packageJson.dependencies` and add `"langchain": "0.3.14"`.

- [ ] **Step 5: Update `basic-runtime.expected.json` fixture**

In `test/generated/fixtures/basic-runtime.expected.json`, update all `"chain"` references to `"agent"`:

- `runJson.mode`: `"chain"` → `"agent"`
- `runServerJson.mode`: `"chain"` → `"agent"`
- `serverRequest.assistant_id`: `"/hello/[tenant]#chain"` → `"/hello/[tenant]#agent"`
- `serverRequest.metadata.dawn.mode`: `"chain"` → `"agent"`

The output shape will also change since the agent route produces different output than the chain. Update to match whatever the mock agent overlay returns. For now, keep the same output shape — the overlay in Task 8 will define the actual expected values.

- [ ] **Step 6: Commit**

```bash
git add test/generated/harness.ts test/generated/fixtures/basic.expected.json test/generated/fixtures/basic-runtime.expected.json
git commit -m "test: update generated harness fixtures for agent route kind"
```

---

### Task 8: Add agent overlay fixtures for runtime and smoke tests

**Files:**
- Create: `test/runtime/fixtures/agent-basic.overlay.json`
- Create: `test/runtime/fixtures/agent-failure.overlay.json`
- Modify: `test/runtime/run-runtime-contract.test.ts`
- Create: `test/smoke/agent-basic.overlay.json`
- Modify: `test/smoke/run-smoke.test.ts`

- [ ] **Step 1: Create `agent-basic.overlay.json` for runtime tests**

Create `test/runtime/fixtures/agent-basic.overlay.json`:

```json
{
  "files": {
    "src/app/(public)/hello/[tenant]/index.ts": "export const agent = {\n  async invoke(input) {\n    return {\n      greeting: `Hello from agent, ${input.tenant || \"unknown\"}!`,\n      tenant: input.tenant || \"unknown\",\n    };\n  },\n};\n"
  },
  "input": {
    "tenant": "agent-tenant"
  },
  "routeFile": "src/app/(public)/hello/[tenant]/index.ts",
  "expected": {
    "mode": "agent",
    "output": {
      "greeting": "Hello from agent, agent-tenant!",
      "tenant": "agent-tenant"
    },
    "status": "passed"
  }
}
```

- [ ] **Step 2: Create `agent-failure.overlay.json` for runtime tests**

Create `test/runtime/fixtures/agent-failure.overlay.json`:

```json
{
  "files": {
    "src/app/(public)/hello/[tenant]/index.ts": "export const agent = {\n  async invoke(input) {\n    throw new Error(`Agent execution failed for ${input.tenant || \"unknown\"}`);\n  },\n};\n"
  },
  "input": {
    "tenant": "agent-tenant"
  },
  "routeFile": "src/app/(public)/hello/[tenant]/index.ts",
  "expected": {
    "error": {
      "kind": "execution_error",
      "message": "Agent execution failed for agent-tenant"
    },
    "mode": "agent",
    "status": "failed"
  }
}
```

- [ ] **Step 3: Add `"agent-basic"` and `"agent-failure"` to runtime test `RuntimeFixtureName`**

In `test/runtime/run-runtime-contract.test.ts`, update:

```typescript
type RuntimeFixtureName = "agent-basic" | "agent-failure" | "graph-basic" | "graph-failure" | "workflow-basic" | "workflow-failure"
```

- [ ] **Step 4: Add runtime test cases for agent**

Add two new test cases in the `describe("runtime contract harness")` block, following the exact pattern of the existing graph-basic and graph-failure tests:

```typescript
  test("executes passing agent fixture through direct runtime primitive", {
    timeout: 180_000,
  }, async () => {
    const result = await runRuntimeScenario("agent-basic")

    expect(result).toMatchObject({
      failureReason: null,
      lane: "runtime",
      name: "agent-basic",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "execute-direct",
      "execute-cli",
      "execute-cli-dev-server",
    ])
    await expectRuntimeParityArtifacts(result, "agent-basic")
  })

  test("executes failing agent fixture through direct runtime primitive", {
    timeout: 180_000,
  }, async () => {
    const result = await runRuntimeScenario("agent-failure")

    expect(result).toMatchObject({
      failureReason: null,
      lane: "runtime",
      name: "agent-failure",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "execute-direct",
      "execute-cli",
      "execute-cli-dev-server",
    ])
    await expectRuntimeParityArtifacts(result, "agent-failure")
  })
```

- [ ] **Step 5: Create `agent-basic.overlay.json` for smoke tests**

Create `test/smoke/agent-basic.overlay.json`:

```json
{
  "deleteFiles": ["src/app/(public)/hello/[tenant]/tools/greet.ts"],
  "files": {
    "src/app/(public)/hello/[tenant]/index.ts": "export const agent = {\n  async invoke(input) {\n    return {\n      greeting: `Hello from agent, ${input.tenant || \"unknown\"}!`,\n      tenant: input.tenant || \"unknown\",\n    };\n  },\n};\n"
  },
  "input": {
    "tenant": "agent-tenant"
  },
  "kind": "agent"
}
```

- [ ] **Step 6: Add `"agent"` to smoke test types and new test case**

In `test/smoke/run-smoke.test.ts`, update:

```typescript
type SmokeRouteKind = "agent" | "chain" | "graph" | "workflow"
type SmokeFixtureName = "agent-basic" | "graph-basic" | "workflow-basic"
```

Add a new test case:

```typescript
  test("boots the agent fixture and executes one canonical flow", {
    timeout: 180_000,
  }, async () => {
    const result = await runSmokeScenario("agent-basic")
    const output = await readSmokeOutput(result)

    expect(result).toMatchObject({
      failureReason: null,
      lane: "smoke",
      name: "agent-basic",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "discover-routes",
      "typecheck",
      "compile",
      "execute",
    ])
    expect(output).toEqual({
      greeting: "Hello from agent, agent-tenant!",
      tenant: "agent-tenant",
    })
    await expect(stat(result.transcriptPath)).resolves.toBeDefined()
  })
```

- [ ] **Step 7: Commit**

```bash
git add test/runtime/fixtures/agent-basic.overlay.json test/runtime/fixtures/agent-failure.overlay.json test/runtime/run-runtime-contract.test.ts test/smoke/agent-basic.overlay.json test/smoke/run-smoke.test.ts
git commit -m "test: add agent overlay fixtures for runtime and smoke harnesses"
```

---

### Task 9: Implement `dawn build` command

**Files:**
- Create: `packages/cli/src/commands/build.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Create `build.ts` command**

Create `packages/cli/src/commands/build.ts`:

```typescript
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import type { Command } from "commander"

import { discoverRoutes } from "@dawn-ai/core"
import { type CommandIo, writeLine } from "../lib/output.js"
import { discoverToolDefinitions } from "../lib/runtime/tool-discovery.js"

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

  const buildDir = resolve(manifest.appRoot, ".dawn", "build")

  if (options.clean) {
    await rm(buildDir, { recursive: true, force: true })
  }

  await mkdir(buildDir, { recursive: true })

  const graphs: Record<string, string> = {}

  for (const route of manifest.routes) {
    const tools = await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })

    const entryFileName = route.id
      .replace(/^\//, "")
      .replace(/\//g, "-")
      .replace(/\[/g, "")
      .replace(/\]/g, "")

    const entryFilePath = join(buildDir, `${entryFileName}.ts`)
    const relativeRoutePath = relative(dirname(entryFilePath), route.routeDir)
    const routeImportPath = `${relativeRoutePath}/index.js`

    let entryContent: string

    if (route.kind === "agent" && tools.length > 0) {
      const toolImports = tools.map((tool) => {
        const relToolPath = relative(dirname(entryFilePath), dirname(tool.filePath))
        const toolFileName = tool.filePath.split("/").pop()?.replace(/\.ts$/, ".js") ?? `${tool.name}.js`
        return `import ${tool.name} from "${relToolPath}/${toolFileName}"`
      })

      const toolBindings = tools.map((tool) =>
        `const ${tool.name}Tool = tool(${tool.name}, {\n  name: "${tool.name}",\n  description: "${tool.description ?? ""}",\n  schema: z.record(z.string(), z.unknown()),\n})`
      )

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

  const mergedConfig = {
    ...userConfig,
    graphs,
  }

  const outputLanggraphPath = join(buildDir, "langgraph.json")
  await writeFile(outputLanggraphPath, JSON.stringify(mergedConfig, null, 2) + "\n", "utf8")

  writeLine(io.stdout, `Build complete: ${relative(process.cwd(), buildDir)}`)
  writeLine(io.stdout, `  ${Object.keys(graphs).length} route(s) compiled`)
  writeLine(io.stdout, `  langgraph.json written to ${relative(process.cwd(), outputLanggraphPath)}`)
}
```

- [ ] **Step 2: Register the build command in CLI entry**

In `packages/cli/src/index.ts`, add the import and registration:

```typescript
import { registerBuildCommand } from "./commands/build.js"
```

Add the registration call after `registerCheckCommand`:

```typescript
  registerBuildCommand(program, io)
  registerCheckCommand(program, io)
  registerDevCommand(program, io)
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/build.ts packages/cli/src/index.ts
git commit -m "feat: implement dawn build command for LangGraph Platform deployment"
```

---

### Task 10: Run full test suite and fix issues

**Files:**
- Various — depends on what breaks

- [ ] **Step 1: Run typecheck across all packages**

Run: `pnpm -r typecheck`
Expected: PASS (fix any type errors)

- [ ] **Step 2: Run unit tests**

Run: `pnpm -r test`
Expected: PASS (fix any failing tests)

- [ ] **Step 3: Run generated harness test**

Run: `pnpm --filter ./test/generated test`
Expected: PASS — the basic fixture should now discover kind `"agent"` and match updated expected JSON

- [ ] **Step 4: Run runtime harness tests**

Run: `pnpm --filter ./test/runtime test`
Expected: PASS — agent-basic and agent-failure overlays should execute correctly

- [ ] **Step 5: Run smoke harness tests**

Run: `pnpm --filter ./test/smoke test`
Expected: PASS — agent-basic overlay should boot, discover, typecheck, compile, and execute

- [ ] **Step 6: Fix any failures**

Address test failures. Common issues:
- Template fixture mismatch — update expected JSON to match new template shape
- Overlay file content issues — ensure mock agent `invoke()` returns the right shape
- Import resolution — ensure `@dawn-ai/langchain` is packed in harness test setup

- [ ] **Step 7: Commit fixes**

```bash
git add -A
git commit -m "fix: address test suite failures after agent route kind integration"
```

---

### Task 11: Final cleanup and verification

**Files:**
- `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts` (if regeneration needed)

- [ ] **Step 1: Verify `dawn.generated.d.ts` is consistent**

Read the current `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts`. The route path and tools are unchanged (`/hello/[tenant]` with `greet` tool), so this file should not need changes. Verify.

- [ ] **Step 2: Run the full CI check locally**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: All green

- [ ] **Step 3: Verify `dawn build` works against the template**

Create a temp app and run build:
```bash
cd /tmp && npx create-dawn-app test-build-app --mode internal
cd test-build-app && pnpm install && npx dawn build
ls -la .dawn/build/
cat .dawn/build/langgraph.json
```

Expected: `.dawn/build/` contains compiled entry file and merged `langgraph.json`

- [ ] **Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: final cleanup for agent route kind"
```
