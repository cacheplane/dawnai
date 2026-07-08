# AG-UI + CopilotKit UI — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan for sub-project 1
**Author:** Brian Love (with Claude)

## Summary

Make Dawn a first-class **AG-UI** agent so its example UIs (and any Dawn user's UI)
can be built on **CopilotKit** instead of hand-rolled SSE parsing. Dawn's dev
server gains a new, additive AG-UI endpoint served by a new `@dawn-ai/ag-ui`
package that translates Dawn's existing runtime event stream into the AG-UI
protocol. The current Agent-Protocol endpoints (and the bespoke SSE envelope)
stay exactly as they are. The chat and research example UIs are then rebuilt on
CopilotKit consuming the AG-UI endpoint.

The AG-UI layer is a permanent **anti-corruption layer**: it lives only at the
edge (one package, one endpoint), so AG-UI's pre-1.0 churn never touches Dawn's
stable core or its test harness.

## Motivation

The existing `examples/chat/web` UI was throwaway smoke-test scaffolding. Rather
than hand-roll another bespoke SSE UI for the research demo, we adopt AG-UI (the
open agent↔UI event protocol, created by CopilotKit) so Dawn gets a standard,
batteries-included React UI layer (streaming, human-in-the-loop, shared state,
generative UI) and interop with the broader AG-UI ecosystem.

## Decisions (from brainstorming)

1. **Altitude:** framework capability — Dawn natively speaks AG-UI; examples are
   thin CopilotKit consumers.
2. **Emission strategy:** **additive only.** A new `@dawn-ai/ag-ui` adapter + a
   new `/agui` endpoint. The existing AP endpoints and the bespoke `runs/stream`
   envelope are kept indefinitely; no plan to retire them. (Rationale: AG-UI is
   pre-1.0 with breaking changes planned; keeping it at the edge insulates Dawn's
   stable contract and its green test harness.)
3. **Sequencing:** chat UI first (prove the capability against the simpler
   example), then the research UI.
4. **Translator risk:** port the canonical `@ag-ui/langgraph` mapping rather than
   invent one; snapshot-only state; validate emitted events against `@ag-ui/core`
   schemas; conformance-test with a real `@ag-ui/client`.

## Research Findings (verified mid-2026, pin these)

- **AG-UI packages:** `@ag-ui/core`/`@ag-ui/encoder`/`@ag-ui/client` at **0.0.57**
  (2026-06-12), MIT. Pre-1.0; breaking changes explicitly planned before 1.0; no
  curated changelog. `@ag-ui/core`'s zod schemas are the normative spec.
- **Transport:** default is SSE, encoded literally as `data: ${JSON}\n\n`
  (`EventEncoder.encodeSSE`). Protobuf is an alternative via `Accept` negotiation.
- **Backend contract:** an AG-UI agent endpoint accepts `POST` of a
  `RunAgentInput` (`{threadId, runId, parentRunId?, state, messages, tools,
  context, forwardedProps, resume?}`) and streams `BaseEvent`s. There is **no
  official TS server framework** — you wire `@ag-ui/core` types + `@ag-ui/encoder`
  into your own handler (Dawn's raw `node:http` server suits this).
- **CopilotKit:** MIT `1.62.2`. React connects via a CopilotRuntime endpoint that
  registers agents (`new HttpAgent({ url })`). The **v2 runtime dropped GraphQL**
  for REST/SSE and is recommended for new projects. A dev-only
  `agents__unsafe_dev_only` path connects the browser directly (not for prod).
  CopilotKit is mid v1→v2 hook migration (`useCopilotAction` → `useFrontendTool`/
  `useHumanInTheLoop`/`useRenderToolCall`); isolate usage behind thin wrappers.
- **Reference translator:** `@ag-ui/langgraph` (local at
  `~/repos/ag-ui/integrations/langgraph`, v0.0.24). TS is **server-only** (needs a
  LangGraph deployment URL) so it can't wrap Dawn's in-process graph — we **port**
  its mapping. Key: it emits **only `STATE_SNAPSHOT`** (no `STATE_DELTA`), and it
  models interrupts as a `CUSTOM {name:"on_interrupt"}` event with resume via
  `forwardedProps.command.resume`.
- **Dawn's current event catalog** (what we translate from), produced by
  `streamResolvedRoute`/`agent-adapter.ts`/`execute-route.ts`: `token`,
  `tool_call {name,input}`, `tool_result {name,output}`, `plan_update {todos}`,
  `interrupt {interruptId,type,kind,detail}` (kinds command/tool/memory/path),
  `subagent.{start,message,tool_call,tool_result,end}`, `done {output|error}`.

## Architecture

```
Dawn route (in-process LangGraph)
   │  streamResolvedRoute → Dawn events
   ▼
@dawn-ai/ag-ui  (NEW pkg; deps: @ag-ui/core + @ag-ui/encoder, pinned)
   • translate(dawnEvent, ctx) → AGUIEvent[]      (pure, table-driven, ported)
   • runAgUi(RunAgentInput) → maps to a Dawn run, applies resume, streams
   • createAgUiHandler() → node:http handler for POST /agui/{routeId}
   ▼  SSE: data: <AG-UI JSON>\n\n
CopilotKit v2 runtime route in the example's Next.js app
   (HttpAgent → /agui/{routeId}; GraphQL-free)
   ▼
CopilotKit React UI  (thin Dawn wrappers isolate v1/v2 churn)
```

The existing AP endpoints (`/threads`, `runs/stream`, `runs/wait`, `state`,
`resume`) are unchanged; the harness and `dawn run --url` keep working.

### Endpoint

`POST /agui/{routeId}` — one AG-UI agent per Dawn route (so a CopilotKit
`HttpAgent` maps 1:1 to a Dawn route URL). The handler:

1. Parses & validates the body as `RunAgentInput` (zod, from `@ag-ui/core`).
2. Resolves `routeId` to a Dawn route; creates-or-reuses the Dawn thread/
   checkpoint keyed by `RunAgentInput.threadId` (reusing existing thread
   machinery).
3. If `forwardedProps.command.resume` (or `resume[]`) is present, routes it to
   Dawn's existing resume decision path; otherwise starts a run from
   `messages`/`state`.
4. Consumes `streamResolvedRoute`, translates each Dawn event to AG-UI event(s),
   and writes them via `EventEncoder` as SSE.

Mounted one-line on the runtime server (like existing capabilities). Always
available; no cost when unused. (A `dawn.config.ts` opt-out may be added later;
not required for v1.)

### Translation (ported from `@ag-ui/langgraph` `handleSingleEvent`)

Tap **Dawn's assembled stream** (not raw LangGraph events) so Dawn's capability
events survive; synthesize AG-UI IDs in the adapter.

| Dawn event | AG-UI event(s) | Notes |
|---|---|---|
| `token` (run of tokens) | `TEXT_MESSAGE_START` (once, minted `messageId`) → `TEXT_MESSAGE_CONTENT{delta}` … → `TEXT_MESSAGE_END` | END on the next `tool_call`/`done`. |
| `tool_call {name,input}` | `TOOL_CALL_START{toolCallId,toolCallName}` + `TOOL_CALL_ARGS{delta:JSON.stringify(input)}` + `TOOL_CALL_END` | Non-streaming branch (matches reference agent.ts:876–931). `toolCallId` minted + pushed to a per-name FIFO. |
| `tool_result {name,output}` | `TOOL_CALL_RESULT{toolCallId,content}` | `toolCallId` popped FIFO-by-name. |
| `plan_update {todos}`, route state (`context`, research `report`/`citations`) | `STATE_SNAPSHOT{snapshot}` | Snapshot-only (reference does the same). Full snapshot of exposed channels per change. |
| `subagent.*` | `CUSTOM{name:"dawn.subagent", value:{call_id,phase,...}}` | Rendered by the UI as a nested activity. |
| `interrupt {interruptId,kind,detail}` | `CUSTOM{name:"on_interrupt", value:{interruptId,kind,detail}}` | Matches reference + shipping CopilotKit hooks. Resume via `forwardedProps.command.resume` → Dawn `/resume {decision}`. |
| `done {output}` / `done {error}` | `RUN_FINISHED` / `RUN_ERROR` | `RUN_STARTED` emitted at stream open. |

**Known v1 limitations (documented, acceptable):** parallel same-name tool calls
could mis-pair FIFO; STATE deltas not emitted (full snapshots); one active
assistant message per run.

### HITL / resume

Dawn's permission gate is backend-enforced, so we use the reference's
CUSTOM-`on_interrupt` path (not the newer opt-in `RUN_FINISHED.outcome=interrupt`).
The adapter encodes Dawn's `kind` + `detail` (command/tool/memory/path;
suggestedPattern; memory old-vs-new) into the event `value`; the example UI maps
it to an approve/deny (Once/Always/Deny) control and returns the decision via
`forwardedProps.command.resume`, which the adapter forwards to Dawn's existing
`/resume` decision path. No change to Dawn's hardened resume internals.

### Example wiring (Next.js)

A CopilotKit **v2 runtime** route (`/api/copilotkit`, REST/SSE, no graphql-yoga)
registers `new HttpAgent({ url: `${DAWN_URL}/agui/<route>` })`; React uses
`CopilotKitProvider` + `CopilotChat`, `useCoAgent`/`useCoAgentStateRender` for the
plan/report panels, and the HITL hook for approvals — all behind thin Dawn
wrapper components so the CopilotKit v1/v2 churn is contained.

## De-risking Strategy

1. **Port, don't invent.** Lift the mapping from `~/repos/ag-ui/integrations/
   langgraph/typescript/src/agent.ts` (`handleSingleEvent`, non-streaming branch)
   and `interrupts.ts`, with file citations in the code for future diffs.
2. **Snapshot-only state** — at parity with the reference; defers all RFC-6902
   diffing risk.
3. **Schema oracle the reference lacks:** every emitted event is parsed through
   the pinned `@ag-ui/core` zod schema in tests (the reference does not validate
   at emit time — we do better).
4. **Ordering verifier:** a tiny checker for START→CONTENT→END and
   RESULT-after-END invariants.
5. **Consumer conformance:** an e2e points a real `@ag-ui/client` `HttpAgent` at
   `/agui/{route}` (aimock-backed Dawn run, no key) and asserts a clean typed
   parse + expected event sequence.
6. **Pin + guard:** pin `@ag-ui/core`/`@ag-ui/encoder`; the schema test fails
   loudly on a breaking bump, and the blast radius is one package.

## Testing Strategy

- **Translator unit tests** (pure, no model): Dawn-event fixtures → assert exact
  AG-UI event arrays; every event validated against `@ag-ui/core` schema.
- **Endpoint e2e** (aimock, no key): drive a Dawn route through `/agui/{route}`,
  consume with `@ag-ui/client` `HttpAgent`, assert the typed event sequence
  (text, tool call+result, todos snapshot, subagent custom, interrupt+resume,
  run finished). Wired into the harness like existing lanes.
- **Example UIs:** no-key **demo mode** (aimock-backed `pnpm dev`) serving both
  chat and research; plus each example's existing offline test story.

## Decomposition

This is multi-subsystem; each sub-project gets its own spec → plan → build → PR.

1. **`@dawn-ai/ag-ui` capability** — translator + `/agui` handler + tests, mounted
   on the dev server. *(First plan; foundation, no UI.)*
2. **Chat UI on CopilotKit** — rebuild `examples/chat/web`; prove the capability
   end-to-end; establish the CopilotKit-v2-runtime + wrapper-component pattern +
   demo mode.
3. **Research UI on CopilotKit** — `examples/research/web` (plan/report/HITL/
   memory panels) = the research demo's Slice 2, on the proven capability.

## Risks & Mitigations

- **AG-UI pre-1.0 churn** → edge-only adapter + pinned deps + schema-guard test.
- **Translator fidelity** → port a maintained reference + consumer-level
  conformance test.
- **CopilotKit v1/v2 migration churn** → thin wrapper components; prefer the v2
  runtime (GraphQL-free) but keep hook choices swappable.
- **New published package** → first release of `@dawn-ai/ag-ui` needs the manual
  OIDC bootstrap before the Version PR merges (see the npm-release runbook).
- **Two streaming protocols coexist** → accepted by decision; the AP envelope is
  unchanged and the AG-UI path is independently tested.

## Open Questions (non-blocking)

- Whether to gate `/agui` behind a `dawn.config.ts` flag (default on) for surface
  control — decide during sub-project 1.
- Exact CopilotKit hook set (v1 stable vs v2) for HITL and state rendering —
  decide during sub-project 2 against the installed `1.62.x` types.
- Whether `dawn.config.ts` should let a route declare the AG-UI state channels it
  exposes (vs. exposing the whole output schema) — decide in sub-project 1.

## Non-Goals

- Replacing or retiring the AP endpoints / bespoke SSE envelope.
- `STATE_DELTA` / RFC-6902 diffing (snapshot-only for now).
- Depending on `@ag-ui/langgraph` at runtime (server-only; we port it).
- Protobuf transport (SSE only for now).
- Modifying Dawn's core streaming or resume internals.
