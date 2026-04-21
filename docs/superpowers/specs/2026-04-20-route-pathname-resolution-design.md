# Route Pathname Resolution Design

## Goal

Replace filesystem-path-based route resolution in `dawn run` and `dawn test` with route pathname resolution powered by route discovery. Developers type `dawn run '/hello/[tenant]'` instead of `dawn run 'src/app/(public)/hello/[tenant]'`.

## Problem

Today, `dawn run <routePath>` and `dawn test [path]` treat their path arguments as filesystem paths. The `resolveRouteTarget` function in `resolve-route-target.ts` resolves the argument relative to `appRoot` using `path.resolve` and then checks the filesystem with `stat()`. This means the developer must know the full internal directory structure including `src/app/`, route group segments like `(public)`, and the exact nesting — none of which are part of the route's logical identity.

Dawn already has `discoverRoutes` which builds a complete `RouteManifest` mapping logical pathnames (e.g., `/hello/[tenant]`) to their filesystem locations (`entryFile`, `routeDir`). This manifest is the source of truth for route identity and should be used for resolution.

## Design

### `resolveRouteTarget` rewrite

The function signature stays the same except `invocationCwd` is removed from `ResolveRouteTargetOptions`:

```typescript
export interface ResolveRouteTargetOptions {
  readonly cwd?: string
  readonly routePath: string
}
```

The implementation changes to:

1. Call `discoverRoutes` (via `findDawnApp` + route walking) to get the `RouteManifest`
2. Normalize the input: ensure it starts with `/` (prepend if missing)
3. Find the route whose `pathname` matches the normalized input
4. If found: return `ResolvedRouteTarget` using the route's `entryFile`, `routeDir`, `pathname`, and `id`
5. If not found: return a failure result listing all available route pathnames

### Removed code

- `toAbsolutePath` function — no longer needed
- `invocationCwd` option — no longer needed (no filesystem path relativity)
- All `stat()` calls — discovery handles filesystem walking
- `LEGACY_BASENAMES` set — no longer relevant
- The directory-vs-file branching logic — discovery provides `entryFile` directly

### Error message format

When no route matches:

```
Route not found: /hello/tennat

Available routes:
  /hello/[tenant]
```

### `dawn test` narrowing path

`load-run-scenarios.ts` has `resolveNarrowingTarget` with the same filesystem path pattern. This is updated to resolve via discovery as well:

1. If no narrowing path: discover all scenarios (unchanged)
2. If narrowing path provided: normalize to a route pathname, discover routes, find all routes whose pathname starts with the normalized path (prefix match), then collect scenario files from those route directories

This means `dawn test /hello` runs all scenarios under routes starting with `/hello`.

### `dawn run` command

`run.ts` drops the `invocationCwd: process.cwd()` line since `resolveRouteTarget` no longer accepts it.

### `dawn test` command

`test.ts` drops the `invocationCwd: process.cwd()` line since `loadRunScenarios` no longer accepts it.

## Testing

- Unit tests for `resolveRouteTarget` verifying:
  - Exact pathname match returns correct `ResolvedRouteTarget`
  - Pathname without leading `/` is normalized and matched
  - Non-existent pathname returns failure with available routes listed
  - App discovery failure returns appropriate error
- Unit tests for narrowing path resolution in `loadRunScenarios`:
  - Exact route pathname narrows to that route's scenarios
  - Prefix match narrows to multiple routes
  - Non-existent prefix returns empty or error

## Scope

- `packages/cli/src/lib/runtime/resolve-route-target.ts` — rewrite
- `packages/cli/src/commands/run.ts` — remove `invocationCwd`
- `packages/cli/src/commands/test.ts` — remove `invocationCwd`
- `packages/cli/src/lib/runtime/load-run-scenarios.ts` — update `resolveNarrowingTarget` to use discovery
- New or updated test files for the above
