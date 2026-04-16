# Thread Handoff

This document is the operational handoff for the Dawn work completed through the route-authoring milestone now on `main`.

It is intended to let a new thread re-orient quickly without rereading the full superpowers history.

## Current State

- Branch baseline: `main`
- Latest merged milestone: Dawn route authoring
- Current repo intent: Dawn is a TypeScript meta-framework for app structure, route discovery, route validation, type generation, local route execution, local scenario testing, and a local development runtime
- Current repo boundary: Dawn does not own deployment runtime, hosted execution, or LangSmith trace semantics

## Verification Baseline

The current baseline should be treated as green when starting a new thread.

Run these first in a fresh thread:

```bash
pnpm install
pnpm ci:validate
node scripts/publish-smoke.mjs
```

Expected result:

- `pnpm ci:validate` passes
- `node scripts/publish-smoke.mjs` passes

If either fails before new work starts, stop and resolve that baseline issue first.

## What Exists Now

### App and Project Contract

The plumbing needed to unblock real authoring work is now in place.

- `pnpm create dawn-app` is the public scaffold path
- contributor-local scaffold flow is documented in [`../CONTRIBUTORS.md`](../CONTRIBUTORS.md)
- `dawn.config.ts` is intentionally narrow
- `appDir` is the only supported config option today
- route discovery is filesystem-based and now stable enough to build on

### Command Model

The current CLI/runtime split is intentional and should not be casually collapsed:

- `dawn check` validates app structure and configuration
- `dawn routes` reports the discovered route surface
- `dawn typegen` generates route types for the current app
- `dawn verify` validates framework integrity
- `dawn run` executes one route invocation
- `dawn test` runs scenario assertions against route executions
- `dawn dev` owns the local watch-oriented runtime lifecycle

Important boundary:

- `dawn dev` is local-only
- production runtime remains aligned with the Agent Server / LangSmith deployment path

### Runtime Model

The route-execution stack is now established:

- in-process `dawn run`
- server-backed `dawn run --url`
- `dawn test` layered on the same execution contract
- `dawn dev` exposing the local `/runs/wait` path
- runtime, smoke, and generated-app parity coverage

The normalized execution result contract now includes route identity, execution source, timing, normalized status, output, and normalized error shape.

### Dawn Route Authoring and SDK

The newest completed milestone introduced a backend-neutral `@dawn/sdk` package and migrated the route authoring convention to `index.ts` per route.

What changed:

- A route is a directory containing `index.ts`; the `index.ts` exports a `workflow` or `graph` function/object
- `@dawn/sdk` is the canonical author-facing package: types, helpers, runtime context, and tool authoring
- `@dawn/langgraph` is now an adapter that implements the `@dawn/sdk` contract and wires it to LangGraph
- route-local tools under `tools/*.ts` are part of the authoring model
- route handlers receive Dawn-specific runtime context via `@dawn/sdk` types
- `dawn run` targets a route directory or its `index.ts`; targeting legacy `workflow.ts`/`graph.ts` directly produces an error

Current authoring package surface:

- [`packages/sdk/src/index.ts`](../packages/sdk/src/index.ts)

Current runtime/discovery support for that authoring lane:

- [`packages/core/src/discovery/discover-routes.ts`](../packages/core/src/discovery/discover-routes.ts)
- [`packages/cli/src/lib/runtime/execute-route.ts`](../packages/cli/src/lib/runtime/execute-route.ts)
- [`packages/cli/src/lib/runtime/tool-discovery.ts`](../packages/cli/src/lib/runtime/tool-discovery.ts)

Starter template proof:

- [`packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`](../packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts)
- [`packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`](../packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts)

## Testing and Harness Model

The repo now has layered verification instead of one catch-all test surface.

### Package and CLI Tests

Package and CLI behavior is covered with Vitest inside the relevant workspaces.

Primary packages:

- `@dawn/core`
- `@dawn/langgraph`
- `@dawn/cli`
- `create-dawn-app`

### Harness Lanes

Repo-level behavior is covered by:

- framework lane
- runtime contract lane
- smoke lane

These are driven through:

- `pnpm verify:harness`
- `pnpm verify:harness:framework`
- `pnpm verify:harness:runtime`
- `pnpm verify:harness:smoke`

### Distribution Surface

Published-package expectations are checked by:

```bash
node scripts/publish-smoke.mjs
```

That command should remain part of any serious integration or release-oriented verification.

## Decisions That Should Hold Unless There Is A Strong Reason To Reopen Them

### Dawn Owns Local Lifecycle Only

Dawn should not become a deployment runtime.

- local lifecycle belongs to `dawn dev`
- production serving remains aligned with the Agent Server / LangSmith path

### `dawn run` Is The Primitive Execution Surface

`dawn run` is the execution primitive.

- `dawn test` builds on `dawn run`
- `dawn dev` does not absorb one-shot execution semantics

### `index.ts` Is The Route Entry

A route directory's `index.ts` is the Dawn-owned route entry. The runtime and discovery layers look for `index.ts` in each route directory and do not fall back to legacy sibling files.

### Tool Composition Is Filesystem-Driven

The current direction is registration/discovery by folder structure, not route-local manual arrays.

Current scopes:

- route-local `tools/*.ts`
- app-level shared `src/tools/*.ts`

### Dawn Runtime Context Is Dawn-Specific

The runtime context provided to route handlers is owned by Dawn.

That context should remain Dawn-specific even when underlying transports or backends evolve.

### LangSmith Owns Traces

Dawn should not invent its own parallel trace model.

Trace and observability concerns should layer on top of LangSmith rather than compete with it.

## What Is Stable Enough To Build On

These parts are now stable enough to support the next authoring phases:

- scaffold and install shape
- narrow config and discovery rules
- route identity and route binding
- local dev runtime lifecycle
- in-process and server-backed execution contract
- route authoring with `index.ts` per route and `@dawn/sdk` author contract
- filesystem-driven tool registration and discovery

## What Is Still Not The Product Thesis

Dawn still does not fully prove the original meta-framework hypothesis.

Today it is best described as:

- a well-tested app/framework shell
- with local runtime plumbing
- and a first Dawn-owned route authoring layer

It is not yet:

- a true cross-backend authoring framework spanning LangChain, LangGraph, and Deep Agents
- a mature agent-composition system
- a backend-neutral authoring contract with multiple real backend implementations

## Known Gaps and Risks

### The Meta-Framework Gap Is Still Real

The repo now has a Dawn-owned route layer, but not yet a Dawn-owned authoring contract broad enough to prove the LangChain / LangGraph / Deep Agents thesis.

### `@dawn/langgraph` Is Still The Only Real Backend Adapter

`@dawn/sdk` now owns the backend-neutral author contract, but `@dawn/langgraph` remains the only backend adapter implementation. Dawn still leans LangGraph-first in execution reality.

### Tool Composition Is Still Early

The current tool model proves registration and runtime context, but not yet richer composition, policy, approvals, or higher-level orchestration semantics.

### The Current Template Is Deliberately Small

The starter app proves the route authoring lane, but it is still intentionally narrow. It should not be mistaken for a complete statement of the eventual framework surface.

## Recommended First Actions In A New Thread

1. Reconfirm the green baseline.

```bash
pnpm install
pnpm ci:validate
node scripts/publish-smoke.mjs
```

2. Read the latest root docs:

- [`../README.md`](../README.md)
- [`../CONTRIBUTORS.md`](../CONTRIBUTORS.md)

3. Read the latest design/plan pair for the most recent milestone:

- [`docs/superpowers/specs/2026-04-15-dawn-route-authoring-design.md`](./superpowers/specs/2026-04-15-dawn-route-authoring-design.md)
- [`docs/superpowers/plans/2026-04-15-dawn-route-authoring.md`](./superpowers/plans/2026-04-15-dawn-route-authoring.md)

4. Read [`docs/next-iterations-roadmap.md`](./next-iterations-roadmap.md) before deciding the next implementation spec.

## Related Documents

- [`docs/next-iterations-roadmap.md`](./next-iterations-roadmap.md)
- [`docs/superpowers/specs`](./superpowers/specs)
- [`docs/superpowers/plans`](./superpowers/plans)
