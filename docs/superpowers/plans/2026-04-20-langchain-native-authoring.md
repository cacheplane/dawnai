# LangChain-Native Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LangChain LCEL runnables as a second execution backend, proving Dawn is a meta-framework. Introduce `BackendAdapter` interface, `@dawnai.org/langchain` package, `@dawnai.org/vite-plugin` for build-time schema inference, and SSE streaming in `dawn dev`.

**Architecture:** `@dawnai.org/sdk` gains a `BackendAdapter` type. The CLI owns route discovery for all kinds (`graph`, `workflow`, `chain`). `@dawnai.org/langchain` provides a thin adapter that handles `.invoke()` / `.stream()` on LCEL runnables, auto-binds Dawn-discovered tools, and runs a Dawn-owned tool execution loop. `@dawnai.org/vite-plugin` infers Zod schemas from TypeScript function signatures at build time. Streaming uses NDJSON for `dawn run` and SSE for `dawn dev`.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, `@langchain/core`, Vite plugin API, TypeScript Compiler API, Zod

---

## File Structure

### New packages

| Package | Path | Responsibility |
|---------|------|----------------|
| `@dawnai.org/langchain` | `packages/langchain/` | BackendAdapter for `chain` routes, tool converter |
| `@dawnai.org/vite-plugin` | `packages/vite-plugin/` | Build-time TS→Zod schema inference for tools |

### New files

| File | Responsibility |
|------|----------------|
| `packages/sdk/src/backend-adapter.ts` | `BackendAdapter` interface type |
| `packages/langchain/package.json` | Package manifest with `@langchain/core` peer dep |
| `packages/langchain/tsconfig.json` | TypeScript config |
| `packages/langchain/vitest.config.ts` | Test config |
| `packages/langchain/src/index.ts` | Public exports |
| `packages/langchain/src/chain-adapter.ts` | BackendAdapter implementation |
| `packages/langchain/src/tool-converter.ts` | Dawn tools → LangChain DynamicStructuredTool |
| `packages/langchain/src/tool-loop.ts` | Dawn-owned ReAct-style tool execution loop |
| `packages/langchain/test/chain-adapter.test.ts` | Adapter tests |
| `packages/langchain/test/tool-converter.test.ts` | Tool conversion tests |
| `packages/langchain/test/tool-loop.test.ts` | Tool loop tests |
| `packages/vite-plugin/package.json` | Package manifest |
| `packages/vite-plugin/tsconfig.json` | TypeScript config |
| `packages/vite-plugin/vitest.config.ts` | Test config |
| `packages/vite-plugin/src/index.ts` | Vite plugin entry |
| `packages/vite-plugin/src/type-extractor.ts` | TS compiler API → type info |
| `packages/vite-plugin/src/zod-generator.ts` | Type info → Zod schema code string |
| `packages/vite-plugin/src/jsdoc-extractor.ts` | JSDoc → descriptions |
| `packages/vite-plugin/test/type-extractor.test.ts` | Type extractor tests |
| `packages/vite-plugin/test/zod-generator.test.ts` | Zod generator tests |
| `packages/vite-plugin/test/jsdoc-extractor.test.ts` | JSDoc extractor tests |
| `packages/vite-plugin/test/plugin.test.ts` | Integration tests |
| `packages/cli/src/lib/runtime/backend-adapters.ts` | Adapter registry and dispatch |
| `packages/cli/src/lib/runtime/stream-types.ts` | Streaming chunk type definitions |

### Modified files

| File | Change |
|------|--------|
| `packages/sdk/src/route-config.ts` | Add `"chain"` to `RouteKind` |
| `packages/sdk/src/index.ts` | Add `BackendAdapter` re-export |
| `packages/core/src/discovery/discover-routes.ts` | Add `chain` to `inferRouteKind()` and `loadRouteExports()` |
| `packages/cli/src/lib/runtime/execute-route.ts` | Replace `normalizeRouteModule` + `invokeEntry` with adapter dispatch |
| `packages/cli/src/lib/runtime/load-route-kind.ts` | CLI-owned normalization replacing `@dawnai.org/langgraph` import |
| `packages/cli/src/lib/runtime/result.ts` | Expand `RuntimeExecutionMode` to include `"chain"` |
| `packages/cli/src/lib/runtime/tool-discovery.ts` | Add optional `schema` field to `DiscoveredToolDefinition` |
| `packages/cli/src/lib/dev/runtime-server.ts` | Add SSE streaming endpoint |
| `packages/cli/src/lib/dev/runtime-registry.ts` | Expand mode type to include `"chain"` |
| `packages/cli/src/commands/run.ts` | Wire streaming NDJSON for `dawn run` |
| `packages/cli/package.json` | Add `@dawnai.org/langchain` dependency |
| `packages/cli/vitest.config.ts` | Add `@dawnai.org/langchain` alias |
| `packages/langgraph/src/index.ts` | Export `BackendAdapter` implementation |
| `packages/langgraph/src/langgraph-adapter.ts` | New file: BackendAdapter wrapping existing logic |

---

### Task 1: Expand `RouteKind` and `BackendAdapter` in `@dawnai.org/sdk`

**Files:**
- Modify: `packages/sdk/src/route-config.ts`
- Create: `packages/sdk/src/backend-adapter.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Add `"chain"` to `RouteKind`**

In `packages/sdk/src/route-config.ts`, change line 1:

```typescript
export type RouteKind = "chain" | "graph" | "workflow"
```

- [ ] **Step 2: Create `BackendAdapter` interface**

Create `packages/sdk/src/backend-adapter.ts`:

```typescript
import type { RouteKind } from "./route-config.js"

export interface BackendAdapter {
  readonly kind: RouteKind
  execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>
  stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): AsyncIterable<unknown>
}
```

- [ ] **Step 3: Re-export from `index.ts`**

Replace `packages/sdk/src/index.ts` with:

```typescript
export type { BackendAdapter } from "./backend-adapter.js"
export type { RouteConfig, RouteKind } from "./route-config.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @dawnai.org/sdk exec tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run SDK tests**

Run: `pnpm --filter @dawnai.org/sdk test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/backend-adapter.ts packages/sdk/src/route-config.ts packages/sdk/src/index.ts
git commit -m "feat: add BackendAdapter interface and chain route kind to @dawnai.org/sdk"
```

---

### Task 2: Update route discovery to recognize `chain` exports

**Files:**
- Modify: `packages/core/src/discovery/discover-routes.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/discover-routes-chain.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { discoverRoutes } from "@dawnai.org/core"
import { join } from "node:path"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

describe("chain route discovery", () => {
  let appRoot: string

  test("discovers a route with a chain export", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "dawn-chain-"))
    await mkdir(join(appRoot, "src", "app", "hello"), { recursive: true })
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      "export default {}",
    )
    await writeFile(
      join(appRoot, "src", "app", "hello", "index.ts"),
      "export const chain = { invoke: async () => ({}) }",
    )

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(1)
    expect(manifest.routes[0]).toMatchObject({
      kind: "chain",
      pathname: "/hello",
    })

    await rm(appRoot, { recursive: true, force: true })
  })

  test("rejects route exporting both chain and graph", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "dawn-chain-"))
    await mkdir(join(appRoot, "src", "app", "hello"), { recursive: true })
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      "export default {}",
    )
    await writeFile(
      join(appRoot, "src", "app", "hello", "index.ts"),
      "export const chain = {}; export const graph = {}",
    )

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      /must export exactly one of/,
    )

    await rm(appRoot, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawnai.org/core exec vitest run test/discover-routes-chain.test.ts`
Expected: FAIL — `chain` not recognized, route has 0 entries

- [ ] **Step 3: Update `inferRouteKind` to recognize `chain`**

In `packages/core/src/discovery/discover-routes.ts`, replace `inferRouteKind` (lines 93-112) with:

