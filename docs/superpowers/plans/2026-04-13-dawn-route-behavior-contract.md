# Dawn Route Behavior Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Dawn’s runtime contract so `dawn run`, `dawn run --url`, `dawn test`, the framework runtime lane, and downstream generated apps all share one richer normalized route-behavior result.

**Architecture:** First formalize the shared result and route-identity primitives, then add server-backed `dawn run`, then expand `dawn test` around the same result contract, then harden the framework runtime harness, and finally add downstream generated-app runtime verification. Keep `dawn serve` out of scope, keep in-process as the default execution mode, and treat the Agent Server stateless run contract as the server transport baseline rather than inventing a new Dawn transport.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript, Commander, Node fetch/http server, Vitest projects, Dawn core discovery primitives, packaged-app harness helpers

---

## Scope Guard

This plan covers one subsystem: Dawn route behavior contract hardening.

It includes:

- richer normalized execution results
- mode-qualified route identity for server transport
- `dawn run --url`
- richer `dawn test` expectations and helper assertions
- framework runtime-lane coverage for server mode
- downstream generated-app runtime verification

It does not include:

- `dawn serve` or `dawn dev` implementation
- live LangSmith trace assertions
- a general-purpose testing DSL
- live network/model integration in default CI lanes
- capability negotiation beyond the documented `/runs/wait` stateless contract

## File Structure Map

- Runtime result and route identity:
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-identity.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- Server-backed run support:
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route-server.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/normalize-server-result.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- `dawn test` contract and helper surface:
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/commands/test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/load-run-scenarios.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/assertions.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/testing/index.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts`
- Framework runtime harness:
  - Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
  - Create: `/Users/blove/repos/dawn/test/runtime/support/fake-agent-server.ts`
  - Modify: `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
  - Modify: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
  - Modify: `/Users/blove/repos/dawn/package.json`
- Downstream generated-app runtime coverage:
  - Create: `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts`
  - Modify: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
  - Modify: `/Users/blove/repos/dawn/test/generated/harness.ts`
  - Modify: `/Users/blove/repos/dawn/test/generated/vitest.config.ts`
  - Modify: `/Users/blove/repos/dawn/test/harness/packaged-app.ts`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/basic-runtime.expected.json`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/custom-app-dir-runtime.expected.json`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/package.json`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/dawn.config.ts`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/src/app/page.tsx`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/src/app/support/[tenant]/graph.ts`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/src/app/support/[tenant]/run.test.ts`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime.expected.json`
- CI wiring:
  - Modify: `/Users/blove/repos/dawn/.github/workflows/ci.yml`

## Task 1: Formalize The Shared Result Contract

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-identity.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
- Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`

- [ ] **Step 1: Write the failing result-contract tests**

Add failing assertions to:
- `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
- `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`

Cover:
- `appRoot` is preserved correctly on success and normalized failure
- `routePath` is app-root-relative
- `routeId` is normalized from the route directory
- `mode`, `status`, and `output` remain intact for successful executions
- `executionSource` exists and is `in-process` for the current path
- `startedAt`, `finishedAt`, and `durationMs` exist
- failure results carry normalized `error.kind`

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`

Expected: FAIL because the richer result contract does not exist yet.

- [ ] **Step 3: Add a route-identity helper**

Create `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-identity.ts` with one clear responsibility:
- derive app-root-relative `routePath`
- derive configured-`appDir`-relative `routeId`
- preserve mode separately so `graph.ts` and `workflow.ts` share route identity but not execution mode

Include focused unit-style tests through the existing command and runtime tests instead of creating a detached test file.

- [ ] **Step 4: Expand the runtime result type**

Update `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/result.ts` so the shared result includes:
- `appRoot`
- `routePath`
- `routeId`
- `mode`
- `status`
- `output`
- `executionSource`
- `startedAt`
- `finishedAt`
- `durationMs`
- normalized `error.kind`
- optional `error.details`
- optional `diagnostics`

Keep the union small and explicit. Do not add trace placeholders.

- [ ] **Step 5: Thread the richer result through the in-process primitive**

Update:
- `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
- `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts`

