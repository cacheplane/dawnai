# Dawn Runtime Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Dawn’s first runtime execution layer by shipping `dawn run`, the first public `dawn test`, and a dedicated runtime-contract harness lane for `graph.ts` and `workflow.ts`.

**Architecture:** Follow the runtime-execution spec’s rollout order exactly: harden the shared execution primitive through direct runtime-contract fixtures first, then expose `dawn run`, then build `dawn test` on top, and finally wire the runtime lane into the root harness and CI. Keep serving, execution, and testing separate, and keep v1 results minimal and structural.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript, Commander, Vitest projects, Node child processes, Dawn core discovery primitives

---

## Scope Guard

This plan covers one subsystem: Dawn runtime execution.

It includes:

- direct runtime-contract fixtures
- `dawn run`
- `dawn test`
- runtime lane integration into the root harness

It does not include:

- server-backed execution
- transport over a local HTTP runtime
- trace-level result contracts
- live model/tool/network execution
- file-based `--input` / `--output` flags
- adding the runtime lane to `pnpm test`

## File Structure Map

- Runtime fixtures and harness:
  - Create: `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
  - Create: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
  - Create: `/Users/blove/repos/dawn/test/runtime/fixtures/graph-basic.overlay.json`
  - Create: `/Users/blove/repos/dawn/test/runtime/fixtures/graph-failure.overlay.json`
  - Create: `/Users/blove/repos/dawn/test/runtime/fixtures/workflow-basic.overlay.json`
  - Create: `/Users/blove/repos/dawn/test/runtime/fixtures/workflow-failure.overlay.json`
  - Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- CLI command surface:
  - Create: `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/commands/test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
- CLI runtime helpers:
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/register-tsx-loader.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/load-run-scenarios.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts`
- CLI package wiring:
  - Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- CLI tests:
  - Create: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/routes-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/verify-command.test.ts`
- Harness orchestration:
  - Modify: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
  - Modify: `/Users/blove/repos/dawn/package.json`
  - Modify: `/Users/blove/repos/dawn/.github/workflows/ci.yml`

## Task 1: Add Direct Runtime-Contract Fixtures And Lane

**Files:**
- Create: `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
- Create: `/Users/blove/repos/dawn/test/runtime/fixtures/graph-basic.overlay.json`
- Create: `/Users/blove/repos/dawn/test/runtime/fixtures/graph-failure.overlay.json`
- Create: `/Users/blove/repos/dawn/test/runtime/fixtures/workflow-basic.overlay.json`
- Create: `/Users/blove/repos/dawn/test/runtime/fixtures/workflow-failure.overlay.json`
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/register-tsx-loader.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`

- [ ] **Step 1: Write the failing runtime-contract tests**

Create `test/runtime/run-runtime-contract.test.ts` covering:
- passing `graph.ts` execution through direct module execution
- failing `graph.ts` execution with stable error classification
- passing `workflow.ts` execution through direct module execution
- failing `workflow.ts` execution with stable error classification
- generated-app scaffolding remains compatible with a dedicated runtime lane

At this stage, do not depend on `dawn run` or `dawn test` yet. The runtime lane should harden the shared execution primitive first.

- [ ] **Step 2: Run the runtime-contract lane to verify it fails**

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
Expected: FAIL because the runtime lane and fixtures do not exist.

- [ ] **Step 3: Create the runtime Vitest config**

Create `test/runtime/vitest.config.ts` as a dedicated runtime lane project. Keep it separate from `vitest.workspace.ts`; `pnpm test` should remain source-test-only.

- [ ] **Step 4: Create the runtime overlay fixtures**

Add deterministic overlays for:
- `graph-basic`
- `graph-failure`
- `workflow-basic`
- `workflow-failure`

These fixtures must stay hermetic and deterministic.

- [ ] **Step 5: Implement the direct runtime-contract harness**

Implement `test/runtime/run-runtime-contract.test.ts` so it:
- materializes a generated app from the existing template path
- applies one runtime overlay
- installs dependencies
- invokes one shared execution primitive directly rather than reimplementing route loading inside the test
- performs direct module execution assertions only
- captures logs and artifacts on failure

Keep this lane separate from `test/smoke/run-smoke.test.ts`.

- [ ] **Step 6: Implement the shared in-process execution primitive**

Create:
- `packages/cli/src/lib/runtime/register-tsx-loader.ts`
- `packages/cli/src/lib/runtime/execute-route.ts`
- `packages/cli/src/lib/runtime/result.ts`

