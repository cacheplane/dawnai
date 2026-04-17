# Remove Companion-File Semantics from `dawn test`

## Goal

Remove the `target` field and companion-file pattern (`graph.ts` / `workflow.ts`) from `dawn test` scenarios. Mode is inferred from the route's `index.ts` export at load time, the same way every other CLI command discovers it.

## Background

The current `dawn test` scenario schema requires a `target` field pointing to a companion file:

```typescript
{
  name: "greeting works",
  target: "./graph.ts",   // ← determines mode, must exist on disk
  input: { tenant: "acme" },
  expect: { status: "passed", output: { greeting: "Hello, acme!" } },
}
```

This was designed before the authoring SDK milestone unified route entry points to `index.ts` with named exports. Now that `loadRouteKind` can infer mode from `index.ts`, the companion-file indirection is unnecessary complexity.

## Design

### Scenario schema (after)

The `target` field is removed:

```typescript
{
  name: "greeting works",
  input: { tenant: "acme" },
  expect: { status: "passed", output: { greeting: "Hello, acme!" } },
}
```

`mode`, `routeFile`, `routePath`, and `routeId` are derived from the sibling `index.ts` at load time. Fields `run`, `expect`, `assert`, `input`, and `name` are unchanged.

### Load-time resolution

When `loadScenarioFile` processes a `run.test.ts`:

1. Resolve sibling `index.ts` in the same directory — error if missing.
2. Call `loadRouteKind(indexFile)` to get mode — error if `index.ts` exports neither `workflow` nor `graph`.
3. Derive `routeId` and `routePath` from `deriveRouteIdentity` (unchanged).
4. Attach `mode`, `routeFile`, `routeId`, `routePath` to every scenario in that file (loaded once per file, shared across scenarios).

### Validation changes

- Remove `target` validation (`=== "./graph.ts" || === "./workflow.ts"`).
- Remove `pathExists(targetFile)` check for companion files.
- Add: error if sibling `index.ts` doesn't exist next to `run.test.ts`.
- Add: error if `loadRouteKind` fails (route exports neither workflow nor graph).
- All other validation unchanged (name, input, expect/assert, meta, error shape).

### Narrowing changes

- Remove the `graph.ts` / `workflow.ts` filename rejection in `discoverScenarioFiles` (the "Route-file narrowing is not supported in v1" error path).
- Narrowing to directories or `run.test.ts` files works unchanged.

### Execution path

In `test.ts`, `runScenario` passes `scenario.mode` to `executeRouteServer` for server-backed scenarios and `scenario.routeFile` to `executeRoute` for in-process scenarios. This is unchanged — mode is just derived differently.

### Companion files removed

- Delete standalone `graph.ts` / `workflow.ts` companion files from all fixtures.
- The handwritten runtime fixture's `graph.ts` (which re-exports from `index.ts`) is deleted.
- Test fixtures that use standalone `graph.ts` or `workflow.ts` without a sibling `index.ts` get consolidated — the export moves into `index.ts`.

### Files modified

**Source:**
- `packages/cli/src/lib/runtime/load-run-scenarios.ts` — remove `target` validation, add `index.ts` + `loadRouteKind` resolution
- `packages/cli/src/commands/test.ts` — no changes expected (consumes `LoadedRunScenario` unchanged)

**Tests:**
- `packages/cli/test/test-command.test.ts` — update all fixtures: companion files become `index.ts`, remove `target` from scenarios, delete tests for target validation, update `routePath` in meta assertions
- `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts` — remove `target` field
- `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/graph.ts` — delete file

**Tests deleted:**
- "rejects missing or invalid targets" — validated `target`, which no longer exists
- "rejects cross-directory targets" — same reason
- "honors explicit local targets when both graph.ts and workflow.ts exist" — contradicts one-mode-per-route
- "rejects route-file narrowing input in v1" — no companion files to reject

**Tests added:**
- "rejects scenarios when sibling index.ts is missing" — new error path
- "rejects scenarios when index.ts exports neither workflow nor graph" — new error path

### Types

`LoadedRunScenario` interface is unchanged — it still carries `mode`, `routeFile`, `routeId`, `routePath`. The only change is that `mode` is derived from `loadRouteKind` instead of from the `target` filename.

The raw scenario type (what authors export from `run.test.ts`) loses the `target` field. Validation in `validateScenario` is updated accordingly.

### Error messages

| Condition | Message |
|-----------|---------|
| No sibling `index.ts` | `Scenario file {path} has no sibling index.ts — run.test.ts must be colocated with a route entry point` |
| `index.ts` exports neither | `Scenario file {path} sibling index.ts exports neither "workflow" nor "graph"` |
