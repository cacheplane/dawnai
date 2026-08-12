# AG-UI Plan and Subagent Activities Design

**Status:** Approved
**Date:** 2026-08-10
**Baseline:** `e95f4d61` (`origin/main` after the Vercel deployment slice)

## Summary

Expose Dawn's existing planning and subagent progress as two standard AG-UI
activity-message types and render them inline in the flagship research web
example.

The adapter emits authoritative `ACTIVITY_SNAPSHOT` events for a root plan and
for each subagent dispatch. The snapshots update stable activity messages in
place. Their content is intentionally semantic and bounded: plan items,
subagent identity and status, the child plan, and a short child-tool status
trail. Child reasoning, token streams, prompts, tool inputs, tool outputs, and
final child answers do not cross this UI boundary.

The research web client registers typed CopilotKit renderers for both activity
types. Plans appear as checklists; running subagents show bounded progress and
collapse to a concise summary after completion or failure. Existing suggestion,
permission, memory, and generic tool-card behavior remains intact.

## Context

Dawn's runtime already emits the information needed for a useful research
activity experience:

- the planning capability emits a complete `plan_update` after every
  `writeTodos` replacement;
- subagent execution emits `subagent.start`, `subagent.message`,
  `subagent.tool_call`, `subagent.tool_result`, capability events such as
  `subagent.plan_update`, and `subagent.end`; and
- every subagent event carries one generated `call_id`, its subagent name,
  route id, and numeric depth.

The CLI preserves these capability chunks until the final AG-UI translation
boundary. The current `@dawn-ai/ag-ui` v1 translator deliberately ignores them,
so CopilotKit users see the root tool calls and final report but not the plan or
delegated work that produces it.

The default research web UI already provides the surrounding activation path:

- a safe suggestion that drives planning, a researcher subagent, corpus tools,
  and a cited report;
- a permission suggestion and standard interrupt/resume UI;
- generic root-tool cards;
- memory-candidate review; and
- a 100 ms CopilotKit render throttle required to keep a full research stream
  responsive.

The pinned stack needs no protocol or UI-framework upgrade. AG-UI 0.0.57
supports `ACTIVITY_SNAPSHOT` and `ACTIVITY_DELTA`, and CopilotKit 1.66.x supports
schema-validated `renderActivityMessages` entries rendered inline by the
standard chat surface.

## Research evidence

Two local framework audits shaped this boundary.

### Flue

Flue has no first-class plan model. It emits semantic `task_start` and `task`
boundaries, but also flattens every child message, reasoning delta, tool event,
and idle event into the parent stream. Its default React reducer ignores the
task boundaries and does not scope all nested events by child session. That
creates noisy presentation and concrete parent/child projection hazards.

The useful lesson is to retain stable correlation and rich runtime
observability without forwarding the raw nested stream into the primary chat
projection.

### Eve

Eve has a durable, full-replacement todo tool, but it exposes the todo lifecycle
as ordinary tool JSON rather than a plan activity. Its subagent topology is
cleaner: the parent stream carries a small control plane and a child-session id,
while detailed child events live on a separate stream. Eve's terminal client
follows that stream and deliberately projects only nested reasoning, messages,
and child-tool status into an expandable subagent region.

The useful lesson is to make the default UI projection explicit, bounded, and
collapsible. Dawn does not need Eve's additional child-stream transport for this
slice because Dawn already has correlated child events at its translator
boundary.

Neither project justifies exposing a new raw client API as part of the primary
activation path.

## Goals

1. Map root `plan_update` events to one standard `dawn.plan` activity per AG-UI
   run.
2. Map each correlated subagent lifecycle to one standard `dawn.subagent`
   activity per `call_id`.
3. Update activities in place with complete replacement snapshots.
4. Expose enough bounded progress to make the research run understandable
   while it is happening.
5. Keep child prose, reasoning, prompts, tool inputs, tool outputs, and final
   child answers out of activity content.
6. Render both activity types inline in the existing research CopilotSidebar.
7. Preserve all existing text, root-tool, interrupt/resume, memory, and terminal
   run behavior.
8. Prove the public event contract with package tests, AG-UI client conformance,
   focused renderer tests, and the deterministic generated research activation.
9. Update directly affected documentation and publish the protocol addition
   with a patch changeset.

## Non-goals