Use one concrete v1 in-process loading strategy:
- add `tsx` as a runtime dependency of `@dawn-ai/cli`
- register the `tsx` loader inside the current process
- use dynamic import after loader registration so source `graph.ts`, `workflow.ts`, and later `run.test.ts` modules execute in-process

Keep the primitive reusable by:
- the runtime-contract lane
- `dawn run`
- `dawn test`

The primitive should emit normalized structural results for:
- success
- app discovery failure
- route resolution / unsupported-boundary failure
- modeled execution failure

- [ ] **Step 7: Tighten scaffold coverage where needed**

Update `packages/create-dawn-app/test/create-app.test.ts` if needed so generated apps continue to expose the route and package wiring the runtime lane expects.

- [ ] **Step 8: Run runtime-contract verification**

Run:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
- `pnpm exec vitest --run --config test/smoke/vitest.config.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add test/runtime packages/cli/src/lib/runtime/register-tsx-loader.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/runtime/result.ts packages/cli/package.json packages/create-dawn-app/test/create-app.test.ts
git commit -m "test: add direct runtime contract coverage"
```

## Task 2: Add `dawn run`

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/register-tsx-loader.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- Create: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`

- [ ] **Step 1: Write the failing `dawn run` command tests**

Create `packages/cli/test/run-command.test.ts` covering:
- valid `graph.ts` route execution from app-root-relative path
- valid `workflow.ts` route execution
- relative-path route execution from inside a route directory
- stdout JSON success result with explicit assertions for:
  - `appRoot`
  - requested `routePath`
  - resolved `mode`
  - `status`
  - `output`
- stdout JSON modeled app-discovery failure with exit `1` and explicit `error.kind` / `error.message`
- stdout JSON modeled route-resolution or unsupported-boundary failure with exit `1` and explicit `error.kind` / `error.message`
- stdout JSON modeled execution failure with exit `1` and explicit `error.kind` / `error.message`
- stderr-only CLI or infrastructure failure with exit `2`

- [ ] **Step 2: Run the `dawn run` tests to verify they fail**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`
Expected: FAIL because the command and runtime helpers do not exist.

- [ ] **Step 3: Implement route target resolution**

Create `packages/cli/src/lib/runtime/resolve-route-target.ts` that:
- discovers the Dawn app root from `cwd` / `--cwd`
- resolves non-relative route paths from the app root
- resolves `.` / `..` paths from the caller’s current working directory
- validates the target exists and ends in `graph.ts` or `workflow.ts`
- returns resolved route metadata needed by execution

- [ ] **Step 4: Extend the shared primitive for CLI usage**

Update the existing shared execution primitive from Task 1 so it:
- stays independent from stdin parsing
- accepts resolved route metadata and parsed JSON input
- returns the normalized structural result used by the runtime lane and CLI commands
- remains in-process by using the registered `tsx` loader rather than a child worker

- [ ] **Step 5: Implement the `dawn run` command**

Create `packages/cli/src/commands/run.ts` that:
- accepts a positional route path
- accepts `--cwd`
- reads stdin JSON
- delegates to the runtime helpers
- writes JSON to stdout for success and modeled failures
- writes human-readable infrastructure errors to stderr only for exit `2`
- exits `0`, `1`, or `2` per the spec

Register it in `packages/cli/src/index.ts`.

- [ ] **Step 6: Run `dawn run` tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`
Expected: PASS.

- [ ] **Step 7: Run CLI package verification**

Run:
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/run.ts packages/cli/src/lib/runtime packages/cli/src/index.ts packages/cli/test/run-command.test.ts
git commit -m "feat: add dawn run"
```

## Task 3: Add `dawn test`

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/test.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/load-run-scenarios.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`

- [ ] **Step 1: Write the failing `dawn test` command tests**

Create `packages/cli/test/test-command.test.ts` covering:
- discovering all `run.test.ts` files under the configured `appDir` route root
- narrowing to one scenario file
- narrowing to one route directory including descendants
- caller-cwd-relative narrowing behavior
- app-root-relative narrowing behavior
- honoring an explicit local `target` when both `graph.ts` and `workflow.ts` exist in the same route directory
- rejecting route-file narrowing input in v1
- rejecting missing or invalid `target`
- rejecting cross-directory targets
- exit `0` when all scenarios pass
- passing a scenario whose `expect.status` is `failed` for an expected modeled route failure
- failing when `expect.status` does not match the actual route result
- failing when minimal `expect.output` assertions do not match
- failing when optional `expect.error.kind` does not match
- failing when optional `expect.error.message` does not match
- exit `1` when one scenario assertion fails
- exit `1` when an unexpected route-execution failure occurs inside a scenario
- exit `1` when no scenarios are found
- exit `2` on scenario-load infrastructure failures
- human-readable output distinguishes scenario-load vs route-execution vs assertion failures

- [ ] **Step 2: Run the `dawn test` tests to verify they fail**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run test/test-command.test.ts`
Expected: FAIL because the command and scenario loader do not exist.

