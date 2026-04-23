# Route Pathname Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace filesystem-path-based route resolution in `dawn run` and `dawn test` with route pathname lookup via `discoverRoutes`, so developers type `dawn run '/hello/[tenant]'` instead of `dawn run 'src/app/(public)/hello/[tenant]'`.

**Architecture:** `resolveRouteTarget` drops its `toAbsolutePath` + `stat()` approach and instead calls `discoverRoutes` to get the `RouteManifest`, then looks up the provided pathname. `load-run-scenarios.ts` narrowing similarly switches from filesystem resolution to route pathname prefix matching. All `invocationCwd` plumbing is removed.

**Tech Stack:** TypeScript, vitest, `@dawnai.org/core` route discovery

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/cli/src/lib/runtime/resolve-route-target.ts` | Rewrite | Route pathname → `ResolvedRouteTarget` via `discoverRoutes` |
| `packages/cli/src/commands/run.ts` | Modify | Remove `invocationCwd` from `resolveRouteTarget` call |
| `packages/cli/src/lib/runtime/load-run-scenarios.ts` | Modify | Replace `resolveNarrowingTarget` with route pathname prefix matching |
| `packages/cli/src/commands/test.ts` | Modify | Remove `invocationCwd` from `loadRunScenarios` call |
| `packages/cli/test/run-command.test.ts` | Modify | Update all route path arguments from filesystem paths to route pathnames |
| `packages/cli/test/test-command.test.ts` | Modify | Update narrowing path arguments to route pathnames |
| `test/smoke/run-smoke.test.ts` | Modify | Update `executeCanonicalFlow` to pass route pathname to `dawn run` |

---

### Task 1: Rewrite `resolveRouteTarget` to use route discovery

**Files:**
- Modify: `packages/cli/src/lib/runtime/resolve-route-target.ts`

- [ ] **Step 1: Rewrite the module**

Replace the entire implementation of `resolveRouteTarget`. The new version:
- Calls `discoverRoutes` to build a `RouteManifest`
- Normalizes the input pathname (ensures leading `/`)
- Looks up the route by `pathname` match
- Returns `ResolvedRouteTarget` on match, or a failure listing available routes

```typescript
import { relative, sep } from "node:path"

import { discoverRoutes } from "@dawnai.org/core"
import {
  createRuntimeFailureResult,
  formatErrorMessage,
  type RuntimeExecutionFailureResult,
} from "./result.js"

export interface ResolveRouteTargetOptions {
  readonly cwd?: string
  readonly routePath: string
}

export interface ResolvedRouteTarget {
  readonly appRoot: string
  readonly routeId: string
  readonly routeFile: string
  readonly routePath: string
}

