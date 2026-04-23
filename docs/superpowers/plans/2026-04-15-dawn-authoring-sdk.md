# Dawn Authoring SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Dawn's author-facing contract from `@dawnai.org/langgraph` into a new backend-neutral `@dawnai.org/sdk` package, and replace the `route.ts` + `workflow.ts`/`graph.ts` convention with a single `index.ts` per route whose kind is inferred from named exports.

**Architecture:** New `@dawnai.org/sdk` owns backend-neutral types (`defineTool`, `ToolDefinition`, `ToolContext`, `RuntimeContext`, `RuntimeTool`, `ToolRegistry`, `RouteConfig`, `RouteKind`). `@dawnai.org/langgraph` slims to the LangGraph execution adapter (`normalizeRouteModule`, `RouteModule`, `defineEntry`) and re-exports SDK types. `@dawnai.org/core` discovery scans for `index.ts` files, inferring route kind from whether `workflow` or `graph` is exported. `@dawnai.org/cli` collapses its execution path to a single lane.

**Tech Stack:** TypeScript, pnpm workspaces + Turbo, Vitest, Biome, tsx, LangGraph.

**Atomic milestone notice:** This is an atomic pre-1.0 break. No deprecation shim. Between Task 5 and Task 12 the repo will have tests that are intentionally red at package boundaries (core vs cli vs template). Each task's own test suite is green at end-of-task, but cross-package integration tests (`test/generated/*`, `test/runtime/*`) only go green at Task 12.

---

## File Structure

**New files:**
- `packages/sdk/package.json` — workspace package definition
- `packages/sdk/tsconfig.json` — TypeScript config
- `packages/sdk/tsconfig.contracts.json` — contract-test TypeScript config
- `packages/sdk/vitest.config.ts` — test config
- `packages/sdk/src/index.ts` — public barrel
- `packages/sdk/src/tool.ts` — `defineTool`, `ToolDefinition`, `ToolContext`
- `packages/sdk/src/runtime-context.ts` — `RuntimeContext`, `RuntimeTool`, `ToolRegistry`
- `packages/sdk/src/route-config.ts` — `RouteConfig`, `RouteKind`
- `packages/sdk/test/define-tool.test.ts` — moved from langgraph
- `packages/sdk/test/tool-context.contract.ts` — moved from langgraph
- `packages/sdk/test/runtime-context.contract.ts` — new contract freeze
- `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts` — replaces route.ts+workflow.ts

**Modified files:**
- `packages/langgraph/package.json` — add `@dawnai.org/sdk` dep, drop subpath exports
- `packages/langgraph/src/index.ts` — re-export from `@dawnai.org/sdk`
- `packages/langgraph/src/route-module.ts` — import `RouteKind` from sdk
- `packages/langgraph/src/runtime-context.ts` — re-export from sdk
- `packages/langgraph/src/define-tool.ts` — re-export from sdk
- `packages/core/package.json` — add `@dawnai.org/sdk` dep
- `packages/core/src/types.ts` — `RouteDefinition` uses `RouteKind`, no `boundEntry*`
- `packages/core/src/discovery/discover-routes.ts` — rewrite for `index.ts` scan
- `packages/core/src/index.ts` — update exports
- `packages/cli/src/lib/runtime/execute-route.ts` — single execution lane
- `packages/cli/src/lib/runtime/resolve-route-target.ts` — accept directories
- `packages/cli/src/commands/check.ts` — drop authoring-routes validator
- `packages/cli/src/commands/verify.ts` — drop authoring-routes validator
- `packages/cli/test/*.test.ts` — rewrite for new contract
- `test/fixtures/contracts/*` — replace route.ts/workflow.ts/graph.ts with index.ts
- `test/generated/fixtures/basic.expected.json` — new manifest shape
- `test/generated/fixtures/basic-runtime.expected.json` — new manifest shape
- `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/*` — replace with index.ts
- `test/generated/run-generated-app.test.ts` — template structure assertions
- `test/generated/run-generated-runtime-contract.test.ts` — target assertions
- `test/runtime/run-runtime-contract.test.ts` — target assertions
- `CONTRIBUTORS.md` — update contributor-local scaffold example

**Deleted files:**
- `packages/langgraph/src/define-route.ts`
- `packages/langgraph/test/define-route.test.ts`
- `packages/core/src/discovery/load-authoring-route-definition.ts`
- `packages/cli/src/lib/runtime/route-definition.ts`
- `packages/cli/src/lib/runtime/validate-authoring-routes.ts`
- `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
- `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`

---

## Task 1: Create `@dawnai.org/sdk` package scaffold

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/tsconfig.contracts.json`
- Create: `packages/sdk/vitest.config.ts`
- Create: `packages/sdk/src/index.ts`
- Create: `packages/sdk/test/placeholder.test.ts`

- [ ] **Step 1: Create `packages/sdk/package.json`**

```json
{
  "name": "@dawnai.org/sdk",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/blove/dawn/tree/main/packages/sdk#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/blove/dawn.git",
    "directory": "packages/sdk"
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
    "typecheck": "tsc --noEmit && tsc -p tsconfig.contracts.json"
  },
  "devDependencies": {
    "@dawnai.org/config-typescript": "workspace:*",
    "@types/node": "25.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/sdk/tsconfig.json`** (copy structure from `packages/langgraph/tsconfig.json`)

Read the langgraph tsconfig first, then replicate the same structure:

```bash
cat /Users/blove/repos/dawn/packages/langgraph/tsconfig.json
```

Create `packages/sdk/tsconfig.json` with identical structure.

- [ ] **Step 3: Create `packages/sdk/tsconfig.contracts.json`** (copy structure from `packages/langgraph/tsconfig.contracts.json`)

```bash
cat /Users/blove/repos/dawn/packages/langgraph/tsconfig.contracts.json
```

Create `packages/sdk/tsconfig.contracts.json` adapted to match the sdk package layout. Include `test/tool-context.contract.ts` and `test/runtime-context.contract.ts` even if those files don't exist yet (they will be added in later tasks). If the contracts config requires referenced files to exist, put an empty placeholder file at each path in this step.

- [ ] **Step 4: Create `packages/sdk/vitest.config.ts`** (replicate langgraph pattern)

```bash
cat /Users/blove/repos/dawn/packages/langgraph/vitest.config.ts
```

Create `packages/sdk/vitest.config.ts` with the same shape. Aliases must self-resolve `@dawnai.org/sdk` to `./src/index.ts` and exclude `*.contract.ts` from test runs.

- [ ] **Step 5: Create `packages/sdk/src/index.ts`** (empty barrel for now)

```ts
export {}
```

- [ ] **Step 6: Create a placeholder test so vitest has something to run**

`packages/sdk/test/placeholder.test.ts`:

```ts
import { describe, expect, it } from "vitest"

describe("@dawnai.org/sdk package", () => {
  it("loads", () => {
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 7: Install workspace so pnpm picks up the new package**

Run: `pnpm install`
Expected: pnpm resolves `@dawnai.org/sdk` in the workspace graph. No errors.

- [ ] **Step 8: Run sdk tests to verify scaffold wires up**

Run: `pnpm --filter @dawnai.org/sdk test`
Expected: PASS — 1 placeholder test.

- [ ] **Step 9: Run sdk typecheck**

Run: `pnpm --filter @dawnai.org/sdk typecheck`
Expected: PASS.

- [ ] **Step 10: Run sdk lint**

Run: `pnpm --filter @dawnai.org/sdk lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/sdk pnpm-lock.yaml
git commit -m "feat(sdk): scaffold @dawnai.org/sdk package"
```

---

## Task 2: Move tool authoring to `@dawnai.org/sdk`

**Files:**
- Create: `packages/sdk/src/tool.ts`
- Move: `packages/langgraph/test/define-tool.test.ts` → `packages/sdk/test/define-tool.test.ts`
- Move: `packages/langgraph/test/tool-context.contract.ts` → `packages/sdk/test/tool-context.contract.ts`
- Delete: `packages/sdk/test/placeholder.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/langgraph/src/define-tool.ts`

- [ ] **Step 1: Create `packages/sdk/src/tool.ts`** (content lifted from `packages/langgraph/src/define-tool.ts`, with `ToolContext` moved here too)

```ts
export interface ToolContext {
  readonly signal: AbortSignal
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown, TContext = ToolContext> {
  readonly name: string
  readonly description?: string
  readonly run: (input: TInput, context: TContext) => Promise<TOutput> | TOutput
}

export function defineTool<TTool extends ToolDefinition>(tool: TTool): TTool {
  assertToolName(tool.name)
  assertToolRun(tool.run)
  return tool
}

function assertToolName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Tool name must be a non-empty string")
  }
}

