# Simplify Tool Authoring

## Goal

Remove `defineTool`, `ToolDefinition`, and `ToolContext` from the public API. Tools become plain default-exported functions with names inferred from filenames.

## Background

The current tool authoring contract requires importing `defineTool` from `@dawn-ai/sdk` and wrapping the tool in an object with a `name` field:

```typescript
import { defineTool, type ToolDefinition } from "@dawn-ai/sdk"

export default defineTool({
  name: "greet",
  run: async (input: unknown) => { ... },
} satisfies ToolDefinition<...>)
```

The `name` field is redundant with the filename — `tools/greet.ts` always maps to tool name `"greet"`. The `defineTool` wrapper only validates that `name` is a non-empty string and `run` is a function, both of which the discovery layer already checks at load time. Removing this ceremony makes tool authoring simpler and more convention-driven.

## Design

### Tool authoring contract (after)

A tool is a `.ts` file in a `tools/` directory that default-exports a function:

```typescript
// src/tools/greet.ts
export default async (input: { tenant: string }, context: { signal: AbortSignal }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

Optional metadata via named exports:

```typescript
export const description = "Greet a tenant by name"
```

- Tool name = filename without `.ts` extension (`greet.ts` -> `"greet"`, `tenant-greet.ts` -> `"tenant-greet"`)
- Shared tools live in `src/tools/`, route-local tools in `<route>/tools/`
- Route-local tools shadow shared tools with the same name (unchanged)
- Tool function signature: `(input, context)` where context is `{ signal: AbortSignal }`

### Discovery changes

In `tool-discovery.ts`, `loadToolDefinition` changes from requiring a record with `.name` and `.run` to:

1. If default export is a **function** -> use it as `run`, derive name from `basename(filePath, ".ts")`
2. If default export is a **record with `.run` as a function** -> use `.run`, derive name from filename (backwards-compatible transition path; `.name` on the object is ignored)
3. Read optional `description` from the module's named `description` export
4. Error if default export is neither a function nor an object with a callable `.run`

`DiscoveredToolDefinition` gains an optional `description` field. Duplicate-name detection within a scope is unchanged.

### SDK removal

Remove from `@dawn-ai/sdk` (`packages/sdk`):
- `defineTool` function, `ToolDefinition` type, `ToolContext` type from `src/tool.ts`
- Re-exports from `src/index.ts`
- `test/define-tool.test.ts`

Remove from `@dawn-ai/langgraph` (`packages/langgraph`):
- `src/define-tool.ts` (re-exports `defineTool` from `@dawn-ai/sdk`) — delete file
- Re-export from `src/index.ts`

### Template and fixture updates

- `packages/devkit/templates/app-basic/.../tools/greet.ts` — replace `defineTool` wrapper with bare function export
- Test fixtures in `packages/cli/test/test-command.test.ts` that create tool files — update to bare function exports (these already use inline object literals, not `defineTool`, so the change is removing the `.name` field and making default export a function)
- Handwritten runtime fixture tool files — same update

### Error messages

| Condition | Message |
|-----------|---------|
| Default export is not a function or object with `.run` | `Tool file {path} must default export a function` |
| Duplicate name within scope | `Duplicate {scope} Dawn tool name "{name}" detected at {path1} and {path2}` (unchanged) |

### Files modified

**Source:**
- `packages/cli/src/lib/runtime/tool-discovery.ts` — accept function exports, derive name from filename, read optional description
- `packages/sdk/src/tool.ts` — remove `defineTool`, `ToolDefinition`, `ToolContext`
- `packages/sdk/src/index.ts` — remove tool re-exports
- `packages/langgraph/src/index.ts` — remove define-tool re-export

**Deleted:**
- `packages/sdk/test/define-tool.test.ts`
- `packages/langgraph/src/define-tool.ts`

**Updated:**
- `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts` — bare function export
- `packages/sdk/README.md` — remove `defineTool` references

**Tests:**
- `packages/cli/test/test-command.test.ts` — update tool fixture strings to bare function exports
- Tool discovery tests (if they exist as separate files, or inline in test-command tests)

### What does not change

- `dawn-context.ts` — consumes `DiscoveredToolDefinition` unchanged (name is still a string, run is still a function)
- Tool resolution order (route-local shadows shared)
- Tool function signature `(input, context)` with `{ signal: AbortSignal }` context
- `RuntimeContext`, `RuntimeTool`, `ToolRegistry` types in `@dawn-ai/sdk` — these describe the consumer side, not the authoring side