export async function resolveRouteTarget(
  options: ResolveRouteTargetOptions,
): Promise<ResolvedRouteTarget | RuntimeExecutionFailureResult> {
  const startedAt = Date.now()

  let manifest: Awaited<ReturnType<typeof discoverRoutes>>

  try {
    manifest = await discoverRoutes(options.cwd ? { cwd: options.cwd } : {})
  } catch (error) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: formatErrorMessage(error),
      routePath: options.routePath,
      startedAt,
    })
  }

  const normalizedPathname = normalizePathname(options.routePath)
  const route = manifest.routes.find(
    (candidate) => candidate.pathname === normalizedPathname,
  )

  if (!route) {
    const available = manifest.routes.map((r) => r.pathname)
    const availableList =
      available.length > 0
        ? `\n\nAvailable routes:\n${available.map((p) => `  ${p}`).join("\n")}`
        : ""

    return createRuntimeFailureResult({
      appRoot: manifest.appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route not found: ${normalizedPathname}${availableList}`,
      routePath: options.routePath,
      startedAt,
    })
  }

  return {
    appRoot: manifest.appRoot,
    routeId: route.id,
    routeFile: route.entryFile,
    routePath: relative(manifest.appRoot, route.entryFile).split(sep).join("/"),
  }
}

function normalizePathname(input: string): string {
  if (input.startsWith("/")) {
    return input
  }

  return `/${input}`
}
```

Remove these deleted items:
- `toAbsolutePath` function
- `LEGACY_BASENAMES` constant
- `discoverApp` function
- `ok` function
- `failure` function
- All `stat()` imports and calls
- `invocationCwd` from `ResolveRouteTargetOptions`
- Import of `deriveRouteIdentity`
- Imports of `Stats`, `stat`, `basename`, `resolve` from node

- [ ] **Step 2: Run the existing test suite to verify the rewrite compiles**

Run: `cd packages/cli && pnpm exec tsc --noEmit`

Expected: Compilation succeeds (the callers still pass `invocationCwd` but it's just an extra property that TypeScript allows on object literals — wait, TypeScript does check excess properties on object literals). So this step will surface type errors in `run.ts` and `test.ts` that pass `invocationCwd`. That's expected — we fix those in the next tasks.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/lib/runtime/resolve-route-target.ts
git commit -m "refactor: rewrite resolveRouteTarget to use route discovery"
```

---

### Task 2: Update `dawn run` command

**Files:**
- Modify: `packages/cli/src/commands/run.ts`

- [ ] **Step 1: Remove `invocationCwd` from the `resolveRouteTarget` call**

In `run.ts`, the `runRunCommand` function currently passes:

```typescript
const resolvedTarget = await resolveRouteTarget({
  ...(options.cwd ? { cwd: options.cwd } : {}),
  invocationCwd: process.cwd(),
  routePath,
})
```

Change to:

```typescript
const resolvedTarget = await resolveRouteTarget({
  ...(options.cwd ? { cwd: options.cwd } : {}),
  routePath,
})
```

- [ ] **Step 2: Verify compilation**

Run: `cd packages/cli && pnpm exec tsc --noEmit`

Expected: May still fail due to `test.ts` and `load-run-scenarios.ts` — that's OK, we fix those next.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/run.ts
git commit -m "refactor: remove invocationCwd from dawn run command"
```

---

### Task 3: Update `load-run-scenarios.ts` narrowing to use route discovery

**Files:**
- Modify: `packages/cli/src/lib/runtime/load-run-scenarios.ts`

- [ ] **Step 1: Replace `resolveNarrowingTarget` with route-pathname-based narrowing**

The current `discoverScenarioFiles` function uses `resolveNarrowingTarget` (filesystem path resolution) to narrow scenario discovery. Replace this with route pathname prefix matching via `discoverRoutes`.

The `loadRunScenarios` function changes from:

```typescript
export async function loadRunScenarios(
  options: LoadRunScenariosOptions,
): Promise<readonly LoadedRunScenario[]> {
  const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  const scenarioFiles = await discoverScenarioFiles({
    appRoot: app.appRoot,
    ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}),
    ...(options.narrowingPath ? { narrowingPath: options.narrowingPath } : {}),
    routesDir: app.routesDir,
  })
  // ... rest unchanged
```

To:

```typescript
export async function loadRunScenarios(
  options: LoadRunScenariosOptions,
): Promise<readonly LoadedRunScenario[]> {
  const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  const scenarioFiles = await discoverScenarioFiles({
    ...(options.narrowingPath ? { narrowingPath: options.narrowingPath } : {}),
    routesDir: app.routesDir,
  })
  // ... rest unchanged
```

Remove `invocationCwd` from `LoadRunScenariosOptions`:

```typescript
export interface LoadRunScenariosOptions {
  readonly cwd?: string
  readonly narrowingPath?: string
}
```

Replace `discoverScenarioFiles`:

```typescript
async function discoverScenarioFiles(options: {
  readonly narrowingPath?: string
  readonly routesDir: string
}): Promise<readonly string[]> {
  if (!options.narrowingPath) {
    return await collectScenarioFiles(options.routesDir)
  }

  const normalizedPathname = options.narrowingPath.startsWith("/")
    ? options.narrowingPath
    : `/${options.narrowingPath}`

  const { discoverRoutes } = await import("@dawnai.org/core")
  const manifest = await discoverRoutes()
  const matchingRoutes = manifest.routes.filter(
    (route) =>
      route.pathname === normalizedPathname ||
      route.pathname.startsWith(`${normalizedPathname}/`),
  )

  if (matchingRoutes.length === 0) {
    throw new RunScenarioLoadError(
      `No routes match narrowing path: ${normalizedPathname}`,
    )
  }

  const scenarioFiles: string[] = []

  for (const route of matchingRoutes) {
    const routeScenarios = await collectScenarioFiles(route.routeDir)
    scenarioFiles.push(...routeScenarios)
  }

  return scenarioFiles.sort((left, right) => left.localeCompare(right))
}
```

Delete `resolveNarrowingTarget` function entirely.

Remove unused imports: `resolve` from `node:path` (check if still needed by other code — `join` and `dirname` are still used). Remove `constants` and `access` from `node:fs` if `pathExists` is still needed elsewhere in the file.

Note: `pathExists` is still used in `loadScenarioFile` to check sibling `index.ts`, so keep that. But `resolve` can be removed if `resolveNarrowingTarget` was the only consumer.

Actually, `resolve` is used in `loadScenarioFile` line 160: `const indexFile = resolve(dirname(options.scenarioFile), "index.ts")`. So keep the `resolve` import.

Also: `discoverRoutes` is already imported at the top via `findDawnApp` from `@dawnai.org/core`. Instead of dynamic import, add `discoverRoutes` to the existing static import:

```typescript
import { discoverRoutes, findDawnApp } from "@dawnai.org/core"
```

- [ ] **Step 2: Verify compilation**

Run: `cd packages/cli && pnpm exec tsc --noEmit`

Expected: May still fail if `test.ts` still passes `invocationCwd`. That's OK — next task.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/lib/runtime/load-run-scenarios.ts
git commit -m "refactor: replace filesystem narrowing with route pathname prefix matching"
```

---

### Task 4: Update `dawn test` command

**Files:**
- Modify: `packages/cli/src/commands/test.ts`

- [ ] **Step 1: Remove `invocationCwd` from the `loadRunScenarios` call**

In `test.ts`, the `runTestCommand` function currently passes:

```typescript
const scenarios = await loadRunScenarios({
  ...(options.cwd ? { cwd: options.cwd } : {}),
  invocationCwd: process.cwd(),
  ...(narrowingPath ? { narrowingPath } : {}),
})
```

Change to:

```typescript
const scenarios = await loadRunScenarios({
  ...(options.cwd ? { cwd: options.cwd } : {}),
  ...(narrowingPath ? { narrowingPath } : {}),
})
```

- [ ] **Step 2: Verify full compilation**

Run: `cd packages/cli && pnpm exec tsc --noEmit`

Expected: PASS — all `invocationCwd` references should now be removed.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/test.ts
git commit -m "refactor: remove invocationCwd from dawn test command"
```

---

### Task 5: Update `run-command.test.ts`

**Files:**
- Modify: `packages/cli/test/run-command.test.ts`

- [ ] **Step 1: Update all route path arguments from filesystem paths to route pathnames**

Every test that passes a filesystem path like `"src/app/hello/[tenant]"` or `"src/app/support/[tenant]"` as the route argument to `dawn run` must be updated to use the route pathname format: `"/hello/[tenant]"` or `"/support/[tenant]"`.

Changes for each test (listed by test name):

1. **"executes the route directory's index.ts and exposes shared and route-local tools through ctx.tools"**
   - `["run", "src/app/hello/[tenant]", "--cwd", appRoot]` → `["run", "/hello/[tenant]", "--cwd", appRoot]`

2. **"executes the route's index.ts when targeted directly"**
   - This test passes `"src/app/support/[tenant]/index.ts"` — targeting a specific file. Since we no longer support filesystem paths, this test should be changed to use the route pathname `"/support/[tenant]"`. Update the invoke call and the expected `routePath` in the assertion. The `routePath` field in the result will now be the route pathname, not a filesystem-relative path.
   - `["run", "src/app/support/[tenant]/index.ts", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`
   - The test name can be updated to something like "resolves route pathname to its entry file" since the "targeted directly" concept no longer applies.

3. **"prefers route-local tools over shared tools with the same name"**
   - `["run", "src/app/hello/[tenant]", "--cwd", appRoot]` → `["run", "/hello/[tenant]", "--cwd", appRoot]`

4. **"executes a graph route when graph is exported as a function"**
   - `["run", "src/app/support/[tenant]", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`

5. **"executes a graph route exposed as an object with .invoke"**
   - `["run", "src/app/support/[tenant]", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`

6. **"fails when an index.ts exports both workflow and graph"**
   - `["run", "src/app/support/[tenant]", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`

7. **"rejects targeting a non-index.ts file inside a route directory"**
   - This test sends `"src/app/support/[tenant]/workflow.ts"` as a filesystem path. Since we no longer support filesystem paths, this test should be **removed entirely** — the concept of targeting a non-index file doesn't exist in the pathname model.

8. **"rejects targeting a route directory that has no index.ts"**
   - This test sends `"src/app/empty"` which is a directory with no `index.ts`. In the new model, this directory would not be discovered as a route, so the test should be updated to verify that a non-existent route pathname returns a "route not found" error with available routes listed.
   - `["run", "src/app/empty", "--cwd", appRoot]` → `["run", "/empty", "--cwd", appRoot]`
   - Expected error changes from `"Route directory has no index.ts: ..."` to `"Route not found: /empty"`
   - The fixture still needs at least one route for the app to be valid. Keep the existing `"src/app/page.tsx"` fixture file but it won't be discovered as a route (no `index.ts` with exports). You may need to add a real route to the fixture so the error message includes it in the "Available routes" list, or the list will be empty.

9. **"resolves dot-relative route paths from the caller working directory"**
   - This test sends `"./"` as a dot-relative path from within the route directory. Since we no longer support filesystem paths at all (no dot-relative resolution), **remove this test entirely**.

10. **"normalizes route identity from a configured custom appDir"**
    - `["run", "src/custom-app/docs", "--cwd", appRoot]` → `["run", "/docs", "--cwd", appRoot]`

11. **"normalizes grouped route directories to canonical route ids"**
    - `["run", "src/app/(public)/hello/[tenant]", "--cwd", appRoot]` → `["run", "/hello/[tenant]", "--cwd", appRoot]`

12. **"returns a modeled app discovery failure as JSON with exit 1"**
    - Route path stays the same since app discovery fails before route lookup. But the route path argument can stay as-is (it won't be resolved since discovery fails).
    - Keep: `["run", "src/app/support/[tenant]"]` — this is fine, discovery fails before we even try to match.
    - Actually, for consistency, change to `["run", "/support/[tenant]"]` since that's what users would type.

13. **"returns a route resolution failure as JSON when the target does not exist"**
    - `["run", "src/app/support/[tenant]", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`
    - Expected error changes from `"Route target does not exist: ..."` to `"Route not found: /support/[tenant]"`

14. **"returns modeled execution failures as JSON with exit 1"**
    - `["run", "src/app/support/[tenant]", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`

15. **"uses stderr-only exit 2 failures for malformed JSON input"**
    - `["run", "src/app/support/[tenant]", "--cwd", appRoot]` → `["run", "/support/[tenant]", "--cwd", appRoot]`

16. **All `--url` server tests** (5 tests):
    - Same pattern: `"src/app/support/[tenant]"` → `"/support/[tenant]"`

Note: The `routePath` field in the JSON output is preserved as a filesystem-relative path (e.g., `"src/app/hello/[tenant]/index.ts"`) via `relative(manifest.appRoot, route.entryFile)` in Task 1. Existing `routePath` assertions in tests do NOT need to change.

- [ ] **Step 2: Remove the two deleted tests**

Remove:
- "rejects targeting a non-index.ts file inside a route directory" (filesystem-path-only concept)
- "resolves dot-relative route paths from the caller working directory" (dot-relative paths no longer supported)

- [ ] **Step 3: Update the "rejects targeting a route directory that has no index.ts" test**

This test should be renamed to "returns route not found when pathname does not match any route" and updated:

```typescript
test("returns route not found when pathname does not match any route", async () => {
  const appRoot = await createFixtureApp({
    "package.json": "{}\n",
    "dawn.config.ts": "export default {};\n",
    "src/app/page.tsx": "export default function Page() { return null; }\n",
  })

  const result = await invoke(["run", "/nonexistent", "--cwd", appRoot], {
    stdin: JSON.stringify({}),
  })

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe("")
  const payload = JSON.parse(result.stdout) as Record<string, unknown>

  expectTiming(payload)
  expect(payload).toMatchObject({
    appRoot,
    executionSource: "in-process",
    error: {
      kind: "route_resolution_error",
      message: expect.stringContaining("Route not found: /nonexistent"),
    },
    status: "failed",
  })
})
```

- [ ] **Step 4: Update the "returns a route resolution failure" test**

```typescript
test("returns a route resolution failure as JSON when the target does not exist", async () => {
  const appRoot = await createFixtureApp({
    "package.json": "{}\n",
    "dawn.config.ts": "export default {};\n",
    "src/app/page.tsx": "export default {};\n",
  })

  const result = await invoke(["run", "/support/[tenant]", "--cwd", appRoot], {
    stdin: JSON.stringify({ tenant: "missing-route" }),
  })

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe("")
  const payload = JSON.parse(result.stdout) as Record<string, unknown>

  expectTiming(payload)
  expect(payload).toMatchObject({
    appRoot,
    executionSource: "in-process",
    error: {
      kind: "route_resolution_error",
      message: expect.stringContaining("Route not found: /support/[tenant]"),
    },
    status: "failed",
  })
})
```

- [ ] **Step 5: Update the "executes the route's index.ts when targeted directly" test**

Rename to "resolves route pathname to its entry file" and simplify:

```typescript
test("resolves route pathname to its entry file", async () => {
  const appRoot = await createFixtureApp({
    "package.json": "{}\n",
    "dawn.config.ts": "export default {};\n",
    "src/app/support/[tenant]/index.ts": `export const workflow = async (state: { tenant: string }) => ({ tenant: state.tenant, source: "direct-index" });\n`,
  })

  const result = await invoke(["run", "/support/[tenant]", "--cwd", appRoot], {
    stdin: JSON.stringify({ tenant: "direct-tenant" }),
  })

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("")
  const payload = JSON.parse(result.stdout) as Record<string, unknown>

  expectTiming(payload)
  expect(payload).toMatchObject({
    appRoot,
    executionSource: "in-process",
    mode: "workflow",
    output: {
      source: "direct-index",
      tenant: "direct-tenant",
    },
    routeId: "/support/[tenant]",
    routePath: "src/app/support/[tenant]/index.ts",
    status: "passed",
  })
})
```

- [ ] **Step 6: Update all remaining route path arguments in invoke calls**

For every remaining test, change the route argument from filesystem path to route pathname. The pattern is:
- `"src/app/hello/[tenant]"` → `"/hello/[tenant]"`
- `"src/app/support/[tenant]"` → `"/support/[tenant]"`
- `"src/app/(public)/hello/[tenant]"` → `"/hello/[tenant]"`
- `"src/custom-app/docs"` → `"/docs"`
- `"src/app/support/[tenant]/index.ts"` → `"/support/[tenant]"`

For the app discovery failure test, change:
- `["run", "src/app/support/[tenant]"]` → `["run", "/support/[tenant]"]`
- Update expected `routePath` assertion from `"src/app/support/[tenant]"` to `"/support/[tenant]"`

- [ ] **Step 7: Run the test suite**

Run: `cd packages/cli && pnpm vitest run test/run-command.test.ts`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/test/run-command.test.ts
git commit -m "test: update run-command tests to use route pathnames"
```

---

### Task 6: Update `test-command.test.ts`

**Files:**
- Modify: `packages/cli/test/test-command.test.ts`

- [ ] **Step 1: Update narrowing path arguments**

1. **"narrows to one scenario file"** — currently passes `"src/app/beta/run.test.ts"`. In the new model, narrowing is by route pathname, not filesystem path. Change to `"/beta"`:
   - `["test", "src/app/beta/run.test.ts", "--cwd", appRoot]` → `["test", "/beta", "--cwd", appRoot]`

2. **"narrows to one route directory including descendants"** — currently passes `"src/app/docs"`. Change to `"/docs"`:
   - `["test", "src/app/docs", "--cwd", appRoot]` → `["test", "/docs", "--cwd", appRoot]`

3. **"supports caller-cwd-relative narrowing"** — passes `"./docs"` from a cwd inside the app. Since we removed `invocationCwd`, this test should be **removed entirely** (dot-relative narrowing no longer supported).

4. **"supports app-root-relative narrowing"** — passes `"src/app/docs"`. Change to `"/docs"`:
   - `["test", "src/app/docs", "--cwd", appRoot]` → `["test", "/docs", "--cwd", appRoot]`

- [ ] **Step 2: Run the test suite**

Run: `cd packages/cli && pnpm vitest run test/test-command.test.ts`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/test-command.test.ts
git commit -m "test: update test-command tests to use route pathnames"
```

---

### Task 7: Update smoke test

**Files:**
- Modify: `test/smoke/run-smoke.test.ts`

- [ ] **Step 1: Update `executeCanonicalFlow` to use route pathname**

The current `executeCanonicalFlow` function constructs a filesystem-relative path:

```typescript
const routePath = relative(
  normalizePrivatePath(options.appRoot),
  normalizePrivatePath(options.entryFile),
)
  .split("\\")
  .join("/")
const runnerResult = await runCommand({
  args: ["exec", "dawn", "run", routePath],
  // ...
})
```

Change the function signature to accept `pathname` instead of `entryFile`, and pass the route pathname directly:

```typescript
async function executeCanonicalFlow(options: {
  readonly appRoot: string
  readonly input: Record<string, unknown>
  readonly pathname: string
  readonly transcriptPath: string
}): Promise<unknown> {
  const runnerResult = await runCommand({
    args: ["exec", "dawn", "run", options.pathname],
    command: "pnpm",
    cwd: options.appRoot,
    stdin: JSON.stringify(options.input),
    transcriptPath: options.transcriptPath,
  })
  const payload = JSON.parse(runnerResult.stdout) as { readonly output: unknown }

  return payload.output
}
```

- [ ] **Step 2: Update the callers of `executeCanonicalFlow`**

In `runSmokeScenario`, the call currently passes `entryFile`:

```typescript
const output = await executeCanonicalFlow({
  appRoot: generatedApp.appRoot,
  entryFile: discoveredRoute.entryFile,
  input: overlay.input,
  transcriptPath,
})
```

Change to pass `pathname`:

```typescript
const output = await executeCanonicalFlow({
  appRoot: generatedApp.appRoot,
  input: overlay.input,
  pathname: discoveredRoute.pathname,
  transcriptPath,
})
```

- [ ] **Step 3: Remove unused `normalizePrivatePath` if no longer needed**

Check if `normalizePrivatePath` is still used elsewhere in the file. It's used in `compileDiscoveredRoute` (lines 355-357), so keep it. Only the call in `executeCanonicalFlow` is removed.

- [ ] **Step 4: Run the smoke tests**

Run: `pnpm vitest run test/smoke/run-smoke.test.ts`

Expected: Both smoke tests pass. Note: these tests have a 180s timeout and take a while — they scaffold a full app, install, typecheck, compile, and execute.

- [ ] **Step 5: Commit**

```bash
git add test/smoke/run-smoke.test.ts
git commit -m "test: update smoke tests to pass route pathnames to dawn run"
```

---

### Task 8: Run full test suite and lint

**Files:** None (verification only)

- [ ] **Step 1: Run full cli test suite**

Run: `cd packages/cli && pnpm vitest run`

Expected: All tests pass.

- [ ] **Step 2: Run linter**

Run: `cd packages/cli && pnpm biome check --write .`

Expected: No errors (or auto-fixed).

- [ ] **Step 3: Run typecheck**

Run: `cd packages/cli && pnpm exec tsc --noEmit`

Expected: Clean.

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A && git commit -m "style: lint fixes"
```

(Only if there were lint fixes to commit.)