- Expose a raw or advanced child-event stream API.
- Emit `CUSTOM`, `RAW`, `STATE_SNAPSHOT`, or activity delta events.
- Add AG-UI reconnect, replay, or thread-management semantics.
- Add queued, waiting, cancelled, or paused subagent states that the Dawn stream
  does not currently support truthfully.
- Show child reasoning, token streams, prompts, tool inputs, tool outputs, or
  final child answers.
- Change planning or subagent runtime semantics.
- Add a parent call id, preserve `tool_run_id`, or otherwise change the existing
  subagent correlation envelope.
- Suppress, specialize, or correlate the existing generic `writeTodos` and
  `task` tool cards. A separate follow-up investigates that work.
- Add a persistent activity side rail.
- Change suggestions, permissions, memory governance, or the 100 ms render
  throttle.
- Add browser end-to-end infrastructure.
- Promote the research web tree into `create-dawn-ai-app` or the default
  scaffold.
- Change the generated research starter's runtime, layout, or dependencies. A
  README-only correction is included because the shipped starter currently
  says these activity events are ignored.
- Add a keyless product demo, provider picker, deployment flow, or analytics.

## Selected approach

Use standard, snapshot-only AG-UI activities and inline CopilotKit renderers.

This is preferable to a custom side panel because CopilotKit already treats
activities as first-class messages, updates them independently by message id,
and renders them in chronological chat context. A side panel would introduce a
second client projection, responsive layout work, and run-grouping state while
competing with the existing memory rail.

It is preferable to specialized `writeTodos` and `task` tool cards because
those root tools cannot represent child plans or child-tool progress during the
delegated run, and they would leave Dawn without a reusable AG-UI activity
contract.

It uses complete snapshots rather than JSON Patch deltas because the source plan
is already full-replacement state, the subagent projection is deliberately
small, and a delta is silently unusable before a base snapshot exists.

## Architecture and ownership

The change has two independent layers:

```text
Dawn runtime chunks
        |
        | explicit allowlisted projection
        v
@dawn-ai/ag-ui ACTIVITY_SNAPSHOT events
        |
        | activityType + schema
        v
CopilotKit research activity renderers
```

### Protocol layer

`@dawn-ai/ag-ui` owns:

- the two public activity-type constants;
- the two public TypeScript content contracts;
- strict parsing of recognized Dawn capability payloads;
- request-local subagent projection state;
- stable AG-UI activity message ids; and
- standard snapshot emission.

The translator recognizes only root `plan_update` and the documented
`subagent.*` variants. Other capability extensions keep the existing
flush-and-ignore behavior.

Recognized activity chunks do not close an open root text message. They update a
separate AG-UI activity message without introducing extra assistant text
messages.

### UI layer

The private research web package owns:

- local runtime schemas for the activity contents;
- `PlanActivityCard` and `SubagentActivityCard` presentation;
- the stable renderer registry supplied to `<CopilotKit>`; and
- focused renderer tests.

It adds a direct Zod dependency for synchronous renderer validation. AG-UI and
CopilotKit versions remain unchanged.

The generic tool renderer, permission renderer, suggestion registration, memory
rail, and runtime route remain separate components and are not modified beyond
the provider accepting the new stable activity-renderer registry.

## Public activity contracts

### Activity type constants

`@dawn-ai/ag-ui` exports stable constants equivalent to:

```ts
export const DAWN_PLAN_ACTIVITY_TYPE = "dawn.plan"
export const DAWN_SUBAGENT_ACTIVITY_TYPE = "dawn.subagent"
```

It also exports TypeScript interfaces for both content shapes. The package does
not add a runtime-schema dependency solely for these interfaces.

### Plan activity

Every valid root `plan_update` emits:

```ts
{
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: `dawn:plan:${runId}`,
  activityType: "dawn.plan",
  replace: true,
  content: {
    todos: Array<{
      content: string,
      status: "pending" | "in_progress" | "completed"
    }>
  }
}
```

The snapshot contains the complete source list. It does not duplicate derived
counts or invent an overall plan status. The UI derives progress from the item
statuses.

There is no initial activity for seed `plan.md` content because Dawn currently
emits a plan event only after `writeTodos`. This slice does not add a synthetic
run-start snapshot.

### Subagent activity

Every valid subagent lifecycle uses:

```ts
messageId: `dawn:subagent:${call_id}`
activityType: "dawn.subagent"
replace: true
```

Its complete content is equivalent to:

```ts
interface DawnSubagentActivityContent {
  name: string
  depth: number
  status: "running" | "completed" | "failed"
  todos?: Array<{
    content: string
    status: "pending" | "in_progress" | "completed"
  }>
  tools: Array<{
    name: string
    status: "running" | "completed" | "incomplete"
  }>
  totalToolCount: number
  error?: string
}
```

`call_id` remains the correlation source and appears in the standard activity
message id. It is not duplicated inside content. Route id and child tool ids are
also omitted from content because the primary renderer does not need them.

The projection retains at most the five most recent child tools. It uses child
tool ids only inside request-local state to correlate calls and results. A tool
id, input, result, or error object never enters public activity content.

The internal canonical identity for a subagent is the complete
`{ call_id, subagent, route_id, depth }` tuple already emitted by Dawn. Every
recognized `subagent.*` payload must contain that tuple, and an event may mutate
existing state only when all four fields exactly match the start identity.
`route_id` remains internal to validation and is never copied into public
activity content.

An exposed error is a human-readable string capped at 400 characters. It never
contains a raw error object or stack trace produced by this adapter.

## Event projection

### Root plan

For each valid `plan_update`:

1. validate the full todo array and each item;
2. emit a complete `dawn.plan` replacement snapshot; and
3. leave root text, tools, interrupts, and terminal state untouched.

A malformed plan update is ignored.

### Subagent start

For `subagent.start`:

1. require a non-empty `call_id`, subagent name, and `route_id` plus a positive
   integer depth;
2. create running state when the call is new;
3. treat an identical repeated start in the same request as an idempotent
   upsert without discarding accumulated progress;
4. ignore a conflicting canonical identity that reuses an existing call id;
   and
5. emit the complete running snapshot.

Because projection state is request-local, a request resumed from an interrupt
inside an already-started child begins by re-emitting `subagent.start`. The
runtime reuses the original `call_id`, so the standard client replaces the
pre-interrupt activity instead of creating a duplicate. Delegation approval is
different: it occurs before any start, so resume emits the first activity for
that call. In both cases the new snapshot is intentionally authoritative; the
adapter does not claim durable replay.

### Child plan

For `subagent.plan_update`:

1. require an existing subagent whose complete canonical identity matches;
2. validate the complete todo list;
3. replace the stored child plan; and
4. emit the complete subagent snapshot.

An update before start or with malformed content is ignored.

### Child tools

For `subagent.tool_call`:

1. require an existing subagent whose complete canonical identity matches, a
   non-empty child tool id, and a non-empty tool name;
2. upsert that tool as running;
3. increment `totalToolCount` only for a new tool id;
4. retain only the five newest tool summaries; and
5. emit the complete subagent snapshot.

For `subagent.tool_result`:

1. require an existing subagent whose complete canonical identity matches and
   a currently retained matching child tool id;
2. mark that tool completed; and
3. emit the complete subagent snapshot.

Tool inputs and outputs are deliberately neither parsed nor copied. A result
for an unknown or already evicted tool id is ignored.

### Child messages

`subagent.message` is consumed without retaining content or emitting an AG-UI
event. It never becomes root `TEXT_MESSAGE_CONTENT`.

### Subagent end

For `subagent.end`:

1. require existing subagent state whose complete canonical identity matches;
2. set running tool summaries without results to `incomplete`;
3. set the activity to `failed` when a non-empty error is present, otherwise to
   `completed`;
4. attach only the bounded error for failure;
5. ignore `final_message`; and
6. emit the complete terminal snapshot.

Events received after a terminal end do not mutate that activity. An end before
start is ignored.

### Interrupts and termination

The standard permission interrupt remains the sole actionable representation of
a parked run. Delegation approval happens before `subagent.start`, so no
subagent activity exists while that approval is pending; the first activity is
emitted only after approval succeeds on resume. If an interrupt instead arises
inside an already-started child, its existing activity remains running because
the runtime deliberately emits no terminal `subagent.end`. Resume reuses that
child's `call_id`, so new running and terminal snapshots replace the same
activity message.

The adapter does not reinterpret observation disconnects, aborts, or missing
`subagent.end` events as cancellation or failure. Current runtime behavior does
not provide enough information to make that claim truthfully.

## Research UI

### Renderer registration

Two schema-validated renderer entries are defined with stable module-level or
memoized identity and supplied through `<CopilotKit
renderActivityMessages={...}>`.

An incompatible activity payload fails closed through the renderer schema and
renders nothing. It does not crash the chat or fall back to dumping JSON.

