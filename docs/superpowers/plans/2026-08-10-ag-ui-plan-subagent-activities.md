# AG-UI Plan and Subagent Activities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Dawn's root-plan and delegated-research progress as bounded standard AG-UI activity snapshots, render those activities inline in the flagship research web client, and prove the complete wire path without exposing child prose or raw payloads.

**Architecture:** Add one request-local, allowlist-only projector inside `@dawn-ai/ag-ui`, then intercept recognized activity chunks after interrupt suppression and before the existing outbound switch. Publish only two stable activity constants and two semantic content contracts; the private research web app validates those contracts again with strict Zod schemas and renders native, accessible checklist cards through CopilotKit's standard `renderActivityMessages` prop. Keep generic root tool cards, permission handling, memory review, suggestions, and the 100 ms render throttle unchanged.

**Tech Stack:** TypeScript 7, Node.js 24, pnpm 10, Vitest 4, `@ag-ui/core`/`@ag-ui/client` 0.0.57, CopilotKit React 1.66.x, React 19 server rendering, Zod 4, Next.js 16, Biome, Changesets, and the existing candidate-registry generated-app harness.

**Approved spec:** `docs/superpowers/specs/2026-08-10-ag-ui-plan-subagent-activities-design.md`

**Execution baseline:** `origin/main` at `e95f4d61` or later. The design commit has been rebased onto that baseline. The user also approved the narrow README-only exception for the generated research starter, so the release changeset includes `@dawn-ai/devkit` and `create-dawn-ai-app` without adding scaffold code or UI.

**Dependency order:** Tasks 1–3 are sequential: the outbound bridge depends on the projector, and the web client imports the public protocol contracts. Task 4 documents the finished behavior. Do not run builds, installs, package checks, or generated harness lanes concurrently in this shared worktree because they mutate `dist/`, the lockfile, packed artifacts, or registry state.

---

### Task 0: Confirm the execution baseline and build inputs

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-08-10-ag-ui-plan-subagent-activities-design.md`
- Read: `docs/superpowers/plans/2026-08-10-ag-ui-plan-subagent-activities.md`
- Verify only: repository root

- [ ] **Step 1: Confirm the branch is clean and based on current main**

```bash
git status --short --branch
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
```

Expected: the worktree is clean and the ancestry command exits `0`. If `origin/main` advanced, rebase before editing and repeat the overlap check below.

- [ ] **Step 2: Recheck overlap if main advanced**

```bash
git diff --name-status HEAD..origin/main -- \
  packages/ag-ui \
  examples/research/web \
  examples/chat/README.md \
  examples/chat/web/README.md \
  packages/devkit/templates/app-research/README.md \
  test/generated/run-generated-research-activation.test.ts \
  scripts/lib/pack-check.mjs \
  scripts/pack-check.test.mjs \
  scripts/lib/published-artifacts.mjs \
  scripts/published-artifacts.test.mjs \
  scripts/published-artifact-smoke.mjs \
  vitest.workspace.ts \
  apps/web/content/docs
```

Expected: no unreviewed overlap. If any target changed, re-read it and update the affected plan step before implementation; do not overwrite upstream work.

- [ ] **Step 3: Select the normative toolchain**

```bash
node --version
npm --version
pnpm --version
```

Expected: Node `v24.x`, npm `11.x`, and pnpm `10.x`. On the current workstation, prepend `/Users/blove/.nvm/versions/node/v24.18.0/bin` to `PATH` if the shell selects another Node version.

- [ ] **Step 4: Install the locked workspace**

```bash
pnpm install --frozen-lockfile
```

Expected: PASS without changing `pnpm-lock.yaml`.

- [ ] **Step 5: Build before any `dist/` consumer runs**

```bash
pnpm build
```

Expected: PASS. This is mandatory because the research web package resolves `@dawn-ai/ag-ui` through its built export and the generated activation packs and executes workspace `dist/` output.

### Task 1: Add the bounded activity contracts, projector, and release surface

**Files:**
- Create: `packages/ag-ui/src/activities.ts`
- Create: `packages/ag-ui/test/activities.test.ts`
- Modify: `packages/ag-ui/src/index.ts`
- Modify: `packages/ag-ui/test/public-api.test.ts`
- Modify: `packages/ag-ui/test/types.test.ts`
- Modify: `scripts/lib/pack-check.mjs`
- Modify: `scripts/pack-check.test.mjs`
- Modify: `scripts/lib/published-artifacts.mjs`
- Modify: `scripts/published-artifacts.test.mjs`
- Modify: `scripts/published-artifact-smoke.mjs`

Use `@superpowers:test-driven-development` for this task. The projector is deliberately internal even though it lives in a packed file: only the two constants and two content types are exported from the package root.

- [ ] **Step 1: Write the recognized-type and root-plan tests**

Create `packages/ag-ui/test/activities.test.ts`. Import `ActivitySnapshotEventSchema` and `EventType` from `@ag-ui/core`, and import the not-yet-created constants, `createDawnActivityProjector`, and `isDawnActivityChunkType` from `../src/activities.ts`.

Use these shared fixtures:

```ts
const identity = {
  call_id: "call-research-1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
} as const

const todos = [
  { content: "Search the corpus", status: "completed" },
  { content: "Read the best source", status: "in_progress" },
] as const

function parseSnapshot(value: unknown) {
  return ActivitySnapshotEventSchema.parse(value)
}
```

Test the exact seven recognized types and reject `token`, `tool_call`, `done`, and `capability.unknown`. Test two valid root plan replacements with one `dawn:plan:run-1` id, `replace: true`, and complete replacement content. Parse both through `parseSnapshot()`.

- [ ] **Step 2: Run the first projector RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts
```

Expected: FAIL because `src/activities.ts` does not exist.

- [ ] **Step 3a: Add the public contracts and recognized-type allowlist**

Create `packages/ag-ui/src/activities.ts` with these public definitions:

```ts
import { EventType, type ActivitySnapshotEvent } from "@ag-ui/core"

export const DAWN_PLAN_ACTIVITY_TYPE = "dawn.plan"
export const DAWN_SUBAGENT_ACTIVITY_TYPE = "dawn.subagent"

export interface DawnPlanActivityContent {
  readonly todos: ReadonlyArray<{
    readonly content: string
    readonly status: "pending" | "in_progress" | "completed"
  }>
}

export interface DawnSubagentActivityContent {
  readonly name: string
  readonly depth: number
  readonly status: "running" | "completed" | "failed"
  readonly todos?: DawnPlanActivityContent["todos"]
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly status: "running" | "completed" | "incomplete"
  }>
  readonly totalToolCount: number
  readonly error?: string
}

export type DawnActivityChunkType =
  | "plan_update"
  | "subagent.start"
  | "subagent.plan_update"
  | "subagent.tool_call"
  | "subagent.tool_result"
  | "subagent.message"
  | "subagent.end"

export interface DawnActivityProjector {
  project(type: DawnActivityChunkType, data: unknown): ActivitySnapshotEvent | null
}
```

Implement `isDawnActivityChunkType(value: string)` with an explicit `switch`; do not use prefix matching.

- [ ] **Step 3b: Add strict todo parsing**