```typescript
async function inferRouteKind(indexFile: string): Promise<RouteKind | null> {
  await registerTsxLoader()
  const routeExports = await loadRouteExports(indexFile)
  const hasChain = "chain" in routeExports && routeExports.chain !== undefined
  const hasGraph = "graph" in routeExports && routeExports.graph !== undefined
  const hasWorkflow = "workflow" in routeExports && routeExports.workflow !== undefined

  const count = [hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(`Route index.ts must export exactly one of "workflow", "graph", or "chain"`)
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

- [ ] **Step 4: Update `loadRouteExports` return type**

In the same file, replace `loadRouteExports` (lines 114-127) with:

```typescript
async function loadRouteExports(indexFile: string): Promise<{
  readonly chain?: unknown
  readonly graph?: unknown
  readonly workflow?: unknown
}> {
  try {
    return (await import(pathToFileURL(indexFile).href)) as {
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

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dawnai.org/core exec vitest run test/discover-routes-chain.test.ts`
Expected: PASS

- [ ] **Step 6: Run all core tests**

Run: `pnpm --filter @dawnai.org/core test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/discovery/discover-routes.ts packages/core/test/discover-routes-chain.test.ts
git commit -m "feat: recognize chain as a valid route export in discovery"
```

---

### Task 3: CLI-owned route normalization (replace `normalizeRouteModule` import)

**Files:**
- Modify: `packages/cli/src/lib/runtime/load-route-kind.ts`
- Modify: `packages/cli/src/lib/runtime/result.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Expand `RuntimeExecutionMode` in `result.ts`**

In `packages/cli/src/lib/runtime/result.ts`, change line 1:

```typescript
export type RuntimeExecutionMode = "chain" | "graph" | "workflow"
```

- [ ] **Step 2: Rewrite `load-route-kind.ts` to be CLI-owned**

Replace the entire contents of `packages/cli/src/lib/runtime/load-route-kind.ts` with:

```typescript
import { pathToFileURL } from "node:url"

import type { RouteKind } from "@dawnai.org/sdk"

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
    readonly chain?: unknown
    readonly config?: Record<string, unknown>
    readonly graph?: unknown
    readonly workflow?: unknown
  }

  const hasChain = "chain" in routeModule && routeModule.chain !== undefined
  const hasGraph = "graph" in routeModule && routeModule.graph !== undefined
  const hasWorkflow = "workflow" in routeModule && routeModule.workflow !== undefined

  const count = [hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(
      `Route index.ts at ${routeFile} must export exactly one of "workflow", "graph", or "chain"`,
    )
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
    `Route index.ts at ${routeFile} exports neither "workflow", "graph", nor "chain"`,
  )
}
```

- [ ] **Step 3: Update `execute-route.ts` to use CLI-owned normalization**

In `packages/cli/src/lib/runtime/execute-route.ts`:

Replace the imports (lines 1-17) with:

```typescript
import { isAbsolute, resolve } from "node:path"

import { findDawnApp } from "@dawnai.org/core"
import { createDawnContext } from "./dawn-context.js"
import { normalizeRouteModule } from "./load-route-kind.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"
import { discoverToolDefinitions } from "./tool-discovery.js"
import { fileExists } from "./utils.js"
```

Replace `executeRouteAtResolvedPath` (lines 103-157) with:

```typescript
async function executeRouteAtResolvedPath(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
  readonly startedAt: number
}): Promise<RuntimeExecutionResult> {
  const routeDir = resolve(options.routeFile, "..")
  let mode: RuntimeExecutionMode | null = null

  try {
    const normalized = await normalizeRouteModule(options.routeFile)
    mode = normalized.kind

    const tools = await discoverToolDefinitions({
      appRoot: options.appRoot,
      routeDir,
    })

    const context = createDawnContext({
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context)

    return createRuntimeSuccessResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      mode: normalized.kind,
      output,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  } catch (error) {
    const kind = isBoundaryError(error) ? "unsupported_route_boundary" : "execution_error"
    const message = rewriteNeitherExportMessage(error, options.routeFile)

    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind,
      message,
      mode,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }
}
```

Remove the `registerTsxLoader()` call and `import(pathToFileURL(...))` from `executeRouteAtResolvedPath` since `normalizeRouteModule` handles both.

Update `rewriteNeitherExportMessage` (lines 159-168) to also match the new message:

```typescript
function rewriteNeitherExportMessage(error: unknown, routeFile: string): string {
  if (
    error instanceof Error &&
    (error.message === `Route index.ts exports neither "workflow" nor "graph"` ||
      error.message === `Route index.ts exports neither "workflow", "graph", nor "chain"`)
  ) {
    return `Route index.ts at ${routeFile} exports neither "workflow", "graph", nor "chain"`
  }

  return formatErrorMessage(error)
}
```

Update `invokeEntry` (lines 170-200) to handle `chain`:

```typescript
async function invokeEntry(
  kind: "chain" | "graph" | "workflow",
  entry: unknown,
  input: unknown,
  context: unknown,
): Promise<unknown> {
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

Update `isBoundaryError` (lines 248-259) to include chain errors:

```typescript
function isBoundaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message === `Route index.ts must export exactly one of "workflow" or "graph"` ||
    error.message === `Route index.ts exports neither "workflow" nor "graph"` ||
    /must export exactly one of/.test(error.message) ||
    /exports neither/.test(error.message) ||
    error.message === "Workflow entry must be a function" ||
    error.message === "Graph entry must be a function or expose invoke(input)" ||
    error.message === "Chain entry must expose invoke(input)"
  )
}
```

- [ ] **Step 4: Run CLI typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 5: Run CLI tests**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS (existing tests still work — they use graph/workflow exports)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/load-route-kind.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/runtime/result.ts
git commit -m "refactor: CLI-owned route normalization supporting chain, graph, and workflow"
```

---

### Task 4: Update dev server and registry for `chain` kind

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-registry.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route-server.ts`

- [ ] **Step 1: Expand `RuntimeRegistryEntry.mode` type**

In `packages/cli/src/lib/dev/runtime-registry.ts`, change line 8:

```typescript
  readonly mode: "chain" | "graph" | "workflow"
```

- [ ] **Step 2: Expand `RunsWaitRequest.metadata.dawn.mode` type**

In `packages/cli/src/lib/dev/runtime-server.ts`, change line 290 in the `RunsWaitRequest` interface:

```typescript
      readonly mode: "chain" | "graph" | "workflow"
```

- [ ] **Step 3: Expand `ExecuteRouteServerOptions.mode` type**

In `packages/cli/src/lib/runtime/execute-route-server.ts`, change line 15:

```typescript
  readonly mode: "chain" | "graph" | "workflow"
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 5: Run all CLI tests**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-registry.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/runtime/execute-route-server.ts
git commit -m "refactor: expand mode types to include chain across dev server and server execution"
```

---

### Task 5: Add optional `schema` field to tool discovery

**Files:**
- Modify: `packages/cli/src/lib/runtime/tool-discovery.ts`

- [ ] **Step 1: Add `schema` to `DiscoveredToolDefinition`**

In `packages/cli/src/lib/runtime/tool-discovery.ts`, update the interface (lines 10-19):

```typescript
export interface DiscoveredToolDefinition {
  readonly description?: string
  readonly filePath: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
  readonly scope: ToolScope
}
```

- [ ] **Step 2: Update `loadToolDefinition` to read `schema` export**

In the same file, update the module type cast in `loadToolDefinition` (line 90) and the function body:

```typescript
async function loadToolDefinition(
  filePath: string,
  scope: ToolScope,
): Promise<DiscoveredToolDefinition> {
  const toolModule = (await import(pathToFileURL(filePath).href)) as {
    readonly default?: unknown
    readonly description?: unknown
    readonly schema?: unknown
  }
  const definition = toolModule.default
  const name = basename(filePath, ".ts")
  const description =
    typeof toolModule.description === "string" ? toolModule.description : undefined
  const schema = toolModule.schema !== undefined ? toolModule.schema : undefined

  if (typeof definition === "function") {
    return {
      ...(description ? { description } : {}),
      filePath,
      name,
      run: definition as DiscoveredToolDefinition["run"],
      ...(schema ? { schema } : {}),
      scope,
    }
  }

  if (isRecord(definition) && typeof definition.run === "function") {
    return {
      ...(description ? { description } : {}),
      filePath,
      name,
      run: definition.run as DiscoveredToolDefinition["run"],
      ...(schema ? { schema } : {}),
      scope,
    }
  }

  throw new Error(`Tool file ${filePath} must default export a function`)
}
```

- [ ] **Step 3: Run CLI typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 4: Run CLI tests**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/tool-discovery.ts
git commit -m "feat: add optional schema field to discovered tool definitions"
```

---

### Task 6: Scaffold `@dawnai.org/langchain` package

**Files:**
- Create: `packages/langchain/package.json`
- Create: `packages/langchain/tsconfig.json`
- Create: `packages/langchain/vitest.config.ts`
- Create: `packages/langchain/src/index.ts`

- [ ] **Step 1: Create `package.json`**

Create `packages/langchain/package.json`:

```json
{
  "name": "@dawnai.org/langchain",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/blove/dawn/tree/main/packages/langchain#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/blove/dawn.git",
    "directory": "packages/langchain"
  },
  "bugs": {
    "url": "https://github.com/blove/dawn/issues"
  },
  "engines": {
    "node": ">=22.12.0"
  },
  "files": [
    "dist"
  ],
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dawnai.org/sdk": "workspace:*"
  },
  "peerDependencies": {
    "@langchain/core": ">=0.3.0"
  },
  "devDependencies": {
    "@dawnai.org/config-typescript": "workspace:*",
    "@langchain/core": "0.3.62",
    "@types/node": "25.6.0",
    "zod": "3.24.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `packages/langchain/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../config-typescript/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

Create `packages/langchain/vitest.config.ts`:

```typescript
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawnai.org/langchain": resolve(rootDir, "src/index.ts"),
      "@dawnai.org/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
```

- [ ] **Step 4: Create placeholder `src/index.ts`**

Create `packages/langchain/src/index.ts`:

```typescript
export { chainAdapter } from "./chain-adapter.js"
export { convertToolToLangChain } from "./tool-converter.js"
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: PASS — lockfile updated, `@langchain/core` installed as dev dep

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/package.json packages/langchain/tsconfig.json packages/langchain/vitest.config.ts packages/langchain/src/index.ts pnpm-lock.yaml
git commit -m "feat: scaffold @dawnai.org/langchain package with peerDep on @langchain/core"
```

---

### Task 7: Implement tool converter (Dawn tools → LangChain DynamicStructuredTool)

**Files:**
- Create: `packages/langchain/src/tool-converter.ts`
- Create: `packages/langchain/test/tool-converter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/langchain/test/tool-converter.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { convertToolToLangChain } from "@dawnai.org/langchain"

describe("convertToolToLangChain", () => {
  test("converts a basic Dawn tool to a DynamicStructuredTool", async () => {
    const dawnTool = {
      name: "greet",
      description: "Greet a user",
      filePath: "/app/tools/greet.ts",
      run: async (input: unknown) => ({ greeting: `Hello, ${(input as { name: string }).name}!` }),
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.name).toBe("greet")
    expect(langchainTool.description).toBe("Greet a user")
    const result = await langchainTool.invoke({ name: "World" })
    expect(result).toBe(JSON.stringify({ greeting: "Hello, World!" }))
  })

  test("uses empty description when none provided", () => {
    const dawnTool = {
      name: "ping",
      filePath: "/app/tools/ping.ts",
      run: async () => ({ pong: true }),
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.name).toBe("ping")
    expect(langchainTool.description).toBe("")
  })

  test("uses provided Zod schema when available", async () => {
    const { z } = await import("zod")
    const schema = z.object({ id: z.string().describe("Customer ID") })

    const dawnTool = {
      name: "lookup",
      description: "Look up customer",
      filePath: "/app/tools/lookup.ts",
      run: async (input: unknown) => input,
      schema,
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.schema).toBe(schema)
  })

  test("threads abort signal to Dawn tool run function", async () => {
    let receivedSignal: AbortSignal | undefined

    const dawnTool = {
      name: "slow",
      filePath: "/app/tools/slow.ts",
      run: async (_input: unknown, context: { signal: AbortSignal }) => {
        receivedSignal = context.signal
        return {}
      },
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)
    const controller = new AbortController()

    await langchainTool.invoke({}, { signal: controller.signal })

    expect(receivedSignal).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/langchain exec vitest run test/tool-converter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `tool-converter.ts`**

Create `packages/langchain/src/tool-converter.ts`:

```typescript
import { DynamicStructuredTool } from "@langchain/core/tools"
import { z } from "zod"

interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

export function convertToolToLangChain(tool: DawnToolDefinition): DynamicStructuredTool {
  const schema = isZodObject(tool.schema) ? tool.schema : z.record(z.string(), z.unknown())

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const result = await tool.run(input, { signal })
      return JSON.stringify(result)
    },
  })
}

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    typeof (value as { _def?: { typeName?: unknown } })._def === "object" &&
    (value as { _def: { typeName?: unknown } })._def !== null
  )
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawnai.org/langchain exec vitest run test/tool-converter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat: implement Dawn tool to LangChain DynamicStructuredTool converter"
```

---

### Task 8: Implement tool execution loop

**Files:**
- Create: `packages/langchain/src/tool-loop.ts`
- Create: `packages/langchain/test/tool-loop.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/langchain/test/tool-loop.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { executeWithToolLoop } from "../src/tool-loop.js"
import { AIMessage, ToolMessage } from "@langchain/core/messages"