Activity messages remain in the browser transcript but are filtered from later
`RunAgentInput.messages` by the standard AG-UI client, so they do not pollute
model context.

### Plan card

The plan card header shows `Plan · N/M complete`.

- It is expanded when any item is `in_progress`.
- It is collapsed, but remains user-expandable, when no item is active.
- It shows at most eight items and a `+N more` indicator.
- Pending, active, and completed items use both text/icon semantics and visual
  styling rather than color alone.
- Repeated snapshots update the same card instead of creating revision history.

### Subagent card

The subagent header shows its human-readable name, lifecycle status, and total
tool count.

- Running cards are expanded.
- Completed and failed cards collapse automatically and remain expandable.
- The body shows the current child checklist when present.
- The body shows up to five recent child-tool names and statuses.
- A failed card shows the bounded error summary.
- Depth greater than one gets a small `nested` label.
- Cards are not visually attached to a particular parent card because Dawn does
  not expose an unambiguous parent-call id for parallel nested branches.

The renderer displays neither route ids nor runtime correlation ids.

### Existing UI behavior

The three starter suggestions are unchanged. The safe research suggestion is
the primary activity demo.

The standard permission UI remains separate and owns every approval action. An
activity card is informational only and never resolves or cancels an interrupt.

Memory candidates remain in the existing left rail. Generic tool cards remain
registered and can temporarily duplicate limited `writeTodos` and `task`
context. That additive behavior is safer than suppressing a tool without a
proven correlation contract and is owned by the separate follow-up.

The provider retains `defaultThrottleMs={100}`. Token-rate child activity is not
introduced.

## Error handling and bounds

The activity bridge is an allowlist, not a generic capability passthrough.

- Unknown capability types retain existing ignore behavior.
- Malformed recognized payloads are ignored without terminating the run.
- Parallel subagents use independent state keyed by `call_id`.
- Conflicting reuse of one call id cannot overwrite another identity.
- Repeated tool calls are deduplicated by child tool id.
- Only five recent tool summaries are retained and exposed.
- Only eight plan items are rendered, though the complete valid plan remains in
  protocol content.
- Child text and arbitrary tool data are never retained by projection state.
- Error display is bounded to 400 characters.

No activity failure may suppress or replace root text, tool calls, interrupts,
`RUN_FINISHED`, or `RUN_ERROR`.

## Verification strategy

### `@dawn-ai/ag-ui` unit tests

Focused tests cover:

1. multiple plan replacements using one run-scoped message id;
2. exact plan activity content and `replace: true`;
3. two interleaved subagents with isolated call-scoped message ids;
4. running, completed, and failed subagent status;
5. child-plan replacement;
6. child-tool add, result correlation, five-entry eviction, total count, and
   incomplete terminal normalization;
7. idempotent repeated start and conflicting call-id reuse;
8. rejection of a missing or conflicting `route_id` and any other canonical
   identity mismatch;
9. delegation approval before start versus an interrupt inside an
   already-started child, including stable replacement after resume;
10. ignored child messages, unknown tools, out-of-order events, and malformed
   payloads;
11. absence of child text, final answers, runtime ids, tool inputs, and tool
   outputs from serialized activity content;
12. unchanged root text framing, root tool correlation, interrupts, and terminal
    events; and
13. absence of activity deltas, custom, raw, and state events.

Each emitted activity must parse with AG-UI's activity snapshot schema.

### AG-UI client conformance

The existing canned conformance stream gains complete plan and subagent
identities. `@ag-ui/client` and `verifyEvents(false)` must accept the stream and
observe standard activity snapshots while the existing first/last run framing,
root tools, and terminal result remain unchanged.

### Renderer tests

Focused research-web tests use synchronous schema parsing and server-side React
rendering rather than browser automation. The research web package receives a
Vitest configuration and direct test dependency, and that configuration is
listed in the root `vitest.workspace.ts`, so the normal root `pnpm test` lane
executes these tests. They verify:

- plan progress counts, active/collapsed behavior, eight-item display bound, and
  overflow text;
- running, completed, and failed subagent presentation;
- child-plan rendering;
- five-tool display bound and total count;
- nested labeling and bounded error display; and
- failure-closed handling of incompatible content.

### Generated research activation

The existing packaged default-research activation remains the end-to-end
behavior proof. Its safe deterministic journey already drives `writeTodos`, the
researcher subagent, `searchCorpus`, `readDoc`, and a cited report.