Add `isRecord`, `asNonEmptyString`, and `parseTodos`. The todo parser requires a `todos` array, non-empty item content, and one exact status; it returns new allowlisted objects and never spreads input. Wrap property access in `try/catch`.

- [ ] **Step 3c: Add plan-only projection**

Implement the `plan_update` branch of `createDawnActivityProjector(runId)` with `dawn:plan:${runId}`, the exact constant, `replace: true`, and a fresh complete todo snapshot. Return `null` for other recognized types for now.

- [ ] **Step 4: Run the root-plan tests GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts
```

Expected: recognized-type and plan replacement tests PASS.

- [ ] **Step 5: Write canonical identity, start, and child-plan tests**

Add tests for a valid start and matching `subagent.plan_update`. Require one stable `dawn:subagent:call-research-1` message id and a complete running snapshot with replaced child todos. Add RED cases for plan-before-start, missing identity fields, and conflicting `subagent`, `route_id`, or `depth` on the same call id.

- [ ] **Step 6: Run the identity/child-plan RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "subagent identity|child plan"
```

Expected: FAIL because subagent state is not implemented.

- [ ] **Step 7a: Add request-local subagent state**

Add one request-local `Map<string, InternalSubagentState>` keyed by `call_id`. Use these private shapes:

The internal state must contain:

```ts
interface SubagentIdentity {
  readonly callId: string
  readonly subagent: string
  readonly routeId: string
  readonly depth: number
}

interface InternalToolState {
  readonly id: string
  readonly name: string
  status: "running" | "completed" | "incomplete"
}

interface InternalSubagentState {
  readonly identity: SubagentIdentity
  status: "running" | "completed" | "failed"
  todos?: DawnPlanActivityContent["todos"]
  readonly seenToolIds: Set<string>
  tools: InternalToolState[]
  totalToolCount: number
  error?: string
  terminal: boolean
}
```

- [ ] **Step 7b: Add canonical identity and snapshot helpers**

Add `parseSubagentIdentity(data)` requiring all four fields, `sameIdentity(left, right)`, and `snapshotSubagent(state)`. The snapshot copies only public fields and uses conditional spreads for optional todos so `exactOptionalPropertyTypes` stays satisfied.

- [ ] **Step 7c: Implement start and child-plan transitions**

Implement `subagent.start` and `subagent.plan_update` only. Identical starts may re-emit; conflicting identity and updates before start return `null`. Child plans replace the full stored list.

- [ ] **Step 8: Run identity and child-plan tests GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "subagent identity|child plan"
```

Expected: PASS.

- [ ] **Step 9: Write child-tool correlation and five-entry-bound tests**

Add a lifecycle test for call → result and a six-tool test. Require six unique calls to retain tools 2–6 in recency order with `totalToolCount: 6`; result for evicted tool 1 returns `null`; result for retained tool 6 emits completed; repeating an existing id never increments the total. Include sensitive input/output sentinels in payloads and require their absence from serialized snapshots.

- [ ] **Step 10: Run the child-tool RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "child tool|five recent"
```

Expected: FAIL because tool transitions are not implemented.

- [ ] **Step 11a: Implement child tool-call retention**

For matching nonterminal identities, implement `subagent.tool_call` using non-empty raw `id` and `tool`; upsert it as running, count each id once with `seenToolIds`, and retain only the newest five summaries. Reinsert an evicted repeated id without incrementing the total.

- [ ] **Step 11b: Implement child tool-result correlation**

Implement `subagent.tool_result` using only its retained `id`; mark it completed without reading `tool` or `output`. Unknown and evicted ids return `null`.

- [ ] **Step 12: Run child-tool tests GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "child tool|five recent"
```

Expected: PASS.

- [ ] **Step 13: Write terminal, idempotency, and parallel-state tests**

Add focused tests for successful end, failed end with a 500-character string capped to 400, running tools normalized to incomplete, terminal freeze, identical repeated start preserving progress, events-before-start ignored, and two interleaved call ids staying isolated. If `error` exists with a non-string value, require the malformed end to return `null`; empty/whitespace error is treated as no error and completes.

- [ ] **Step 14: Run the terminal/state RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "terminal|repeated start|parallel"
```

Expected: FAIL because end/freeze behavior is not implemented.

- [ ] **Step 15a: Implement terminal normalization**

Implement `truncateError(value)` for string errors only. On matching `subagent.end`, turn running tools incomplete, set failed only for a trimmed non-empty string error, otherwise completed, ignore `final_message`, emit once, and freeze the state. Reject a present non-string error as malformed.

- [ ] **Step 15b: Implement idempotent and terminal state guards**

Preserve plan/tools on identical repeated start, ignore conflicting repeated starts, and ignore every mutation after terminal.

- [ ] **Step 16: Run terminal/state tests GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "terminal|repeated start|parallel"
```

Expected: PASS.

- [ ] **Step 17: Write privacy, message-ignore, malformed, and hostile-input tests**

Add tests that `subagent.message` emits nothing, and that serialized public content omits child prose, tool inputs/outputs, `final_message`, route ids, call ids, and child tool ids. Add malformed todo/status/id/name/route/depth/tool cases, arrays where records are required, and an object with a throwing getter. Require `null` and no throw. Parse every non-null projection in the whole file with `ActivitySnapshotEventSchema`.

- [ ] **Step 18: Run the hardening RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts -t "privacy|malformed|hostile|message"
```

Expected: FAIL on the still-unhandled malformed/hostile edge cases.

- [ ] **Step 19: Complete allowlist hardening**

Make `isRecord` reject arrays, make every string validator reject whitespace-only values, and keep the entire `project()` parse/mutation path inside `try/catch`. Implement matching `subagent.message` as a consumed `null` without reading message content. Ensure `snapshotSubagent` creates fresh allowlisted arrays and conditionally spreads optional todos/error; never spread a runtime payload.

- [ ] **Step 20: Run the complete projector suite GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts
```

Expected: all projector tests PASS and every emitted event parses with AG-UI 0.0.57.

- [ ] **Step 21: Add failing root-surface and type assertions**

Change `packages/ag-ui/test/public-api.test.ts` to require the exact sorted runtime surface:

```ts
expect(Object.keys(api).sort()).toEqual([
  "DAWN_PLAN_ACTIVITY_TYPE",
  "DAWN_SUBAGENT_ACTIVITY_TYPE",
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
])

expect(api.DAWN_PLAN_ACTIVITY_TYPE).toBe("dawn.plan")
expect(api.DAWN_SUBAGENT_ACTIVITY_TYPE).toBe("dawn.subagent")
```

Extend `packages/ag-ui/test/types.test.ts` with compile-time `DawnPlanActivityContent` and `DawnSubagentActivityContent` values plus exact constant assertions, importing only from `../src/index.js`.

- [ ] **Step 22: Run the public-surface RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/public-api.test.ts test/types.test.ts
```

Expected: FAIL because the root does not export the new contracts yet.

- [ ] **Step 23: Export the public constants and types**

Export only the constants and the two content types from `packages/ag-ui/src/index.ts`:

```ts
export {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
  type DawnSubagentActivityContent,
} from "./activities.js"
```

Do not export the projector or chunk-type guard from the root.

