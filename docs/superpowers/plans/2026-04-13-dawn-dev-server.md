# Dawn Dev Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `dawn dev` as Dawn’s watch-first local runtime command, serving the whole app from `cwd` over the shared `/runs/wait` contract and proving parity against `dawn run --url`.

**Architecture:** Build the local server in two layers. First add a narrow runtime-server primitive that can discover an app, build a runtime registry, expose `/healthz` and `/runs/wait`, and normalize request-vs-execution failures. Then add the parent `dawn dev` command that owns child-process lifecycle, watch/restart behavior, readiness gating, and CLI logs. After that, harden the implementation with real served parity tests and downstream packaged-app coverage.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript, Commander, Node child_process/http/fs/watch APIs, Dawn core discovery, Vitest projects, packaged-app harness helpers

---

## Scope Guard

This plan covers one subsystem: Dawn’s local development runtime server.

It includes:

- `dawn dev`
- local `/healthz` and `/runs/wait`
- app-wide runtime registry for `graph.ts` and `workflow.ts`
- parent/child restart orchestration
- served parity coverage against real `dawn dev`
- downstream generated-app server coverage

It does not include:

- production serving or deployment
- `dawn serve`
- hot module replacement or partial route reload
- trace collection beyond the existing LangSmith-aligned boundary
- broadening the shared server contract beyond what the approved spec defines

## File Structure Map

- CLI command and process orchestration:
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/commands/dev.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/dev-session.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/dev-child.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/watch-app.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/health.ts`
- Runtime server contract:
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-registry.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-server.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/server-errors.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route-server.ts`
- CLI and local server tests:
  - Create: `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- Framework served parity coverage:
  - Modify: `/Users/blove/repos/dawn/test/runtime/support/fake-agent-server.ts`
  - Create: `/Users/blove/repos/dawn/test/runtime/support/dev-server.ts`
  - Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
  - Modify: `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
  - Modify: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
  - Modify: `/Users/blove/repos/dawn/package.json`
- Downstream packaged-app server coverage:
  - Modify: `/Users/blove/repos/dawn/test/generated/harness.ts`
  - Modify: `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts`
  - Modify: `/Users/blove/repos/dawn/test/generated/vitest.config.ts`
  - Modify: `/Users/blove/repos/dawn/test/harness/packaged-app.ts`
  - Modify: `/Users/blove/repos/dawn/scripts/publish-smoke.mjs`

## Task 1: Build The Local Runtime Server Primitive

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-registry.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-server.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/server-errors.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route-server.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`

- [ ] **Step 1: Write the failing runtime-server tests**

Add failing tests in:
- `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts`
- `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`

Cover:
- `GET /healthz` returns `200 { "status": "ready" }` only after the server is fully ready
- `POST /runs/wait` executes `graph.ts` and `workflow.ts` entries by mode-qualified `assistant_id`
- `metadata.dawn.*` mismatch is rejected as a non-`200` non-`execution_error` request failure
- malformed request bodies and unknown `assistant_id` are non-`200` request failures
- actual route exceptions return `500` with `error.kind: "execution_error"`
- `dawn run --url` keeps treating non-`200` request failures as transport/request failures rather than normalized execution failures

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/dev-command.test.ts`
- `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`

Expected: FAIL because no local runtime server exists yet.

- [ ] **Step 3: Implement runtime registry construction**

Create `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-registry.ts` with one responsibility:
- discover the Dawn app once from a resolved app root
- enumerate executable `graph.ts` and `workflow.ts` entries only
- derive `routeId`, `routePath`, `mode`, and mode-qualified `assistant_id`
- expose a narrow lookup API for `/runs/wait`

Keep `route.ts`, `state.ts`, and non-runtime files out of the executable registry.

- [ ] **Step 4: Implement the local HTTP server**

Create:
- `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-server.ts`
- `/Users/blove/repos/dawn/packages/cli/src/lib/dev/server-errors.ts`

The server must:
- bind localhost only
- expose `GET /healthz`
- expose `POST /runs/wait`
- reject request-contract failures without using `error.kind: "execution_error"`
- normalize actual route execution failures into the shared `500` execution-error envelope
- stop accepting new requests during shutdown and support in-flight cancellation

Reuse existing route execution primitives instead of duplicating in-process runtime logic.

- [ ] **Step 5: Tighten client-side server normalization where needed**

