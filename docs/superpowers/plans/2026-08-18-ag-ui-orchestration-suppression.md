# AG-UI Orchestration Suppression Implementation Plan (PR 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present each successful built-in orchestration action once — `writeTodos` as a `dawn.plan` activity, `task` as a `dawn.subagent` activity — by suppressing the redundant generic `TOOL_CALL_*` frames for exactly those two calls, while failing open to the generic frames whenever the semantic projection cannot be proven.

**Architecture:** A new pure, request-local **orchestration ledger** (`packages/ag-ui/src/orchestration-ledger.ts`) owns all buffering and ordering. The outbound mapper stops yielding events directly: it builds the events it would have emitted and routes every one through the ledger, emitting whatever the ledger returns. The ledger holds the frames of a suppressible call until a correlated activity commits suppression (drop the frames) or a result/terminal boundary forces fallback (emit them in source order). Everything else passes through untouched — instantly when nothing is pending, deferred behind the head of the ledger when something is.

**Tech Stack:** TypeScript, Node.js 24, pnpm 10, Vitest, AG-UI 0.0.57 (`@ag-ui/core`, `@ag-ui/client` `verifyEvents`), Biome (repo lint script only), Changesets.

**Approved spec:** `docs/superpowers/specs/2026-08-18-ag-ui-orchestration-projection-design.md` (the **amended** version, on branch `blove/ag-ui-orchestration-projection`) — sections "Part D: orchestration projection buffer", "Event flows", "Tool-result handling", "Text, unknown chunks, and terminal boundaries", "Privacy and public contracts", "UI behavior", "Documentation and release". This plan is self-contained; the spec is background.