- [ ] **Step 24: Run projector, public-surface, and typecheck GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts test/public-api.test.ts test/types.test.ts
pnpm --filter @dawn-ai/ag-ui typecheck
```

Expected: all focused tests and typecheck PASS.

- [ ] **Step 25: Add the two pack-manifest assertions**

In `scripts/pack-check.test.mjs`, require `dist/activities.js` and `dist/activities.d.ts` in the AG-UI manifest test. In `scripts/published-artifacts.test.mjs`, require those same two files from `expectedFilesForPackage("@dawn-ai/ag-ui")`.

- [ ] **Step 26a: Add ESM-probe surface assertions**

In `scripts/published-artifacts.test.mjs`, update the generated ESM-probe assertion to the exact six-name surface while leaving the function loop at four functions.

- [ ] **Step 26b: Add TypeScript-probe and fixture assertions**

Update the type-probe assertion for both constants and both interfaces. Extend `createAgUiProbeFixture()` with the literal constants and interface declarations while preserving all removed-legacy-export negatives.

- [ ] **Step 27: Run the release-guard RED**

Run:

```bash
node --test --test-name-pattern="checks the AG-UI root and SSE entrypoints" \
  scripts/pack-check.test.mjs
node --test \
  --test-name-pattern="AG-UI installed probes|returns AG-UI entrypoint expectations" \
  scripts/published-artifacts.test.mjs
```

Expected: FAIL because the release manifests/probe generators still describe the old four-function surface and omit `dist/activities.*`.

- [ ] **Step 28: Update the two expected-file manifests**

Add `dist/activities.js` and `dist/activities.d.ts` to `scripts/lib/pack-check.mjs`'s AG-UI list and `scripts/lib/published-artifacts.mjs`'s `@dawn-ai/ag-ui` expectations, preserving sorted order.

- [ ] **Step 29: Update the installed-package smoke generator**

In `scripts/published-artifact-smoke.mjs`, make the sorted runtime surface:

  ```ts
  [
    "DAWN_PLAN_ACTIVITY_TYPE",
    "DAWN_SUBAGENT_ACTIVITY_TYPE",
    "createCounterIdFactory",
    "createDefaultIdFactory",
    "fromRunAgentInput",
    "toAguiEvents",
  ]
  ```

Assert the two values equal `dawn.plan` and `dawn.subagent`. Keep only the four functions in the function-type loop. Import the two public content interfaces into the TypeScript probe, place the constants in `RootValueSurface`, and place the interfaces in `RootTypeSurface`.

- [ ] **Step 30: Synchronize published-artifact fixtures**

In `scripts/published-artifacts.test.mjs`, mirror the exact surface in fixture JS/declarations and source-string assertions. Add empty `dist/activities.js` and representative `dist/activities.d.ts` fixture files only where a package-file fixture enumerates physical expected files.

Do not add a package export subpath for `activities`; it is an internal emitted module reachable through the root re-exports only.

- [ ] **Step 31: Run focused release guards GREEN**

```bash
node --test --test-name-pattern="checks the AG-UI root and SSE entrypoints" \
  scripts/pack-check.test.mjs
node --test \
  --test-name-pattern="AG-UI installed probes|returns AG-UI entrypoint expectations" \
  scripts/published-artifacts.test.mjs
```

Expected: PASS.

- [ ] **Step 32a: Build the AG-UI package**

```bash
pnpm --filter @dawn-ai/ag-ui build
```

Expected: PASS; `dist/activities.js` and `.d.ts` exist locally but remain gitignored.

- [ ] **Step 32b: Run complete release-guard suites**

```bash
pnpm test:pack-check
pnpm test:published-artifacts
```

Expected: PASS.

- [ ] **Step 32c: Run complete AG-UI package checks**

```bash
pnpm --filter @dawn-ai/ag-ui test
pnpm --filter @dawn-ai/ag-ui lint
pnpm --filter @dawn-ai/ag-ui typecheck
```

Expected: PASS.

- [ ] **Step 32d: Check the task diff**

```bash
git diff --check
```

Expected: PASS.

- [ ] **Step 33: Commit the bounded contract and release surface**

```bash
git add \
  packages/ag-ui/src/activities.ts \
  packages/ag-ui/src/index.ts \
  packages/ag-ui/test/activities.test.ts \
  packages/ag-ui/test/public-api.test.ts \
  packages/ag-ui/test/types.test.ts \
  scripts/lib/pack-check.mjs \
  scripts/pack-check.test.mjs \
  scripts/lib/published-artifacts.mjs \
  scripts/published-artifacts.test.mjs \
  scripts/published-artifact-smoke.mjs
git commit -m "feat(ag-ui): add bounded activity contracts"
```

Expected: the commit contains only the listed source, tests, and release guards.

### Task 2: Integrate activities into the outbound stream and packaged activation

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Modify: `packages/ag-ui/test/outbound.test.ts`
- Modify: `packages/ag-ui/test/conformance.test.ts`
- Modify: `test/generated/run-generated-research-activation.test.ts`
- Reuse: `packages/ag-ui/src/activities.ts`

Use `@superpowers:test-driven-development`. Write all outbound and generated-journey assertions before wiring the projector so both the cheap unit boundary and the real packaged boundary reach a genuine RED.

- [ ] **Step 1: Replace the old “plan is unknown” fixture with a truly unknown chunk**

In `packages/ag-ui/test/outbound.test.ts`, change the existing test named `unknown non-token chunks flush an open text message before being ignored` to use:

```ts
{ type: "capability.unknown", data: { arbitrary: true } }
```

Keep its expected framing unchanged: unknown chunks still close the open text message before the next token.

- [ ] **Step 2: Write the recognized-plan framing tests**

Import `ActivitySnapshotEventSchema` and the two public constants. Add one valid `plan_update` between two token chunks and require a valid plan snapshot without `TEXT_MESSAGE_END` until `done`. Add one malformed recognized plan and require no activity, no flush, and no `RUN_ERROR`.

- [ ] **Step 3: Run the plan-framing RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/outbound.test.ts -t "plan activity|malformed recognized plan"
```

Expected: FAIL because `outbound.ts` still sends plans through its default flush-and-ignore branch.

- [ ] **Step 4: Write the complete subagent wire/privacy test**

Use this full identity on every event:

```ts
const child = {
  call_id: "call-1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
}
```

Send start, child plan, tool call `{ id: "child-tool-1", tool: "readDoc", input: "secret-input" }`, tool result `{ id: "child-tool-1", output: "secret-output" }`, message with `secret-child-prose`, and end with `final_message: "secret-final"`. Require standard snapshots and exact allowlisted contents; none of the four secret sentinels may appear in serialized activity content or root text.

- [ ] **Step 5: Write interrupt-before-start and child-interrupt tests**

Add one scenario where delegation approval interrupts before `subagent.start`; require no activity and preserve the exact interrupt terminal. Add one where a valid start precedes a child-owned interrupt; require one running snapshot, then require post-interrupt child plan/tool/end chunks to remain suppressed.

- [ ] **Step 6: Write the request-local resume replacement test**

Use two separate `collect()` calls. The first starts the child and parks on an interrupt. The second re-emits start and end with the same `call_id`. Require the same `dawn:subagent:${callId}` message id across requests, fresh running state on resume, and terminal completion; do not expect pre-interrupt plan/tools to replay.

- [ ] **Step 7: Make the AG-UI client conformance stream require activities**