- [ ] **Step 3: Implement scenario discovery and loading**

Create `packages/cli/src/lib/runtime/load-run-scenarios.ts` that:
- resolves the configured Dawn routes root from app discovery
- discovers `run.test.ts` files
- supports no-arg and narrowed-path discovery
- enforces local-only scenario targets:
  - `./graph.ts`
  - `./workflow.ts`
- rejects cross-directory targets
- loads default-exported scenario arrays

- [ ] **Step 4: Implement the `dawn test` command**

Create `packages/cli/src/commands/test.ts` that:
- accepts optional positional narrowing path
- accepts `--cwd`
- uses the same shared execution primitive behind `dawn run`
- prints concise human-readable pass/fail output
- evaluates scenario assertions for:
  - `expect.status`
  - minimal `expect.output`
  - optional `expect.error.kind`
  - optional `expect.error.message`
- distinguishes scenario-load vs route-execution vs assertion failures
- returns exit `0`, `1`, or `2` per the spec

Register it in `packages/cli/src/index.ts`.

- [ ] **Step 5: Run `dawn test` tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run test/test-command.test.ts`
Expected: PASS.

- [ ] **Step 6: Run CLI package verification**

Run:
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/test.ts packages/cli/src/lib/runtime/load-run-scenarios.ts packages/cli/src/index.ts packages/cli/test/test-command.test.ts
git commit -m "feat: add dawn test"
```

## Task 4: Extend Runtime Lane And Wire It Into Root Harness

**Files:**
- Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
- Modify: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
- Modify: `/Users/blove/repos/dawn/package.json`
- Modify: `/Users/blove/repos/dawn/.github/workflows/ci.yml`

- [ ] **Step 1: Extend the failing runtime-contract tests to cover CLI execution**

Update `test/runtime/run-runtime-contract.test.ts` so it also expects:
- `dawn run` CLI execution for a passing `graph.ts` case
- `dawn run` CLI execution for a failing `graph.ts` case
- `dawn run` CLI execution for a passing `workflow.ts` case
- `dawn run` CLI execution for a failing `workflow.ts` case

- [ ] **Step 2: Run the runtime-contract lane to verify it fails**

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
Expected: FAIL because CLI execution coverage is not wired yet.

- [ ] **Step 3: Implement CLI execution coverage in the runtime lane**

Update `test/runtime/run-runtime-contract.test.ts` so the lane:
- reuses the generated app setup
- runs direct module execution assertions
- runs `dawn run` CLI assertions
- preserves artifacts and transcripts for both surfaces

- [ ] **Step 4: Add the runtime lane to root harness orchestration**

Update `scripts/harness-report.mjs` to add a `runtime` lane that runs:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`

Update `package.json` scripts so:
- `verify:harness` includes `runtime`
- there is a dedicated `verify:harness:runtime` helper
- `pnpm test` remains source-test-only

- [ ] **Step 5: Update CI lane separation**

Update `.github/workflows/ci.yml` so CI clearly separates:
- source tests
- framework verification
- runtime-contract verification
- smoke verification

- [ ] **Step 6: Run root verification**

Run:
- `pnpm verify:harness:self-test`
- `pnpm verify:harness`
- `pnpm ci:validate`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/runtime/run-runtime-contract.test.ts scripts/harness-report.mjs package.json .github/workflows/ci.yml
git commit -m "chore: add runtime harness lane"
```

## Final Verification Gate

Before considering this plan fully implemented, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm verify:harness:self-test
pnpm verify:harness
pnpm exec vitest --run --config test/runtime/vitest.config.ts
pnpm exec vitest --run --config test/smoke/vitest.config.ts
node scripts/publish-smoke.mjs
pnpm ci:validate
```

Expected:
- all commands pass
- `pnpm test` remains source-test-only
- `dawn run` executes both `graph.ts` and `workflow.ts`
- `dawn run` emits stable JSON results for success, app discovery failure, route resolution failure, and modeled execution failure
- `dawn test` discovers and runs colocated `run.test.ts` scenarios from the configured route root
- runtime-contract coverage stays separate from smoke startup coverage
- root harness reports framework, runtime, and smoke lanes coherently
