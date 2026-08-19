# AG-UI Orchestration Correlation Implementation Plan (PR 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AG-UI adapter everything it needs to correlate a built-in
`writeTodos`/`task` tool call with its semantic activity — using the logical
(model/provider) tool-call ID that PR 1 made the public tool identity — without
yet suppressing anything.

**Architecture:** Three small pieces of plumbing plus one internal return-shape
change. (1) `StreamTransformerInput` gains an optional `toolCallId`, which the
LangChain tool converter fills from `extractToolCallId(liveConfig)` — the same
model tool-call ID the root `TOOL_CALL_*` events are keyed by after PR 1, never
the execution run ID. (2) The planning capability echoes it as `tool_call_id`
on `plan_update`. (3) `task` needs no new field: `subagent.start.call_id`
already *is* the logical ID. The AG-UI activity projector then returns a
private `ProjectedDawnActivity` (`{event, orchestration?}`) instead of a bare
event, reading correlation from `tool_call_id` (plan) and `call_id` (subagent).
The outbound mapper keeps emitting only `projection.event`; the correlation is
consumed by PR 3's suppression ledger.

**Tech Stack:** TypeScript, Node.js 24, pnpm 10, Vitest, LangChain/LangGraph
(`@langchain/core` 1.2.5), AG-UI 0.0.57, Biome (repo lint script only),
Changesets.