Update `packages/ag-ui/test/conformance.test.ts` so `CANNED` contains:

```ts
const childIdentity = {
  call_id: "c1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
} as const

const CANNED: DawnAgentStreamChunk[] = [
  { type: "token", data: "Researching" },
  { type: "tool_call", data: { name: "searchCorpus", input: { query: "agents" } } },
  { type: "tool_result", data: { name: "searchCorpus", output: [{ path: "corpus/a.md" }] } },
  { type: "plan_update", data: { todos: [{ content: "search", status: "completed" }] } },
  { type: "subagent.start", data: childIdentity },
  {
    type: "subagent.plan_update",
    data: { ...childIdentity, todos: [{ content: "read", status: "in_progress" }] },
  },
  {
    type: "subagent.tool_call",
    data: { ...childIdentity, id: "child-tool-1", tool: "readDoc", input: "not public" },
  },
  {
    type: "subagent.tool_result",
    data: { ...childIdentity, id: "child-tool-1", output: "not public" },
  },
  { type: "subagent.message", data: { ...childIdentity, message: "not root text" } },
  { type: "subagent.end", data: { ...childIdentity, final_message: "not public" } },
  { type: "token", data: " done. [corpus/a.md]" },
  { type: "done", data: { messages: [] } },
]
```

After `agent.run(input).pipe(verifyEvents(false), toArray())`, require:

- `ACTIVITY_SNAPSHOT` is present and every such event parses through `ActivitySnapshotEventSchema`;
- the activity types are exactly `dawn.plan` and `dawn.subagent`;
- the stream still begins with `RUN_STARTED`, still contains the root tool call/result, and ends with `RUN_FINISHED`;
- it contains no `ACTIVITY_DELTA`, `STATE_SNAPSHOT`, `CUSTOM`, or `RAW`; and
- serialized activity content omits `not public`, route ids, call ids, and child tool ids.

- [ ] **Step 8: Run all cheap pre-integration tests RED**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/outbound.test.ts test/conformance.test.ts
```

Expected: FAIL only on missing activity snapshots/no-flush semantics. Existing root text/tool/interrupt and terminal tests remain green.

- [ ] **Step 9: Extract the packaged child-reply sentinel**

In `test/generated/run-generated-research-activation.test.ts`, extract the child fixture reply:

```ts
const CHILD_REPLY =
  "ReAct and plan-and-execute are common agent architectures. [corpus/agent-architectures.md]"
```

Use `CHILD_REPLY` in `createSafeResearchFixtures()` without changing fixture order or output.

- [ ] **Step 10: Add no-activity assertions to unaffected journeys**

Add:

```ts
function expectNoActivitySnapshots(events: readonly AgUiEvent[]): void {
  expect(events.filter((event) => event.type === "ACTIVITY_SNAPSHOT")).toEqual([])
}
```

Call it from `assertGatedResearchInterrupt()`, `assertResumedGatedJourney()`, and `assertBuiltArtifactJourney()`. Those fixtures do not run `writeTodos` or `task`, and this slice must not synthesize a seed-plan activity.

- [ ] **Step 11: Add the exact packaged plan assertion**

Extend `assertSafeResearchJourney()` after the existing successful-terminal and root-tool assertions. Require exactly seven activity snapshots: one plan and six updates of one researcher message.

The plan must equal exactly:

```ts
{
  type: "ACTIVITY_SNAPSHOT",
  messageId: `dawn:plan:${ids.runId}`,
  activityType: "dawn.plan",
  replace: true,
  content: { todos },
}
```

- [ ] **Step 12: Add the six packaged researcher states**

The six subagent contents, in exact order, must equal:

```ts
[
  {
    name: "researcher",
    depth: 1,
    status: "running",
    tools: [],
    totalToolCount: 0,
  },
  {
    name: "researcher",
    depth: 1,
    status: "running",
    tools: [{ name: "searchCorpus", status: "running" }],
    totalToolCount: 1,
  },
  {
    name: "researcher",
    depth: 1,
    status: "running",
    tools: [{ name: "searchCorpus", status: "completed" }],
    totalToolCount: 1,
  },
  {
    name: "researcher",
    depth: 1,
    status: "running",
    tools: [
      { name: "searchCorpus", status: "completed" },
      { name: "readDoc", status: "running" },
    ],
    totalToolCount: 2,
  },
  {
    name: "researcher",
    depth: 1,
    status: "running",
    tools: [
      { name: "searchCorpus", status: "completed" },
      { name: "readDoc", status: "completed" },
    ],
    totalToolCount: 2,
  },
  {
    name: "researcher",
    depth: 1,
    status: "completed",
    tools: [
      { name: "searchCorpus", status: "completed" },
      { name: "readDoc", status: "completed" },
    ],
    totalToolCount: 2,
  },
]
```

Every subagent snapshot has `messageId: "dawn:subagent:call_task_0_2"`, `activityType: "dawn.subagent"`, and `replace: true`. None has `todos` or `error` in this fixture.

- [ ] **Step 13: Add packaged activity ordering assertions**

Use the already-correlated root tool ids to assert ordering:

- plan snapshot index is after `writeTodos` `TOOL_CALL_END` and before its `TOOL_CALL_RESULT`;
- first researcher snapshot is after `task` `TOOL_CALL_END`;
- terminal researcher snapshot is before `task` `TOOL_CALL_RESULT`; and
- all seven activity snapshots precede the first final-root `TEXT_MESSAGE_CONTENT`.

- [ ] **Step 14: Add packaged leakage and forbidden-event assertions**

Serialize only the seven activity `content` values and require absence of:

```ts
[
  SUBQUESTION,
  CHILD_REPLY,
  report,
  "corpus/agent-architectures.md",
  "call_task_0_2",
  "call_searchCorpus_0_0",
  "call_readDoc_0_1",
  '"call_id"',
  '"route_id"',
  '"id"',
  '"input"',
  '"output"',
  '"final_message"',
]
```

Also require `reconstructAssistantText(events)` not to contain the full `CHILD_REPLY`, while preserving the existing citation assertion. Require no `ACTIVITY_DELTA`, `CUSTOM`, `RAW`, or `STATE_SNAPSHOT`. Do not alter scaffold/install/lifecycle, permission/resume, memory, report, sanitizer, server-cleanup, or transcript assertions.

- [ ] **Step 15a: Build the pre-integration source**

```bash
pnpm build
```

Expected: PASS; built output still contains the old outbound flush-ignore behavior.

- [ ] **Step 15b: Run the packaged pre-integration RED**

```bash
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-research-activation.test.ts
```

Expected: FAIL only because the safe exchange has zero activity snapshots; the unchanged scaffold/npm lifecycle and safe AG-UI journey reach that assertion. Let registry/global teardown and server cleanup complete naturally. Preserve the printed temp root on failure until GREEN is accepted.

- [ ] **Step 16: Add the activity event type and request-local projector**

In `packages/ag-ui/src/outbound.ts`:

1. Import `type ActivitySnapshotEvent` from `@ag-ui/core`.
2. Import `createDawnActivityProjector` and `isDawnActivityChunkType` from `./activities.js`.
3. Add `ActivitySnapshotEvent` to `AguiOutboundEvent`.
4. Construct one projector per `toAguiEvents()` call:

   ```ts
   const activityProjector = createDawnActivityProjector(ctx.runId)
   ```

- [ ] **Step 17: Intercept recognized activities at the exact outbound seam**

After the existing pending-interrupt suppression block and before the `switch`, add:

   ```ts
   if (isDawnActivityChunkType(chunk.type)) {
     const activity = activityProjector.project(chunk.type, chunk.data)
     if (activity !== null) yield activity
     continue
   }
   ```

This position is load-bearing. Recognized valid or malformed activity chunks must not call `flushText()`. Unknown extensions must still reach the existing default branch and retain flush-then-ignore behavior. Pending interrupts must still suppress later activity chunks before projection.

- [ ] **Step 18: Run the focused outbound/conformance boundary GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/outbound.test.ts test/conformance.test.ts
```