So the in-process path emits the richer normalized result without changing the default execution semantics.

- [ ] **Step 6: Run the focused tests to verify they pass**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/runtime/result.ts packages/cli/src/lib/runtime/route-identity.ts packages/cli/src/lib/runtime/resolve-route-target.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/commands/run.ts packages/cli/test/run-command.test.ts test/runtime/run-runtime-contract.test.ts
git commit -m "refactor: formalize route execution results"
```

## Task 2: Add Server-Backed `dawn run --url`

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route-server.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/normalize-server-result.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-identity.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`

- [ ] **Step 1: Write the failing server-mode command tests**

Extend `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts` with cases for:
- `dawn run <route> --url <server>` returns the same normalized shape as in-process
- `executionSource` becomes `server`
- `assistant_id` is mode-qualified
- non-`200` transport failures normalize to `server_transport_error`
- malformed server payloads fail as transport errors

Use a local fake HTTP server in the test to keep the path deterministic.

- [ ] **Step 2: Run the focused CLI tests to verify they fail**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`

Expected: FAIL because `--url` support does not exist yet.

- [ ] **Step 3: Implement the server transport primitive**

Create `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route-server.ts` that:
- accepts resolved route metadata plus JSON input and base URL
- issues `POST /runs/wait`
- sends:
  - mode-qualified `assistant_id`
  - raw `input`
  - `metadata.dawn.route_id`
  - `metadata.dawn.route_path`
  - `metadata.dawn.mode`
  - `on_completion: "delete"`

Create `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/normalize-server-result.ts` that:
- normalizes successful server responses into the Dawn success result
- classifies non-`200` and malformed responses as:
  - `execution_error` when Dawn can confidently map the server payload into the normalized execution-error contract
  - otherwise `server_transport_error`
- preserves raw HTTP status and payload only in `diagnostics`, and only for explicit debug/verbose paths

- [ ] **Step 4: Extend the run command surface**

Update `/Users/blove/repos/dawn/packages/cli/src/commands/run.ts` to:
- accept `--url <baseUrl>`
- keep stdin/stdout and exit-code behavior identical
- use in-process execution when `--url` is absent
- use the server primitive when `--url` is present

Do not add lifecycle flags or implicit server startup.

- [ ] **Step 5: Run the CLI verification**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route-server.ts packages/cli/src/lib/runtime/normalize-server-result.ts packages/cli/src/commands/run.ts packages/cli/src/lib/runtime/route-identity.ts packages/cli/test/run-command.test.ts packages/cli/package.json
git commit -m "feat: add server-backed dawn run"
```

## Task 3: Expand `dawn test` Assertions And Helper Surface

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/cli/src/commands/test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/load-run-scenarios.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/assertions.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/testing/index.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts`

- [ ] **Step 1: Write the failing `dawn test` assertion tests**

Extend `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts` with cases for:
- deep-partial nested output matching
- exact array matching
- `meta.mode`, `meta.routeId`, `meta.routePath`, and `meta.executionSource`
- `{ includes: "..." }` error message matching
- `run.url` forwarding to the server-backed execution path
- declarative `expect` running before `assert(result)`
- `assert(result)` not running when declarative matching already failed

- [ ] **Step 2: Run the focused `dawn test` suite to verify it fails**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/test-command.test.ts`

Expected: FAIL because the richer scenario contract does not exist yet.

- [ ] **Step 3: Pin the loaded scenario shape**

Update `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/load-run-scenarios.ts` so it validates:
- required `name`
- required colocated-only `target`, exactly `./graph.ts` or `./workflow.ts`
- required `input`
- at least one of `expect` or `assert`
- optional `run.url`
- `expect.status`
- optional `expect.output`
- optional `expect.error.kind`
- optional `expect.error.message`
- `expect.meta`
- `{ includes: string }` error-message matcher

Keep validation errors explicit and deterministic.

- [ ] **Step 4: Implement shared assertion helpers**

Create `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/assertions.ts` with:
- `expectOutput`
- `expectError`
- `expectMeta`