function assertToolRun(run: unknown): asserts run is ToolDefinition["run"] {
  if (typeof run !== "function") {
    throw new Error("Tool run must be a function")
  }
}
```

- [ ] **Step 2: Update `packages/sdk/src/index.ts` to export tool surface**

```ts
export { defineTool, type ToolContext, type ToolDefinition } from "./tool.js"
```

- [ ] **Step 3: Move `packages/langgraph/test/define-tool.test.ts` → `packages/sdk/test/define-tool.test.ts`**

Copy the file. Change the import from `@dawnai.org/langgraph` to `@dawnai.org/sdk`:

```ts
import { defineTool } from "@dawnai.org/sdk"
```

Delete the original at `packages/langgraph/test/define-tool.test.ts`.

- [ ] **Step 4: Move `packages/langgraph/test/tool-context.contract.ts` → `packages/sdk/test/tool-context.contract.ts`**

Copy the file. Change import from `@dawnai.org/langgraph` to `@dawnai.org/sdk`.

Delete the original at `packages/langgraph/test/tool-context.contract.ts`.

- [ ] **Step 5: Delete the placeholder test**

```bash
rm /Users/blove/repos/dawn/packages/sdk/test/placeholder.test.ts
```

- [ ] **Step 6: Run sdk tests to verify move**

Run: `pnpm --filter @dawnai.org/sdk test`
Expected: PASS — `define-tool.test.ts` runs and passes.

- [ ] **Step 7: Run sdk contract typecheck**

Run: `pnpm --filter @dawnai.org/sdk typecheck`
Expected: PASS — `tool-context.contract.ts` type-checks against `@dawnai.org/sdk` exports.

- [ ] **Step 8: Add `@dawnai.org/sdk` as a dependency of `@dawnai.org/langgraph`**

Edit `packages/langgraph/package.json`. Add at top-level (alphabetically with existing `devDependencies`):

```json
  "dependencies": {
    "@dawnai.org/sdk": "workspace:*"
  },
```

- [ ] **Step 9: Run `pnpm install` to wire the dep**

Run: `pnpm install`
Expected: pnpm-lock.yaml updates, no errors.

- [ ] **Step 10: Replace `packages/langgraph/src/define-tool.ts` with a re-export**

```ts
export { defineTool, type ToolContext, type ToolDefinition } from "@dawnai.org/sdk"
```

- [ ] **Step 11: Run langgraph tests**

Run: `pnpm --filter @dawnai.org/langgraph test`
Expected: PASS — `define-tool.test.ts` is gone, other tests continue to pass.

- [ ] **Step 12: Run langgraph typecheck**

Run: `pnpm --filter @dawnai.org/langgraph typecheck`
Expected: PASS.

- [ ] **Step 13: Run langgraph lint**

Run: `pnpm --filter @dawnai.org/langgraph lint`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add packages/sdk packages/langgraph pnpm-lock.yaml
git commit -m "refactor(sdk): move defineTool and ToolContext to @dawnai.org/sdk"
```

---

## Task 3: Move runtime context to `@dawnai.org/sdk`

**Files:**
- Create: `packages/sdk/src/runtime-context.ts`
- Create: `packages/sdk/test/runtime-context.contract.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/langgraph/src/runtime-context.ts`
- Modify: `packages/sdk/tsconfig.contracts.json` (add contract test file)

- [ ] **Step 1: Create `packages/sdk/src/runtime-context.ts`**

Content lifted from `packages/langgraph/src/runtime-context.ts`, plus `ToolRegistry` added per spec:

```ts
export type RuntimeTool<TInput = unknown, TOutput = unknown> = (
  input: TInput,
) => Promise<TOutput> | TOutput

export type ToolRegistry = Record<string, RuntimeTool<never, unknown>>

export interface RuntimeContext<TTools extends ToolRegistry = ToolRegistry> {
  readonly signal: AbortSignal
  readonly tools: TTools
}
```

Note: `ToolContext` stays in `tool.ts` (already moved in Task 2). Do not duplicate.

- [ ] **Step 2: Add runtime-context exports to `packages/sdk/src/index.ts`**

```ts
export { defineTool, type ToolContext, type ToolDefinition } from "./tool.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
```

- [ ] **Step 3: Write the runtime-context contract test**

`packages/sdk/test/runtime-context.contract.ts`:

```ts
import type { RuntimeContext, RuntimeTool, ToolRegistry } from "@dawnai.org/sdk"

const _registry: ToolRegistry = {}
void _registry

const _tool: RuntimeTool<{ name: string }, { greeting: string }> = async (input) => ({
  greeting: `hi ${input.name}`,
})
void _tool

const _context: RuntimeContext<{
  readonly greet: RuntimeTool<{ readonly name: string }, { readonly greeting: string }>
}> = {
  signal: new AbortController().signal,
  tools: {
    greet: async (input) => ({ greeting: `hi ${input.name}` }),
  },
}
void _context
```

- [ ] **Step 4: Ensure `packages/sdk/tsconfig.contracts.json` includes the new contract file**

Inspect the existing contracts config. If it uses a glob that already includes `test/*.contract.ts`, nothing to do. Otherwise add the new file to its `include` list.

- [ ] **Step 5: Run sdk tests + typecheck**

Run: `pnpm --filter @dawnai.org/sdk test && pnpm --filter @dawnai.org/sdk typecheck`
Expected: PASS.

- [ ] **Step 6: Replace `packages/langgraph/src/runtime-context.ts` with re-export**

```ts
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "@dawnai.org/sdk"
```

- [ ] **Step 7: Run langgraph full validation**

Run: `pnpm --filter @dawnai.org/langgraph test && pnpm --filter @dawnai.org/langgraph typecheck && pnpm --filter @dawnai.org/langgraph lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk packages/langgraph
git commit -m "refactor(sdk): move RuntimeContext and RuntimeTool to @dawnai.org/sdk, add ToolRegistry"
```

---

## Task 4: Move `RouteConfig` and `RouteKind` to `@dawnai.org/sdk`, delete `defineRoute`

**Files:**
- Create: `packages/sdk/src/route-config.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/langgraph/src/route-module.ts`
- Modify: `packages/langgraph/src/index.ts`
- Delete: `packages/langgraph/src/define-route.ts`
- Delete: `packages/langgraph/test/define-route.test.ts`
- Modify: `packages/langgraph/package.json` (drop `./define-entry` and `./route-module` subpath exports if they exist; drop `define-route` — verify with inspection)

- [ ] **Step 1: Create `packages/sdk/src/route-config.ts`**

```ts
export type RouteKind = "graph" | "workflow"

export interface RouteConfig {
  readonly runtime?: "node" | "edge"
  readonly streaming?: boolean
  readonly tags?: readonly string[]
}
```

- [ ] **Step 2: Update `packages/sdk/src/index.ts`**

```ts
export { type RouteConfig, type RouteKind } from "./route-config.js"
export { defineTool, type ToolContext, type ToolDefinition } from "./tool.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
```

- [ ] **Step 3: Run sdk test + typecheck + lint**

Run: `pnpm --filter @dawnai.org/sdk test && pnpm --filter @dawnai.org/sdk typecheck && pnpm --filter @dawnai.org/sdk lint`
Expected: PASS.

- [ ] **Step 4: Update `packages/langgraph/src/route-module.ts` to import `RouteKind` from sdk and emit spec-pinned error messages**

Replace the file-top local `RouteEntryKind` alias and `RouteConfig` interface with imports. The error messages in `assertExactlyOneEntry` now distinguish the "both" vs "neither" cases per the spec:

```ts
import type { RouteConfig, RouteKind } from "@dawnai.org/sdk"

export type { RouteConfig, RouteKind }

export interface GraphRouteModule<TEntry = unknown> {
  readonly graph: TEntry
  readonly workflow?: never
  readonly config?: RouteConfig
}

export interface WorkflowRouteModule<TEntry = unknown> {
  readonly workflow: TEntry
  readonly graph?: never
  readonly config?: RouteConfig
}

export type RouteModule<TEntry = unknown> = GraphRouteModule<TEntry> | WorkflowRouteModule<TEntry>

export interface NormalizedRouteModule<TEntry = unknown> {
  readonly kind: RouteKind
  readonly entry: TEntry
  readonly config: RouteConfig
}

export function normalizeRouteModule<TEntry>(
  module: RouteModule<TEntry> | (GraphRouteModule<TEntry> & WorkflowRouteModule<TEntry>),
): NormalizedRouteModule<TEntry> {
  assertExactlyOneEntry(module)

  if ("graph" in module) {
    return {
      kind: "graph",
      entry: module.graph,
      config: module.config ?? {},
    }
  }

  return {
    kind: "workflow",
    entry: module.workflow,
    config: module.config ?? {},
  }
}

export function assertExactlyOneEntry<TEntry>(
  module: RouteModule<TEntry> | (GraphRouteModule<TEntry> & WorkflowRouteModule<TEntry>),
): asserts module is RouteModule<TEntry> {
  const hasGraph = "graph" in module && (module as { graph?: unknown }).graph !== undefined
  const hasWorkflow =
    "workflow" in module && (module as { workflow?: unknown }).workflow !== undefined

  if (hasGraph && hasWorkflow) {
    throw new Error(`Route index.ts must export exactly one of "workflow" or "graph"`)
  }

  if (!hasGraph && !hasWorkflow) {
    throw new Error(`Route index.ts exports neither "workflow" nor "graph"`)
  }
}
```

The `RouteEntryKind` type alias is removed. `RouteKind` is the canonical name.

Note on error messages: the spec pins `Route index.ts at <path> exports neither "workflow" nor "graph"` for the neither-case. `normalizeRouteModule` doesn't know the path — the CLI call site in `execute-route.ts` (Task 8) catches this error and wraps it with the path prefix. Keep the error text here exactly as shown.

- [ ] **Step 5: Delete `packages/langgraph/src/define-route.ts`**

```bash
rm /Users/blove/repos/dawn/packages/langgraph/src/define-route.ts
```

- [ ] **Step 6: Delete `packages/langgraph/test/define-route.test.ts`**

```bash
rm /Users/blove/repos/dawn/packages/langgraph/test/define-route.test.ts
```

- [ ] **Step 7: Update `packages/langgraph/src/index.ts` to drop defineRoute and use RouteKind**

```ts
export { defineEntry } from "./define-entry.js"
export { defineTool, type ToolDefinition } from "./define-tool.js"
export {
  type GraphRouteModule,
  type NormalizedRouteModule,
  normalizeRouteModule,
  type RouteConfig,
  type RouteKind,
  type RouteModule,
  type WorkflowRouteModule,
} from "./route-module.js"
export type { RuntimeContext, RuntimeTool, ToolContext } from "./runtime-context.js"
```

Note: `ToolContext` is now re-exported from langgraph (it comes from `./runtime-context.js` which re-exports sdk, but `ToolContext` lives in `./tool.js` in sdk — the export from sdk works regardless). If the type name is not re-exported via `./runtime-context.js`, add it via `./define-tool.js` instead (that file already re-exports from sdk).

Verify with:

```bash
cat packages/langgraph/src/runtime-context.ts
cat packages/langgraph/src/define-tool.ts
```

Expected: `ToolContext` must be reachable via some existing re-export file. If not, add `type ToolContext` to whichever re-export list needs it (prefer `./define-tool.js`) so the top-level `index.ts` re-export compiles.

- [ ] **Step 8: Verify `packages/langgraph/package.json` subpath exports match reality**

The current package.json declares `./define-entry` and `./route-module` subpath exports. Those files still exist — leave them. Verify no subpath export points at a deleted file by running build.

- [ ] **Step 9: Update `packages/langgraph/test/route-module.test.ts` for new error messages**

Read the file:

```bash
cat /Users/blove/repos/dawn/packages/langgraph/test/route-module.test.ts
```

Any assertion that expects the old error string `Route modules must define exactly one primary executable entry: graph or workflow` must be updated. Split into two cases per the new messages:

- When module has both `graph` and `workflow`: expect `Route index.ts must export exactly one of "workflow" or "graph"`
- When module has neither: expect `Route index.ts exports neither "workflow" nor "graph"`

Edit the test file to assert these two distinct cases.

- [ ] **Step 10: Run langgraph full validation**

Run: `pnpm --filter @dawnai.org/langgraph test && pnpm --filter @dawnai.org/langgraph typecheck && pnpm --filter @dawnai.org/langgraph lint && pnpm --filter @dawnai.org/langgraph build`
Expected: PASS. `define-route.test.ts` gone; `route-module.test.ts` updated for new error strings; imports from `@dawnai.org/sdk` resolve.

- [ ] **Step 11: Commit**

```bash
git add packages/sdk packages/langgraph
git commit -m "refactor(sdk): move RouteConfig and RouteKind to @dawnai.org/sdk, drop defineRoute"
```

---

## Task 5: Update `@dawnai.org/core` types to use `RouteKind` from sdk

**Files:**
- Modify: `packages/core/package.json` — add `@dawnai.org/sdk` dep
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

**Warning:** At end of this task, core tests are still green (tests use the exported types). The downstream CLI will go red at the next task boundary; we repair it in Task 8.

- [ ] **Step 1: Add `@dawnai.org/sdk` to `packages/core/package.json` dependencies**

Edit `packages/core/package.json`. In `dependencies`:

```json
  "dependencies": {
    "@dawnai.org/sdk": "workspace:*",
    "tsx": "^4.8.1"
  },
```

- [ ] **Step 2: Run `pnpm install`**

Run: `pnpm install`
Expected: lockfile updates.

- [ ] **Step 3: Rewrite `packages/core/src/types.ts`**

```ts
import type { RouteKind } from "@dawnai.org/sdk"

export type { RouteKind }

export interface DawnConfig {
  readonly appDir?: string
}

export type RouteSegment =
  | {
      readonly kind: "static"
      readonly raw: string
    }
  | {
      readonly kind: "dynamic" | "catchall" | "optional-catchall"
      readonly name: string
      readonly raw: string
    }

export interface RouteDefinition {
  readonly id: string
  readonly pathname: string
  readonly kind: RouteKind
  readonly entryFile: string
  readonly routeDir: string
  readonly segments: RouteSegment[]
}

export interface RouteManifest {
  readonly appRoot: string
  readonly routes: RouteDefinition[]
}

export interface LoadDawnConfigOptions {
  readonly appRoot: string
}

export interface LoadedDawnConfig {
  readonly appRoot: string
  readonly config: DawnConfig
  readonly configPath: string
}

export interface FindDawnAppOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface DiscoveredDawnApp {
  readonly appRoot: string
  readonly configPath: string
  readonly routesDir: string
}

export interface DiscoverRoutesOptions {
  readonly appRoot?: string
  readonly cwd?: string
}
```

Key changes vs prior:
- `RouteEntryKind` removed; `RouteKind` from sdk is the canonical name
- `RouteDefinition.entryKind` renamed to `kind`
- `boundEntryFile` / `boundEntryKind` removed

- [ ] **Step 4: Update `packages/core/src/index.ts` — drop `loadAuthoringRouteDefinition`, drop `RouteEntryKind`, add `RouteKind`**

```ts
export { loadDawnConfig } from "./config.js"
export { discoverRoutes, validateRouteEntries } from "./discovery/discover-routes.js"
export { assertDawnRoutesDir, findDawnApp } from "./discovery/find-dawn-app.js"
export {
  isPrivateSegment,
  isRouteGroupSegment,
  toRouteSegments,
} from "./discovery/route-segments.js"
export { renderRouteTypes } from "./typegen/render-route-types.js"
export type {
  DawnConfig,
  DiscoveredDawnApp,
  DiscoverRoutesOptions,
  FindDawnAppOptions,
  LoadDawnConfigOptions,
  LoadedDawnConfig,
  RouteDefinition,
  RouteKind,
  RouteManifest,
  RouteSegment,
} from "./types.js"
```