Expected: PASS, including AG-UI client `verifyEvents(false)`.

- [ ] **Step 19a: Run all focused AG-UI tests GREEN**

```bash
pnpm --filter @dawn-ai/ag-ui exec vitest --run --config vitest.config.ts \
  test/activities.test.ts test/outbound.test.ts test/conformance.test.ts \
  test/public-api.test.ts test/types.test.ts
```

Expected: PASS.

- [ ] **Step 19b: Run AG-UI static checks and build**

```bash
pnpm --filter @dawn-ai/ag-ui lint
pnpm --filter @dawn-ai/ag-ui build
pnpm --filter @dawn-ai/ag-ui typecheck
```

Expected: PASS.

- [ ] **Step 19c: Run the complete AG-UI package test script**

```bash
pnpm --filter @dawn-ai/ag-ui test
```

Expected: PASS. Check that conformance still uses `verifyEvents(false)` and that no test relaxed existing text/tool/interrupt terminal ordering.

- [ ] **Step 20: Refresh the workspace build**

```bash
pnpm build
```

Expected: PASS and all `dist/` consumers reflect the outbound bridge.

- [ ] **Step 21: Run the packaged activation GREEN**

```bash
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-research-activation.test.ts
```

Expected: one test PASS. The safe journey produces exactly seven snapshots, gated/resume/built journeys produce none, and all existing npm lifecycle, report, transcript, and process cleanup checks remain green. Delete only the Task 2 RED temp root after this accepted run; do not remove unrelated preserved diagnostics.

- [ ] **Step 22: Audit the exact Task 2 diff**

```bash
git diff --check
git diff --name-only
```

Expected: only the four Task 2 files are newly modified since the Task 1 commit.

- [ ] **Step 23: Commit the outbound bridge and real activation proof**

```bash
git add \
  packages/ag-ui/src/outbound.ts \
  packages/ag-ui/test/outbound.test.ts \
  packages/ag-ui/test/conformance.test.ts \
  test/generated/run-generated-research-activation.test.ts
git commit -m "feat(ag-ui): emit plan and subagent activities"
```

Expected: the commit contains the outbound integration and both fast/packaged behavior proofs, with no fixture behavior change.

### Task 3: Render activities in the flagship research web client

**Files:**
- Create: `examples/research/web/app/components/ActivitySchemas.ts`
- Create: `examples/research/web/app/components/ActivityChecklist.tsx`
- Create: `examples/research/web/app/components/PlanActivityCard.tsx`
- Create: `examples/research/web/app/components/SubagentActivityCard.tsx`
- Create: `examples/research/web/app/components/ActivityRenderers.tsx`
- Create: `examples/research/web/app/components/ActivityRenderers.test.tsx`
- Create: `examples/research/web/vitest.config.ts`
- Modify: `examples/research/web/app/page.tsx`
- Modify: `examples/research/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.workspace.ts`

Do not modify `DemoSuggestions.tsx`, `ToolCallCard.tsx`, `PermissionInterrupt.tsx`, `MemoryCandidates.tsx`, the CopilotKit route, the research server, or any scaffold source. Use `@superpowers:test-driven-development`.

- [ ] **Step 1a: Add research-web test and schema dependencies**

Update `examples/research/web/package.json`:

```json
{
  "scripts": {
    "test": "vitest --run --config vitest.config.ts"
  },
  "dependencies": {
    "@dawn-ai/ag-ui": "workspace:*",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "vitest": "^4.1.10"
  }
}
```

Merge those entries into the existing objects; retain every current script and dependency.

```bash
pnpm install
```

Expected: PASS and update only the intended research-web importer/lock entries.

- [ ] **Step 1b: Register the research-web Vitest project**

Create `examples/research/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    name: "research-web",
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
  },
})
```

Add `./examples/research/web/vitest.config.ts` to `vitest.workspace.ts` immediately after the research-server entry.

- [ ] **Step 1c: Write the first missing-schema test**

Create `ActivityRenderers.test.tsx` importing only the not-yet-created `planActivityContentSchema`. Add one valid plan `safeParse` assertion and one strict-extra-key rejection.

- [ ] **Step 1d: Run the missing-schema RED**

```bash
pnpm --filter @dawn-example/research-web test
```

Expected: lockfile/workspace links update, then the test FAILS because `ActivitySchemas.ts` is missing. “No tests found” is not a valid RED.

- [ ] **Step 2: Implement the plan activity schema**

Create `ActivitySchemas.ts` importing both public content types from `@dawn-ai/ag-ui` and `z` from `zod`. Implement:

```ts
const todoSchema = z
  .object({
    content: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict()

export const planActivityContentSchema = z
  .object({ todos: z.array(todoSchema) })
  .strict()
```

Add a compile-time assignment from `z.output<typeof planActivityContentSchema>` to `DawnPlanActivityContent`. Do not export `todoSchema`.

- [ ] **Step 3: Run the plan-schema test GREEN**

```bash
pnpm --filter @dawn-example/research-web test -t "plan schema"
```

Expected: PASS.

- [ ] **Step 4: Write the subagent-schema RED cases**

Import the not-yet-created `subagentActivityContentSchema` into the same test. Add valid running/completed/failed cases. Add strict failures for extra `call_id`, `route_id`, `id`, `input`, `output`, or `final_message`; six tools; 401-character error; `error` on non-failed status; missing error on failed; non-positive depth; and `totalToolCount < tools.length`.

- [ ] **Step 5: Run the subagent-schema RED**

```bash
pnpm --filter @dawn-example/research-web test -t "subagent schema"
```

Expected: FAIL because the subagent schema is not exported.

- [ ] **Step 6: Implement the strict subagent discriminated union**

Add the private strict tool schema:

```ts
const toolSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(["running", "completed", "incomplete"]),
  })
  .strict()
```

Build `subagentActivityContentSchema` as a strict discriminated union on `status`. Running/completed accept non-empty name, positive integer depth, optional todo array, at most five tools, and nonnegative integer total; they reject error. Failed requires `error: z.string().min(1).max(400)`. Refine the union so `totalToolCount >= tools.length`. Add a compile-time output assignment to `DawnSubagentActivityContent`.

- [ ] **Step 7: Run both schema groups GREEN**

```bash
pnpm --filter @dawn-example/research-web test -t "schema"
```

Expected: PASS, and every `safeParse` call returns synchronously.

- [ ] **Step 8: Write checklist and plan-card SSR tests**

