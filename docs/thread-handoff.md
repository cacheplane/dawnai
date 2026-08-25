# Thread Handoff

> Historical note: much of this handoff records the route-authoring milestone;
> the release-operations section is the current controller handoff. For current
> user-facing behavior, prefer the website docs in `apps/web/content/docs` and
> the root `README.md`.

This document is the operational handoff for the Dawn framework and its
release-integrity controller now on `main`.

It is intended to let a new thread re-orient quickly without rereading the full superpowers history.

## Current State

- Branch baseline: `main`
- Latest operational milestone: the release-integrity controller cutover
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

For release work, also run `pnpm test:release-controller` and follow the
[release-integrity cutover runbook](./superpowers/runbooks/2026-08-09-release-integrity-cutover.md).

## Release Operations

Release ownership is intentionally split by capability:

- `.github/workflows/version-pr.yml` owns Changesets' Version Packages pull
  request only. It uses `RELEASE_GITHUB_TOKEN` and cannot publish.
- `.github/workflows/release.yml` is the sole npm publishing owner. A `main`,
  schedule, or manual coordinator validates the candidate, creates or validates
  the annotated tag, dispatches at `vX.Y.Z`, and exits. Preparation and every
  mutation continue only when both the workflow ref and SHA are the exact tag and
  candidate commit.
- `.github/workflows/published-artifact-verify.yml` independently audits the
  complete draft using exactly version, commit SHA, and manifest digest. It has
  no Release writer.

The version workflow advances the fixed package group and synchronizes Helm
`appVersion`; when an app version advances, each chart's own patch version also
advances exactly once. An already-synchronized rerun is a strict no-op.

Before npm publication, preparation creates one 21-tarball payload and a
canonical manifest. GitHub attests those 22 subjects. The draft consolidated
Release then escrows exactly 45 base assets: `release-record.json`, the manifest,
21 tarballs, and 22 attestation bundles. Repository Immutable Releases must be
enabled before the release workflow is activated.

Publication is serial and resumable. A matching package already accepted by npm
is verified and skipped; the first exact E404 is published next. Different public
bytes, a moved `latest` after partial publication, an incorrect tag, or any
escrow/provenance drift is a hard conflict. The controller never repacks after
public mutation and never unpublishes or repairs a conflicting version.

The consolidated Release stays draft through the five required exact-version
smoke lanes:

- `metadata`
- `published-harness`
- `runtime-targets`
- `scaffold`
- `storage`

The independent audit attaches a unique receipt for every attempt. Failed
attempts remain visible and move the draft to `AUDIT_RETRYABLE`; only one
byte-correlated successful attempt can create canonical `audit-result.json` and
advance the marker to `AUDIT_VERIFIED`. Final publication changes only the draft
flag, then re-reads the same Release as immutable with unchanged body, assets,
and annotated-tag target.

Manual recovery always uses the exact version, SHA, and tag. Protected terminal
abandonment is available only before any npm mutation, requires approval through
the `release-abandonment` environment and two fresh full-inventory absence
observations, and preserves a permanent tombstone. It is not a rollback path.

After the first patch release, require one clean post-publication exact-tag audit
and the next scheduled reconciliation to be a no-op. Record the actual release,
smoke, chart, production deployment, and scheduled-run receipts in the runbook.

The real `vercel-native` CI deployment lane and pinned Vercel CLI remain required.
The exact release commit must also have a successful production Vercel
deployment and clean public-site browser verification. The
`copilotkit-examples-e2e` lane remains required and exercises the v2 CopilotKit
imports used by the chat and research examples.

## What Exists Now

### App and Project Contract

The plumbing needed to unblock real authoring work is now in place.

- `pnpm create dawn-ai-app` is the public scaffold path
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
- `dawn dev` exposing local `/runs/wait` and `/runs/stream` endpoints
- runtime, smoke, and generated-app parity coverage

The normalized execution result contract now includes route identity, execution source, timing, normalized status, output, and normalized error shape.

### Dawn Route Authoring and SDK

The newest completed milestone introduced a backend-neutral `@dawn-ai/sdk` package and migrated the route authoring convention to `index.ts` per route.

What changed:

- A route is a directory containing `index.ts`; the `index.ts` exports exactly one route entry: default `agent(...)`, named `workflow`, named `graph`, or named `chain`
- `@dawn-ai/sdk` is the canonical author-facing package: types, helpers, runtime context, and tool authoring
- `@dawn-ai/langgraph` is now an adapter that implements the `@dawn-ai/sdk` contract and wires it to LangGraph
- route-local tools under `tools/*.ts` are part of the authoring model
- route handlers receive Dawn-specific runtime context via `@dawn-ai/sdk` types
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

- `@dawn-ai/core`
- `@dawn-ai/langgraph`
- `@dawn-ai/cli`
- `create-dawn-ai-app`

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

### Published Artifact Verification

For a managed release, the `Published Artifact Verification` workflow is an
exact-tag independent audit, not a `latest`-based optional check. Supply only the
exact version, candidate commit SHA, and manifest SHA-256. During the release it
runs while the consolidated Release is still draft; after publication it may
emit Actions evidence but cannot mutate the immutable Release. Preserve the
dispatch-returned run ID instead of guessing from a recent-runs list.

For an ad-hoc local no-key check outside the managed release transition, the
existing package-set commands remain useful:

Local no-key check:

```bash
pnpm published:verify -- --version latest --package-set memory-pgvector-core
pnpm published:smoke -- --version latest --package-set memory-pgvector-core --pgvector
```

Never write API keys to files; pass `OPENAI_API_KEY` only through the one shell
or workflow step that runs the live OpenAI smoke.

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
- route authoring with `index.ts` per route and `@dawn-ai/sdk` author contract
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

### `@dawn-ai/langgraph` Is Still The Only Real Backend Adapter

`@dawn-ai/sdk` now owns the backend-neutral author contract, but `@dawn-ai/langgraph` remains the only backend adapter implementation. Dawn still leans LangGraph-first in execution reality.

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

- [`docs/superpowers/specs/2026-08-09-release-integrity-controller-design.md`](./superpowers/specs/2026-08-09-release-integrity-controller-design.md)
- [`docs/superpowers/plans/2026-08-09-release-integrity-controller-pr2.md`](./superpowers/plans/2026-08-09-release-integrity-controller-pr2.md)
- [`docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md`](./superpowers/runbooks/2026-08-09-release-integrity-cutover.md)
- [`docs/superpowers/specs/2026-04-15-dawn-route-authoring-design.md`](./superpowers/specs/2026-04-15-dawn-route-authoring-design.md)
- [`docs/superpowers/plans/2026-04-15-dawn-route-authoring.md`](./superpowers/plans/2026-04-15-dawn-route-authoring.md)

4. Read [`docs/next-iterations-roadmap.md`](./next-iterations-roadmap.md) before deciding the next implementation spec.

## Related Documents

- [`docs/next-iterations-roadmap.md`](./next-iterations-roadmap.md)
- [`docs/superpowers/specs`](./superpowers/specs)
- [`docs/superpowers/plans`](./superpowers/plans)
