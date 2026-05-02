# Dawn Codegen Wiring Design

## Problem

The DX improvements (PR #25) added codegen functions for extracting tool JSON Schemas, resolving state fields, and rendering type manifests. However, these functions are not yet called by `dawn dev` or `dawn build` — they exist but nothing invokes them automatically. Users must manually run `dawn typegen` and the output is incomplete (no JSON Schema manifests, no state resolution).

## Goal

Wire the codegen pipeline into `dawn dev` and `dawn build` so that all generated output is produced automatically with zero user configuration:
- `.dawn/dawn.generated.d.ts` — route types + tool types + state types (IDE consumption)
- `.dawn/routes/<id>/tools.json` — JSON Schema per tool (LLM runtime consumption)
- `.dawn/routes/<id>/state.json` — resolved state fields + defaults + reducer types (runtime consumption)

## Design

### 1. Reusable `runTypegen()` Function

Extract a reusable orchestrator from the existing `typegen` command into `packages/cli/src/lib/typegen/run-typegen.ts`.

```typescript
export interface TypegenResult {
  readonly routeCount: number
  readonly toolSchemaCount: number
  readonly stateRouteCount: number
}

export async function runTypegen(options: {
  readonly appRoot: string
  readonly manifest: RouteManifest
}): Promise<TypegenResult>
```

Execution order:
1. For each route, call `extractToolTypesForRoute()` and `extractToolSchemasForRoute()`
2. For each route, call `discoverStateDefinition()` — skip gracefully if no `state.ts`
3. Write `.dawn/dawn.generated.d.ts` — existing route/tool types + state types via `renderStateTypes()`
4. Write `.dawn/routes/<routeId>/tools.json` — JSON Schema per route (keyed by tool name)
5. Write `.dawn/routes/<routeId>/state.json` — resolved fields, defaults, reducer type strings

Route ID slug transform: `/hello/[tenant]` → `hello-tenant` (same as build command).

### 2. Dev Session Typegen Integration

The `InternalDevSession` runs typegen on start and selectively on file changes without restarting the server.

#### Path classification:

```typescript
function classifyChange(relativePath: string): "typegen" | "restart" {
  if (/\/tools\/[^/]+\.ts$/.test(relativePath)) return "typegen"
  if (/\/state\.ts$/.test(relativePath)) return "typegen"
  if (/\/reducers\/[^/]+\.ts$/.test(relativePath)) return "typegen"
  return "restart"
}
```

#### Behavior:
- `"typegen"` → call `runTypegen()`, no server restart. Debounce 100ms to batch rapid saves.
- `"restart"` → existing `requestRestart()` behavior (does not re-run typegen).
- On initial `start()` → run typegen once before spawning the dev child.

#### Error handling:
If typegen fails during watch (e.g., TS syntax error in a tool file), log the error to stderr and continue. The stale `.dawn/` output remains usable until the next successful run. The dev server is not affected.

### 3. Build Integration

`dawn build` calls `runTypegen()` as its first step before generating entry files. It receives the manifest from `discoverRoutes()` and passes it directly — no double-discovery.

The build entries themselves remain unchanged. Runtime schema loading from `.dawn/routes/<id>/tools.json` happens at request time (already implemented in `execute-route.ts`), which works the same in dev and deployed environments.

### 4. Typegen Command Refactor

The existing `dawn typegen` command becomes a thin wrapper:

```typescript
export async function runTypegenCommand(options, io) {
  const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  const manifest = await discoverRoutes({ appRoot: app.appRoot })
  const result = await runTypegen({ appRoot: app.appRoot, manifest })
  writeLine(io.stdout, `Wrote types for ${result.routeCount} route(s), ${result.toolSchemaCount} tool schema(s), ${result.stateRouteCount} stateful route(s)`)
}
```

## What Changes

| File | Change |
|------|--------|
| `packages/cli/src/lib/typegen/run-typegen.ts` | New — reusable typegen orchestrator |
| `packages/cli/src/commands/typegen.ts` | Refactor to thin wrapper calling `runTypegen()` |
| `packages/cli/src/lib/dev/dev-session.ts` | Add typegen on start + path-based watch routing with debounce |
| `packages/cli/src/lib/dev/classify-change.ts` | New — path classification helper |
| `packages/cli/src/commands/build.ts` | Call `runTypegen()` as pre-step |

## What Does NOT Change

- Runtime schema loading (`execute-route.ts`) — already implemented
- State discovery (`state-discovery.ts`) — already implemented
- Core extraction functions (`extract-tool-schema.ts`, `extract-tool-types.ts`) — already implemented
- Template `tsconfig.json` — already includes `.dawn/dawn.generated.d.ts`
- State adapter (`state-adapter.ts`) — already implemented

## Generated Output Structure

```
.dawn/                              (gitignored)
  dawn.generated.d.ts               Route types + tool types + state types (IDE)
  routes/
    hello-tenant/
      tools.json                    JSON Schema per tool (LLM runtime)
      state.json                    Resolved state fields + defaults (runtime)
    other-route/
      tools.json
  build/                            (dawn build only)
    hello-tenant.ts                 Entry file
    langgraph.json                  Merged config
```

## Dependencies

- No new package dependencies
- `runTypegen()` imports from `@dawn-ai/core` (already a dependency of `@dawn-ai/cli`)
- State discovery uses existing `discoverStateDefinition()` from `packages/cli/src/lib/runtime/state-discovery.ts`