Import `renderToStaticMarkup` plus the not-yet-created checklist and plan card. Require active plan markup to contain `<details open`, `Plan · 1/3 complete`, and visible pending/in-progress/completed labels. Render ten todos and require exactly eight list items plus `+2 more`. Require a plan without `in_progress` to omit the `open` attribute.

- [ ] **Step 9: Run the plan-card RED**

```bash
pnpm --filter @dawn-example/research-web test -t "plan card|checklist"
```

Expected: FAIL because the components do not exist.

- [ ] **Step 10: Implement the shared checklist**

Create `ActivityChecklist.tsx` with props:

```ts
interface ActivityChecklistProps {
  readonly todos: DawnPlanActivityContent["todos"]
  readonly limit?: number
}
```

Render an ordered list of the first `limit ?? 8` items. Give each status both a glyph and visible label (`pending`, `in progress`, or `completed`) so meaning is not color-only. When truncated, render `+N more` after the list. Do not mutate or sort the input.

- [ ] **Step 11: Implement the plan card**

Create `PlanActivityCard.tsx`. Derive `completedCount`, `totalCount`, and whether any todo is `in_progress`. Render a native `<details open={hasActiveTodo}>` with summary text exactly `Plan · N/M complete`; render `ActivityChecklist` in the body with limit 8. The inactive card has no `open` attribute but remains user-expandable.

- [ ] **Step 12: Run checklist and plan-card tests GREEN**

```bash
pnpm --filter @dawn-example/research-web test -t "plan card|checklist"
```

Expected: PASS.

- [ ] **Step 13: Write running/nested subagent-card SSR tests**

Import the not-yet-created subagent card. Require a running card to be expanded and show name, running status, total-tool count, an optional child plan, and five tool names/statuses. Require depth 2 to show `nested` and depth 1 not to.

- [ ] **Step 14: Write terminal/failure subagent-card SSR tests**

Require completed and failed cards to omit `open`; failed markup must contain `role="alert"` and its supplied bounded error. Assert no runtime id/input/output sentinel is present.

- [ ] **Step 15: Run the subagent-card RED**

```bash
pnpm --filter @dawn-example/research-web test -t "subagent card"
```

Expected: FAIL because `SubagentActivityCard.tsx` does not exist.

- [ ] **Step 16: Implement the bounded subagent card**

Create `SubagentActivityCard.tsx` using the public subagent content type.

- Render `<details open={content.status === "running"}>`.
- Summary text contains the human-readable name, lifecycle status, and `${totalToolCount} tools`.
- Render a visible `nested` badge only when `depth > 1`.
- Render the optional child plan with `ActivityChecklist` and the same eight-item visual bound.
- Render only the already-bounded `content.tools` list, with both glyph and visible status text.
- On failure, render the bounded error in an element with `role="alert"`.
- Never render message ids, call ids, route ids, tool ids, prompts, arguments, outputs, or raw serialized payloads.

Use the example's existing small inline-style convention; do not add a styling framework or redesign the page.

- [ ] **Step 17: Run subagent-card tests GREEN**

```bash
pnpm --filter @dawn-example/research-web test -t "subagent card"
```

Expected: PASS.

- [ ] **Step 18: Write the stable renderer-registry RED**

Import the not-yet-created renderer registry. Require its activity types, in order, to equal the two public constants. Validate a representative payload through each renderer's Standard Schema hook and require synchronous results.

- [ ] **Step 19: Run the renderer-registry RED**

```bash
pnpm --filter @dawn-example/research-web test -t "renderer registry"
```

Expected: FAIL because `ActivityRenderers.tsx` does not exist.

- [ ] **Step 20: Register typed activity renderers with stable identity**

Create `ActivityRenderers.tsx`:

```tsx
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
  type DawnSubagentActivityContent,
} from "@dawn-ai/ag-ui"
import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import { planActivityContentSchema, subagentActivityContentSchema } from "./ActivitySchemas"
import { PlanActivityCard } from "./PlanActivityCard"
import { SubagentActivityCard } from "./SubagentActivityCard"

export const planActivityRenderer = {
  activityType: DAWN_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<DawnPlanActivityContent>

export const subagentActivityRenderer = {
  activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
  content: subagentActivityContentSchema,
  render: ({ content }) => <SubagentActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<DawnSubagentActivityContent>

export const activityMessageRenderers = [planActivityRenderer, subagentActivityRenderer]
```

Keep the array at module scope and mutable; do not construct it inline in `Home` and do not add hooks or side effects inside renderer callbacks.

- [ ] **Step 21: Run the complete renderer/schema suite GREEN**

```bash
pnpm --filter @dawn-example/research-web test
```

Expected: PASS. Tests use `renderToStaticMarkup`, not jsdom/Playwright/Testing Library, and assert semantics rather than full style-ordered HTML.

- [ ] **Step 22: Wire the stable registry into the existing provider**

Modify only the provider wiring in `examples/research/web/app/page.tsx`:

```tsx
import { activityMessageRenderers } from "./components/ActivityRenderers"

<CopilotKit
  runtimeUrl="/api/copilotkit"
  defaultThrottleMs={100}
  renderActivityMessages={activityMessageRenderers}
>
```

Preserve `DemoSuggestions`, `PermissionInterrupt`, `ToolCallCard`, `MemoryCandidates`, the sidebar, and their order. Update the stale installed-version comment from CopilotKit 1.62.3 to 1.66.4, but do not rewrite the surrounding investigation notes or touch `ToolCallCard.tsx`.

- [ ] **Step 23: Prove root Vitest collection**

```bash
pnpm --filter @dawn-example/research-web test
pnpm exec vitest --run --config vitest.workspace.ts --project research-web
```

Expected: both commands PASS. The second proves the renderer project belongs to the root Vitest configuration.

- [ ] **Step 24: Typecheck and build the research web app**

```bash
pnpm --filter @dawn-example/research-web typecheck
pnpm --filter @dawn-example/research-web build
```

Expected: both commands PASS with the public `@dawn-ai/ag-ui` types and CopilotKit renderer prop.

- [ ] **Step 25: Run scoped style and diff checks**

```bash
pnpm exec biome check --config-path packages/config-biome/biome.json \
  examples/research/web/app/components/ActivitySchemas.ts \
  examples/research/web/app/components/ActivityChecklist.tsx \
  examples/research/web/app/components/PlanActivityCard.tsx \
  examples/research/web/app/components/SubagentActivityCard.tsx \
  examples/research/web/app/components/ActivityRenderers.tsx \
  examples/research/web/app/components/ActivityRenderers.test.tsx \
  examples/research/web/app/page.tsx \
  examples/research/web/package.json \
  examples/research/web/vitest.config.ts \
  vitest.workspace.ts
git diff --check
```

Expected: PASS with no unrelated formatting.

- [ ] **Step 26: Commit the flagship activity UI**

```bash
git add \
  examples/research/web/app/components/ActivitySchemas.ts \
  examples/research/web/app/components/ActivityChecklist.tsx \
  examples/research/web/app/components/PlanActivityCard.tsx \
  examples/research/web/app/components/SubagentActivityCard.tsx \
  examples/research/web/app/components/ActivityRenderers.tsx \
  examples/research/web/app/components/ActivityRenderers.test.tsx \
  examples/research/web/app/page.tsx \
  examples/research/web/package.json \
  examples/research/web/vitest.config.ts \
  pnpm-lock.yaml \
  vitest.workspace.ts
git commit -m "feat(research): render AG-UI activities"
```

