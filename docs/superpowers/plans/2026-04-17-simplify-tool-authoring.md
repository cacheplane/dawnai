# Simplify Tool Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `defineTool` ceremony and infer tool names from filenames so tools are just default-exported functions.

**Architecture:** Change `tool-discovery.ts` to accept bare function exports and derive names from filenames. Remove `defineTool`, `ToolDefinition`, and `ToolContext` from `@dawn-ai/sdk` and `@dawn-ai/langgraph`. Update template and test fixtures.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/cli/src/lib/runtime/tool-discovery.ts` | Modify | Accept function exports, derive name from filename, read optional description |
| `packages/sdk/src/tool.ts` | Modify | Remove all contents (file becomes empty or deleted) |
| `packages/sdk/src/index.ts` | Modify | Remove tool re-exports |
| `packages/sdk/test/define-tool.test.ts` | Delete | Tests for removed `defineTool` |
| `packages/sdk/test/runtime-context.test.ts` | Modify | Remove `defineTool` usage |
| `packages/sdk/README.md` | Modify | Remove `defineTool` references |
| `packages/langgraph/src/define-tool.ts` | Delete | Re-export of removed `defineTool` |
| `packages/langgraph/src/index.ts` | Modify | Remove define-tool re-export |
| `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts` | Modify | Bare function export |
| `packages/cli/test/test-command.test.ts` | Modify | Update inline tool fixtures |

---

### Task 1: Update tool discovery to accept function exports

**Files:**
- Modify: `packages/cli/src/lib/runtime/tool-discovery.ts`

- [ ] **Step 1: Update `DiscoveredToolDefinition` to include optional description**

In `packages/cli/src/lib/runtime/tool-discovery.ts`, change the interface:

```typescript
export interface DiscoveredToolDefinition {
  readonly description?: string
  readonly filePath: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
  readonly scope: ToolScope
}
```

- [ ] **Step 2: Add `basename` import**

Add `basename` to the existing `node:path` import:

```typescript
import { basename, join } from "node:path"
```

- [ ] **Step 3: Rewrite `loadToolDefinition` to accept function exports**

Replace the `loadToolDefinition` function with:

```typescript
async function loadToolDefinition(
  filePath: string,
  scope: ToolScope,
): Promise<DiscoveredToolDefinition> {
  const toolModule = (await import(pathToFileURL(filePath).href)) as {
    readonly default?: unknown
    readonly description?: unknown
  }
  const definition = toolModule.default
  const name = basename(filePath, ".ts")
  const description =
    typeof toolModule.description === "string" ? toolModule.description : undefined

  if (typeof definition === "function") {
    return {
      ...(description ? { description } : {}),
      filePath,
      name,
      run: definition as DiscoveredToolDefinition["run"],
      scope,
    }
  }

  if (isRecord(definition) && typeof definition.run === "function") {
    return {
      ...(description ? { description } : {}),
      filePath,
      name,
      run: definition.run as DiscoveredToolDefinition["run"],
      scope,
    }
  }

  throw new Error(`Tool file ${filePath} must default export a function`)
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @dawn-ai/cli exec tsc -p tsconfig.json --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 5: Run existing CLI tests to verify backward compatibility**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/test-command.test.ts`
Expected: PASS — the existing object-with-name fixtures still work because the record+run path handles them.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/tool-discovery.ts
git commit -m "refactor: accept function exports and derive tool name from filename"
```

---

### Task 2: Update CLI test fixtures to bare function exports

**Files:**
- Modify: `packages/cli/test/test-command.test.ts`

- [ ] **Step 1: Update the shared tool fixture in the workflow test**

In `packages/cli/test/test-command.test.ts`, find the first test's `"src/tools/greet.ts"` fixture (around line 25) and replace:

```typescript
      "src/tools/greet.ts": `export default {
  name: "greet",
  run: async (input: { tenant: string }) => ({ scope: "shared", tenant: input.tenant }),
};
`,
```

with:

```typescript
      "src/tools/greet.ts": `export default async (input: { tenant: string }) => ({ scope: "shared", tenant: input.tenant });
`,
```

- [ ] **Step 2: Update the route-local tool fixture in the workflow test**

In the same test, find `"src/app/hello/[tenant]/tools/tenant-greet.ts"` (around line 39) and replace:

```typescript
      "src/app/hello/[tenant]/tools/tenant-greet.ts": `export default {
  name: "tenant-greet",
  run: async (input: { tenant: string }) => ({ scope: "route-local", tenant: input.tenant }),
};
`,
```

with:

```typescript
      "src/app/hello/[tenant]/tools/tenant-greet.ts": `export default async (input: { tenant: string }) => ({ scope: "route-local", tenant: input.tenant });
`,
```

- [ ] **Step 3: Run the CLI tests**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/test-command.test.ts`
Expected: PASS — all 25 tests pass with bare function tool fixtures.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/test-command.test.ts
git commit -m "test: update tool fixtures to bare function exports"
```

---

### Task 3: Remove `defineTool` from `@dawn-ai/sdk` and `@dawn-ai/langgraph`

**Files:**
- Modify: `packages/sdk/src/tool.ts`
- Modify: `packages/sdk/src/index.ts`
- Delete: `packages/sdk/test/define-tool.test.ts`
- Modify: `packages/sdk/test/runtime-context.test.ts`
- Modify: `packages/sdk/README.md`
- Delete: `packages/langgraph/src/define-tool.ts`
- Modify: `packages/langgraph/src/index.ts`

- [ ] **Step 1: Empty `packages/sdk/src/tool.ts`**

Replace the entire contents of `packages/sdk/src/tool.ts` with an empty file (no exports).

- [ ] **Step 2: Remove tool re-exports from `packages/sdk/src/index.ts`**

Replace the contents of `packages/sdk/src/index.ts` with:

```typescript
export type { RouteConfig, RouteKind } from "./route-config.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
```

- [ ] **Step 3: Delete `packages/sdk/test/define-tool.test.ts`**

```bash
rm packages/sdk/test/define-tool.test.ts
```

- [ ] **Step 4: Update `packages/sdk/test/runtime-context.test.ts`**

Replace the entire file with:

```typescript
import type { RuntimeContext, RuntimeTool } from "@dawn-ai/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("@dawn-ai/sdk runtime-context type surface", () => {
  test("runtime-context types are exported from the package root", () => {
    type Tools = {
      readonly lookupCustomer: RuntimeTool<{ readonly id: string }, { readonly id: string }>
    }

    expectTypeOf<RuntimeContext<Tools>>().toEqualTypeOf<{
      readonly signal: AbortSignal
      readonly tools: Tools
    }>()
  })

  test("runtime-context tools are callable by name", async () => {
    const lookupCustomer = async (
      input: { readonly id: string },
      _context: RuntimeContext<{
        readonly lookupCustomer: RuntimeTool<{ readonly id: string }, { readonly id: string }>
      }>,
    ) => _context.tools.lookupCustomer(input)

    const result = await lookupCustomer(
      { id: "cus_123" },
      {
        signal: new AbortController().signal,
        tools: {
          lookupCustomer: async ({ id }) => ({ id }),
        },
      },
    )

    expect(result).toEqual({ id: "cus_123" })
  })
})
```

- [ ] **Step 5: Update `packages/sdk/README.md`**

Replace with:

```markdown
# @dawn-ai/sdk

TypeScript types for authoring Dawn routes and tools.

Public surface:
- `RuntimeContext` — context object passed to workflow and graph entry points (tools, abort signal)
- `RuntimeTool`, `ToolRegistry` — tool type primitives
- `RouteConfig`, `RouteKind` — route metadata types

This package is a pure type layer with no runtime dependencies. Import it in route `index.ts` files for type annotations.
```

- [ ] **Step 6: Delete `packages/langgraph/src/define-tool.ts`**

```bash
rm packages/langgraph/src/define-tool.ts
```

- [ ] **Step 7: Remove define-tool re-export from `packages/langgraph/src/index.ts`**

Replace the contents of `packages/langgraph/src/index.ts` with:

```typescript
export { defineEntry } from "./define-entry.js"
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

- [ ] **Step 8: Run SDK tests**

Run: `pnpm --filter @dawn-ai/sdk test`
Expected: PASS (1 test file, 2 tests)

- [ ] **Step 9: Run langgraph typecheck**

Run: `pnpm --filter @dawn-ai/langgraph exec tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/sdk/src/tool.ts packages/sdk/src/index.ts packages/sdk/test packages/sdk/README.md packages/langgraph/src/define-tool.ts packages/langgraph/src/index.ts
git commit -m "refactor: remove defineTool, ToolDefinition, and ToolContext from SDK and langgraph"
```

---

### Task 4: Update devkit template and run full validation

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`

- [ ] **Step 1: Replace the template tool with a bare function export**

Replace the contents of `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts` with:

```typescript
export default async (input: unknown) => {
  const { tenant } = input as { readonly tenant: string }

  return {
    greeting: `Hello, ${tenant}!`,
  }
}
```

- [ ] **Step 2: Run full CI validation**

Run: `pnpm ci:validate`
Expected: PASS — all lint, typecheck, tests, build, pack-check, and harness lanes green.

- [ ] **Step 3: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/tools/greet.ts
git commit -m "refactor: simplify starter template tool to bare function export"
```