Matching rules:
- object output uses deep-partial subset matching
- primitive output uses exact matching
- arrays use exact matching
- helper failures produce Dawn-owned diff messages

Create `/Users/blove/repos/dawn/packages/cli/src/testing/index.ts` that re-exports the public helper surface for `@dawn-ai/cli/testing`.

- [ ] **Step 5: Update the test command runner**

Modify `/Users/blove/repos/dawn/packages/cli/src/commands/test.ts` so it:
- evaluates declarative `expect` first
- skips `assert(result)` when declarative matching fails
- runs `assert(result)` only after declarative success
- supports `run.url` by calling the same server-backed primitive used by `dawn run`
- prints clearer failure messages for nested output and metadata mismatches

- [ ] **Step 6: Wire package exports**

Update `/Users/blove/repos/dawn/packages/cli/package.json` so published consumers can import `@dawn-ai/cli/testing`.

- [ ] **Step 7: Verify the published testing export path**

Add one focused packed-consumer assertion to the existing CLI or generated test surface that proves:
- the packed `@dawn-ai/cli` tarball exposes `@dawn-ai/cli/testing`
- a consumer can import `expectOutput`, `expectError`, and `expectMeta`

Keep this verification small and explicit rather than relying on repo-local resolution.

- [ ] **Step 8: Run CLI verification**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/test-command.test.ts`
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/commands/test.ts packages/cli/src/lib/runtime/load-run-scenarios.ts packages/cli/src/lib/runtime/assertions.ts packages/cli/src/testing/index.ts packages/cli/package.json packages/cli/test/test-command.test.ts
git commit -m "feat: expand dawn test assertions"
```

## Task 4: Extend The Framework Runtime Harness

**Files:**
- Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
- Create: `/Users/blove/repos/dawn/test/runtime/support/fake-agent-server.ts`
- Modify: `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
- Modify: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
- Modify: `/Users/blove/repos/dawn/package.json`

- [ ] **Step 1: Write the failing runtime-harness tests for server mode**

Extend `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts` to expect:
- direct in-process execution with richer result fields
- CLI execution with richer result fields
- server-backed CLI execution through a controlled local fake Agent Server
- parity assertions between in-process and server execution for:
  - `routeId`
  - `routePath`
  - `mode`
  - `status`
  - output / normalized failure
  - `executionSource` differing only where expected

- [ ] **Step 2: Run the runtime lane to verify it fails**

Run:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`

Expected: FAIL because the server-backed runtime lane does not exist yet.

- [ ] **Step 3: Add a fake Agent Server helper**

Create `/Users/blove/repos/dawn/test/runtime/support/fake-agent-server.ts` that:
- starts a local HTTP server
- records incoming request bodies
- responds with controlled success and failure payloads for `/runs/wait`
- makes it easy to assert the mode-qualified `assistant_id` and Dawn metadata mapping

Keep this helper local to the runtime lane.

- [ ] **Step 4: Extend the runtime lane implementation**

Update `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts` so each runtime fixture runs:
- direct execution
- `dawn run`
- `dawn run --url`

Persist the richer normalized JSON artifacts for each execution path.

- [ ] **Step 5: Keep harness reporting coherent**

Update:
- `/Users/blove/repos/dawn/scripts/harness-report.mjs`
- `/Users/blove/repos/dawn/package.json`

So the runtime lane remains one lane, but now reports richer result artifacts without changing the top-level harness model.
Persist and report, per execution path:
- normalized result JSON
- command transcript
- artifact location
- execution source
- route identity (`routeId` and `routePath`)

- [ ] **Step 6: Run harness verification**

Run:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
- `pnpm verify:harness:runtime`
- `pnpm verify:harness`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/runtime/run-runtime-contract.test.ts test/runtime/support/fake-agent-server.ts test/runtime/vitest.config.ts scripts/harness-report.mjs package.json
git commit -m "test: extend runtime harness for server mode"
```

## Task 5: Add Downstream Generated-App Runtime Verification

**Files:**
- Create: `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/harness.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/vitest.config.ts`
- Modify: `/Users/blove/repos/dawn/test/harness/packaged-app.ts`
- Create: `/Users/blove/repos/dawn/test/generated/fixtures/basic-runtime.expected.json`
- Create: `/Users/blove/repos/dawn/test/generated/fixtures/custom-app-dir-runtime.expected.json`
- Modify: `/Users/blove/repos/dawn/.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing downstream runtime-contract tests**