Expected: no server, generic-tool, permission, memory, suggestion, route, or scaffold source is staged.

### Task 4: Document the exact activity boundary and release it honestly

**Files:**
- Modify: `packages/ag-ui/README.md`
- Modify: `apps/web/content/docs/ag-ui.mdx`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/recipes/research-web-ui.mdx`
- Modify: `examples/research/web/README.md`
- Modify: `examples/chat/README.md`
- Modify: `examples/chat/web/README.md`
- Modify: `packages/devkit/templates/app-research/README.md`
- Create: `.changeset/ag-ui-activity-snapshots.md`
- Verify only: generated `packages/cli/docs/` output

This task includes the user-approved narrow scope amendment: correct the README shipped by the generated research starter, but do not add a scaffold web client or change starter source, dependencies, scripts, ports, or runtime behavior.

**Required documentation contract:**

Make the documentation agree on this exact mapping:

| Dawn chunk | AG-UI output | Public content |
|---|---|---|
| root `plan_update` | replacement `ACTIVITY_SNAPSHOT`, id `dawn:plan:${runId}`, type `dawn.plan` | complete todo list only |
| `subagent.start`, matching child plan/tool/result/end | replacement `ACTIVITY_SNAPSHOT`, id `dawn:subagent:${call_id}`, type `dawn.subagent` | name, depth, status, optional todos, at most five tool name/status summaries, total count, optional 400-character error |
| `subagent.message` | consumed without emission | none |
| unknown capability chunk | existing flush-and-ignore behavior | none |

Every relevant page must say snapshots replace stable messages and must explicitly exclude child reasoning/prose, prompts, tool inputs, tool outputs, final child answers, route ids, and raw runtime ids from content. Do not claim reconnect, replay, generic capability mapping, activity deltas, or durable state.

- [ ] **Step 1: Update the package README**

In `packages/ag-ui/README.md`, add the two constants/content types to the root import example; replace both “planning/subagents are ignored” statements with a snapshot-only activity section; retain unknown-event and no-replay limits.

- [ ] **Step 2: Update the AG-UI protocol guide**

In `apps/web/content/docs/ag-ui.mdx`, add both activity rows to the outbound table; document stable ids, full replacement, exact statuses, five-tool/400-character bounds, identity validation, and excluded data.

- [ ] **Step 3: Update the dev-server AG-UI endpoint**

In `apps/web/content/docs/dev-server.mdx`, update only the AG-UI endpoint section's stale sentence. Preserve the earlier Agent Protocol `/runs/stream` table because it correctly documents raw runtime events.

- [ ] **Step 4: Update the API reference**

In `apps/web/content/docs/api.mdx`, add public constants and content types to the `@dawn-ai/ag-ui` import block and replace the stale mapping paragraph with the exact snapshot contract plus unknown-event behavior.

Do not edit `packages/cli/docs/*.md`; those are generated/ignored build output from website MDX.

- [ ] **Step 5: Update the flagship research-web recipe**

In `apps/web/content/docs/recipes/research-web-ui.mdx`, add plan/researcher cards to “What you'll build”; show a stable module-level `renderActivityMessages` registry using the public constants and strict schemas; keep `defaultThrottleMs={100}`; say cards are informational and permissions remain owned by the separate standard interrupt UI.

- [ ] **Step 6: Update the flagship research-web README**

In `examples/research/web/README.md`, document `ActivitySchemas`, checklist/cards, and registry; state the safe suggestion shows plan and researcher progress before the cited answer; retain generic root-tool, permission, suggestions, memory, and server-held-key behavior. Describe the evidence honestly: SSR tests prove renderer presentation and the packaged activation proves the wire path; neither is a browser/live-model test.

- [ ] **Step 7: Correct the chat example overview**

In `examples/chat/README.md`, say the adapter emits standard planning/subagent activities, while the basic chat web client drives only `/chat` and registers no activity renderers. Do not imply the `/coordinator` UI now exists.

- [ ] **Step 8: Correct the chat-web README**

In `examples/chat/web/README.md`, make the same distinction in one concise paragraph; the basic client still has no plan/subagent presentation.

- [ ] **Step 9: Correct the shipped research-starter README**

In `packages/devkit/templates/app-research/README.md`, say the generated server endpoint emits standard activity messages and point to the separate research-web recipe/example that renders them. State plainly that the generated starter remains server-first and contains no web UI.

- [ ] **Step 10: Add the exact patch changeset**

Create `.changeset/ag-ui-activity-snapshots.md`:

```md
---
"@dawn-ai/ag-ui": patch
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Expose Dawn planning and subagent progress as bounded standard AG-UI activity
snapshots. The research web example renders plan checklists and delegated-work
status without forwarding child prose, prompts, tool inputs, tool outputs, or
final child answers, and the generated research starter now points users to
that activity-aware web recipe.
```

The research web package is private and receives no changeset entry. Use patch because Dawn's fixed 0.x release group would turn a minor entry into 1.0.

- [ ] **Step 11: Prove every stale claim is gone**

First prove the old claims are gone:

```bash
! rg -n \
  'AG-UI v1.*ignore|does not map planning|no v1 mapping.*ignored|does not expose live planning|planning capability events.*ignored' \
  packages/ag-ui/README.md \
  apps/web/content/docs/ag-ui.mdx \
  apps/web/content/docs/dev-server.mdx \
  apps/web/content/docs/api.mdx \
  apps/web/content/docs/recipes/research-web-ui.mdx \
  examples/research/web/README.md \
  examples/chat/README.md \
  examples/chat/web/README.md \
  packages/devkit/templates/app-research/README.md
```

Expected: PASS because the search finds no matches.

- [ ] **Step 12: Rebuild generated CLI docs**

```bash
pnpm --filter @dawn-ai/cli build
```

Expected: PASS. Do not stage generated/ignored `packages/cli/docs` output.

- [ ] **Step 13: Run docs and release-inventory checks**

```bash
node scripts/check-docs.mjs
pnpm check:release-inventory
```

Expected: PASS.

- [ ] **Step 14: Run scoped style and diff checks**

```bash
pnpm exec biome check --config-path packages/config-biome/biome.json \
  packages/ag-ui/README.md \
  apps/web/content/docs/ag-ui.mdx \
  apps/web/content/docs/dev-server.mdx \
  apps/web/content/docs/api.mdx \
  apps/web/content/docs/recipes/research-web-ui.mdx \
  examples/research/web/README.md \
  examples/chat/README.md \
  examples/chat/web/README.md \
  packages/devkit/templates/app-research/README.md \
  .changeset/ag-ui-activity-snapshots.md
git diff --check
```

Expected: PASS. If Biome does not support one of the Markdown files, remove only that unsupported path from the scoped Biome invocation; `check-docs` and `git diff --check` remain mandatory.

- [ ] **Step 15: Commit docs and changeset**

```bash
git add \
  packages/ag-ui/README.md \
  apps/web/content/docs/ag-ui.mdx \
  apps/web/content/docs/dev-server.mdx \
  apps/web/content/docs/api.mdx \
  apps/web/content/docs/recipes/research-web-ui.mdx \
  examples/research/web/README.md \
  examples/chat/README.md \
  examples/chat/web/README.md \
  packages/devkit/templates/app-research/README.md \
  .changeset/ag-ui-activity-snapshots.md
git commit -m "docs: document AG-UI activities"
```

Expected: the commit contains only the nine docs and one changeset.

- [ ] **Step 16: Run the commit-aware changeset checks**

```bash
BASE_REF=origin/main node scripts/check-changesets.mjs
pnpm exec changeset status --since=origin/main
```

Expected: the changeset checker reports the user-facing AG-UI/devkit/creator changes are covered, and Changesets reports one valid patch file. The checker compares committed history, so running it only before the commit is not sufficient. If either check fails, correct the docs/changeset and amend the docs commit.

### Task 5: Run complete verification and independent review

**Files:**
- Verify: all files changed by Tasks 1–4
- Verify: `docs/superpowers/specs/2026-08-10-ag-ui-plan-subagent-activities-design.md`
- Verify: `docs/superpowers/plans/2026-08-10-ag-ui-plan-subagent-activities.md`

Use `@superpowers:verification-before-completion` before making any completion claim. Use `@superpowers:requesting-code-review` after the full checks are green.

- [ ] **Step 1: Confirm exact scope and current-main ancestry**

```bash
git status --short --branch
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git diff --name-status origin/main...HEAD
git log --oneline --reverse origin/main..HEAD
```

Expected: clean worktree, current main is an ancestor, and the diff contains only protocol/release guards, research activity UI/tests, the generated activation assertion, the nine approved docs, one changeset, and the design/plan docs. No generic tool-card, permission, memory, runtime, scaffold code, provider, deployment, or browser-E2E file appears.

If main advanced and the ancestry check fails, rebase now, repeat the overlap audit from Task 0, rebuild, and rerun every affected focused test before continuing.

- [ ] **Step 2: Reconfirm the final toolchain**

```bash
node --version
npm --version
pnpm --version
```

Expected: Node 24, npm 11, pnpm 10.

- [ ] **Step 3: Run the complete AG-UI package checks**

```bash
pnpm --filter @dawn-ai/ag-ui test
pnpm --filter @dawn-ai/ag-ui lint
pnpm --filter @dawn-ai/ag-ui typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the focused release-guard tests**

```bash
pnpm test:pack-check
pnpm test:published-artifacts
```

Expected: PASS.

- [ ] **Step 5: Run the complete research-web checks**

```bash
pnpm --filter @dawn-example/research-web test
pnpm exec vitest --run --config vitest.workspace.ts --project research-web
pnpm --filter @dawn-example/research-web typecheck
pnpm --filter @dawn-example/research-web build
```

Expected: PASS.

- [ ] **Step 6: Refresh the final workspace build**

```bash
pnpm build
```

Expected: PASS with current source reflected in every `dist/` consumer.

- [ ] **Step 7: Run the final packaged activation**

```bash
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-research-activation.test.ts
```

Expected: PASS. The activation uses aimock rather than a live model and completes all child-process/global-registry teardown. If it fails, preserve and report its printed diagnostic root; use `@superpowers:systematic-debugging` rather than rerunning blindly.

- [ ] **Step 8: Run committed documentation and changeset checks**

```bash
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
pnpm exec changeset status --since=origin/main
pnpm check:release-inventory
```

Expected: PASS with exactly the three patch entries.

- [ ] **Step 9: Run complete package and TypeScript tooling checks**

```bash
pnpm pack:check
pnpm verify:typescript-tooling-pack
```

Expected: PASS. `pack:check` must observe `dist/activities.js` and `.d.ts`, while the installed probe must observe the exact two new runtime constants and public types without reintroducing removed legacy exports.

- [ ] **Step 10: Run the repository Definition of Done**

```bash
pnpm ci:validate
```

Expected: PASS through lint, build-cache, build, typecheck, root source tests (including the registered research-web project), release checks, docs, pack checks, TypeScript tooling, and all harness lanes. Run this serially and allow every registry/server teardown to finish.

- [ ] **Step 11: Audit protocol privacy**

```bash
rg -n \
  'ACTIVITY_DELTA|STATE_SNAPSHOT|CUSTOM|RAW|subagent\.message|final_message|route_id|tool_run_id' \
  packages/ag-ui/src/activities.ts \
  packages/ag-ui/src/outbound.ts \
  examples/research/web/app/components/ActivitySchemas.ts \
  examples/research/web/app/components/ActivityRenderers.tsx
```

Expected: matches are limited to allowlist/ignore logic or comments enforcing exclusion—never copied public payload fields.

- [ ] **Step 12: Audit unchanged UX and scaffold boundaries**

```bash
git diff origin/main...HEAD -- \
  examples/research/web/app/components/DemoSuggestions.tsx \
  examples/research/web/app/components/ToolCallCard.tsx \
  examples/research/web/app/components/PermissionInterrupt.tsx \
  examples/research/web/app/components/MemoryCandidates.tsx \
  packages/devkit/templates/app-research/package.json.template \
  packages/devkit/templates/app-research/src
```

Expected: empty diff. Confirm separately that `defaultThrottleMs={100}` is unchanged and activity renderers are module-scoped.

- [ ] **Step 13: Request independent spec review**

Dispatch one spec reviewer with the exact `origin/main...HEAD` range. Ask them to check:

- complete canonical identity validation and request-local state;
- bounded tools/error and no retained child content;
- recognized-no-flush versus unknown-flush behavior;
- interrupt-before-start and child-interrupt/resume semantics;
- AG-UI 0.0.57 conformance and exact public/release surfaces;
- schema failure-closed behavior, stable renderer identity, accessibility, and root-test collection;
- packaged seven-snapshot order/privacy without weakening prior activation assertions; and
- the docs-only starter exception with no scaffold UI/code promotion.

Expected: no spec deviation.

- [ ] **Step 14: Request independent quality review**

Dispatch a separate code-quality reviewer over the same range. Ask it to focus on malformed/hostile input safety, state bounds, exact-optional typing, React/schema behavior, accessibility, release guard completeness, test isolation, and accidental scope creep.

Expected: no Critical or Important finding.

- [ ] **Step 15: Resolve validated review findings**

Use `@superpowers:receiving-code-review`. For a behavior fix, add a regression test first, run the smallest RED/GREEN boundary, then rerun `pnpm ci:validate`. Commit or amend deliberately and redispatch the relevant reviewer. If both reviews are clean, record that no edit was needed.

- [ ] **Step 16: Produce the final evidence summary**

```bash
git status --short --branch
git diff --check origin/main...HEAD
git log --oneline --reverse origin/main..HEAD
```

Expected: clean worktree, no whitespace errors, and intentional commits equivalent to:

```text
docs: design AG-UI research activities
docs: plan AG-UI research activities
feat(ag-ui): add bounded activity contracts
feat(ag-ui): emit plan and subagent activities
feat(research): render AG-UI activities
docs: document AG-UI activities
```

Report the exact verification commands/results, generated activation duration and cleanup state, full `ci:validate` result, changeset packages, reviewer verdicts, and any preserved failure artifact path. Do not claim browser E2E, replay, a raw advanced stream, scaffold UI promotion, or generic-tool-card specialization; those remain follow-ups.