describe("executeWithToolLoop", () => {
  test("returns output directly when no tool calls", async () => {
    const mockChain = {
      invoke: async () => new AIMessage({ content: "Hello!" }),
    }

    const result = await executeWithToolLoop({
      chain: mockChain,
      input: { message: "hi" },
      tools: [],
      signal: new AbortController().signal,
    })

    expect(result).toBeInstanceOf(AIMessage)
    expect((result as AIMessage).content).toBe("Hello!")
  })

  test("executes tool calls and feeds results back", async () => {
    let callCount = 0
    const mockChain = {
      invoke: async (input: unknown) => {
        callCount++
        if (callCount === 1) {
          return new AIMessage({
            content: "",
            tool_calls: [
              { id: "call_1", name: "greet", args: { name: "World" } },
            ],
          })
        }
        return new AIMessage({ content: "Done! Hello, World!" })
      },
    }

    const tools = [
      {
        name: "greet",
        run: async (input: unknown) => ({ greeting: `Hello, ${(input as { name: string }).name}!` }),
      },
    ]

    const result = await executeWithToolLoop({
      chain: mockChain,
      input: { message: "greet World" },
      tools,
      signal: new AbortController().signal,
    })

    expect((result as AIMessage).content).toBe("Done! Hello, World!")
    expect(callCount).toBe(2)
  })

  test("limits tool loop iterations to prevent infinite loops", async () => {
    const mockChain = {
      invoke: async () =>
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "noop", args: {} },
          ],
        }),
    }

    const tools = [
      { name: "noop", run: async () => ({}) },
    ]

    await expect(
      executeWithToolLoop({
        chain: mockChain,
        input: {},
        tools,
        signal: new AbortController().signal,
        maxIterations: 3,
      }),
    ).rejects.toThrow(/maximum.*iterations/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/langchain exec vitest run test/tool-loop.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `tool-loop.ts`**

Create `packages/langchain/src/tool-loop.ts`:

```typescript
import { AIMessage, ToolMessage } from "@langchain/core/messages"

const DEFAULT_MAX_ITERATIONS = 10

interface ToolExecutor {
  readonly name: string
  readonly run: (input: unknown, context: { readonly signal: AbortSignal }) => Promise<unknown> | unknown
}

export interface ExecuteWithToolLoopOptions {
  readonly chain: { readonly invoke: (input: unknown) => Promise<unknown> }
  readonly input: unknown
  readonly tools: readonly ToolExecutor[]
  readonly signal: AbortSignal
  readonly maxIterations?: number
}

export async function executeWithToolLoop(
  options: ExecuteWithToolLoopOptions,
): Promise<unknown> {
  const { chain, input, tools, signal, maxIterations = DEFAULT_MAX_ITERATIONS } = options
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  let currentInput: unknown = input
  let messages: unknown[] = []

  for (let i = 0; i < maxIterations; i++) {
    const result = await chain.invoke(currentInput)

    if (!isAIMessageWithToolCalls(result)) {
      return result
    }

    const toolMessages = await Promise.all(
      result.tool_calls.map(async (call) => {
        const tool = toolMap.get(call.name)
        if (!tool) {
          return new ToolMessage({
            content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
            tool_call_id: call.id ?? "",
          })
        }
        try {
          const output = await tool.run(call.args, { signal })
          return new ToolMessage({
            content: JSON.stringify(output),
            tool_call_id: call.id ?? "",
          })
        } catch (error) {
          return new ToolMessage({
            content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            tool_call_id: call.id ?? "",
          })
        }
      }),
    )

    messages = [...(Array.isArray(currentInput) ? currentInput : []), result, ...toolMessages]
    currentInput = messages
  }

  throw new Error(`Tool execution loop exceeded maximum ${maxIterations} iterations`)
}

function isAIMessageWithToolCalls(
  value: unknown,
): value is AIMessage & { tool_calls: readonly { id?: string; name: string; args: unknown }[] } {
  return (
    value instanceof AIMessage &&
    Array.isArray((value as AIMessage & { tool_calls?: unknown }).tool_calls) &&
    ((value as AIMessage & { tool_calls: unknown[] }).tool_calls).length > 0
  )
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawnai.org/langchain exec vitest run test/tool-loop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/tool-loop.ts packages/langchain/test/tool-loop.test.ts
git commit -m "feat: implement Dawn-owned tool execution loop for chain routes"
```

---

### Task 9: Implement chain adapter (BackendAdapter for `chain` kind)

**Files:**
- Create: `packages/langchain/src/chain-adapter.ts`
- Create: `packages/langchain/test/chain-adapter.test.ts`
- Modify: `packages/langchain/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/langchain/test/chain-adapter.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { chainAdapter } from "@dawnai.org/langchain"

describe("chainAdapter", () => {
  test("kind is chain", () => {
    expect(chainAdapter.kind).toBe("chain")
  })

  test("execute calls invoke on the entry", async () => {
    const entry = {
      invoke: async (input: unknown) => ({ result: input }),
      stream: async function* () { yield "chunk" },
    }

    const output = await chainAdapter.execute(entry, { message: "hello" }, {
      signal: new AbortController().signal,
    })

    expect(output).toEqual({ result: { message: "hello" } })
  })

  test("stream yields chunks from entry.stream", async () => {
    const entry = {
      invoke: async () => ({}),
      stream: async function* (input: unknown) {
        yield "chunk1"
        yield "chunk2"
        yield "chunk3"
      },
    }

    const chunks: unknown[] = []
    for await (const chunk of chainAdapter.stream(entry, {}, {
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"])
  })

  test("execute throws when entry has no invoke method", async () => {
    await expect(
      chainAdapter.execute("not-a-runnable", {}, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/invoke/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/langchain exec vitest run test/chain-adapter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `chain-adapter.ts`**

Create `packages/langchain/src/chain-adapter.ts`:

```typescript
import type { BackendAdapter } from "@dawnai.org/sdk"

interface RunnableLike {
  readonly invoke: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  readonly stream: (
    input: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

function assertRunnableLike(entry: unknown): asserts entry is RunnableLike {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("invoke" in entry) ||
    typeof (entry as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Chain entry must expose invoke(input) — expected a LangChain Runnable")
  }
}

export const chainAdapter: BackendAdapter = {
  kind: "chain",

  async execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    assertRunnableLike(entry)
    return await entry.invoke(input, { signal: context.signal })
  },

  async *stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): AsyncIterable<unknown> {
    assertRunnableLike(entry)

    if (typeof entry.stream !== "function") {
      yield await entry.invoke(input, { signal: context.signal })
      return
    }

    const streamResult = entry.stream(input, { signal: context.signal })
    const iterable =
      streamResult instanceof Promise ? await streamResult : streamResult

    for await (const chunk of iterable) {
      yield chunk
    }
  },
}
```

- [ ] **Step 4: Update `src/index.ts`**

Replace `packages/langchain/src/index.ts` with:

```typescript
export { chainAdapter } from "./chain-adapter.js"
export { convertToolToLangChain } from "./tool-converter.js"
export { executeWithToolLoop } from "./tool-loop.js"
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @dawnai.org/langchain exec vitest run test/chain-adapter.test.ts`
Expected: PASS

- [ ] **Step 6: Run all langchain tests**

Run: `pnpm --filter @dawnai.org/langchain test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/langchain/src/chain-adapter.ts packages/langchain/src/index.ts packages/langchain/test/chain-adapter.test.ts
git commit -m "feat: implement BackendAdapter for chain routes in @dawnai.org/langchain"
```

---

### Task 10: Scaffold `@dawnai.org/vite-plugin` package

**Files:**
- Create: `packages/vite-plugin/package.json`
- Create: `packages/vite-plugin/tsconfig.json`
- Create: `packages/vite-plugin/vitest.config.ts`
- Create: `packages/vite-plugin/src/index.ts`

- [ ] **Step 1: Create `package.json`**

Create `packages/vite-plugin/package.json`:

```json
{
  "name": "@dawnai.org/vite-plugin",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/blove/dawn/tree/main/packages/vite-plugin#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/blove/dawn.git",
    "directory": "packages/vite-plugin"
  },
  "bugs": {
    "url": "https://github.com/blove/dawn/issues"
  },
  "engines": {
    "node": ">=22.12.0"
  },
  "files": [
    "dist"
  ],
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "typescript": "5.8.3"
  },
  "devDependencies": {
    "@dawnai.org/config-typescript": "workspace:*",
    "@types/node": "25.6.0",
    "zod": "3.24.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `packages/vite-plugin/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../config-typescript/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

Create `packages/vite-plugin/vitest.config.ts`:

```typescript
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawnai.org/vite-plugin": resolve(rootDir, "src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
```

- [ ] **Step 4: Create placeholder `src/index.ts`**

Create `packages/vite-plugin/src/index.ts`:

```typescript
export { extractParameterType } from "./type-extractor.js"
export { generateZodSchema } from "./zod-generator.js"
export { extractJsDoc } from "./jsdoc-extractor.js"
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/vite-plugin/package.json packages/vite-plugin/tsconfig.json packages/vite-plugin/vitest.config.ts packages/vite-plugin/src/index.ts pnpm-lock.yaml
git commit -m "feat: scaffold @dawnai.org/vite-plugin package for build-time schema inference"
```

---

### Task 11: Implement type extractor (TS Compiler API → type info)

**Files:**
- Create: `packages/vite-plugin/src/type-extractor.ts`
- Create: `packages/vite-plugin/test/type-extractor.test.ts`

- [ ] **Step 1: Define the type info structure**

Create `packages/vite-plugin/src/type-info.ts`:

```typescript
export type TypeInfo =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | { readonly kind: "unknown" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "array"; readonly element: TypeInfo }
  | { readonly kind: "tuple"; readonly elements: readonly TypeInfo[] }
  | { readonly kind: "object"; readonly properties: readonly PropertyInfo[] }
  | { readonly kind: "record"; readonly key: TypeInfo; readonly value: TypeInfo }
  | { readonly kind: "map"; readonly key: TypeInfo; readonly value: TypeInfo }
  | { readonly kind: "set"; readonly element: TypeInfo }
  | { readonly kind: "union"; readonly members: readonly TypeInfo[] }
  | { readonly kind: "intersection"; readonly members: readonly TypeInfo[] }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "optional"; readonly inner: TypeInfo }

export interface PropertyInfo {
  readonly name: string
  readonly type: TypeInfo
  readonly optional: boolean
  readonly description?: string
}
```

- [ ] **Step 2: Write failing tests**

Create `packages/vite-plugin/test/type-extractor.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { extractParameterType } from "../src/type-extractor.js"
import type { TypeInfo } from "../src/type-info.js"

describe("extractParameterType", () => {
  test("extracts string property", () => {
    const source = `export default async (input: { name: string }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "name", type: { kind: "string" }, optional: false }],
    })
  })

  test("extracts number property", () => {
    const source = `export default async (input: { count: number }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "count", type: { kind: "number" }, optional: false }],
    })
  })

  test("extracts boolean property", () => {
    const source = `export default async (input: { active: boolean }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "active", type: { kind: "boolean" }, optional: false }],
    })
  })

  test("extracts optional property", () => {
    const source = `export default async (input: { name?: string }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "name", type: { kind: "string" }, optional: true }],
    })
  })

  test("extracts array property", () => {
    const source = `export default async (input: { tags: string[] }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        { name: "tags", type: { kind: "array", element: { kind: "string" } }, optional: false },
      ],
    })
  })

  test("extracts nested object", () => {
    const source = `export default async (input: { user: { id: string; name: string } }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "user",
          type: {
            kind: "object",
            properties: [
              { name: "id", type: { kind: "string" }, optional: false },
              { name: "name", type: { kind: "string" }, optional: false },
            ],
          },
          optional: false,
        },
      ],
    })
  })

  test("extracts union type", () => {
    const source = `export default async (input: { status: "active" | "inactive" }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "status",
          type: { kind: "enum", values: ["active", "inactive"] },
          optional: false,
        },
      ],
    })
  })

  test("extracts Record type", () => {
    const source = `export default async (input: Record<string, number>) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "record",
      key: { kind: "string" },
      value: { kind: "number" },
    })
  })

  test("extracts Map type", () => {
    const source = `export default async (input: { data: Map<string, number> }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "data",
          type: { kind: "map", key: { kind: "string" }, value: { kind: "number" } },
          optional: false,
        },
      ],
    })
  })

  test("extracts Set type", () => {
    const source = `export default async (input: { ids: Set<string> }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "ids",
          type: { kind: "set", element: { kind: "string" } },
          optional: false,
        },
      ],
    })
  })

  test("extracts tuple type", () => {
    const source = `export default async (input: { pair: [string, number] }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "pair",
          type: {
            kind: "tuple",
            elements: [{ kind: "string" }, { kind: "number" }],
          },
          optional: false,
        },
      ],
    })
  })

  test("extracts literal types", () => {
    const source = `export default async (input: { count: 42; flag: true }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        { name: "count", type: { kind: "literal", value: 42 }, optional: false },
        { name: "flag", type: { kind: "literal", value: true }, optional: false },
      ],
    })
  })

  test("extracts nullable type", () => {
    const source = `export default async (input: { name: string | null }) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "name",
          type: {
            kind: "union",
            members: [{ kind: "string" }, { kind: "null" }],
          },
          optional: false,
        },
      ],
    })
  })

  test("resolves type alias", () => {
    const source = `
      type Input = { id: string; name: string }
      export default async (input: Input) => input
    `
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "name", type: { kind: "string" }, optional: false },
      ],
    })
  })

  test("resolves generic type", () => {
    const source = `
      type WithId<T> = { id: string } & T
      export default async (input: WithId<{ name: string }>) => input
    `
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "name", type: { kind: "string" }, optional: false },
      ],
    })
  })

  test("returns unknown for untyped parameter", () => {
    const source = `export default async (input) => input`
    const result = extractParameterType(source, "test.ts")

    expect(result).toEqual({ kind: "unknown" })
  })

  test("returns null when no default export", () => {
    const source = `export const foo = 42`
    const result = extractParameterType(source, "test.ts")

    expect(result).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/type-extractor.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement `type-extractor.ts`**

Create `packages/vite-plugin/src/type-extractor.ts`:

```typescript
import ts from "typescript"
import type { PropertyInfo, TypeInfo } from "./type-info.js"

export function extractParameterType(source: string, fileName: string): TypeInfo | null {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const host = createInMemoryHost(fileName, source)
  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
  }, host)
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(fileName)

  if (!sf) {
    return null
  }

  const defaultExport = findDefaultExport(sf, checker)

  if (!defaultExport) {
    return null
  }

  const signatures = checker.getSignaturesOfType(
    checker.getTypeAtLocation(defaultExport),
    ts.SignatureKind.Call,
  )

  if (signatures.length === 0) {
    return null
  }

  const firstParam = signatures[0]!.parameters[0]

  if (!firstParam) {
    return null
  }

  const paramType = checker.getTypeOfSymbol(firstParam)
  return resolveType(paramType, checker)
}

function resolveType(type: ts.Type, checker: ts.TypeChecker): TypeInfo {
  if (type.flags & ts.TypeFlags.String) {
    return { kind: "string" }
  }

  if (type.flags & ts.TypeFlags.Number) {
    return { kind: "number" }
  }

  if (type.flags & ts.TypeFlags.Boolean) {
    return { kind: "boolean" }
  }

  if (type.flags & ts.TypeFlags.Null) {
    return { kind: "null" }
  }

  if (type.isStringLiteral()) {
    return { kind: "literal", value: type.value }
  }

  if (type.isNumberLiteral()) {
    return { kind: "literal", value: type.value }
  }

  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    const intrinsicName = (type as unknown as { intrinsicName?: string }).intrinsicName
    return { kind: "literal", value: intrinsicName === "true" }
  }

  if (type.isUnion()) {
    const members = type.types.map((t) => resolveType(t, checker))

    if (members.every((m) => m.kind === "literal" && typeof m.value === "string")) {
      return {
        kind: "enum",
        values: members.map((m) => (m as { kind: "literal"; value: string }).value),
      }
    }

    return { kind: "union", members }
  }

  if (type.isIntersection()) {
    const allProperties: PropertyInfo[] = []
    for (const member of type.types) {
      const resolved = resolveType(member, checker)
      if (resolved.kind === "object") {
        allProperties.push(...resolved.properties)
      }
    }
    if (allProperties.length > 0) {
      return { kind: "object", properties: allProperties }
    }
    return { kind: "intersection", members: type.types.map((t) => resolveType(t, checker)) }
  }

  const symbol = type.getSymbol() ?? type.aliasSymbol
  const typeName = symbol?.name

  if (typeName === "Array" || typeName === "ReadonlyArray") {
    const typeArgs = getTypeArguments(type, checker)
    if (typeArgs.length > 0) {
      return { kind: "array", element: resolveType(typeArgs[0]!, checker) }
    }
  }

  if (typeName === "Map" || typeName === "ReadonlyMap") {
    const typeArgs = getTypeArguments(type, checker)
    if (typeArgs.length >= 2) {
      return {
        kind: "map",
        key: resolveType(typeArgs[0]!, checker),
        value: resolveType(typeArgs[1]!, checker),
      }
    }
  }

  if (typeName === "Set" || typeName === "ReadonlySet") {
    const typeArgs = getTypeArguments(type, checker)
    if (typeArgs.length > 0) {
      return { kind: "set", element: resolveType(typeArgs[0]!, checker) }
    }
  }

  if (checker.isTupleType(type)) {
    const typeArgs = getTypeArguments(type, checker)
    return { kind: "tuple", elements: typeArgs.map((t) => resolveType(t, checker)) }
  }

  const indexInfo = checker.getIndexInfosOfType(type)
  const stringIndex = indexInfo.find(
    (info) => info.keyType.flags & ts.TypeFlags.String,
  )
  if (stringIndex && type.getProperties().length === 0) {
    return {
      kind: "record",
      key: { kind: "string" },
      value: resolveType(stringIndex.type, checker),
    }
  }

  const properties = type.getProperties()
  if (properties.length > 0) {
    const props: PropertyInfo[] = properties.map((prop) => {
      const propType = checker.getTypeOfSymbol(prop)
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
      return {
        name: prop.name,
        type: resolveType(propType, checker),
        optional,
      }
    })
    return { kind: "object", properties: props }
  }

  return { kind: "unknown" }
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  if ((type as ts.TypeReference).typeArguments) {
    return (type as ts.TypeReference).typeArguments ?? []
  }
  return checker.getTypeArguments(type as ts.TypeReference)
}

function findDefaultExport(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ts.Node | null {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return statement.expression
    }

    if (
      ts.isExportDefault(statement) &&
      (ts.isFunctionDeclaration(statement) || ts.isArrowFunction(statement))
    ) {
      return statement
    }
  }

  const symbol = checker.getSymbolAtLocation(sourceFile)
  if (symbol) {
    const exports = checker.getExportsOfModule(symbol)
    const defaultExport = exports.find((e) => e.escapedName === "default")
    if (defaultExport) {
      const declarations = defaultExport.declarations
      if (declarations && declarations.length > 0) {
        const decl = declarations[0]!
        if (ts.isExportAssignment(decl)) {
          return decl.expression
        }
        return decl
      }
    }
  }

  return null
}

function createInMemoryHost(fileName: string, source: string): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost({})

  return {
    ...defaultHost,
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true)
      }
      return defaultHost.getSourceFile(name, languageVersion)
    },
    fileExists(name) {
      if (name === fileName) {
        return true
      }
      return defaultHost.fileExists(name)
    },
    readFile(name) {
      if (name === fileName) {
        return source
      }
      return defaultHost.readFile(name)
    },
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/type-extractor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/vite-plugin/src/type-info.ts packages/vite-plugin/src/type-extractor.ts packages/vite-plugin/test/type-extractor.test.ts
git commit -m "feat: implement TypeScript type extractor using compiler API"
```

---

### Task 12: Implement Zod schema generator

**Files:**
- Create: `packages/vite-plugin/src/zod-generator.ts`
- Create: `packages/vite-plugin/test/zod-generator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/vite-plugin/test/zod-generator.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { generateZodSchema } from "../src/zod-generator.js"
import type { TypeInfo } from "../src/type-info.js"

describe("generateZodSchema", () => {
  test("generates z.string()", () => {
    expect(generateZodSchema({ kind: "string" })).toBe("z.string()")
  })

  test("generates z.number()", () => {
    expect(generateZodSchema({ kind: "number" })).toBe("z.number()")
  })

  test("generates z.boolean()", () => {
    expect(generateZodSchema({ kind: "boolean" })).toBe("z.boolean()")
  })

  test("generates z.null()", () => {
    expect(generateZodSchema({ kind: "null" })).toBe("z.null()")
  })

  test("generates z.unknown()", () => {
    expect(generateZodSchema({ kind: "unknown" })).toBe("z.unknown()")
  })

  test("generates z.literal()", () => {
    expect(generateZodSchema({ kind: "literal", value: "active" })).toBe('z.literal("active")')
    expect(generateZodSchema({ kind: "literal", value: 42 })).toBe("z.literal(42)")
    expect(generateZodSchema({ kind: "literal", value: true })).toBe("z.literal(true)")
  })

  test("generates z.array()", () => {
    expect(
      generateZodSchema({ kind: "array", element: { kind: "string" } }),
    ).toBe("z.array(z.string())")
  })

  test("generates z.tuple()", () => {
    expect(
      generateZodSchema({
        kind: "tuple",
        elements: [{ kind: "string" }, { kind: "number" }],
      }),
    ).toBe("z.tuple([z.string(), z.number()])")
  })

  test("generates z.object() with properties", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "count", type: { kind: "number" }, optional: true },
      ],
    }

    expect(generateZodSchema(type)).toBe(
      'z.object({ "id": z.string(), "count": z.number().optional() })',
    )
  })

  test("generates z.object() with description on properties", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false, description: "Customer ID" },
      ],
    }

    expect(generateZodSchema(type)).toBe(
      'z.object({ "id": z.string().describe("Customer ID") })',
    )
  })

  test("generates z.record()", () => {
    expect(
      generateZodSchema({
        kind: "record",
        key: { kind: "string" },
        value: { kind: "number" },
      }),
    ).toBe("z.record(z.string(), z.number())")
  })

  test("generates z.map()", () => {
    expect(
      generateZodSchema({
        kind: "map",
        key: { kind: "string" },
        value: { kind: "number" },
      }),
    ).toBe("z.map(z.string(), z.number())")
  })

  test("generates z.set()", () => {
    expect(
      generateZodSchema({ kind: "set", element: { kind: "string" } }),
    ).toBe("z.set(z.string())")
  })

  test("generates z.union()", () => {
    expect(
      generateZodSchema({
        kind: "union",
        members: [{ kind: "string" }, { kind: "null" }],
      }),
    ).toBe("z.union([z.string(), z.null()])")
  })

  test("generates z.intersection()", () => {
    expect(
      generateZodSchema({
        kind: "intersection",
        members: [
          { kind: "object", properties: [{ name: "a", type: { kind: "string" }, optional: false }] },
          { kind: "object", properties: [{ name: "b", type: { kind: "number" }, optional: false }] },
        ],
      }),
    ).toBe(
      'z.intersection(z.object({ "a": z.string() }), z.object({ "b": z.number() }))',
    )
  })

  test("generates z.enum()", () => {
    expect(
      generateZodSchema({ kind: "enum", values: ["active", "inactive"] }),
    ).toBe('z.enum(["active", "inactive"])')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/zod-generator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `zod-generator.ts`**

Create `packages/vite-plugin/src/zod-generator.ts`:

```typescript
import type { TypeInfo } from "./type-info.js"

export function generateZodSchema(type: TypeInfo, descriptions?: Map<string, string>): string {
  switch (type.kind) {
    case "string":
      return "z.string()"
    case "number":
      return "z.number()"
    case "boolean":
      return "z.boolean()"
    case "null":
      return "z.null()"
    case "unknown":
      return "z.unknown()"
    case "literal":
      return `z.literal(${formatLiteralValue(type.value)})`
    case "array":
      return `z.array(${generateZodSchema(type.element, descriptions)})`
    case "tuple":
      return `z.tuple([${type.elements.map((e) => generateZodSchema(e, descriptions)).join(", ")}])`
    case "object": {
      const props = type.properties.map((prop) => {
        let schema = generateZodSchema(prop.type, descriptions)
        if (prop.optional) {
          schema += ".optional()"
        }
        const desc = prop.description ?? descriptions?.get(prop.name)
        if (desc) {
          schema += `.describe(${JSON.stringify(desc)})`
        }
        return `${JSON.stringify(prop.name)}: ${schema}`
      })
      return `z.object({ ${props.join(", ")} })`
    }
    case "record":
      return `z.record(${generateZodSchema(type.key, descriptions)}, ${generateZodSchema(type.value, descriptions)})`
    case "map":
      return `z.map(${generateZodSchema(type.key, descriptions)}, ${generateZodSchema(type.value, descriptions)})`
    case "set":
      return `z.set(${generateZodSchema(type.element, descriptions)})`
    case "union":
      return `z.union([${type.members.map((m) => generateZodSchema(m, descriptions)).join(", ")}])`
    case "intersection": {
      const parts = type.members.map((m) => generateZodSchema(m, descriptions))
      if (parts.length === 2) {
        return `z.intersection(${parts[0]}, ${parts[1]})`
      }
      return parts.reduce((acc, part) => `z.intersection(${acc}, ${part})`)
    }
    case "enum":
      return `z.enum([${type.values.map((v) => JSON.stringify(v)).join(", ")}])`
    case "optional":
      return `${generateZodSchema(type.inner, descriptions)}.optional()`
  }
}

function formatLiteralValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  return String(value)
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/zod-generator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/zod-generator.ts packages/vite-plugin/test/zod-generator.test.ts
git commit -m "feat: implement Zod schema code generator from type info"
```

---

### Task 13: Implement JSDoc extractor

**Files:**
- Create: `packages/vite-plugin/src/jsdoc-extractor.ts`
- Create: `packages/vite-plugin/test/jsdoc-extractor.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/vite-plugin/test/jsdoc-extractor.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { extractJsDoc } from "../src/jsdoc-extractor.js"

describe("extractJsDoc", () => {
  test("extracts description from JSDoc comment", () => {
    const source = `
/**
 * Look up a customer by ID
 */
export default async (input: { id: string }) => input
`
    const result = extractJsDoc(source, "test.ts")

    expect(result.description).toBe("Look up a customer by ID")
    expect(result.params).toEqual({})
  })

  test("extracts @param descriptions", () => {
    const source = `
/**
 * Look up a customer
 * @param id - Customer ID
 * @param includeHistory - Include order history
 */
export default async (input: { id: string; includeHistory?: boolean }) => input
`
    const result = extractJsDoc(source, "test.ts")

    expect(result.description).toBe("Look up a customer")
    expect(result.params).toEqual({
      id: "Customer ID",
      includeHistory: "Include order history",
    })
  })

  test("returns empty when no JSDoc present", () => {
    const source = `export default async (input: { id: string }) => input`
    const result = extractJsDoc(source, "test.ts")

    expect(result.description).toBeUndefined()
    expect(result.params).toEqual({})
  })

  test("handles multiline description", () => {
    const source = `
/**
 * Look up a customer by ID.
 * Returns the full customer record.
 */
export default async (input: { id: string }) => input
`
    const result = extractJsDoc(source, "test.ts")

    expect(result.description).toBe("Look up a customer by ID. Returns the full customer record.")
  })

  test("handles @param without dash separator", () => {
    const source = `
/**
 * Greet
 * @param name The user name
 */
export default async (input: { name: string }) => input
`
    const result = extractJsDoc(source, "test.ts")

    expect(result.params).toEqual({ name: "The user name" })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/jsdoc-extractor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `jsdoc-extractor.ts`**

Create `packages/vite-plugin/src/jsdoc-extractor.ts`:

```typescript
import ts from "typescript"

export interface JsDocInfo {
  readonly description?: string
  readonly params: Record<string, string>
}

export function extractJsDoc(source: string, fileName: string): JsDocInfo {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const defaultExport = findDefaultExportNode(sourceFile)

  if (!defaultExport) {
    return { params: {} }
  }

  const jsDocNodes = getJsDocComments(defaultExport, sourceFile)

  if (jsDocNodes.length === 0) {
    return { params: {} }
  }

  const jsDocText = jsDocNodes[jsDocNodes.length - 1]!
  return parseJsDocComment(jsDocText)
}

function findDefaultExportNode(sourceFile: ts.SourceFile): ts.Node | null {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return statement
    }

    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement
    }

    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement
    }
  }

  return null
}

function getJsDocComments(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const commentRanges = ts.getLeadingCommentRanges(sourceFile.text, node.pos)

  if (!commentRanges) {
    return []
  }

  return commentRanges
    .filter((range) => range.kind === ts.SyntaxKind.MultiLineCommentTrivia)
    .map((range) => sourceFile.text.slice(range.pos, range.end))
    .filter((text) => text.startsWith("/**"))
}

function parseJsDocComment(comment: string): JsDocInfo {
  const lines = comment
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)

  const descriptionLines: string[] = []
  const params: Record<string, string> = {}

  for (const line of lines) {
    const paramMatch = line.match(/^@param\s+(\w+)\s*(?:-\s*)?(.*)/)

    if (paramMatch) {
      params[paramMatch[1]!] = paramMatch[2]!.trim()
      continue
    }

    if (line.startsWith("@")) {
      continue
    }

    descriptionLines.push(line)
  }

  return {
    ...(descriptionLines.length > 0
      ? { description: descriptionLines.join(" ") }
      : {}),
    params,
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/jsdoc-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/jsdoc-extractor.ts packages/vite-plugin/test/jsdoc-extractor.test.ts
git commit -m "feat: implement JSDoc extractor for tool descriptions and param metadata"
```

---

### Task 14: Implement Vite plugin (full integration)

**Files:**
- Modify: `packages/vite-plugin/src/index.ts`
- Create: `packages/vite-plugin/test/plugin.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `packages/vite-plugin/test/plugin.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { transformToolSource } from "../src/index.js"

describe("transformToolSource", () => {
  test("injects schema and description for a typed tool", () => {
    const source = `
/**
 * Look up a customer by ID
 * @param id - Customer ID
 */
export default async (input: { id: string }) => {
  return { name: "Acme" }
}
`
    const result = transformToolSource(source, "lookup-customer.ts")

    expect(result).not.toBeNull()
    expect(result!).toContain('export const description = "Look up a customer by ID"')
    expect(result!).toContain("export const schema =")
    expect(result!).toContain('z.object(')
    expect(result!).toContain('.describe("Customer ID")')
  })

  test("does not override existing description export", () => {
    const source = `
/**
 * JSDoc description
 */
export const description = "Explicit description"
export default async (input: { id: string }) => ({ id: input.id })
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).toBeNull()
  })

  test("does not override existing schema export", () => {
    const source = `
import { z } from "zod"
export const schema = z.object({ id: z.string() })
export default async (input: { id: string }) => ({ id: input.id })
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).toBeNull()
  })

  test("returns null for tool with no type annotation", () => {
    const source = `export default async (input) => input`
    const result = transformToolSource(source, "tool.ts")

    expect(result).toBeNull()
  })

  test("injects only description when type is unknown", () => {
    const source = `
/**
 * A simple tool
 */
export default async (input: unknown) => input
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result!).toContain('export const description = "A simple tool"')
    expect(result!).not.toContain("export const schema")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/plugin.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the full plugin in `index.ts`**

Replace `packages/vite-plugin/src/index.ts` with:

```typescript
import { extractJsDoc } from "./jsdoc-extractor.js"
import { extractParameterType } from "./type-extractor.js"
import { generateZodSchema } from "./zod-generator.js"

export { extractJsDoc } from "./jsdoc-extractor.js"
export { extractParameterType } from "./type-extractor.js"
export { generateZodSchema } from "./zod-generator.js"

const TOOLS_DIR_PATTERN = /\/tools\/[^/]+\.ts$/

export function dawnToolSchemaPlugin(): {
  name: string
  transform(code: string, id: string): { code: string } | null
} {
  return {
    name: "dawn-tool-schema",
    transform(code: string, id: string): { code: string } | null {
      if (!TOOLS_DIR_PATTERN.test(id)) {
        return null
      }

      const transformed = transformToolSource(code, id)

      if (!transformed) {
        return null
      }

      return { code: transformed }
    },
  }
}

export function transformToolSource(source: string, fileName: string): string | null {
  const hasExistingDescription = /export\s+const\s+description\s*=/.test(source)
  const hasExistingSchema = /export\s+const\s+schema\s*=/.test(source)

  if (hasExistingDescription && hasExistingSchema) {
    return null
  }

  const jsDoc = extractJsDoc(source, fileName)
  const typeInfo = extractParameterType(source, fileName)

  const needsDescription = !hasExistingDescription && jsDoc.description !== undefined
  const needsSchema =
    !hasExistingSchema && typeInfo !== null && typeInfo.kind !== "unknown"

  if (!needsDescription && !needsSchema) {
    return null
  }

  const injections: string[] = []

  if (needsDescription) {
    injections.push(`export const description = ${JSON.stringify(jsDoc.description)}`)
  }

  if (needsSchema && typeInfo) {
    const paramDescriptions = new Map(Object.entries(jsDoc.params))
    if (typeInfo.kind === "object") {
      for (const prop of typeInfo.properties) {
        const desc = paramDescriptions.get(prop.name)
        if (desc && !prop.description) {
          (prop as { description?: string }).description = desc
        }
      }
    }
    const zodCode = generateZodSchema(typeInfo, paramDescriptions)
    injections.push(`import { z } from "zod"`)
    injections.push(`export const schema = ${zodCode}`)
  }

  return `${injections.join("\n")}\n${source}`
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawnai.org/vite-plugin exec vitest run test/plugin.test.ts`
Expected: PASS

- [ ] **Step 5: Run all vite-plugin tests**

Run: `pnpm --filter @dawnai.org/vite-plugin test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/vite-plugin/src/index.ts packages/vite-plugin/test/plugin.test.ts
git commit -m "feat: implement Vite plugin for build-time tool schema inference"
```

---

### Task 15: Wire `@dawnai.org/langgraph` as a BackendAdapter

**Files:**
- Create: `packages/langgraph/src/langgraph-adapter.ts`
- Modify: `packages/langgraph/src/index.ts`

- [ ] **Step 1: Create `langgraph-adapter.ts`**

Create `packages/langgraph/src/langgraph-adapter.ts`:

```typescript
import type { BackendAdapter } from "@dawnai.org/sdk"

export function createLangGraphAdapter(kind: "graph" | "workflow"): BackendAdapter {
  return {
    kind,

    async execute(
      entry: unknown,
      input: unknown,
      context: { readonly signal: AbortSignal },
    ): Promise<unknown> {
      if (kind === "workflow") {
        if (typeof entry !== "function") {
          throw new Error("Workflow entry must be a function")
        }
        return await entry(input, { signal: context.signal })
      }

      if (typeof entry === "function") {
        return await entry(input, { signal: context.signal })
      }

      if (
        typeof entry === "object" &&
        entry !== null &&
        "invoke" in entry &&
        typeof (entry as { invoke?: unknown }).invoke === "function"
      ) {
        return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
          input,
          { signal: context.signal },
        )
      }

      throw new Error("Graph entry must be a function or expose invoke(input)")
    },

    async *stream(
      entry: unknown,
      input: unknown,
      context: { readonly signal: AbortSignal },
    ): AsyncIterable<unknown> {
      const result = await this.execute(entry, input, context)
      yield result
    },
  }
}

export const graphAdapter = createLangGraphAdapter("graph")
export const workflowAdapter = createLangGraphAdapter("workflow")
```

- [ ] **Step 2: Update `index.ts`**

Replace `packages/langgraph/src/index.ts` with:

```typescript
export { defineEntry } from "./define-entry.js"
export { graphAdapter, workflowAdapter } from "./langgraph-adapter.js"
export {
  type GraphRouteModule,
  type NormalizedRouteModule,
  normalizeRouteModule,
  type RouteConfig,
  type RouteKind,
  type RouteModule,
  type WorkflowRouteModule,
} from "./route-module.js"
export type { RuntimeContext, RuntimeTool } from "./runtime-context.js"
```

- [ ] **Step 3: Run langgraph typecheck**

Run: `pnpm --filter @dawnai.org/langgraph exec tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run langgraph tests**

Run: `pnpm --filter @dawnai.org/langgraph test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/langgraph/src/langgraph-adapter.ts packages/langgraph/src/index.ts
git commit -m "feat: expose graphAdapter and workflowAdapter as BackendAdapter implementations"
```

---

### Task 16: Create streaming types and NDJSON framing

**Files:**
- Create: `packages/cli/src/lib/runtime/stream-types.ts`

- [ ] **Step 1: Create stream types**

Create `packages/cli/src/lib/runtime/stream-types.ts`:

```typescript
export type StreamChunk =
  | { readonly type: "chunk"; readonly data: unknown }
  | { readonly type: "tool_call"; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly name: string; readonly output: unknown }
  | { readonly type: "done"; readonly output: unknown }

export function toNdjsonLine(chunk: StreamChunk): string {
  return JSON.stringify(chunk)
}

export function toSseEvent(chunk: StreamChunk): string {
  return `event: ${chunk.type}\ndata: ${JSON.stringify(omitType(chunk))}\n\n`
}

function omitType(chunk: StreamChunk): Record<string, unknown> {
  const { type: _, ...rest } = chunk
  return rest
}
```

- [ ] **Step 2: Run CLI typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/lib/runtime/stream-types.ts
git commit -m "feat: add streaming chunk types with NDJSON and SSE framing"
```

---

### Task 17: Add SSE endpoint to dev server

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`

- [ ] **Step 1: Add SSE streaming endpoint**

In `packages/cli/src/lib/dev/runtime-server.ts`, add the import at the top of the file:

```typescript
import { type StreamChunk, toSseEvent } from "../runtime/stream-types.js"
```

Add a new route handler inside `handleRequest`, after the `/runs/wait` POST handler (after line 211 `sendJson(response, 200, result.output)`), add a new block before the function closes:

Add this new endpoint check after the healthz check (after line 113):

```typescript
  if (request.method === "POST" && request.url === "/runs/stream") {
    await handleStreamRequest({ registry, request, response, signal })
    return
  }
```

Then add the `handleStreamRequest` function after `handleRequest`:

```typescript
async function handleStreamRequest(options: {
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
}): Promise<void> {
  const { request, response, registry, signal } = options

  const rawBody = await readRequestBody(request)
  const parsedBody = parseJson(rawBody)

  if (!parsedBody.ok) {
    sendJson(response, 400, createRequestErrorBody("Malformed request body"))
    return
  }

  const validatedBody = validateRunsWaitRequest(parsedBody.value)

  if (!validatedBody.ok) {
    sendJson(response, 400, createRequestErrorBody(validatedBody.message, validatedBody.details))
    return
  }

  const route = registry.lookup(validatedBody.value.assistant_id)

  if (!route) {
    sendJson(
      response,
      404,
      createRequestErrorBody(`Unknown assistant_id: ${validatedBody.value.assistant_id}`),
    )
    return
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  const result = await executeResolvedRoute({
    appRoot: registry.appRoot,
    input: validatedBody.value.input,
    signal,
    routeFile: route.routeFile,
    routeId: route.routeId,
    routePath: route.routePath,
  })

  if (result.status === "failed") {
    const errorChunk: StreamChunk = {
      type: "done",
      output: { error: result.error.message },
    }
    response.write(toSseEvent(errorChunk))
  } else {
    const doneChunk: StreamChunk = { type: "done", output: result.output }
    response.write(toSseEvent(doneChunk))
  }

  response.end()
}
```

- [ ] **Step 2: Run CLI typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 3: Run CLI tests**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts
git commit -m "feat: add SSE streaming endpoint to dev server"
```

---

### Task 18: Add `@dawnai.org/langchain` to CLI dependencies and wire adapter

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/vitest.config.ts`

- [ ] **Step 1: Add `@dawnai.org/langchain` to CLI `package.json`**

In `packages/cli/package.json`, add to the `dependencies` object:

```json
"@dawnai.org/langchain": "workspace:*",
```

Also add `@langchain/core` to devDependencies for type resolution:

```json
"@langchain/core": "0.3.62",
```

- [ ] **Step 2: Update CLI `vitest.config.ts`**

Add the `@dawnai.org/langchain` alias:

```typescript
export default defineConfig({
  resolve: {
    alias: {
      "@dawnai.org/core": resolve(rootDir, "../core/src/index.ts"),
      "@dawnai.org/langchain": resolve(rootDir, "../langchain/src/index.ts"),
      "@dawnai.org/langgraph": resolve(rootDir, "../langgraph/src/index.ts"),
      "@dawnai.org/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: PASS

- [ ] **Step 4: Run CLI typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json packages/cli/vitest.config.ts pnpm-lock.yaml
git commit -m "feat: add @dawnai.org/langchain dependency to CLI package"
```

---

### Task 19: Chain route integration test

**Files:**
- Create: `packages/cli/test/chain-route.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/cli/test/chain-route.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test, afterEach } from "vitest"
import { executeRoute } from "../src/lib/runtime/execute-route.js"

describe("chain route execution", () => {
  let appRoot: string

  afterEach(async () => {
    if (appRoot) {
      await rm(appRoot, { recursive: true, force: true })
    }
  })

  test("executes a chain route with invoke", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "dawn-chain-"))
    await mkdir(join(appRoot, "src", "app", "hello"), { recursive: true })
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}")
    await writeFile(
      join(appRoot, "src", "app", "hello", "index.ts"),
      `
export const chain = {
  invoke: async (input) => ({ result: "chain works", input }),
  stream: async function* (input) {
    yield { chunk: "hello" }
    yield { chunk: "world" }
  },
}
`,
    )

    const result = await executeRoute({
      appRoot,
      input: { message: "test" },
      routeFile: join(appRoot, "src", "app", "hello", "index.ts"),
    })

    expect(result.status).toBe("passed")
    if (result.status === "passed") {
      expect(result.mode).toBe("chain")
      expect(result.output).toEqual({ result: "chain works", input: { message: "test" } })
    }
  })

  test("fails with clear error when chain entry has no invoke", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "dawn-chain-"))
    await mkdir(join(appRoot, "src", "app", "broken"), { recursive: true })
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}")
    await writeFile(
      join(appRoot, "src", "app", "broken", "index.ts"),
      `export const chain = "not a runnable"`,
    )

    const result = await executeRoute({
      appRoot,
      input: {},
      routeFile: join(appRoot, "src", "app", "broken", "index.ts"),
    })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error.message).toContain("invoke")
    }
  })
})
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @dawnai.org/cli exec vitest run test/chain-route.test.ts`
Expected: PASS

- [ ] **Step 3: Run all CLI tests**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/chain-route.test.ts
git commit -m "test: add chain route integration tests"
```

---

### Task 20: Full CI validation and documentation

**Files:**
- Modify: `docs/next-iterations-roadmap.md`

- [ ] **Step 1: Run full CI validation**

Run: `pnpm ci:validate`
Expected: PASS — all lint, typecheck, tests, build, pack-check, and harness lanes green

- [ ] **Step 2: Update roadmap**

In `docs/next-iterations-roadmap.md`, update Phase 2 section to reflect implementation status. Add a note that Phase 2 core is implemented with `@dawnai.org/langchain`, `@dawnai.org/vite-plugin`, BackendAdapter interface, SSE streaming, and chain route support.

- [ ] **Step 3: Commit**

```bash
git add docs/next-iterations-roadmap.md
git commit -m "docs: update roadmap to reflect Phase 2 implementation"
```

- [ ] **Step 4: Run full CI one more time**

Run: `pnpm ci:validate`
Expected: PASS
