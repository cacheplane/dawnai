# `@dawn-ai/ag-ui` — Transport-Agnostic AG-UI Adapter — Design

**Status:** Approved (design), pending implementation plan
**Date:** 2026-07-07
**Author:** Brian Love (with Claude)

## Summary

A new leaf package, `@dawn-ai/ag-ui`, that maps between Dawn's agent stream
events and the [AG-UI protocol](https://docs.ag-ui.com) event schema — in both
directions — as a **pure library with no transport commitment**. It imports no
HTTP server, no SSE plumbing, and no LangGraph. Consumers own the transport and
pipe data through the mapper: `dawn dev` can adopt it now, and any future
production transport can reuse it unchanged.

This package deliberately does **not** decide "where the agent runs." That keeps
Dawn aligned with its hard roadmap constraint — *own local lifecycle only, not
production runtime* — while giving Dawn a portable, spec-compliant AG-UI surface
that is not coupled to the LangGraph Agent Protocol.

## Motivation

Dawn already streams agent execution as a sequence of chunks
(`token | tool_call | tool_result | interrupt | done`) and serializes them to
SSE/ndjson in `dawn dev`. AG-UI is an emerging client↔agent-UI transport
(CopilotKit / ag-ui-protocol) whose event schema maps almost 1:1 onto Dawn's
chunks. Building a reusable mapper — rather than a bespoke server — gives us:

- **Portability:** the same mapping works behind `dawn dev` today and behind any
  production transport later. Auth/transport decisions stay with the consumer.
- **Spec compliance without drift:** we depend on `@ag-ui/core` for the canonical
  event types and enums instead of hand-rolling them.
- **A clean interrupt story:** AG-UI models human-in-the-loop as
  `RUN_FINISHED{outcome:{type:"interrupt"}}` + a resume run — a native fit for
  Dawn's `interrupt` chunk and `Command({ resume })`.

## Scope

### In scope (v1)

1. **Outbound mapping:** `toAguiEvents(chunks, ctx)` — a stateful async-generator
   transform from Dawn `StreamChunk`s to AG-UI `BaseEvent`s.
2. **Inbound mapping:** `fromRunAgentInput(input)` — AG-UI `RunAgentInput` to a
   Dawn run input `{ messages, resume? }`, including the interrupt-resume path.
3. **A small, additive core change:** surface the upstream tool-call id on the
   `tool_call` / `tool_result` stream chunks so AG-UI `toolCallId` correlation is
   faithful (rather than name-matched).

### Out of scope (v1)

- No HTTP server, endpoint, or transport wiring. The package exports functions
  only.
- No `dawn dev` integration. Wiring the mapper into the dev runtime is a
  **separate follow-up** with its own spec/plan.
- No `STATE_SNAPSHOT` / `STATE_DELTA` emission. Dawn has no incremental
  state-diff stream today; adding one is future work.
- No interpretation of `RunAgentInput.tools` / `state` / `context`. They are
  preserved on a typed `raw` escape hatch but not acted upon (YAGNI).
- No production auth model. Auth belongs to whatever transport a consumer builds;
  see "Relationship to auth/middleware" below.

## Package layout

```
packages/ag-ui/
  package.json          # @dawn-ai/ag-ui, leaf package, mirrors packages/permissions shape
  tsconfig.json
  vitest.config.ts
  src/
    index.ts            # public exports
    outbound.ts         # toAguiEvents (state machine)
    inbound.ts          # fromRunAgentInput
    interrupts.ts       # Dawn interrupt <-> AG-UI Interrupt mapping (shared by both directions)
    ids.ts              # IdFactory type + default factory
    types.ts            # Dawn-facing types this package consumes (StreamChunk shape, run ctx)
  src/*.test.ts         # co-located table-driven golden tests
```

Dependencies: `@ag-ui/core` (event types/enums). No dependency on
`@dawn-ai/langchain` or any server. The Dawn `StreamChunk` shape the mapper
consumes is declared structurally in `types.ts` (a minimal local interface), so
the package does not take a runtime dependency on the CLI/langchain packages —
it only needs the shape.

## Outbound: `toAguiEvents`

```ts
export interface RunContext {
  readonly threadId: string
  readonly runId: string
}

export function toAguiEvents(
  chunks: AsyncIterable<StreamChunk>,
  ctx: RunContext,
  options?: { readonly idFactory?: IdFactory },
): AsyncIterable<BaseEvent>
```

It is a **state machine** because AG-UI requires message/tool framing that Dawn
emits implicitly. State tracked across the stream:

- `openMessageId: string | null` — the currently-open assistant text message.
- (tool framing is emitted eagerly per `tool_call` chunk; no long-lived tool
  state is needed because Dawn delivers a tool call's whole input at once.)

Mapping rules (in emission order):

| Dawn chunk | AG-UI events emitted |
|---|---|
| *(stream start)* | `RUN_STARTED { threadId, runId }` |
| `token` (first since last flush) | `TEXT_MESSAGE_START { messageId, role: "assistant" }`, then `TEXT_MESSAGE_CONTENT { messageId, delta }` |
| `token` (subsequent) | `TEXT_MESSAGE_CONTENT { messageId, delta }` |
| any non-`token` chunk while a message is open | first `TEXT_MESSAGE_END { messageId }` (flush), then handle the chunk |
| `tool_call { id, name, input }` | `TOOL_CALL_START { toolCallId, toolCallName }`, `TOOL_CALL_ARGS { toolCallId, delta: JSON.stringify(input) }`, `TOOL_CALL_END { toolCallId }` |
| `tool_result { id, name, output }` | `TOOL_CALL_RESULT { messageId, toolCallId, content: stringify(output) }` |
| `interrupt` | `RUN_FINISHED { outcome: { type: "interrupt", interrupts: [...] } }` |
| `done` | `RUN_FINISHED { outcome: { type: "success" } }` |
| *(upstream throws)* | `RUN_ERROR { message, code? }`, then the generator returns |

Notes:

- **Single args frame.** Dawn has the full tool input at once, so `TOOL_CALL_ARGS`
  is emitted once with the complete JSON. This is spec-valid (deltas need only
  concatenate to valid JSON).
- **`TOOL_CALL_RESULT.messageId`.** AG-UI requires a `messageId` on the result
  event (the id of the tool-result message). It is generated via `idFactory`,
  independent of the assistant text `messageId`.
- **Flush-before-finish.** `done` / `interrupt` / `tool_call` first flush any open
  text message with `TEXT_MESSAGE_END`.

### IDs and determinism

```ts
export type IdFactory = (kind: "message" | "toolResult") => string
```

`Math.random()` / `Date.now()` are non-deterministic and make golden tests
impossible, so all generated ids flow through an injectable `IdFactory`. The
default factory produces collision-resistant ids (nanoid-style). Two id sources
are **not** the factory's job: `runId`/`threadId` come from `RunContext` (the
consumer owns run identity), and `toolCallId` is the real upstream id carried on
the chunk (see core change).

### Graceful degradation

The generator never throws into the consumer mid-stream. Two failure modes:

- **Upstream throw:** caught, emitted as `RUN_ERROR`, generator returns cleanly.
- **Malformed chunk** (e.g. a `tool_result` with no `id` because it came from an
  older producer): synthesize a fallback id via `idFactory` and continue, rather
  than abort the whole run. A `tool_result` with no correlating id falls back to
  a fresh `toolResult` id (the link is best-effort in that case).

## Core change: surface the tool-call id on stream chunks

Today `StreamChunk` and `AgentStreamChunk` carry only `{ name, input }` /
`{ name, output }` for tool events — correlation is by name, which breaks when a
tool is called more than once in a run. AG-UI needs a stable `toolCallId`
linking `TOOL_CALL_START` → `TOOL_CALL_RESULT`.

**Change (additive, optional):**

- `packages/cli/src/lib/runtime/stream-types.ts`:
  - `tool_call`: add optional `readonly id?: string`
  - `tool_result`: add optional `readonly id?: string`
- `packages/langchain/src/agent-adapter.ts` (`on_tool_start` / `on_tool_end`
  emit sites, ~lines 613–629): populate `id` from **`event.run_id`** — LangGraph's
  `streamEvents` assigns the *same* `run_id` to the `on_tool_start` and
  `on_tool_end` of a single tool invocation, so it is a deterministic
  start↔end correlator (no name-matching, correct even for repeated calls).
- `toSseEvent` / `toNdjsonLine`: no change needed — they serialize the whole
  chunk, so `id` passes through automatically.

The field is optional, so every existing consumer and serialized shape is
unaffected. The mapper reads `id` when present and falls back gracefully when
absent.

> Rationale for `event.run_id` over the model's OpenAI `tool_call_id`: `run_id`
> is guaranteed present on both the start and end events and uniquely identifies
> the invocation. The OpenAI `tool_call_id` is only reliably reachable at
> tool-execution time (via `config`, as `extractToolCallId` does) and is not
> needed for AG-UI correlation. If a future consumer needs the model-facing id,
> that is a separate additive field.

## Inbound: `fromRunAgentInput`

```ts
export function fromRunAgentInput(input: RunAgentInput): DawnRunInput

export interface DawnRunInput {
  readonly messages: DawnMessage[]
  readonly resume?: unknown           // Command({ resume }) payload, when resuming an interrupt
  readonly raw: RunAgentInput         // typed escape hatch: tools/state/context preserved, uninterpreted
}
```

- **Messages:** AG-UI messages (`{ id, role, content }`, roles `user` / `assistant`
  / `tool` / `system`) map to Dawn's message input shape. Tool-call messages on
  input are passed through structurally (Dawn's run input already accepts prior
  tool messages).
- **Resume (interrupt round-trip):** when `RunAgentInput` carries a `resume`
  array (AG-UI's mechanism for answering open interrupts), it is mapped to the
  payload Dawn expects inside `Command({ resume })`. The `interrupts.ts` module
  owns the shape translation so outbound (`interrupt` → AG-UI `Interrupt`) and
  inbound (AG-UI resume → Dawn resume) stay symmetric and are tested together.
- **`raw`:** the untouched `RunAgentInput` so a consumer can reach
  `tools`/`state`/`context`/`forwardedProps` if it needs them. v1 does not
  interpret these.

## Interrupt mapping (`interrupts.ts`)

The one place both directions meet. Dawn's `interrupt` chunk carries a payload
describing why the run paused (e.g. tool approval, path/command gate). This maps
to an AG-UI `Interrupt` entry inside `RUN_FINISHED.outcome.interrupts`. The
reverse — an AG-UI `resume` answer — maps back to Dawn's resume payload. Keeping
both in one module with a shared test guarantees the round-trip is lossless for
the interrupt kinds Dawn emits.

The exact `Interrupt` field shape will be pinned against `@ag-ui/core` during
implementation (the plan verifies the type before writing the mapping).

## Public API (`index.ts`)

```ts
export { toAguiEvents, type RunContext } from "./outbound"
export { fromRunAgentInput, type DawnRunInput, type DawnMessage } from "./inbound"
export { type IdFactory } from "./ids"
export { type StreamChunk } from "./types"
```

AG-UI event/input types are re-used from `@ag-ui/core`; the package does not
re-export them (consumers import from `@ag-ui/core` directly to avoid a second
source of truth).

## Testing

Pure async-generator + pure functions → table-driven golden tests, no network,
no server. A deterministic `IdFactory` (counter-based: `msg-1`, `tr-1`, …) makes
event sequences exact-matchable.

Outbound cases:

- text-only stream (`token`×N, `done`)
- single tool call + result (asserts `toolCallId` correlation)
- interleaved text → tool call → text (asserts flush ordering)
- repeated calls to the same tool (asserts distinct `toolCallId`s via `run_id`)
- `interrupt` → `RUN_FINISHED{interrupt}`
- upstream throw → `RUN_ERROR` then clean return
- empty stream (`done` only) → `RUN_STARTED`, `RUN_FINISHED{success}`
- `tool_result` with missing `id` → graceful fallback

Inbound cases:

- user + assistant messages → Dawn messages
- resume answer → Dawn `resume` payload
- `raw` preserves `tools`/`state`/`context`

Round-trip case:

- Dawn `interrupt` → AG-UI interrupt outcome → AG-UI resume `RunAgentInput` →
  Dawn resume payload (asserts the interrupt shape survives both hops).

Core-change tests:

- `agent-adapter` emits `id` on `tool_call` / `tool_result` from `event.run_id`;
  start and end of one invocation share the id (extend existing adapter tests).

## Relationship to auth/middleware (context, not scope)

This package intentionally carries **no auth model**. AG-UI does not define one —
it leaves auth to the host HTTP layer, and the `@ag-ui/langgraph` reference
adapter delegates auth to the underlying deployment. Because any Dawn-owned
transport can be bypassed by hitting the runtime directly, request-level
auth/middleware must ultimately be enforced at the runtime boundary regardless of
AG-UI. The (paused) "middleware survives to production" work is therefore
**orthogonal** to this adapter and unblocked by it: this package makes Dawn's
stream portable; a later transport/runtime decision handles enforcement.

## Risks and open questions

- **`@ag-ui/core` API surface.** Exact exported type/enum names and the
  `Interrupt` / `RunAgentInput.resume` field shapes must be pinned against the
  installed `@ag-ui/core` version during implementation, not assumed. The plan's
  first task installs the dep and reads its `.d.ts`.
- **`event.run_id` availability.** Confirmed conceptually (LangGraph assigns a
  per-invocation `run_id` present on both tool start/end); the plan verifies it
  against the installed `@langchain/*` version with a focused test before relying
  on it, and falls back to a synthesized correlator if absent.
- **Version/publishing.** New public package → needs the OIDC new-package
  bootstrap before its first release (see the npm-release memo). Not a v1-code
  concern but flagged for the release step.
```