Update:
- `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route-server.ts`
- `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`

So the client path and local server agree on:
- what counts as request-contract failure
- what counts as execution failure
- how `execution_error` is reserved

- [ ] **Step 6: Run the focused tests to verify they pass**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/dev-command.test.ts`
- `pnpm --filter @dawn-ai/cli exec vitest --run test/run-command.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-registry.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/dev/server-errors.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/runtime/execute-route-server.ts packages/cli/test/dev-command.test.ts packages/cli/test/run-command.test.ts
git commit -m "feat: add dawn dev runtime server"
```

## Task 2: Add The Parent `dawn dev` Lifecycle Command

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/dev.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/dev-session.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/dev-child.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/watch-app.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/health.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`

- [ ] **Step 1: Write the failing lifecycle tests**

Extend `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts` with cases for:
- `dawn dev` discovers the app from `cwd`
- startup output prints the listening URL
- the child serves on a stable port
- a watched route edit triggers one restart and the new behavior becomes visible after readiness
- bursty edits during restart coalesce into at most one follow-up restart
- an in-flight `/runs/wait` request canceled by restart surfaces as a non-execution failure
- a bad watched edit leaves the parent alive in a broken-but-watching state
- a later fixing edit recovers readiness
- changing `appDir` outside the discovered app root terminates the session as a fatal config error
- a restart-time environment failure, such as port rebinding failure, terminates the session as fatal
- a stuck child is force-killed after the shutdown timeout and replaced

- [ ] **Step 2: Run the focused lifecycle suite to verify it fails**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/dev-command.test.ts`

Expected: FAIL because `dawn dev` and the parent/child session manager do not exist yet.

- [ ] **Step 3: Implement the `dawn dev` command**

Create `/Users/blove/repos/dawn/packages/cli/src/commands/dev.ts` and register it from `/Users/blove/repos/dawn/packages/cli/src/index.ts`.

Initial command contract:
- `dawn dev`
- app discovery from the process `cwd` using the shared upward-search semantics
- optional `--port`
- no deployment or serve aliases
- no implicit invocation of `dawn run`

- [ ] **Step 4: Implement parent/child lifecycle orchestration**

Create:
- `/Users/blove/repos/dawn/packages/cli/src/lib/dev/dev-session.ts`
- `/Users/blove/repos/dawn/packages/cli/src/lib/dev/dev-child.ts`
- `/Users/blove/repos/dawn/packages/cli/src/lib/dev/watch-app.ts`
- `/Users/blove/repos/dawn/packages/cli/src/lib/dev/health.ts`

The parent must:
- resolve app root before first child start
- watch the app root and `dawn.config.ts`
- restart on relevant changes
- gate readiness on `/healthz`
- coalesce overlapping restart requests
- distinguish fatal startup/env failures from recoverable watched-config failures
- surface restart-induced request cancellation as a non-execution failure
- keep the port stable across restarts

The child must:
- own the listening socket
- boot the runtime server
- report readiness only after registry + HTTP startup complete
- cancel in-flight `/runs/wait` requests during shutdown

- [ ] **Step 5: Run the focused lifecycle verification**

Run:
- `pnpm --filter @dawn-ai/cli exec vitest --run test/dev-command.test.ts`
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/commands/dev.ts packages/cli/src/lib/dev/dev-session.ts packages/cli/src/lib/dev/dev-child.ts packages/cli/src/lib/dev/watch-app.ts packages/cli/src/lib/dev/health.ts packages/cli/test/dev-command.test.ts packages/cli/package.json
git commit -m "feat: add dawn dev lifecycle command"
```

## Task 3: Replace Fake-Server Parity With Real `dawn dev` Coverage

**Files:**
- Create: `/Users/blove/repos/dawn/test/runtime/support/dev-server.ts`
- Modify: `/Users/blove/repos/dawn/test/runtime/support/fake-agent-server.ts`
- Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
- Modify: `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
- Modify: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
- Modify: `/Users/blove/repos/dawn/package.json`

- [ ] **Step 1: Write the failing served-parity tests**

Extend `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts` with cases that start a real `dawn dev` process and assert parity for:
- passing `graph.ts`
- failing `graph.ts`
- passing `workflow.ts`
- failing `workflow.ts`
- request-contract failure branches against the real local server
- restart-induced cancellation surfaced as a non-execution failure

- [ ] **Step 2: Run the runtime lane to verify it fails**

Run:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`