Create `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts` covering:
- packaged generated basic app:
  - `dawn run`
  - `dawn run --url`
  - `dawn test`
- packaged generated custom-app-dir app:
  - `dawn run`
  - `dawn run --url`
  - `dawn test`
- one handwritten external app fixture for the route-shape edge case that the generator does not express cleanly:
  - `dawn run`
  - `dawn run --url`
  - `dawn test`

Assert against stable expected JSON fixtures for normalized result shape and scenario output, including external parity checks for:
- `routeId`
- `routePath`
- `mode`
- `status`
- `executionSource`
- output / normalized failure

- [ ] **Step 2: Run the generated-app lane to verify it fails**

Run:
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`

Expected: FAIL because the downstream runtime checks do not exist yet.

- [ ] **Step 3: Extend the generated harness utilities**

Update:
- `/Users/blove/repos/dawn/test/generated/harness.ts`
- `/Users/blove/repos/dawn/test/harness/packaged-app.ts`

So generated tests can:
- scaffold the packaged app once
- run `dawn run`
- start a controlled local fake Agent Server
- run `dawn run --url`
- run `dawn test`
- collect normalized JSON artifacts and transcripts
- stage a checked-in handwritten external app fixture into a temp external repo when a generated template is too blunt

- [ ] **Step 4: Implement the generated runtime-contract tests**

Create `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts` and expected fixtures:
- `/Users/blove/repos/dawn/test/generated/fixtures/basic-runtime.expected.json`
- `/Users/blove/repos/dawn/test/generated/fixtures/custom-app-dir-runtime.expected.json`
- `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime.expected.json`

Add one checked-in handwritten external app fixture under:
- `/Users/blove/repos/dawn/test/generated/fixtures/handwritten-runtime-app/`

Keep the expected fixtures stable by normalizing private temp paths the same way the existing generated-app tests do.

- [ ] **Step 5: Keep the existing generated-app lifecycle lane focused**

Adjust `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts` only where needed so:
- lifecycle verification stays lifecycle-focused
- runtime-behavior verification lives in the new generated-runtime test file

- [ ] **Step 6: Run full generated verification**

Run:
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`
- `node scripts/publish-smoke.mjs`

Expected: PASS.

- [ ] **Step 7: Add CI coverage**

Update `/Users/blove/repos/dawn/.github/workflows/ci.yml` so the existing validation flow continues to cover the generated lane with the new runtime-contract tests included.

- [ ] **Step 8: Commit**

```bash
git add test/generated/run-generated-runtime-contract.test.ts test/generated/run-generated-app.test.ts test/generated/harness.ts test/generated/vitest.config.ts test/generated/fixtures/basic-runtime.expected.json test/generated/fixtures/custom-app-dir-runtime.expected.json test/harness/packaged-app.ts .github/workflows/ci.yml
git commit -m "test: add generated app runtime verification"
```

## Final Verification

- [ ] **Step 1: Run targeted command suites**

Run:
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`

Expected: PASS.

- [ ] **Step 2: Run full repo verification**

Run:
- `pnpm ci:validate`
- `node scripts/publish-smoke.mjs`

Expected: PASS.

- [ ] **Step 3: Re-read the spec and confirm scope**

Check `/Users/blove/repos/dawn/docs/superpowers/specs/2026-04-13-dawn-route-behavior-contract-design.md` against the implementation. Confirm:
- one normalized result contract across in-process and server execution
- mode-qualified server identifiers
- richer `dawn test` expectation and helper model
- framework runtime lane coverage
- downstream generated-app runtime coverage
- no server lifecycle creep into `dawn run`

- [ ] **Step 4: Final commit if needed**

```bash
git status --short
git add -A
git commit -m "feat: harden route behavior contract"
```