Note: the `export { loadAuthoringRouteDefinition, ... }` block is removed. `discover-routes.ts` still references the file for now — we rewrite it in Task 6.

- [ ] **Step 5: Don't run core tests yet**

`discover-routes.ts` currently imports `RouteEntryKind` and `boundEntry*` fields that no longer exist on the types. This is expected — Task 6 rewrites discovery and makes core green again.

- [ ] **Step 6: Commit (repo is red in core)**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "refactor(core): adopt RouteKind from @dawnai.org/sdk, drop bound entry fields"
```

---

## Task 6: Rewrite `@dawnai.org/core` discovery for `index.ts`-based model

**Files:**
- Rewrite: `packages/core/src/discovery/discover-routes.ts`
- Delete: `packages/core/src/discovery/load-authoring-route-definition.ts`
- Rewrite: `packages/core/test/discover-routes.test.ts`
- Modify: `packages/core/src/typegen/render-route-types.ts` (if it references removed fields)

**Verification:** Core tests green at end of this task. The test fixtures it uses (`test/fixtures/contracts/*`) still have the old `route.ts` layout — they fail with the new discovery. Update those fixtures in Task 7.

Workflow for this task: update discovery first, then update fixtures in the next task, then run tests together. But to keep this task self-contained and reviewable, we rewrite the test to use NEW fixtures inline with an `mkdtemp` helper pattern so it doesn't depend on `test/fixtures/contracts`. Then the contract fixtures update happens in Task 7 and the render-route-types tests + other fixture consumers get checked then.

- [ ] **Step 1: Write the failing test**

Overwrite `packages/core/test/discover-routes.test.ts`. The test builds `index.ts` route structures in a tmpdir and asserts discovery behavior.

Start by reading the current test to preserve scenarios (route groups, dynamic segments, private segments, collision detection):

```bash
cat /Users/blove/repos/dawn/packages/core/test/discover-routes.test.ts
```

Replace with a version that:
1. Uses `mkdtemp` + `writeFile` to build apps in temp dirs (no dependency on `test/fixtures/contracts`)
2. Tests:
   - Route directory with `index.ts` exporting `workflow` is discovered with `kind: "workflow"`
   - Route directory with `index.ts` exporting `graph` is discovered with `kind: "graph"`
   - Route directory with `index.ts` exporting both throws with message `Route index.ts must export exactly one of "workflow" or "graph"`
   - Route directory with `index.ts` exporting neither is skipped silently
   - Route directory with `index.ts` containing a `config` export merges into the route (manifest may or may not expose it — consult types.ts: if `RouteDefinition` does not carry config, don't assert on it)
   - Route groups `(public)/` are discovered and stripped from pathname
   - Dynamic segments `[tenant]/` are discovered
   - Catch-all and optional-catch-all segments are discovered
   - Private `_name/` segments are skipped
   - Duplicate pathnames across groups produce a collision error

The test should NOT reference `entryKind`, `boundEntryFile`, or `boundEntryKind` since those fields are gone.

Write the full file. Code for the helper and representative test:

```ts
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { discoverRoutes } from "../src/index.js"

let workspaceRoot: string

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "dawn-discover-"))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

async function writeApp(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = workspaceRoot

  await writeFile(join(appRoot, "dawn.config.ts"), `export default { appDir: "src/app" }\n`, "utf8")

  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(appRoot, relative)
    await mkdir(join(absolute, ".."), { recursive: true })
    await writeFile(absolute, content, "utf8")
  }

  return appRoot
}

describe("discoverRoutes", () => {
  it("discovers a workflow route from index.ts", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(1)
    expect(manifest.routes[0]).toMatchObject({
      pathname: "/hello",
      kind: "workflow",
    })
  })

  it("discovers a graph route from index.ts", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export const graph = { invoke: async () => ({}) }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0].kind).toBe("graph")
  })

  it("throws when index.ts exports both workflow and graph", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts":
        `export async function workflow() { return {} }\nexport const graph = { invoke: async () => ({}) }\n`,
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      /Route index\.ts must export exactly one of "workflow" or "graph"/,
    )
  })

  it("skips index.ts that exports neither", async () => {
    const appRoot = await writeApp({
      "src/app/util/index.ts": `export const helper = 1\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(0)
  })

  it("strips route groups from pathnames", async () => {
    const appRoot = await writeApp({
      "src/app/(public)/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0].pathname).toBe("/hello")
  })

  it("preserves dynamic segments in pathnames", async () => {
    const appRoot = await writeApp({
      "src/app/hello/[tenant]/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0].pathname).toBe("/hello/[tenant]")
    expect(manifest.routes[0].segments).toEqual([
      { kind: "static", raw: "hello" },
      { kind: "dynamic", name: "tenant", raw: "[tenant]" },
    ])
  })

  it("skips private segments", async () => {
    const appRoot = await writeApp({
      "src/app/_internal/index.ts": `export async function workflow() { return {} }\n`,
      "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes.map((r) => r.pathname)).toEqual(["/hello"])
  })

  it("detects duplicate pathnames across route groups", async () => {
    const appRoot = await writeApp({
      "src/app/(a)/hello/index.ts": `export async function workflow() { return {} }\n`,
      "src/app/(b)/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(/Duplicate Dawn route pathname/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawnai.org/core test`
Expected: FAIL. Errors will reference removed types in `discover-routes.ts` (compile errors) or the unchanged discovery logic not scanning `index.ts`.

- [ ] **Step 3: Rewrite `packages/core/src/discovery/discover-routes.ts`**

Replace the entire file:

```ts
import { readdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { RouteKind } from "@dawnai.org/sdk"
import type {
  DiscoverRoutesOptions,
  RouteDefinition,
  RouteManifest,
} from "../types.js"
import { findDawnApp } from "./find-dawn-app.js"
import { isPrivateSegment, isRouteGroupSegment, toRouteSegments } from "./route-segments.js"

const INDEX_FILE = "index.ts"

let loaderPromise: Promise<void> | undefined

export async function discoverRoutes(options: DiscoverRoutesOptions = {}): Promise<RouteManifest> {
  const app = await findDawnApp(options)
  const routes = validateRouteCollisions(await collectRouteDefinitions(app.routesDir))

  return {
    appRoot: app.appRoot,
    routes: routes.sort((left, right) => left.pathname.localeCompare(right.pathname)),
  }
}

async function collectRouteDefinitions(routesDir: string): Promise<RouteDefinition[]> {
  const discovered: RouteDefinition[] = []

  await walkRouteTree(routesDir, routesDir, discovered)

  return discovered
}

async function walkRouteTree(
  routesDir: string,
  currentDir: string,
  discovered: RouteDefinition[],
): Promise<void> {
  const routeEntry = await readRouteEntry(routesDir, currentDir)

  if (routeEntry) {
    discovered.push(routeEntry)
  }

  const entries = (await readdir(currentDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )

  for (const entry of entries) {
    if (!entry.isDirectory() || isPrivateSegment(entry.name)) {
      continue
    }

    await walkRouteTree(routesDir, join(currentDir, entry.name), discovered)
  }
}

async function readRouteEntry(
  routesDir: string,
  routeDir: string,
): Promise<RouteDefinition | null> {
  const entries = await readdir(routeDir, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return null
  }

  const hasIndex = entries.some((entry) => entry.isFile() && entry.name === INDEX_FILE)

  if (!hasIndex) {
    return null
  }

  const indexFile = resolve(routeDir, INDEX_FILE)
  const kind = await inferRouteKind(indexFile)

  if (!kind) {
    return null
  }

  const routeSegments = relative(routesDir, routeDir)
    .split(sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment))

  return {
    id: toPathname(routeSegments),
    pathname: toPathname(routeSegments),
    kind,
    entryFile: indexFile,
    routeDir,
    segments: toRouteSegments(routeSegments),
  }
}

async function inferRouteKind(indexFile: string): Promise<RouteKind | null> {
  await registerTsxLoader()
  const module = (await import(pathToFileURL(indexFile).href)) as {
    readonly graph?: unknown
    readonly workflow?: unknown
  }
  const hasGraph = "graph" in module && module.graph !== undefined
  const hasWorkflow = "workflow" in module && module.workflow !== undefined

  if (hasGraph && hasWorkflow) {
    throw new Error(`Route index.ts must export exactly one of "workflow" or "graph"`)
  }

  if (hasGraph) {
    return "graph"
  }

  if (hasWorkflow) {
    return "workflow"
  }

  return null
}

async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= import("tsx").then(() => undefined)
  await loaderPromise
}

export function validateRouteEntries(_routeDir: string, _entryFiles: readonly string[]): void {
  // Kept as exported no-op for now; removed from public API in follow-up.
  // Discovery no longer validates sibling entry files — route kind comes from index.ts exports.
}

function validateRouteCollisions(routes: readonly RouteDefinition[]): RouteDefinition[] {
  const byPathname = new Map<string, RouteDefinition>()

  for (const route of routes) {
    const existingRoute = byPathname.get(route.pathname)

    if (existingRoute) {
      throw new Error(
        `Duplicate Dawn route pathname "${route.pathname}" detected at ${existingRoute.routeDir} and ${route.routeDir}`,
      )
    }

    byPathname.set(route.pathname, route)
  }

  return [...routes]
}

function toPathname(routeSegments: readonly string[]): string {
  if (routeSegments.length === 0) {
    return "/"
  }

  return `/${routeSegments.join("/")}`
}
```

- [ ] **Step 4: Decide on `validateRouteEntries` export**

The old `validateRouteEntries` is referenced by `packages/core/src/index.ts`. The no-op shim preserves the export so no other package breaks. If grep shows no external callers, remove the export from `index.ts` and delete the function:

```bash
```

Use the Grep tool:
- pattern: `validateRouteEntries`
- output_mode: `files_with_matches`

If the only hit is inside `@dawnai.org/core` itself (and its own test that we rewrote), remove the export and the function. If there are external callers, the shim stays.

- [ ] **Step 5: Delete `packages/core/src/discovery/load-authoring-route-definition.ts`**

```bash
rm /Users/blove/repos/dawn/packages/core/src/discovery/load-authoring-route-definition.ts
```

- [ ] **Step 6: Inspect `packages/core/src/typegen/render-route-types.ts` for removed field references**

```bash
cat /Users/blove/repos/dawn/packages/core/src/typegen/render-route-types.ts
```

If it references `entryKind`, rename to `kind`. If it references `boundEntryFile`/`boundEntryKind`, remove those branches — the route always points at a single `index.ts`.

- [ ] **Step 7: Run core test to verify green**

Run: `pnpm --filter @dawnai.org/core test`
Expected: PASS — the rewritten `discover-routes.test.ts` passes; `render-route-types.test.ts` is unaffected unless it referenced removed fields (fix those if so).

- [ ] **Step 8: Run core typecheck + lint**

Run: `pnpm --filter @dawnai.org/core typecheck && pnpm --filter @dawnai.org/core lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "refactor(core): rewrite discovery to scan index.ts and infer kind from exports"
```

---

## Task 7: Update contract test fixtures (`test/fixtures/contracts/*`)

**Files:**
- Rewrite: `test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/*`
- Rewrite: `test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/*`
- Rewrite: `test/fixtures/contracts/invalid-companion/*` — redefine as `invalid-both-exports`
- Rewrite: `test/fixtures/contracts/invalid-route-only/*` — redefine as `invalid-index-no-exports`
- Modify: `test/fixtures/contracts/invalid-config/*` — if it uses `route.ts`, update
- Modify: `test/fixtures/contracts/manifest.snap.json` — update if shape changed
- Potentially: tests in `packages/core/test/*` and `packages/cli/test/*` that consume these fixtures

- [ ] **Step 1: Inspect all contract fixtures to understand current shapes**

```bash
find /Users/blove/repos/dawn/test/fixtures/contracts -type f
```

Read each file. Note which fixtures represent positive cases (valid-*) vs negative cases (invalid-*).

- [ ] **Step 2: Update `valid-basic`**

Delete `route.ts` and `workflow.ts` (or `graph.ts`) in each route dir. Create `index.ts` with a `workflow` or `graph` export matching the original intent:

```bash
rm /Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/\(public\)/hello/\[tenant\]/route.ts
# plus any workflow.ts/graph.ts in the same dir
```

Create `test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/index.ts`:

```ts
import type { RuntimeContext } from "@dawnai.org/sdk"
import type { HelloState } from "./state.js"

export async function workflow(state: HelloState, _ctx: RuntimeContext): Promise<HelloState> {
  return state
}
```

- [ ] **Step 3: Update `valid-custom-app-dir`** similarly. The current fixture uses `graph.ts`, so the new `index.ts` should export `graph`:

```ts
export const graph = {
  invoke: async (input: unknown) => input,
}
```

- [ ] **Step 4: Redefine `invalid-companion` as `invalid-both-exports`**

The old fixture tests the case where both `workflow.ts` and `graph.ts` exist in the same route dir. New equivalent: a route whose `index.ts` exports both `workflow` and `graph`.

Keep the directory name `invalid-companion` if it's referenced by name in tests — update the content only. Replace files with:

`src/app/broken/[tenant]/index.ts`:

```ts
export async function workflow() {
  return {}
}

export const graph = {
  invoke: async () => ({}),
}
```

Delete `workflow.ts` and `graph.ts` from that dir.

- [ ] **Step 5: Redefine `invalid-route-only` as `invalid-no-exports`**

Old fixture: `route.ts` with no executable sibling. New equivalent: `index.ts` that exports neither `workflow` nor `graph`. But per spec this case is **skipped silently**, not an error. So this fixture no longer represents an invalid case and should be deleted, not transformed. Check test consumers:

```bash
```

Use Grep:
- pattern: `invalid-route-only`
- output_mode: `content`
- `-n`: true

For each test that references `invalid-route-only`, decide whether to delete the test (if its assertion no longer makes sense) or re-point it at a different invalid fixture (e.g., `invalid-both-exports`). Delete the fixture directory once no tests reference it.

- [ ] **Step 6: Check `invalid-config`**

```bash
cat /Users/blove/repos/dawn/test/fixtures/contracts/invalid-config/src/app/hello/route.ts
```

If it exists as `route.ts`, rename to `index.ts` and ensure its exports still express "invalid config" (e.g., malformed `config` export — though the spec says unknown keys are ignored, so "invalid config" may no longer be a meaningful fixture either).

If the fixture tests dawn.config.ts validation (not route config), the `route.ts` file is incidental; replace with `index.ts` exporting a `workflow`.

- [ ] **Step 7: Update `manifest.snap.json` if tests consume it with the old shape**

Read current snapshot:

```bash
cat /Users/blove/repos/dawn/test/fixtures/contracts/manifest.snap.json
```

The snapshot shown earlier only carries `pathname` and `segments` (no `entryKind`/`boundEntry*`), so it likely still works. If tests compare more fields against this snapshot, update accordingly.

- [ ] **Step 8: Rebuild fixture-consuming tests**

Run: `pnpm --filter @dawnai.org/core test`
Expected: PASS (since core tests rewrote themselves inline in Task 6, unchanged here).

Run: `pnpm --filter @dawnai.org/cli test`
Expected: may still FAIL — CLI tests still reference old contract. Acceptable; we rewrite CLI tests in Task 9.

- [ ] **Step 9: Commit**

```bash
git add test/fixtures/contracts
git commit -m "test: migrate contract fixtures to index.ts route convention"
```

---

## Task 8: Simplify `@dawnai.org/cli` runtime — single execution path

**Files:**
- Delete: `packages/cli/src/lib/runtime/validate-authoring-routes.ts`
- Delete: `packages/cli/src/lib/runtime/route-definition.ts`
- Rewrite: `packages/cli/src/lib/runtime/execute-route.ts`
- Rewrite: `packages/cli/src/lib/runtime/resolve-route-target.ts`
- Modify: `packages/cli/src/commands/check.ts`
- Modify: `packages/cli/src/commands/verify.ts`

- [ ] **Step 1: Delete `validate-authoring-routes.ts`**

```bash
rm /Users/blove/repos/dawn/packages/cli/src/lib/runtime/validate-authoring-routes.ts
```

- [ ] **Step 2: Delete `route-definition.ts`**

```bash
rm /Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-definition.ts
```

- [ ] **Step 3: Rewrite `packages/cli/src/lib/runtime/resolve-route-target.ts`**

New responsibilities:
1. Accept a path that is either an absolute/relative `index.ts` or a directory
2. Resolve directory targets to their `index.ts`
3. Produce a clear error when target points at legacy `workflow.ts` / `graph.ts`
4. Produce a clear error when directory has no `index.ts`
5. Return the resolved `index.ts` absolute path + route identity
6. Drop the `mode` field from the result — callers determine mode by inspecting exports

Replace the file:

```ts
import { basename, resolve } from "node:path"
import type { Stats } from "node:fs"
import { stat } from "node:fs/promises"

import { findDawnApp } from "@dawnai.org/core"
import {
  createRuntimeFailureResult,
  formatErrorMessage,
  type RuntimeExecutionFailureResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"

export interface ResolveRouteTargetOptions {
  readonly cwd?: string
  readonly invocationCwd?: string
  readonly routePath: string
}

export interface ResolvedRouteTarget {
  readonly appRoot: string
  readonly routeId: string
  readonly routeFile: string
  readonly routePath: string
}

const LEGACY_BASENAMES = new Set(["workflow.ts", "graph.ts", "route.ts"])

export async function resolveRouteTarget(
  options: ResolveRouteTargetOptions,
): Promise<ResolvedRouteTarget | RuntimeExecutionFailureResult> {
  const startedAt = Date.now()
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: discoveredApp.message,
      routePath: options.routePath,
      startedAt,
    })
  }

  const rawTarget = toAbsolutePath(options.routePath, {
    appRoot: discoveredApp.appRoot,
    ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}),
  })

  let targetStat: Stats | null

  try {
    targetStat = await stat(rawTarget)
  } catch {
    targetStat = null
  }

  if (!targetStat) {
    return failure({
      appRoot: discoveredApp.appRoot,
      routesDir: discoveredApp.routesDir,
      routeFile: rawTarget,
      message: `Route target does not exist: ${rawTarget}`,
      startedAt,
    })
  }

  if (targetStat.isDirectory()) {
    const indexFile = resolve(rawTarget, "index.ts")
    let indexStat: Stats | null

    try {
      indexStat = await stat(indexFile)
    } catch {
      indexStat = null
    }

    if (!indexStat?.isFile()) {
      return failure({
        appRoot: discoveredApp.appRoot,
        routesDir: discoveredApp.routesDir,
        routeFile: rawTarget,
        message: `Route directory has no index.ts: ${rawTarget}`,
        startedAt,
      })
    }

    return ok({
      appRoot: discoveredApp.appRoot,
      routesDir: discoveredApp.routesDir,
      routeFile: indexFile,
    })
  }

  if (basename(rawTarget) !== "index.ts") {
    if (LEGACY_BASENAMES.has(basename(rawTarget))) {
      return failure({
        appRoot: discoveredApp.appRoot,
        routesDir: discoveredApp.routesDir,
        routeFile: rawTarget,
        message: `Route target must be a route directory or its index.ts: ${rawTarget}`,
        startedAt,
      })
    }

    return failure({
      appRoot: discoveredApp.appRoot,
      routesDir: discoveredApp.routesDir,
      routeFile: rawTarget,
      message: `Route target must be a route directory or its index.ts: ${rawTarget}`,
      startedAt,
    })
  }

  return ok({
    appRoot: discoveredApp.appRoot,
    routesDir: discoveredApp.routesDir,
    routeFile: rawTarget,
  })
}

function ok(options: {
  readonly appRoot: string
  readonly routesDir: string
  readonly routeFile: string
}): ResolvedRouteTarget | RuntimeExecutionFailureResult {
  const identity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile: options.routeFile,
    routesDir: options.routesDir,
  })

  if (!identity.ok) {
    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file is outside the configured appDir: ${options.routeFile}`,
      routePath: identity.routePath,
      startedAt: Date.now(),
    })
  }

  return {
    appRoot: options.appRoot,
    routeId: identity.routeId,
    routeFile: options.routeFile,
    routePath: identity.routePath,
  }
}

function failure(options: {
  readonly appRoot: string
  readonly routesDir: string
  readonly routeFile: string
  readonly message: string
  readonly startedAt: number
}): RuntimeExecutionFailureResult {
  const identity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile: options.routeFile,
    routesDir: options.routesDir,
  })

  return createRuntimeFailureResult({
    appRoot: options.appRoot,
    executionSource: "in-process",
    kind: "route_resolution_error",
    message: options.message,
    ...(identity.ok ? { routeId: identity.routeId } : {}),
    routePath: identity.routePath,
    startedAt: options.startedAt,
  })
}

async function discoverApp(options: ResolveRouteTargetOptions): Promise<
  | {
      readonly appRoot: string
      readonly ok: true
      readonly routesDir: string
    }
  | {
      readonly message: string
      readonly ok: false
    }
> {
  try {
    const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})

    return {
      appRoot: app.appRoot,
      ok: true,
      routesDir: app.routesDir,
    }
  } catch (error) {
    return {
      message: formatErrorMessage(error),
      ok: false,
    }
  }
}

function toAbsolutePath(
  routePath: string,
  options: {
    readonly appRoot: string
    readonly invocationCwd?: string
  },
): string {
  if (routePath.startsWith("./") || routePath.startsWith("../")) {
    return resolve(options.invocationCwd ?? process.cwd(), routePath)
  }

  return resolve(options.appRoot, routePath)
}
```

- [ ] **Step 4: Inspect `result.ts` to check whether `mode` was required**

```bash
cat /Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts
```

If `RuntimeExecutionFailureResult` / `RuntimeExecutionSuccessResult` require `mode`, temporarily leave `mode` optional or rename it to `kind` / retain as optional. Keep the type surface consistent with how `executeRoute.ts` will use it in the next step.

A minimal plan: in `result.ts` make `mode` optional (`readonly mode?: RuntimeExecutionMode`) and accept the runtime inferring kind from module exports. If touching `result.ts` cascades widely, update `result.ts` in the same step; tests will be rewritten in Task 9 anyway.

- [ ] **Step 5: Rewrite `packages/cli/src/lib/runtime/execute-route.ts`**

Single execution lane:
1. Resolve route target → absolute `index.ts`
2. Register tsx loader
3. Import module
4. `normalizeRouteModule(module)` to determine kind + entry + config
5. Discover tools, build context, invoke handler
6. Return success/failure result

```ts
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { findDawnApp } from "@dawnai.org/core"
import { normalizeRouteModule } from "@dawnai.org/langgraph"
import { createDawnContext } from "./dawn-context.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"
import { discoverToolDefinitions } from "./tool-discovery.js"
import { fileExists } from "./utils.js"

export interface ExecuteRouteOptions {
  readonly appRoot?: string
  readonly cwd?: string
  readonly input: unknown
  readonly routeFile: string
  readonly signal?: AbortSignal
}

export async function executeRoute(options: ExecuteRouteOptions): Promise<RuntimeExecutionResult> {
  const startedAt = Date.now()
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: discoveredApp.message,
      routePath: options.routeFile,
      startedAt,
    })
  }

  const appRoot = discoveredApp.appRoot
  const routeFile = resolveRouteFile({
    appRoot,
    routeFile: options.routeFile,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })

  const identity = deriveRouteIdentity({
    appRoot,
    routeFile,
    routesDir: discoveredApp.routesDir,
  })

  if (!identity.ok) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file is outside the configured appDir: ${routeFile}`,
      routePath: identity.routePath,
      startedAt,
    })
  }

  if (!(await fileExists(routeFile))) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file does not exist: ${routeFile}`,
      routeId: identity.routeId,
      routePath: identity.routePath,
      startedAt,
    })
  }

  return await executeRouteAtResolvedPath({
    appRoot,
    input: options.input,
    routeFile,
    routeId: identity.routeId,
    routePath: identity.routePath,
    ...(options.signal ? { signal: options.signal } : {}),
    startedAt,
  })
}

export async function executeResolvedRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
}): Promise<RuntimeExecutionResult> {
  return await executeRouteAtResolvedPath({
    ...options,
    startedAt: Date.now(),
  })
}

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

  try {
    await registerTsxLoader()
    const routeModule = await import(pathToFileURL(options.routeFile).href)
    const normalized = normalizeRouteModule(routeModule)

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
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }
}

function rewriteNeitherExportMessage(error: unknown, routeFile: string): string {
  if (
    error instanceof Error &&
    error.message === `Route index.ts exports neither "workflow" nor "graph"`
  ) {
    return `Route index.ts at ${routeFile} exports neither "workflow" nor "graph"`
  }

  return formatErrorMessage(error)
}

async function invokeEntry(
  kind: "graph" | "workflow",
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

function resolveRouteFile(options: {
  readonly appRoot: string
  readonly cwd?: string
  readonly routeFile: string
}): string {
  if (isAbsolute(options.routeFile)) {
    return resolve(options.routeFile)
  }

  if (options.routeFile.startsWith(".") || options.routeFile.startsWith("..")) {
    return resolve(options.cwd ?? process.cwd(), options.routeFile)
  }

  return resolve(options.appRoot, options.routeFile)
}

async function discoverApp(options: ExecuteRouteOptions): Promise<
  | {
      readonly appRoot: string
      readonly ok: true
      readonly routesDir: string
    }
  | {
      readonly message: string
      readonly ok: false
    }
> {
  try {
    const app = await findDawnApp({
      ...(options.appRoot ? { appRoot: options.appRoot } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })

    return {
      appRoot: app.appRoot,
      ok: true,
      routesDir: app.routesDir,
    }
  } catch (error) {
    return {
      message: formatErrorMessage(error),
      ok: false,
    }
  }
}

function isBoundaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message === `Route index.ts must export exactly one of "workflow" or "graph"` ||
    error.message === `Route index.ts exports neither "workflow" nor "graph"` ||
    error.message === "Workflow entry must be a function" ||
    error.message === "Graph entry must be a function or expose invoke(input)"
  )
}
```

- [ ] **Step 6: Update `packages/cli/src/commands/check.ts`**

Drop the `validateAuthoringRoutes` call. Discovery already fails fast on malformed `index.ts` exports, so validation is inherent. For per-route deeper validation (e.g., tool discovery succeeds), add an inline walk:

```ts
import { discoverRoutes } from "@dawnai.org/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { discoverToolDefinitions } from "../lib/runtime/tool-discovery.js"

interface CheckOptions {
  readonly cwd?: string
}

export function registerCheckCommand(program: Command, io: CommandIo): void {
  program
    .command("check")
    .description("Validate a Dawn app")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .action(async (options: CheckOptions) => {
      await runCheckCommand(options, io)
    })
}

export async function runCheckCommand(options: CheckOptions, io: CommandIo): Promise<void> {
  try {
    const manifest = await discoverRoutes(options.cwd ? { cwd: options.cwd } : {})

    for (const route of manifest.routes) {
      await discoverToolDefinitions({
        appRoot: manifest.appRoot,
        routeDir: route.routeDir,
      })
    }

    writeLine(io.stdout, `Dawn app is valid: ${manifest.routes.length} routes discovered.`)

    for (const route of manifest.routes) {
      writeLine(io.stdout, `- ${route.pathname} (${route.kind})`)
    }
  } catch (error) {
    throw new CliError(`Validation failed: ${formatErrorMessage(error)}`)
  }
}
```

- [ ] **Step 7: Update `packages/cli/src/commands/verify.ts`**

Remove the `validateAuthoringRoutes(manifest)` call. Tool-discovery can happen inline per-route as in `check.ts`, or leave verify focused on discovery+typegen only — per the spec, verify's role is app integrity, and discovery already fails on malformed index.ts.

Edit the `verifyApp` function:

```ts
// Remove this import:
// import { validateAuthoringRoutes } from "../lib/runtime/validate-authoring-routes.js"

// Inside verifyApp, replace:
//   manifest = await discoverRoutes({ appRoot: app.appRoot })
//   await validateAuthoringRoutes(manifest)
// with:
//   manifest = await discoverRoutes({ appRoot: app.appRoot })
```

- [ ] **Step 8: Search for other callers of deleted symbols**

Use Grep:
- pattern: `validateAuthoringRoutes|resolveAuthoringRouteDefinitionForTarget|loadAuthoringRouteHandler|loadAuthoringRouteDefinition|ResolvedAuthoringRouteDefinition`
- output_mode: `files_with_matches`

For each remaining hit, update or delete the caller.

- [ ] **Step 9: Build cli to check type errors**

Run: `pnpm --filter @dawnai.org/cli typecheck`
Expected: may have errors (tests still reference old imports). Fix non-test errors first. Test errors land in Task 9.

- [ ] **Step 10: Commit**

```bash
git add packages/cli
git commit -m "refactor(cli): collapse to single execution path for index.ts routes"
```

---

## Task 9: Rewrite CLI tests for new contract

**Files:**
- Rewrite: `packages/cli/test/check-command.test.ts`
- Rewrite: `packages/cli/test/verify-command.test.ts`
- Rewrite: `packages/cli/test/run-command.test.ts`
- Rewrite: `packages/cli/test/test-command.test.ts`
- Rewrite: `packages/cli/test/routes-command.test.ts`
- Rewrite (as needed): `packages/cli/test/dev-command.test.ts`, `packages/cli/test/typegen-command.test.ts`

- [ ] **Step 1: Read each current test to map scenarios**

```bash
for f in /Users/blove/repos/dawn/packages/cli/test/*.test.ts; do echo "=== $f"; head -40 "$f"; done
```

For each test file: note scenarios covered, the harness used to build apps, and any references to `route.ts` / `workflow.ts` / `graph.ts`.

- [ ] **Step 2: Rewrite `check-command.test.ts`**

Scenarios to cover:
- Valid app with `index.ts` exporting `workflow` — passes with route list
- Valid app with `index.ts` exporting `graph` — passes
- App with `index.ts` exporting both — fails with pinned error `Route index.ts must export exactly one of "workflow" or "graph"`
- App with route dir containing no `index.ts` — dir is ignored (not a route)
- App with broken tool module in shared or route-local tools — fails with tool error

Use temp-dir builder pattern (mkdtemp + writeFile). Reference the sdk contract for imports:

```ts
// Inside the fixture app:
// src/app/hello/index.ts:
//   import type { RuntimeContext } from "@dawnai.org/sdk"
//   export async function workflow(_input: unknown, _ctx: RuntimeContext) { return {} }
```

- [ ] **Step 3: Rewrite `verify-command.test.ts`**

Same shape: temp-dir apps with `index.ts`. Assert manifest shape no longer contains `boundEntryFile`/`boundEntryKind`. Add assertion for the renamed `kind` field on each route.

- [ ] **Step 4: Rewrite `run-command.test.ts`**

Scenarios:
- `dawn run <routeDir>` executes the `index.ts` in that dir
- `dawn run <routeDir>/index.ts` equivalent
- `dawn run <path>/workflow.ts` returns error `Route target must be a route directory or its index.ts: <path>`
- Directory with no `index.ts` → `Route directory has no index.ts: <path>`
- Workflow handler receives `(state, ctx)` with `ctx.tools` populated from route-local tools
- Graph entry as function works; graph entry as object with `.invoke` works; graph exporting both forms (unsupported) fails

- [ ] **Step 5: Rewrite `test-command.test.ts`**

Mirror run-command scenarios plus scenario-file loading if that's in scope for this command.

- [ ] **Step 6: Rewrite `routes-command.test.ts`**

- Outputs reflect `index.ts` entryFile
- `kind` column replaces `entryKind`
- No `boundEntryFile` in JSON output

- [ ] **Step 7: Run all CLI tests**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS.

- [ ] **Step 8: Run CLI typecheck + lint**

Run: `pnpm --filter @dawnai.org/cli typecheck && pnpm --filter @dawnai.org/cli lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli
git commit -m "test(cli): rewrite command tests for index.ts route contract"
```

---

## Task 10: Update starter template to `index.ts` convention

**Files:**
- Delete: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
- Delete: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`
- Create: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`
- Keep: `state.ts`, `tools/greet.ts` (unchanged)

- [ ] **Step 1: Delete old template route files**

```bash
rm "/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts"
rm "/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts"
```

- [ ] **Step 2: Create `index.ts` merging the two old files' intent**

`packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`:

```ts
import type { RuntimeContext, RuntimeTool } from "@dawnai.org/langgraph";

import type { HelloState } from "./state.js";

type HelloTools = {
  readonly greet: RuntimeTool<
    { readonly tenant: string },
    { readonly greeting: string }
  >;
};

export async function workflow(
  state: HelloState,
  context: RuntimeContext<HelloTools>,
): Promise<HelloState> {
  const result = await context.tools.greet({ tenant: state.tenant });

  return {
    ...state,
    greeting: result.greeting,
  };
}
```

No `config` export — defaults are fine for the starter.

- [ ] **Step 3: Verify template package builds**

Run: `pnpm --filter @dawnai.org/devkit lint`
Expected: PASS.

(The devkit package holds the template as source files, not compiled output. Build may not apply; lint is the main check.)

- [ ] **Step 4: Check `create-dawn-app` for references**

```bash
cat /Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts
```

If it references `route.ts` or `workflow.ts` in its scaffolding logic, update. Often it just copies `templates/app-basic` verbatim — in which case no change needed.

- [ ] **Step 5: Commit**

```bash
git add packages/devkit packages/create-dawn-app
git commit -m "feat(devkit): switch starter template to single index.ts per route"
```

---

## Task 11: Update generated-app tests and expected fixtures

**Files:**
- Modify: `test/generated/fixtures/basic.expected.json`
- Modify: `test/generated/fixtures/basic-runtime.expected.json`
- Modify: `test/generated/run-generated-app.test.ts`
- Modify: `test/generated/run-generated-runtime-contract.test.ts`
- Modify: `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/*` (delete route.ts + graph.ts, add index.ts)
- Keep: `test/generated/harness.ts` (check for references, update as needed)

- [ ] **Step 1: Read expected fixtures and current tests**

```bash
cat /Users/blove/repos/dawn/test/generated/fixtures/basic.expected.json
cat /Users/blove/repos/dawn/test/generated/fixtures/basic-runtime.expected.json
head -60 /Users/blove/repos/dawn/test/generated/run-generated-app.test.ts
head -60 /Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts
```

- [ ] **Step 2: Update `basic.expected.json`**

In `routesJson.routes[0]`, change:
```json
"entryKind": "route",
"entryFile": "<app-root>/src/app/(public)/hello/[tenant]/route.ts",
"boundEntryFile": "<app-root>/src/app/(public)/hello/[tenant]/workflow.ts",
"boundEntryKind": "workflow",
```
to:
```json
"kind": "workflow",
"entryFile": "<app-root>/src/app/(public)/hello/[tenant]/index.ts",
```

Also update `typegenOutput` if the `renderedBytes` count changes — run the test to observe the new value and update inline.

- [ ] **Step 3: Update `basic-runtime.expected.json`** similarly, following the same field renames.

- [ ] **Step 4: Update handwritten runtime fixture**

```bash
rm "/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/route.ts"
rm "/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/graph.ts"
```

Create `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/index.ts`:

```ts
import type { RuntimeContext } from "@dawnai.org/sdk"
import type { HelloState } from "./state.js"

export const graph = {
  invoke: async (state: HelloState, _ctx: RuntimeContext): Promise<HelloState> => {
    return { ...state, greeting: `Hello, ${state.tenant}!` }
  },
}
```

Update `run.test.ts` in the same dir if it imports from `./graph` or `./route`:

```bash
cat "/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts"
```

Update imports to reference `./index.js`.

- [ ] **Step 5: Update `run-generated-app.test.ts`**

Any assertion that the generated template tree contains `route.ts` or `workflow.ts` → switch to asserting presence of `index.ts` and absence of the old files.

- [ ] **Step 6: Update `run-generated-runtime-contract.test.ts`**

Any assertion about `dawn run <path>/workflow.ts` → switch to `dawn run <path>` (directory target) or `dawn run <path>/index.ts`.

- [ ] **Step 7: Run generated-app tests**

Run: `pnpm --filter dawn exec vitest --run --config test/generated/vitest.config.ts`
(Or the root-level test script — inspect `scripts/test.mjs` to find how these run.)

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add test/generated
git commit -m "test(generated): update fixtures and assertions for index.ts route convention"
```

---

## Task 12: Update runtime contract test

**Files:**
- Modify: `test/runtime/run-runtime-contract.test.ts`

- [ ] **Step 1: Read the current test**

```bash
head -100 /Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts
```

- [ ] **Step 2: Update route-target assertions**

Wherever the test passes a route target path, switch from `<path>/workflow.ts` or `<path>/graph.ts` to `<path>` (directory) or `<path>/index.ts`.

Wherever the test builds inline fixture files, replace `route.ts`/`workflow.ts` with a single `index.ts`.

Wherever the test asserts failure for passing a workflow.ts directly, update the expected error to the new pinned message:
`Route target must be a route directory or its index.ts: <path>`

- [ ] **Step 3: Run runtime contract test**

Run: `pnpm test:runtime`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/runtime
git commit -m "test(runtime): update contract test for index.ts route target"
```

---

## Task 13: Update docs

**Files:**
- Modify: `CONTRIBUTORS.md`
- Potentially: package-level READMEs (`packages/*/README.md` if any)
- Potentially: repo root `README.md`

- [ ] **Step 1: Update `CONTRIBUTORS.md` contributor-local scaffold example**

Find the scaffold section and update to show `index.ts` single-file convention.

- [ ] **Step 2: Scan for other doc references**

Use Grep:
- pattern: `route\.ts|workflow\.ts|graph\.ts|defineRoute`
- glob: `**/*.md`
- output_mode: `content`
- `-n`: true

For each hit in a doc file, update to reflect the new convention. Keep fixture paths (e.g. inside test descriptions) accurate if they still reference the new names.

- [ ] **Step 3: Update `@dawnai.org/sdk` package README if exists**

If `packages/sdk/README.md` was not created, skip. If created in Task 1, ensure it accurately describes the current exports.

- [ ] **Step 4: Run docs check**

Run: `node scripts/check-docs.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTORS.md README.md packages/*/README.md
git commit -m "docs: update route authoring references to index.ts convention"
```

---

## Task 14: Final milestone verification

**Files:** none (verification only).

- [ ] **Step 1: Full validate**

Run: `pnpm ci:validate`
Expected: PASS (lint, typecheck, test, docs check, build, pack:check, harness).

- [ ] **Step 2: Publish smoke**

Run: `node scripts/publish-smoke.mjs`
Expected: PASS.

- [ ] **Step 3: Check for stragglers**

Use Grep to confirm no old convention remains:
- pattern: `route\.ts|defineRoute|boundEntryFile|boundEntryKind|RouteEntryKind`
- output_mode: `files_with_matches`

Exclude the design spec, this plan file, and `CHANGELOG` entries. Any other hit is a straggler — fix it.

- [ ] **Step 4: Inspect the final tree**

```bash
ls packages/
```

Expected: `sdk` directory present.

```bash
find packages/devkit/templates -name "route.ts"
find packages/devkit/templates -name "workflow.ts"
```

Expected: no output (both deleted).

- [ ] **Step 5: Final commit (if any doc/lint cleanup)**

If prior steps revealed small fixes, batch and commit:

```bash
git add .
git commit -m "chore: final cleanup after authoring-sdk migration"
```

Otherwise skip.

---

## Rollout Notes

- This milestone is atomic. Do not merge any intermediate task individually to `main` — rebase the whole branch into a single PR (or a small stack of PRs where each commit is one task).
- No deprecation shim. After Task 14 is merged, any remaining test app that still uses `route.ts` will fail with a clear error.
- The only intermediate state where `pnpm ci:validate` is expected to pass mid-flight is after Tasks 1–4 (SDK creation + langgraph slim). From Task 5 onwards, only the targeted per-task commands pass until Task 14.