Expected: FAIL because the runtime harness still depends on fake-server assumptions.

- [ ] **Step 3: Add a reusable real-dev-server test helper**

Create `/Users/blove/repos/dawn/test/runtime/support/dev-server.ts` to:
- spawn `dawn dev`
- wait for `/healthz`
- stream logs for test diagnostics
- trigger shutdown and await clean exit
- provide helpers for file edits and readiness transitions

Keep `/Users/blove/repos/dawn/test/runtime/support/fake-agent-server.ts` only where the fake server still adds value for isolated client transport tests.

- [ ] **Step 4: Update runtime harness wiring**

Modify:
- `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
- `/Users/blove/repos/dawn/test/runtime/vitest.config.ts`
- `/Users/blove/repos/dawn/scripts/harness-report.mjs`
- `/Users/blove/repos/dawn/package.json`

So the runtime lane exercises real `dawn dev` parity without destabilizing the existing smoke lane.

- [ ] **Step 5: Run the runtime verification**

Run:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
- `pnpm verify:harness:runtime`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/runtime/support/dev-server.ts test/runtime/support/fake-agent-server.ts test/runtime/run-runtime-contract.test.ts test/runtime/vitest.config.ts scripts/harness-report.mjs package.json
git commit -m "test: add real dawn dev runtime parity"
```

## Task 4: Add Downstream Packaged-App `dawn dev` Coverage

**Files:**
- Modify: `/Users/blove/repos/dawn/test/generated/harness.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/vitest.config.ts`
- Modify: `/Users/blove/repos/dawn/test/harness/packaged-app.ts`
- Modify: `/Users/blove/repos/dawn/scripts/publish-smoke.mjs`

- [ ] **Step 1: Write the failing downstream server tests**

Extend `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts` and the generated harness so each generated runtime fixture also proves:
- `dawn dev` starts successfully in the packaged app
- `/healthz` gates readiness
- `dawn run --url` matches the in-process result shape
- `dawn test` server scenarios pass against the running `dawn dev`

- [ ] **Step 2: Run the generated runtime suite to verify it fails**

Run:
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`

Expected: FAIL because generated-app server orchestration is not wired yet.

- [ ] **Step 3: Extend the packaged-app harness**

Modify:
- `/Users/blove/repos/dawn/test/generated/harness.ts`
- `/Users/blove/repos/dawn/test/harness/packaged-app.ts`

To:
- start `dawn dev` inside packed/generated apps
- wait for `/healthz`
- drive `dawn run --url`
- drive `dawn test` server scenarios
- capture stdout/stderr artifacts for failing runs

- [ ] **Step 4: Fold the served path into release smoke coverage**

Update `/Users/blove/repos/dawn/scripts/publish-smoke.mjs` so publish smoke still proves the packaged consumer path after `dawn dev` lands.

Keep the lane narrow and deterministic. Do not add live external network dependencies.

- [ ] **Step 5: Run the downstream verification**

Run:
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`
- `node scripts/publish-smoke.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/generated/harness.ts test/generated/run-generated-runtime-contract.test.ts test/generated/vitest.config.ts test/harness/packaged-app.ts scripts/publish-smoke.mjs
git commit -m "test: add packaged dawn dev coverage"
```

## Final Verification

- [ ] **Step 1: Run the full repo validation**

Run:
- `pnpm ci:validate`

Expected: PASS.

- [ ] **Step 2: Run explicit dev-runtime checks**

Run:
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`
- `pnpm --filter @dawn-ai/cli test`
- `pnpm --filter @dawn-ai/cli typecheck`
- `node scripts/publish-smoke.mjs`

Expected: PASS.

- [ ] **Step 3: Re-read the spec against the finished diff**

Confirm the implementation still matches:
- `/Users/blove/repos/dawn/docs/superpowers/specs/2026-04-13-dawn-dev-server-design.md`

Pay special attention to:
- `dawn dev` owning local lifecycle only
- shared `/runs/wait` contract
- `/healthz` readiness semantics
- fatal vs recoverable watched-config behavior
- request-contract failures vs execution failures

- [ ] **Step 4: Merge back to `main` only after green verification**

Use a fast-forward or normal local merge as appropriate, then rerun:
- `pnpm ci:validate`
- `node scripts/publish-smoke.mjs`

on merged `main` before claiming completion.