Extend that journey to require:

1. one `dawn.plan` message identity updated with the expected fixture plan;
2. one researcher activity identity progressing from running to completed;
3. child tool summaries in exact `searchCorpus`, then `readDoc` order;
4. no child prose, tool arguments, tool results, or final child answer in
   activity content;
5. activity snapshots before the final cited report; and
6. the existing exact root tool sequence, report, permission/resume, memory,
   build, dev, start, cleanup, and sanitized transcript assertions remaining
   unchanged.

The scenario continues to use aimock only as deterministic test infrastructure.
It does not create a keyless user demo.

### Repository verification

Implementation verification includes focused package and renderer tests,
research web typecheck/build, the generated activation, AG-UI conformance, docs
and changeset checks, and the repository's normal validation lane. A focused
renderer command is useful while iterating, but root `pnpm test` must also
collect and execute that project. The existing browser-activation gate remains
a later slice.

## Documentation and release

Update documentation that currently says planning and subagent chunks are
ignored:

- `packages/ag-ui/README.md`;
- `apps/web/content/docs/ag-ui.mdx`;
- `apps/web/content/docs/dev-server.mdx`;
- `apps/web/content/docs/api.mdx`;
- `apps/web/content/docs/recipes/research-web-ui.mdx`; and
- `examples/research/web/README.md`;
- `examples/chat/README.md`;
- `examples/chat/web/README.md`; and
- `packages/devkit/templates/app-research/README.md`.

The documentation names both activity types, describes full-snapshot
replacement, lists their bounded public fields, and states the excluded child
content. It does not claim reconnect/replay or generic capability mapping.

Add one patch changeset for `@dawn-ai/ag-ui`, `@dawn-ai/devkit`, and
`create-dawn-ai-app`. The latter two entries account only for correcting the
README shipped by the generated research starter; they do not promote or add a
web client to that scaffold. The research web package is private and receives
no changeset entry.

## Expected file ownership

The implementation plan may refine exact test-file placement, but the intended
ownership is:

- `packages/ag-ui/src/activities.ts` — public constants, types, validation, and
  bounded projection helpers;
- `packages/ag-ui/src/outbound.ts` — stream integration and activity emission;
- `packages/ag-ui/src/index.ts` — public exports;
- `packages/ag-ui/test/*` — focused mapping, type, and conformance tests;
- `examples/research/web/app/components/*Activity*.tsx` — typed renderers and
  cards;
- `examples/research/web/app/page.tsx` — stable renderer registration;
- `examples/research/web/package.json` — direct schema/test dependencies and
  scripts when required;
- `examples/research/web/vitest.config.ts` and focused research renderer tests;
- `vitest.workspace.ts` — include the research-web project in the repository
  test lane;
- the existing generated activation test;
- directly affected docs, including the generated research starter README; and
- one patch changeset.

No core planning, LangChain subagent, creator source, devkit template runtime,
permission, memory, or deployment source file is expected to change.

## Acceptance criteria

The slice is complete when:

1. A compatible AG-UI client receives valid standard `dawn.plan` and
   `dawn.subagent` activity snapshots.
2. Repeated plan and subagent updates replace stable activity messages rather
   than create duplicates.
3. A first-click safe research run visibly shows its plan and researcher
   progress before the cited final report.
4. The subagent activity shows bounded child-plan and child-tool status without
   exposing child prose, reasoning, prompts, inputs, outputs, or final answers.
5. Parallel, malformed, interrupted, resumed, failed, and terminal event paths
   preserve honest status and existing AG-UI behavior.
6. The flagship renderer is responsive, accessible, and compatible with the
   existing suggestions, permissions, memory, and generic tools.
7. The packaged deterministic activation proves the real protocol path without
   a live model or product-facing keyless mode.
8. Public documentation and the patch changeset describe the exact shipped
   contract.
9. All focused and repository verification gates pass.

## Follow-up sequence

After this slice:

1. use the separate generic-tool-card investigation to decide whether
   `writeTodos` and `task` should remain, specialize, or be suppressed when a
   correlated semantic activity exists;
2. add the deterministic browser activation gate that clicks the existing
   suggestions and verifies visible plan, subagent, citation, and permission
   behavior; and
3. treat that browser gate as a prerequisite for a later design that promotes a
   web UI into the default scaffold.

Those are independent specs rather than hidden expansion of this one.