**What already shipped (do not redo):**
- **PR 1 (#481, merged):** root `TOOL_CALL_*`/`TOOL_CALL_RESULT` events are keyed by the model's logical tool-call ID. Calls are announced from `on_chat_model_end` (so a turn's frames arrive *before* any tool executes); resume replays announce at `on_tool_end`; ID-less streams fall back to the execution run ID.
- **PR 2 (#482, merged):** `plan_update` carries `tool_call_id`; `subagent.start.call_id` is the logical ID; the activity projector returns `ProjectedDawnActivity { event, orchestration? }` where `orchestration` is `{ toolCallId, toolName: "writeTodos" | "task" }`, populated at exactly two boundaries (valid `plan_update` with a non-empty id; the FIRST `subagent.start` per call id). `packages/ag-ui/src/outbound.ts` currently yields only `projection.event` and ignores `orchestration`.

**Execution baseline:** Branch `blove/ag-ui-orchestration-suppression` (already created) off `main` at `6b8134b8fdd7e07043e709683deb3337726cf368`. Never edit `pnpm-lock.yaml`.

**Toolchain trap:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && ` (shell state does not persist; the default shell is Node 22 and makes unrelated tests fail spuriously). Never run bare `biome check --write` — pass explicit paths with `--config-path packages/config-biome/biome.json`.

**Dependency order:** Tasks 1 → 2 → 3 are strictly sequential (2 consumes 1; 3 extends 2). Tasks 4 and 5 need 3. Do not run the activation lane concurrently with anything.

---

### Task 0: Baseline

- [ ] **Step 1: Confirm branch, toolchain, and green baseline**

```bash
git branch --show-current   # blove/ag-ui-orchestration-suppression
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node --version   # v24.x
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

Expected: ag-ui 90 passed. If red, STOP.

---

### Task 1: The orchestration ledger (pure module)

**Files:**
- Create: `packages/ag-ui/src/orchestration-ledger.ts`
- Create: `packages/ag-ui/test/orchestration-ledger.test.ts`

The ledger is deliberately independent of the stream generator: it takes already-built AG-UI events and returns the events to emit now. That makes every ordering and bounds rule unit-testable without driving a generator.

**Behavior contract (implement exactly):**

1. `onToolCall(id, name, frames)` — `frames` are the `TOOL_CALL_START`/`ARGS`(one or many)/`END` events for one call. If suppression is enabled, `id` is a non-empty string, and `name` is exactly `writeTodos` or `task`, and `id` is not already tracked → append an **unresolved candidate** entry holding those frames and emit nothing (return `[]`). Otherwise → route the frames as a passthrough entry (deferred if anything is pending, else returned immediately).
2. `onActivity(event, correlation)` — the activity event itself is always routed as passthrough (it is never suppressed). Before routing, if `correlation` is present and names a currently **unresolved** candidate whose tracked name equals `correlation.toolName`, that candidate becomes **suppressed**: its frames are discarded, and its id is remembered so its later result can be dropped. A correlation naming an unknown or already-suppressed id changes nothing.
3. `onToolResult(id, name, event)` — if `id` is a non-empty string and names a **suppressed** call whose remembered name equals `name` → drop the result (return `[]`) and forget the id. If it names an **unresolved** candidate whose name equals `name` → mark that candidate **fallback** (its frames will emit) and route the result as passthrough after it. If the id matches a tracked call but the name does not → route as passthrough, leaving the candidate untouched. Otherwise → route as passthrough.
4. `onPassthrough(event)` — route one event.
5. `settle(interruptToolCallId?)` — terminal: every remaining **unresolved** candidate becomes **fallback**, EXCEPT one whose id equals `interruptToolCallId`, which is **dropped** (frames discarded). Then drain everything in order and return it. All tracking state is cleared; suppression stays disabled for anything after (there is nothing after a terminal).
6. **Routing/draining:** entries are an ordered list. "Routing" appends to the list, then drains from the head while the head is *resolved*: a passthrough entry is always resolved; a candidate is resolved when suppressed (emits nothing) or fallback (emits its frames); an unresolved candidate blocks. Drained suppressed candidates leave their id in the suppressed map. When the list is empty, routing returns the event immediately.
7. **Bounds** — named exported constants `MAX_TRACKED_CALLS = 16`, `MAX_DEFERRED_EVENTS = 256`, `MAX_RETAINED_CHARS = 1_048_576`. Counted across all held state: tracked calls = unresolved + suppressed ids; deferred events = events held in the list; retained chars = shallow sum of the string-valued fields of held events (see `measureEvent` below). Exceeding ANY bound (strictly greater than the limit after the add) triggers **global fail-open**: every unresolved candidate becomes fallback, the whole list drains in order, `suppressionDisabled` is set for the rest of the run, and already-suppressed ids remain tracked so their results are still dropped. An ordinary event is never dropped or truncated to stay within a bound.
8. **Duplicate ids:** `onToolCall` with an id already tracked (unresolved or suppressed) is malformed → global fail-open AND clear the suppressed map (so a later colliding result is preserved generically), then route the duplicate's frames as passthrough.

- [ ] **Step 1: Write the failing tests**

Create `packages/ag-ui/test/orchestration-ledger.test.ts`. Use small helpers so tests read as event sequences:

```typescript
import { EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import type { AguiOutboundEvent } from "../src/outbound.js"
import {
  createOrchestrationLedger,
  MAX_DEFERRED_EVENTS,
  MAX_RETAINED_CHARS,
  MAX_TRACKED_CALLS,
} from "../src/orchestration-ledger.js"

function frames(id: string, name: string, args = "{}"): AguiOutboundEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ]
}

function result(id: string, content = "ok"): AguiOutboundEvent {
  return { type: EventType.TOOL_CALL_RESULT, messageId: `tr-${id}`, toolCallId: id, content }
}

function activity(messageId: string): AguiOutboundEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: "dawn.plan",
    replace: true,
    content: { todos: [] },
  }
}

function text(delta: string): AguiOutboundEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta }
}

const kinds = (events: readonly AguiOutboundEvent[]) => events.map((event) => event.type)
```

Write these tests (each asserts the EXACT returned arrays, in order):

1. **passes ordinary tools straight through** — `onToolCall("call_a", "searchCorpus", frames(...))` returns those three frames immediately; `onToolResult` returns the result.
2. **holds a writeTodos call until its plan activity commits suppression** — `onToolCall("call_w", "writeTodos", …)` returns `[]`; `onActivity(activity("dawn:plan:run-1"), {toolCallId: "call_w", toolName: "writeTodos"})` returns exactly `[the activity]` (frames discarded); `onToolResult("call_w", "writeTodos", result("call_w"))` returns `[]`.
3. **holds a task call until subagent.start commits suppression** — same shape with `toolName: "task"`.
4. **falls back when the result arrives with no correlation** — `onToolCall("call_t", "task", …)` → `[]`; `onToolResult("call_t", "task", result("call_t"))` returns the three frames **followed by** the result.
5. **defers unrelated events behind an unresolved candidate and releases them in order** — `onToolCall("call_w", "writeTodos", …)` → `[]`; `onPassthrough(text("a"))` → `[]`; `onToolCall("call_s", "searchCorpus", frames("call_s","searchCorpus"))` → `[]`; then the correlated activity returns `[activity, text("a"), …call_s frames]` in exactly that order.
6. **a correlation for an unknown id emits the activity and holds the candidate** — activity with `toolCallId: "nope"` while `call_w` is unresolved returns `[]` (deferred behind the candidate); a later `onToolResult("call_w", "writeTodos", …)` then returns frames, activity, result in source order.
7. **a correlation whose toolName does not match the tracked name does not suppress** — track `call_w` as `writeTodos`, send correlation `{toolCallId: "call_w", toolName: "task"}`; the candidate must still fall back on its result.
8. **a result whose name does not match does not resolve the candidate** — `onToolResult("call_w", "somethingElse", …)` leaves `call_w` unresolved (returns `[]`), and `settle()` then emits the frames.
9. **drops the result of a suppressed call exactly once** — after suppression, the first matching result returns `[]`; a SECOND result with the same id returns that event (the id was forgotten).
10. **parallel candidates drain only a resolved prefix** — track `call_w1` then `call_w2`; correlate `call_w2` FIRST → returns `[]` (blocked by w1); correlate `call_w1` → returns `[activity1, activity2]` in source order.
11. **settle flushes unresolved candidates as fallback in source order** — two unresolved candidates plus interleaved passthrough; `settle()` returns everything in source order.
12. **settle drops the candidate named by the interrupt** — `settle("call_t")` discards `call_t`'s frames while flushing every other entry in order.
13. **settle after suppression emits nothing for the suppressed call.**
14. **duplicate id fails open** — track `call_w` (unresolved), then `onToolCall("call_w", "writeTodos", …)` again: the return contains the FIRST candidate's frames followed by the duplicate's frames, and a subsequent `writeTodos` call with a fresh id is NOT held (returns its frames immediately).
15. **a duplicate colliding with a SUPPRESSED id preserves a later result** — suppress `call_w`, then `onToolCall("call_w", …)` again; afterwards `onToolResult("call_w", …)` must RETURN the result (not drop it).
16. **exceeds MAX_TRACKED_CALLS** — hold `MAX_TRACKED_CALLS` candidates (all unresolved, distinct ids); the NEXT candidate trips fail-open: everything drains in source order and no further call is held. Assert the exact boundary: the 16th is still held (returns `[]`), the 17th trips it.
17. **exceeds MAX_DEFERRED_EVENTS** — one unresolved candidate, then push passthrough events until the bound trips; assert nothing was dropped (count events in vs out) and that suppression is disabled afterwards.
18. **exceeds MAX_RETAINED_CHARS** — one unresolved candidate, then a passthrough text event whose `delta` alone exceeds `MAX_RETAINED_CHARS`; assert fail-open drained everything and the long event is present in the output unmodified (`.length` unchanged).
19. **suppression stays disabled after fail-open but suppressed ids still drop results** — suppress `call_w1`, trip a bound, then `onToolResult("call_w1", "writeTodos", …)` returns `[]` while a new `writeTodos` call is not held.

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx vitest --run test/orchestration-ledger.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `packages/ag-ui/src/orchestration-ledger.ts`**

```typescript
import type { AguiOutboundEvent } from "./outbound.js"

/** Built-in tools whose generic frames a semantic activity can replace. */
const ORCHESTRATION_TOOL_NAMES = new Set(["writeTodos", "task"])

/** Bounds on everything the ledger may retain for one run. */
export const MAX_TRACKED_CALLS = 16
export const MAX_DEFERRED_EVENTS = 256
export const MAX_RETAINED_CHARS = 1_048_576

export interface OrchestrationCorrelation {
  readonly toolCallId: string
  readonly toolName: string
}

export interface OrchestrationLedger {
  onToolCall(
    id: string | undefined,
    name: string,
    frames: readonly AguiOutboundEvent[],
  ): AguiOutboundEvent[]
  onActivity(
    event: AguiOutboundEvent,
    correlation: OrchestrationCorrelation | undefined,
  ): AguiOutboundEvent[]
  onToolResult(
    id: string | undefined,
    name: string,
    event: AguiOutboundEvent,
  ): AguiOutboundEvent[]
  onPassthrough(event: AguiOutboundEvent): AguiOutboundEvent[]
  settle(interruptToolCallId?: string): AguiOutboundEvent[]
}

type CandidateState = "unresolved" | "suppressed" | "fallback"

interface CandidateEntry {
  readonly kind: "candidate"
  readonly id: string
  readonly name: string
  state: CandidateState
  frames: readonly AguiOutboundEvent[]
}

interface PassthroughEntry {
  readonly kind: "passthrough"
  readonly event: AguiOutboundEvent
}

type LedgerEntry = CandidateEntry | PassthroughEntry

/**
 * Shallow size accounting. The adapter constructs every event it hands us, so
 * only its own string fields can grow: no recursive walk of foreign objects is
 * needed (and none is done — a hostile getter must not be able to run here).
 */
function measureEvent(event: AguiOutboundEvent): number {
  let total = 0
  for (const value of Object.values(event as Record<string, unknown>)) {
    if (typeof value === "string") total += value.length
  }
  return total
}

/**
 * Request-local buffer that lets one semantic activity stand in for the
 * generic tool frames of the built-in call that produced it.
 *
 * It fails open in every direction: a call it cannot correlate, a bound it
 * cannot respect, or a terminal boundary it reaches with work outstanding all
 * end with the original frames emitted in source order. The only events it
 * ever discards are the frames and result of a call whose activity has
 * already been emitted — and, at an interrupt, the frames of the call that
 * interrupt belongs to, because the resumed run re-presents that same call
 * under the same logical id.
 */
export function createOrchestrationLedger(): OrchestrationLedger {
  const entries: LedgerEntry[] = []
  const unresolved = new Map<string, CandidateEntry>()
  const suppressed = new Map<string, string>()
  let suppressionDisabled = false
  let deferredEvents = 0
  let retainedChars = 0

  function countHeld(events: readonly AguiOutboundEvent[], sign: 1 | -1): void {
    deferredEvents += sign * events.length
    for (const event of events) retainedChars += sign * measureEvent(event)
  }

  function isResolved(entry: LedgerEntry): boolean {
    return entry.kind === "passthrough" || entry.state !== "unresolved"
  }

  /** Emit the resolved prefix of the ledger. */
  function drainHead(): AguiOutboundEvent[] {
    const out: AguiOutboundEvent[] = []
    while (entries.length > 0) {
      const entry = entries[0]
      if (entry === undefined || !isResolved(entry)) break
      entries.shift()
      if (entry.kind === "passthrough") {
        countHeld([entry.event], -1)
        out.push(entry.event)
        continue
      }
      countHeld(entry.frames, -1)
      if (entry.state === "fallback") out.push(...entry.frames)
      entry.frames = []
    }
    return out
  }

  /** Fail open: nothing stays held, and no new call is considered. */
  function failOpen(options: { readonly forgetSuppressed: boolean }): AguiOutboundEvent[] {
    suppressionDisabled = true
    for (const candidate of unresolved.values()) candidate.state = "fallback"
    unresolved.clear()
    if (options.forgetSuppressed) suppressed.clear()
    const out: AguiOutboundEvent[] = []
    while (entries.length > 0) out.push(...drainHead())
    return out
  }

  function overBounds(): boolean {
    return (
      unresolved.size + suppressed.size > MAX_TRACKED_CALLS ||
      deferredEvents > MAX_DEFERRED_EVENTS ||
      retainedChars > MAX_RETAINED_CHARS
    )
  }

  function route(events: readonly AguiOutboundEvent[]): AguiOutboundEvent[] {
    if (entries.length === 0) return [...events]
    for (const event of events) {
      entries.push({ kind: "passthrough", event })
      countHeld([event], 1)
    }
    const drained = drainHead()
    if (!overBounds()) return drained
    return [...drained, ...failOpen({ forgetSuppressed: false })]
  }

  return {
    onToolCall(id, name, frames) {
      if (id !== undefined && id !== "" && (unresolved.has(id) || suppressed.has(id))) {
        // A colliding id makes every decision about it ambiguous.
        return [...failOpen({ forgetSuppressed: true }), ...route(frames)]
      }
      if (
        suppressionDisabled ||
        id === undefined ||
        id === "" ||
        !ORCHESTRATION_TOOL_NAMES.has(name)
      ) {
        return route(frames)
      }
      const candidate: CandidateEntry = {
        kind: "candidate",
        id,
        name,
        state: "unresolved",
        frames,
      }
      entries.push(candidate)
      unresolved.set(id, candidate)
      countHeld(frames, 1)
      if (!overBounds()) return []
      return failOpen({ forgetSuppressed: false })
    },

    onActivity(event, correlation) {
      if (correlation !== undefined) {
        const candidate = unresolved.get(correlation.toolCallId)
        if (candidate !== undefined && candidate.name === correlation.toolName) {
          candidate.state = "suppressed"
          countHeld(candidate.frames, -1)
          candidate.frames = []
          unresolved.delete(candidate.id)
          suppressed.set(candidate.id, candidate.name)
        }
      }
      return route([event])
    },

    onToolResult(id, name, event) {
      if (id === undefined || id === "") return route([event])
      if (suppressed.get(id) === name) {
        suppressed.delete(id)
        return []
      }
      const candidate = unresolved.get(id)
      if (candidate !== undefined && candidate.name === name) {
        candidate.state = "fallback"
        unresolved.delete(id)
      }
      return route([event])
    },

    onPassthrough(event) {
      return route([event])
    },

    settle(interruptToolCallId) {
      for (const candidate of unresolved.values()) {
        if (candidate.id === interruptToolCallId) {
          // The resumed run re-presents this same call under this same id, so
          // flushing here would leave the client holding a duplicate the
          // resume can never reconcile. The interrupt itself carries the
          // actionable context.
          countHeld(candidate.frames, -1)
          candidate.frames = []
          candidate.state = "suppressed"
          continue
        }
        candidate.state = "fallback"
      }
      unresolved.clear()
      const out: AguiOutboundEvent[] = []
      while (entries.length > 0) out.push(...drainHead())
      suppressed.clear()
      return out
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx vitest --run test/orchestration-ledger.test.ts
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx tsc --noEmit
```

If a bounds test disagrees with the implementation about the exact trip point, fix the TEST to match "strictly greater than the limit after the add" — but only after confirming by reading the code that the implementation matches that rule.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/orchestration-ledger.ts packages/ag-ui/test/orchestration-ledger.test.ts
git commit -m "feat(ag-ui): add the orchestration suppression ledger"
```

---

### Task 2: Route the outbound mapper through the ledger

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Modify: `packages/ag-ui/test/outbound.test.ts`

Read `packages/ag-ui/src/outbound.ts` first. Today every branch of `toAguiEvents` `yield`s directly. After this task, ONLY the ledger's return values are yielded. Mechanical conversion:

- Create the ledger next to the projector: `const ledger = createOrchestrationLedger()`.
- `flushText()` currently yields a `TEXT_MESSAGE_END`. Change it to route that event: `yield* ledger.onPassthrough({...})`. Keep its `openMessageId` bookkeeping unchanged.
- `token`: route the `TEXT_MESSAGE_START` (when opening) and the `TEXT_MESSAGE_CONTENT` through `onPassthrough`.
- `tool_call`: build the three frames into an array instead of yielding them, then `yield* ledger.onToolCall(tc.id, tc.name, builtFrames)`. **Important:** the frames must be built with the SAME `toolCallId` the current code computes (`tc.id ?? nextId("toolCall")`), and the existing `pendingFallbackToolCallIds` bookkeeping for ID-less calls stays exactly as it is. Pass `tc.id` (the raw upstream id, possibly `undefined`) as the ledger's `id` argument — an ID-less call must never be a candidate.
- `tool_result`: compute `toolCallId` exactly as today (including the FIFO fallback), build the `TOOL_CALL_RESULT` event, then `yield* ledger.onToolResult(tr.id, tr.name, resultEvent)` — again passing the RAW `tr.id`.
- activity branch: `const projection = activityProjector.project(...)`; when `projection.event !== null`, `yield* ledger.onActivity(projection.event, projection.orchestration)`. When it is `null`, emit nothing (unchanged) — but note a `null` event with a correlation is impossible by PR 2's contract.
- `RUN_STARTED` is emitted before anything can be pending: leave it a direct `yield`.
- Terminal handling is Task 3 — for now, immediately before each existing terminal `yield` (`RUN_FINISHED` in the `done` case, the two stream-end paths, and `RUN_ERROR` in the catch and the malformed-interrupt path), insert `yield* ledger.settle()`. The interrupt-drop refinement lands in Task 3.

- [ ] **Step 1: Add the failing tests**

Append to `packages/ag-ui/test/outbound.test.ts` (it already has a `collect(chunks)` helper and a deterministic id factory — reuse them):

```typescript
describe("orchestration suppression", () => {
  const TODOS = [{ content: "Search the corpus", status: "in_progress" }] as const
  const CHILD = {
    call_id: "call_task_0_2",
    subagent: "researcher",
    route_id: "/researcher",
    depth: 1,
  } as const

  test("a correlated writeTodos call presents only as a plan activity", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: { todos: TODOS } } },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      { type: "tool_result", data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
  })

  test("a correlated task call presents only as a subagent activity", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: { subagent: "researcher" } } },
      { type: "subagent.start", data: CHILD },
      { type: "subagent.end", data: CHILD },
      { type: "tool_result", data: { id: "call_task_0_2", name: "task", output: "done" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
  })

  test("an uncorrelated writeTodos call keeps its generic frames in source order", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      { type: "tool_result", data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
  })

  test("ordinary tools are never suppressed and keep their order around a suppressed one", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      { type: "tool_call", data: { id: "call_searchCorpus_0_2", name: "searchCorpus", input: { q: "x" } } },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      { type: "tool_result", data: { id: "call_searchCorpus_0_2", name: "searchCorpus", output: "hit" } },
      { type: "tool_result", data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
    const start = events.find((event) => event.type === EventType.TOOL_CALL_START)
    expect(start).toMatchObject({ toolCallName: "searchCorpus" })
  })

  test("text framing survives a deferred orchestration call", async () => {
    const events = await collect([
      { type: "token", data: "before" },
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an ID-less writeTodos call is never suppressed", async () => {
    const events = await collect([
      { type: "tool_call", data: { name: "writeTodos", input: {} } },
      { type: "plan_update", data: { todos: TODOS } },
      { type: "tool_result", data: { name: "writeTodos", output: "ok" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
  })

  test("an incomplete stream flushes held frames before RUN_FINISHED", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })
})
```

Every EXISTING test in `outbound.test.ts` must keep passing unchanged. If one fails, the routing broke ordering — fix `outbound.ts`, never the old expectation.

- [ ] **Step 2: Verify failure, Step 3: implement the routing, Step 4: verify pass**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts
git commit -m "feat(ag-ui): present built-in orchestration work once"
```

---

### Task 3: Interrupt boundaries

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts` (the `interrupt` case and the terminal paths)
- Modify: `packages/ag-ui/test/outbound.test.ts`

Rules:
- On a VALID interrupt: `yield* flushText()`, then `yield* ledger.settle(interrupt.toolCallId)` — the settle happens when the interrupt chunk is seen, so any fallback frames precede the eventual `RUN_FINISHED`. Then push onto `pendingInterrupts` as today.
- On a MALFORMED interrupt (the `RUN_ERROR` path): `yield* ledger.settle()` before the `RUN_ERROR`.
- The pending-interrupt gate (later non-`done` chunks ignored) is unchanged.
- The other terminal paths keep the plain `ledger.settle()` from Task 2.

Add tests:

```typescript
  test("an interrupt drops the frames of the call it belongs to", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "tool", toolCallId: "call_task_0_2" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })
  })

  test("an interrupt flushes an unrelated held call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "command", toolCallId: "call_runBash_0_9" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an interrupt with no toolCallId flushes every held call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      { type: "interrupt", data: { interruptId: "int-1", kind: "memory" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("a malformed interrupt flushes held frames before RUN_ERROR", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      { type: "interrupt", data: { kind: "tool" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })

  test("an upstream error flushes held frames before RUN_ERROR", async () => {
    async function* failing(): AsyncGenerator<DawnAgentStreamChunk> {
      yield { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } }
      throw new Error("boom")
    }

    const events = []
    for await (const event of toAguiEvents(failing(), CTX, { idFactory: createCounterIdFactory() })) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })
```

Adapt `CTX`/helper names to the file's existing conventions.

- [ ] Steps: failing run → implement → passing run (`pnpm --filter @dawn-ai/ag-ui test`) → commit:

```bash
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts
git commit -m "feat(ag-ui): settle orchestration state at interrupt boundaries"
```

---

### Task 4: Conformance and the generated activation lane

**Files:**
- Modify: `packages/ag-ui/test/conformance.test.ts`
- Modify: `test/generated/run-generated-research-activation.test.ts`

- [ ] **Step 1: Conformance**

The canned stream contains a root `tool_call`/`tool_result` pair plus `plan_update` and `subagent.*` chunks. Give the plan chunk a `tool_call_id` matching a NEW `writeTodos` call you add to the fixture, and make the existing subagent `call_id` match a NEW `task` call. Then assert: `verifyEvents` still accepts the stream; no `TOOL_CALL_*` event references either orchestration id; the pre-existing ordinary tool pair still has full `START → ARGS+ → END → RESULT` correlation; both activity types still appear.

- [ ] **Step 2: Activation lane**

The safe journey's root tool order becomes `recall → searchCorpus → readDoc → writeFile` (from `recall → writeTodos → task → searchCorpus → readDoc → writeFile`). Update the expected `toolCallName` sequence accordingly, and ADD an assertion that no `TOOL_CALL_*` event carries a `toolCallId` of `call_writeTodos_0_1` or `call_task_0_2`. Keep every other assertion — the seven activity snapshots, their content and order, the `^call_` positive checks, the gated/resumed `runBash` id convergence, and the activity-content exclusion regex — exactly as they are.

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm vitest run --config test/generated/vitest.config.ts run-generated-research-activation
```

Triage: if an activity snapshot disappears, suppression ate a capability chunk — that is a bug in Task 2's routing, not a test to update. If a `writeTodos`/`task` frame survives, correlation did not arrive: check that the deterministic aimock ids match between the tool call and the `plan_update`/`subagent.start` payloads before touching anything.

- [ ] **Step 3: Commit**

```bash
git add packages/ag-ui/test/conformance.test.ts test/generated/run-generated-research-activation.test.ts
git commit -m "test: assert built-in orchestration presents once end to end"
```

---

### Task 5: Documentation

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx`
- Modify: `apps/web/content/docs/recipes/research-web-ui.mdx`
- Modify: `packages/ag-ui/README.md`
- Modify: `examples/research/web/README.md`, `packages/devkit/templates/app-research/README.md` (only where they describe the duplicate cards)

State in each place, in that page's voice:
- `writeTodos` and a successfully started `task` are represented by their `dawn.plan` / `dawn.subagent` activities; Dawn does not also emit generic tool events for them.
- Every other root tool remains an ordinary tool event.
- The generic frames still appear as a fail-open fallback when the activity cannot be produced (resolver failure, malformed payload, missing id, buffer limits).
- Activity content still excludes correlation ids and child content.
- A client that renders no activity renderer sees less for those two built-ins — that is the deliberate contract.

REMOVE the statement in `research-web-ui.mdx` (around lines 243-246) that root `task` events are "a separate surface" that the activity renderers "do not suppress or specialize". Do NOT claim the UI performs suppression — it happens in Dawn's adapter. `apps/web/content/docs/ag-ui.mdx`'s chunk→event table needs a row or note reflecting that a correlated `tool_call` for these two tools yields no `TOOL_CALL_*` events.

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/cli test
```

- [ ] Commit: `git commit -m "docs: describe canonical orchestration presentation"`

---

### Task 6: Changeset, full verification, review

- [ ] **Step 1:** Create `.changeset/orchestration-suppression.md` (check `AGENTS.md` banned phrases first):

```markdown
---
"@dawn-ai/ag-ui": patch
---

Present each built-in orchestration action once. A `writeTodos` call whose plan
activity was emitted, and a `task` call whose subagent activity was emitted, no
longer also produce generic tool-call events, so activity-aware AG-UI clients
stop showing a duplicate card for the same work. Every other tool is unchanged,
and the generic events return as a fallback whenever the activity cannot be
produced.
```

- [ ] **Step 2:** Full gates, reporting each exit code explicitly (never pipe in a way that hides them):

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/core test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/langchain test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/cli test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm vitest run --config test/generated/vitest.config.ts run-generated-research-activation
```

- [ ] **Step 3:** Commit the changeset, then use superpowers:requesting-code-review on `git diff main...HEAD` and superpowers:finishing-a-development-branch. PR title: `feat(ag-ui): present built-in orchestration work once`. The body must state the client-visible behavior change, the fail-open guarantees, and that clients without activity renderers see less for these two built-ins.

---

## Out of scope

- `MESSAGES_SNAPSHOT` on reconnect/resume.
- Surfacing a subagent `final_message` summary in activity content (the suppressed `task` result was one carrier of the child's answer — note it as a follow-up, do not implement).
- Streamed `TOOL_CALL_ARGS` deltas from `tool_call_chunks`.
- Making correlation assertable from `@dawn-ai/testing` (`run-result.ts` types `planUpdates` as `{ todos }` only).
- Any generic capability presentation API.