**Approved spec:** `docs/superpowers/specs/2026-08-18-ag-ui-orchestration-projection-design.md`
(the **amended** version — commits `be9f64e6`/`569fcce9` on branch
`blove/ag-ui-orchestration-projection`; sections "Part B: core transformer
input", "Part C: activity projector result", and "Migration from the v1
implementation commits"). This plan is self-contained; the spec is background.

**Relationship to the superseded v1 commits:** `38d8be8f` and `13a6f58f` on
`blove/ag-ui-orchestration-projection` implement this same plumbing against the
**execution run ID** and are superseded. Do NOT cherry-pick them. This plan
re-implements the same shapes against logical identity; where a v1 idea
survives it is written out in full below.

**Scope guard:** Do NOT implement suppression, buffering, or any change to
which events reach the client. After this PR the stream is byte-identical to
today except that `plan_update` gains a `tool_call_id` field and child
capability chunks lose a `tool_call_id` they would otherwise carry. PR 3 owns
the ledger, the interrupt-drop rule, the docs pages, and the presentation
policy.

**Execution baseline:** Branch `blove/ag-ui-orchestration-correlation` (already
created) off `main` at `6466f44f760a3576390b24775d1c232a6ac102aa` (PR 1
merged). Never edit `pnpm-lock.yaml`. Preserve unrelated untracked files.

**Toolchain trap:** Tests require Node 24. Prefix every node/pnpm command with
`export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && ` — shell state does
not persist between commands, and the default shell is Node 22 (which makes ~8
unrelated `dawn verify` tests fail spuriously). Never run bare
`biome check --write`; pass explicit file paths with
`--config-path packages/config-biome/biome.json`.

**Dependency order:** Tasks 1–5 are sequential (Task 4 depends on the
`tool_call_id` field name Task 1 establishes). Do not run builds or lanes
concurrently in this worktree.

---

### Task 0: Baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch and toolchain**

```bash
git branch --show-current   # must print blove/ag-ui-orchestration-correlation
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node --version   # v24.x
```

- [ ] **Step 2: Baseline the three affected suites**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/core test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/langchain test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

Expected: core 504 passed, langchain 217 passed, ag-ui 82 passed. If any suite
is red, STOP — the baseline is broken.

---

### Task 1: `StreamTransformerInput.toolCallId` and `plan_update.tool_call_id`

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (the `StreamTransformerInput` interface, near line 367)
- Modify: `packages/core/src/capabilities/built-in/planning.ts` (the stream transformer, near lines 64–87)
- Modify: `packages/core/test/capabilities/planning.test.ts`

- [ ] **Step 1: Write the failing tests**

Read `packages/core/test/capabilities/planning.test.ts` first — it already has
two stream-transformer tests ("stream transformer emits plan_update…" style)
that call `transformer.transform({ toolName: "writeTodos", toolOutput: … })`
and assert `events` deep-equals `[{ event: "plan_update", data: { todos } }]`.

Update BOTH existing stream-transformer tests to pass
`toolCallId: "call_writeTodos_0_1"` in the transform input and to expect the id
echoed, e.g. the bare-todos test becomes:

```typescript
    expect(events).toEqual([
      {
        event: "plan_update",
        data: {
          todos: [{ content: "x", status: "pending" }],
          tool_call_id: "call_writeTodos_0_1",
        },
      },
    ])
```

(apply the same shape to the Command-shaped `update.todos` test, keeping that
test's own todos/content unchanged), and ADD these two tests after them:

```typescript
  it("stream transformer omits tool correlation when the call ID is absent", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir, ctx)
    const transformer = contribution.streamTransformers?.[0]

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      const newTodos = [{ content: "without id", status: "pending" }]
      for await (const out of transformer.transform({
        toolName: "writeTodos",
        toolOutput: { todos: newTodos },
      })) {
        events.push(out)
      }
    }

    expect(events).toEqual([
      {
        event: "plan_update",
        data: { todos: [{ content: "without id", status: "pending" }] },
      },
    ])
    expect(Object.hasOwn(events[0]?.data ?? {}, "tool_call_id")).toBe(false)
  })

  it("stream transformer omits tool correlation when the call ID is empty", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir, ctx)
    const transformer = contribution.streamTransformers?.[0]

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      const newTodos = [{ content: "empty id", status: "pending" }]
      for await (const out of transformer.transform({
        toolName: "writeTodos",
        toolOutput: { todos: newTodos },
        toolCallId: "",
      })) {
        events.push(out)
      }
    }

    expect(events).toEqual([
      {
        event: "plan_update",
        data: { todos: [{ content: "empty id", status: "pending" }] },
      },
    ])
    expect(Object.hasOwn(events[0]?.data ?? {}, "tool_call_id")).toBe(false)
  })
```

Match the surrounding file's idioms: if the existing tests use `it(` vs `test(`
or a different fixture-setup preamble (`routeDir`, `ctx`, `writeFileSync`),
copy the local convention exactly.

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/core && npx vitest --run test/capabilities/planning.test.ts
```

Expected: FAIL — the transformer does not emit `tool_call_id` yet (and TypeScript
rejects the unknown `toolCallId` property on the transform input).

- [ ] **Step 3: Add the field to `StreamTransformerInput`**

In `packages/core/src/capabilities/types.ts`, replace the interface body:

```typescript
export interface StreamTransformerInput {
  readonly toolName: string
  readonly toolOutput: unknown
  /**
   * Model/provider tool-call id (logical identity) of the execution that
   * produced `toolOutput`, when the runtime has one — the same id the root
   * AG-UI `TOOL_CALL_*` events are keyed by, never the internal LangChain
   * execution run id. Optional: adapters that cannot supply one omit it, and
   * a transformer that uses it must tolerate its absence.
   */
  readonly toolCallId?: string
}
```

- [ ] **Step 4: Emit it from the planning transformer**

In `packages/core/src/capabilities/built-in/planning.ts`, replace the `yield`
at the end of the stream transformer with:

```typescript
          yield {
            event: "plan_update",
            data: {
              todos,
              // Correlation for the AG-UI adapter: same public id the tool's
              // own TOOL_CALL_* frames carry, so the client's plan activity
              // and its tool call can be recognized as one action. Omitted
              // when the runtime has no logical id; the plan activity is
              // still valid without it.
              ...(typeof input.toolCallId === "string" && input.toolCallId.length > 0
                ? { tool_call_id: input.toolCallId }
                : {}),
            },
          }
```

- [ ] **Step 5: Run to verify pass**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/core && npx vitest --run test/capabilities/planning.test.ts
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/core test
```

Expected: the planning file green; whole core suite green (506 passed — 504
baseline plus the two new tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/types.ts packages/core/src/capabilities/built-in/planning.ts packages/core/test/capabilities/planning.test.ts
git commit -m "feat(core): carry the logical tool-call id into plan updates"
```

---

### Task 2: The tool converter supplies the logical ID

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts` (the stream-transformer dispatch loop, near lines 103–119)
- Modify: `packages/langchain/test/tool-converter.test.ts`

`extractToolCallId(liveConfig)` (same file, near line 208) already reads the
model tool-call id from `config.toolCall.id` / `configurable.toolCallId` /
`metadata.tool_call_id`, returning `""` when absent, and the converter already
calls it into a local `toolCallId` for the offload/ToolMessage paths. Reuse
that local — do NOT call `runManager.runId`.

- [ ] **Step 1: Write the failing tests**

Read `packages/langchain/test/tool-converter.test.ts` first. Its first test
("dispatches every transformer output as a capability event with the live
config") builds a `config` object and a converted tool with a transformer, and
asserts the transform input equals `{ toolName, toolOutput }`. Update that test
so the config carries a provider tool-call id and a run manager is supplied,
then assert the transformer received the PROVIDER id (and explicitly not the
run id). Concretely: give `config` a `toolCall: { id: "provider-call-1" }`
property, pass a run manager `{ runId: "execution-run-1", getChild: vi.fn(() => undefined) }`
as the converted tool's second `func` argument, capture the transform input into
a local `transformerInput` variable instead of asserting inline, and after the
call assert:

```typescript
    expect(transformerInput).toMatchObject({
      toolName: "probe",
      toolOutput: JSON.stringify({ ok: true }),
      toolCallId: "provider-call-1",
    })
    expect(transformerInput?.toolCallId).not.toBe("execution-run-1")
```

Keep every other assertion in that test (dispatch order, `dawn.capability`
payloads, the live-config argument) exactly as-is. Import the type if useful:
`import type { StreamTransformerInput } from "@dawn-ai/core"`.

Then ADD this test:

```typescript
  test("omits the transformer tool-call id when the config carries none", async () => {
    let transformerInput: StreamTransformerInput | undefined
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* (input) {
            transformerInput = input
          },
        },
      ],
    )

    await converted.func({}, undefined as never, { signal: new AbortController().signal } as never)

    expect(transformerInput).toBeDefined()
    expect(Object.hasOwn(transformerInput ?? {}, "toolCallId")).toBe(false)
  })
```

Adapt the `convertToolToLangChain(...)` argument list to the real signature in
the file if it differs (tool, middlewareContext, offload, routeParamNames,
streamTransformers).

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/langchain && npx vitest --run test/tool-converter.test.ts
```

Expected: FAIL — `toolCallId` is not passed to transformers yet.

- [ ] **Step 3: Implement**

In `packages/langchain/src/tool-converter.ts`, inside the stream-transformer
loop, change the transform call to:

```typescript
          for await (const output of transformer.transform({
            toolName: tool.name,
            toolOutput: convertedResult,
            // The model/provider tool-call id — the public identity the root
            // AG-UI tool frames use. `extractToolCallId` returns "" when the
            // provider supplied none, in which case the field stays absent.
            ...(toolCallId ? { toolCallId } : {}),
          })) {
```

No other change: `toolCallId` is already in scope from the existing
`const toolCallId = extractToolCallId(liveConfig)` above.

- [ ] **Step 4: Run to verify pass**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/langchain && npx vitest --run test/tool-converter.test.ts
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/langchain test
```

Expected: both green (langchain 218 passed — 217 baseline plus one new test).

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): pass the logical tool-call id to stream transformers"
```

---

### Task 3: Keep child tool-call IDs off child capability chunks

A subagent's own `writeTodos` now dispatches `plan_update` carrying the
CHILD's tool-call id. That id is internal to the subagent (root suppression
never correlates on child events, and the documented activity boundary keeps
child tool ids internal), so the agent adapter strips it when namespacing a
child capability event.

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts` (`childData`, near line 387)
- Modify: `packages/langchain/test/agent-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("capability custom events", …)` block (it
already has a `collectCustomEvents(metadata, extraCapabilityPayloads)` helper
whose second argument injects extra `dawn.capability` payloads and whose first
argument supplies child metadata — read the helper before writing this):

```typescript
  test("strips the child's tool-call id from a namespaced capability chunk", async () => {
    const chunks = await collectCustomEvents(
      {
        dawn: {
          subagent_stack: [
            { callId: "call-child", name: "researcher", routeId: "/researcher" },
          ],
        },
      },
      [{ event: "plan_update", data: { todos: ["child"], tool_call_id: "call_child_writeTodos" } }],
    )

    const childPlan = chunks.find((chunk) => chunk.type === "subagent.plan_update")
    expect(childPlan).toBeDefined()
    expect(Object.hasOwn(childPlan?.data ?? {}, "tool_call_id")).toBe(false)
    expect(childPlan?.data).toMatchObject({
      todos: ["child"],
      call_id: "call-child",
      subagent: "researcher",
      route_id: "/researcher",
    })
  })
```

If the helper's signature or the child metadata shape differs from the above,
adapt to the file's actual helper — the assertions are the contract.

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/langchain && npx vitest --run test/agent-adapter.test.ts
```

Expected: FAIL — `tool_call_id` currently passes through `childData`.

- [ ] **Step 3: Implement**

Replace `childData` in `packages/langchain/src/agent-adapter.ts`:

```typescript
function childData(child: SubagentContext, data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return { value: data, ...childIdentity(child) }
  // A child capability event carries the CHILD's own tool-call id (e.g. a
  // subagent's writeTodos). Only ROOT orchestration correlates a tool call
  // with its activity, and the subagent activity boundary keeps child tool
  // ids internal, so the id is dropped rather than namespaced outward.
  const { tool_call_id: _toolCallId, ...publicData } = data
  return { ...publicData, ...childIdentity(child) }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/langchain && npx vitest --run test/agent-adapter.test.ts
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/langchain test
```

Expected: green (219 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter.test.ts
git commit -m "feat(langchain): keep child tool-call ids off namespaced capability chunks"
```

---

### Task 4: Projector returns correlation beside the activity

**Files:**
- Modify: `packages/ag-ui/src/activities.ts`
- Modify: `packages/ag-ui/src/outbound.ts` (the activity branch, near lines 105–109)
- Modify: `packages/ag-ui/test/activities.test.ts`

The return type of `DawnActivityProjector.project` changes from
`ActivitySnapshotEvent | null` to `ProjectedDawnActivity`. The test file's
local wrapper at `packages/ag-ui/test/activities.test.ts:22-31` is the ONLY
place that needs updating for the 81 existing call sites — update the wrapper
to unwrap `.event`, and the existing tests keep working unchanged.

- [ ] **Step 1: Write the failing tests**

First update the test wrapper so existing tests compile against the new shape:

```typescript
function createDawnActivityProjector(runId: string) {
  const projector = createUncheckedDawnActivityProjector(runId)
  return {
    project(...args: Parameters<typeof projector.project>) {
      const { event } = projector.project(...args)
      if (event !== null) expect(ActivitySnapshotEventSchema.parse(event)).toEqual(event)
      return event
    },
  }
}
```

Then add a new describe block that uses the UNCHECKED projector directly (it
is the one that returns the full projection):

```typescript
describe("orchestration correlation", () => {
  const IDENTITY = {
    call_id: "call_task_0_2",
    subagent: "researcher",
    route_id: "/researcher",
    depth: 1,
  } as const

  test("a valid plan update correlates to its writeTodos call", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    const projection = projector.project("plan_update", {
      todos: [{ content: "Search", status: "pending" }],
      tool_call_id: "call_writeTodos_0_1",
    })

    expect(projection.event).not.toBeNull()
    expect(projection.orchestration).toEqual({
      toolCallId: "call_writeTodos_0_1",
      toolName: "writeTodos",
    })
    expect(JSON.stringify(projection.event?.content)).not.toContain("call_writeTodos_0_1")
  })

  test("a plan update without a correlation id yields no correlation", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    const projection = projector.project("plan_update", {
      todos: [{ content: "Search", status: "pending" }],
    })

    expect(projection.event).not.toBeNull()
    expect(projection.orchestration).toBeUndefined()
  })

  test("an empty or non-string correlation id yields no correlation", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    const todos = [{ content: "Search", status: "pending" }]

    expect(
      projector.project("plan_update", { todos, tool_call_id: "" }).orchestration,
    ).toBeUndefined()
    expect(
      projector.project("plan_update", { todos, tool_call_id: 42 }).orchestration,
    ).toBeUndefined()
  })

  test("a malformed plan update yields neither event nor correlation", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    const projection = projector.project("plan_update", {
      todos: [{ content: "bad", status: "unknown" }],
      tool_call_id: "call_writeTodos_0_1",
    })

    expect(projection.event).toBeNull()
    expect(projection.orchestration).toBeUndefined()
  })

  test("the first subagent start correlates to its task call by call_id", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    const projection = projector.project("subagent.start", IDENTITY)

    expect(projection.event).not.toBeNull()
    expect(projection.orchestration).toEqual({
      toolCallId: "call_task_0_2",
      toolName: "task",
    })
  })

  test("a repeated subagent start re-emits the snapshot without re-correlating", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    projector.project("subagent.start", IDENTITY)
    const repeat = projector.project("subagent.start", IDENTITY)

    expect(repeat.event).not.toBeNull()
    expect(repeat.orchestration).toBeUndefined()
  })

  test("subagent lifecycle updates after start carry no correlation", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    projector.project("subagent.start", IDENTITY)

    const planUpdate = projector.project("subagent.plan_update", {
      ...IDENTITY,
      todos: [{ content: "child", status: "pending" }],
    })
    const toolCall = projector.project("subagent.tool_call", {
      ...IDENTITY,
      id: "child-tool-1",
      tool: "readDoc",
    })
    const end = projector.project("subagent.end", IDENTITY)

    expect(planUpdate.orchestration).toBeUndefined()
    expect(toolCall.orchestration).toBeUndefined()
    expect(end.orchestration).toBeUndefined()
    expect(end.event).not.toBeNull()
  })

  test("a malformed subagent start yields neither event nor correlation", () => {
    const projector = createUncheckedDawnActivityProjector("run-1")
    const projection = projector.project("subagent.start", { ...IDENTITY, depth: 0 })

    expect(projection.event).toBeNull()
    expect(projection.orchestration).toBeUndefined()
  })
})
```

Check how the test file imports the raw projector (it aliases it as
`createUncheckedDawnActivityProjector`) and reuse that import.

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx vitest --run test/activities.test.ts
```

Expected: FAIL — `project()` still returns a bare event.

- [ ] **Step 3: Implement in `packages/ag-ui/src/activities.ts`**

Add the types after `DawnSubagentActivityContent`:

```typescript
/** The two built-in orchestration tools that have canonical activities. */
export type OrchestrationToolName = "writeTodos" | "task"

/**
 * Correlation between a recognized activity and the root tool call that
 * produced it, keyed by the model/provider tool-call id (logical identity).
 * Package-private: it never reaches the wire. PR 3's suppression ledger is
 * its consumer — it decides whether the generic tool frames for that call are
 * redundant with the activity being emitted here.
 */
export interface DawnActivityCorrelation {
  readonly toolCallId: string
  readonly toolName: OrchestrationToolName
}

/** An activity projection plus optional orchestration correlation. */
export interface ProjectedDawnActivity {
  readonly event: ActivitySnapshotEvent | null
  readonly orchestration?: DawnActivityCorrelation
}
```

Change the interface:

```typescript
export interface DawnActivityProjector {
  project(type: DawnActivityChunkType, data: unknown): ProjectedDawnActivity
}
```

Add a helper next to `subagentSnapshot`:

```typescript
function projectEvent(event: ActivitySnapshotEvent | null): ProjectedDawnActivity {
  return { event }
}
```

Then, inside `createDawnActivityProjector`'s `project`:

- `plan_update`: on the malformed path return `projectEvent(null)`. On the
  valid path build the event as today, then:

```typescript
        const toolCallId = readRawNonemptyString(data, "tool_call_id")
        return {
          event,
          ...(toolCallId !== null
            ? { orchestration: { toolCallId, toolName: "writeTodos" as const } }
            : {}),
        }
```

- `subagent.start`: the ALREADY-TRACKED branch (`current !== undefined`) returns
  `projectEvent(...)` — a repeat start never re-correlates. The NEW-state branch
  returns:

```typescript
        return {
          event: subagentSnapshot(state),
          orchestration: { toolCallId: parsedIdentity.callId, toolName: "task" as const },
        }
```

  (`parsedIdentity.callId` is already validated non-empty by
  `parseSubagentIdentity`, so no extra check is needed — and it IS the logical
  id, which is why `task` needs no extra field.)

- Every other branch and every remaining `return null`: wrap in
  `projectEvent(...)`.

Do NOT export the new types from `packages/ag-ui/src/index.ts` — they are
package-private. Run `npx vitest --run test/public-api.test.ts` to confirm the
public surface test still passes unchanged.

- [ ] **Step 4: Update `packages/ag-ui/src/outbound.ts`**

```typescript
      if (isDawnActivityChunkType(chunk.type)) {
        const projection = activityProjector.project(chunk.type, chunk.data)
        if (projection.event !== null) yield projection.event
        continue
      }
```

Nothing else changes: correlation is deliberately unused until PR 3.

- [ ] **Step 5: Run to verify pass**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

Expected: green (90 passed — 82 baseline plus the eight new correlation tests).
The outbound and conformance suites must be unchanged and green: this PR emits
exactly the same AG-UI events as before.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src/activities.ts packages/ag-ui/src/outbound.ts packages/ag-ui/test/activities.test.ts
git commit -m "feat(ag-ui): return orchestration correlation beside activity snapshots"
```

---

### Task 5: Changeset, full verification, review

**Files:**
- Create: `.changeset/orchestration-correlation.md`

- [ ] **Step 1: Write the changeset**

Check `AGENTS.md` for banned phrases first (`grep -in "banned\|forbidden" AGENTS.md`,
which points at `forbiddenContent` in `scripts/check-docs.mjs`) — changeset text
reaches the generated CHANGELOG and a banned phrase reds the release.

```markdown
---
"@dawn-ai/core": patch
"@dawn-ai/langchain": patch
"@dawn-ai/ag-ui": patch
---

Carry the model's tool-call ID from a tool execution into the capability
stream: `StreamTransformerInput` gains an optional `toolCallId`, and the
planning capability echoes it as `tool_call_id` on `plan_update`. Child
capability events keep their subagent's tool-call ID internal. This is the
correlation groundwork for presenting built-in orchestration work once; no
emitted AG-UI event changes yet.
```

All three MUST be `patch` — the fixed 0.x release group turns any `minor` into
a 1.0.0 bump.

- [ ] **Step 2: Full verification (report each exit code; never pipe through `tail` in a way that hides it)**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/core test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/langchain test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/cli test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm vitest run --config test/generated/vitest.config.ts run-generated-research-activation
```

The activation lane takes ~90–140s and must run alone. It asserts the safe
journey's seven activity snapshots and their content — `tool_call_id` must NOT
appear inside any `ACTIVITY_SNAPSHOT.content` (the lane already asserts this
via its `call_[A-Za-z]+_\d+_\d+` exclusion regex, which now also covers the new
field). If that assertion fires, the projector is leaking correlation into
content — fix the source, not the test.

- [ ] **Step 3: Commit**

```bash
git add .changeset/orchestration-correlation.md
git commit -m "chore: changeset for orchestration correlation plumbing"
```

- [ ] **Step 4: Review and finish**

Use superpowers:requesting-code-review on `git diff main...HEAD`, then
superpowers:finishing-a-development-branch. PR title:
`feat: correlate built-in orchestration activities by logical tool-call id`.
The PR body must state that no emitted AG-UI event changes in this PR (only the
raw capability stream's `plan_update` gains a public id, and child capability
chunks lose an internal one), and link PR 1 (#481) and the amended design.

---

## Out of scope (PR 3 — do not do here)

- The orchestration suppression ledger, its bounds, and the interrupt-drop rule.
- Any change to which AG-UI events reach the client.
- Docs pages (`apps/web/content/docs/ag-ui.mdx`, the research web recipe,
  package READMEs) — PR 3 documents the presentation policy in one place.
- `MESSAGES_SNAPSHOT`, subagent `final_message` in activity content, streamed
  `TOOL_CALL_ARGS` deltas.
