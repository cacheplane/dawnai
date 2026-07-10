# `@dawn-ai/ag-ui` Canonical Adapter API Design

**Status:** Independent review issues addressed, maintainer review pending
**Date:** 2026-07-10
**Supersedes:** `2026-07-07-ag-ui-adapter-design.md` where this document conflicts

## Summary

Make the transport-agnostic adapter the single canonical AG-UI mapping layer in
Dawn. Remove the older synchronous `createAgUiTranslator` and `mapRunInput`
APIs, route Dawn's shared development/production AG-UI endpoint through
`toAguiEvents` and `fromRunAgentInput`, and keep runtime-specific policy inside
the CLI.

The package root remains protocol focused. Optional SSE encoding moves to an
explicit `@dawn-ai/ag-ui/sse` subpath so importing the canonical adapter does not
imply an HTTP transport. Dawn's existing shared runtime server exposes the
endpoint through both `dawn dev` and the Node/Docker `dawn start` path. This
change modifies that existing endpoint but does not add a server, deployment
runtime, managed hosting service, or transport to the adapter package.

Backward compatibility with the superseded translator API and its custom event
semantics is not required.

## Context

The original transport-agnostic adapter was developed while `main` independently
landed an AG-UI package and a local CLI endpoint. Rebasing produced one package
with two competing implementations:

- `toAguiEvents` and `fromRunAgentInput`, which use canonical AG-UI run outcomes
  and the langchain `AgentStreamChunk` shape;
- `createAgUiTranslator` and `mapRunInput`, which use the flat CLI stream shape,
  legacy `CUSTOM` interrupts, and CLI-specific checkpoint policy.

The implementations disagree about interrupts, terminal errors, state events,
input history, fallback IDs, and public types. Keeping both makes it unclear
which behavior is authoritative and allows the local endpoint to diverge from
library consumers.

Meanwhile, `main` now includes published-artifact verification. The final API
must therefore be verified from a packed package, not only through workspace
source imports.

After the initial review of this design, `main` also landed the production Node
target and `dawn start`. `serveRuntime` uses the same runtime listener as
`dawn dev` and exposes `/agui/{routeId}` on its default `0.0.0.0` bind. The
endpoint is therefore a production-facing, user-operated surface. Its current
middleware bypass must be fixed as part of canonicalizing the handler.

## Goals

1. Provide one authoritative bidirectional Dawn-to-AG-UI mapping API.
2. Preserve the adapter package's independence from the CLI, LangGraph, and any
   HTTP server.
3. Keep checkpoint, resume-decision, route, and thread-status policy in the CLI.
4. Make the existing shared-runtime `/agui/{routeId}` endpoint consume the same
   adapter API external users consume in both development and production.
5. Use standard AG-UI interrupt outcomes and resume input, with explicit
   validation where Dawn's local runtime has a narrower execution model.
6. Verify protocol conformance, runtime endpoint behavior, and packed-package
   exports.
7. Apply the same Dawn middleware gate to AG-UI requests that protects Agent
   Protocol runs before the shared runtime is considered production-ready.

## Non-goals

- Preserve `createAgUiTranslator`, `mapRunInput`, or their exported types.
- Preserve `STATE_SNAPSHOT` emission for arbitrary Dawn capability chunks.
- Preserve `CUSTOM{name:"dawn.subagent.*"}` events.
- Preserve `CUSTOM{name:"on_interrupt"}` or
  `forwardedProps.command.resume` as the interrupt protocol.
- Add state-delta, planning, subagent, or capability extension mappings to the
  v1 canonical adapter.
- Add a new production runtime, server, endpoint, managed hosting service, or
  authentication framework. The existing Node/Docker runtime remains a
  consumer of the adapter and reuses its existing middleware.
- Make the pure adapter understand Dawn checkpoint policy or permission
  decisions such as `once`, `always`, and `deny`.

## Architecture

The design has three boundaries:

```text
AG-UI RunAgentInput
        |
        v
fromRunAgentInput                 @dawn-ai/ag-ui
        |
        v
CLI invocation bridge            @dawn-ai/cli (runtime policy)
        |
        v
Dawn route / langchain stream
        |
        v
CLI stream normalization         @dawn-ai/cli (shape only)
        |
        v
toAguiEvents                     @dawn-ai/ag-ui
        |
        v
optional SSE encoding            @dawn-ai/ag-ui/sse
```

`@dawn-ai/ag-ui` owns protocol translation. `@dawn-ai/cli` owns the decisions
needed to run a Dawn route in Dawn's shared development/production runtime. The
CLI may depend on the adapter; the adapter must not depend on the CLI or
langchain packages.

## Package API

### Root export

The root `@dawn-ai/ag-ui` export contains exactly:

```ts
export {
  toAguiEvents,
  fromRunAgentInput,
  createCounterIdFactory,
  createDefaultIdFactory,
  type AguiOutboundEvent,
  type DawnAgentStreamChunk,
  type DawnInterruptEnvelope,
  type DawnMessage,
  type DawnResumeRequest,
  type DawnRunInput,
  type IdFactory,
  type RunContext,
  type ToAguiOptions,
}
```

All other package functions and types are implementation details. In particular,
`AgUiEvent`, `DawnToolCallData`, `DawnToolResultData`, `fromAguiResume`,
`toAguiInterrupt`, `asToolCallData`, `asToolResultData`, `RawChunk`,
`DawnStreamChunk`, and `TranslatorOptions` are not public API. Consumers use
AG-UI protocol types directly from `@ag-ui/core`.

The removed public API is:

- `createAgUiTranslator`
- `AgUiTranslator`
- `mapRunInput`
- `MappedRunInput`
- `ResumeDecision`
- `TranslatorOptions`
- the flat `DawnStreamChunk` translator type
- `AgUiEvent`
- `DawnToolCallData`
- `DawnToolResultData`
- `fromAguiResume`
- `toAguiInterrupt`
- `asToolCallData`
- `asToolResultData`
- `RawChunk`

No compatibility aliases or deprecation period are required.

### SSE subpath

SSE encoding is reusable but transport-specific. It moves to:

```ts
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
```

The package declares an `./sse` export pointing at a focused module. The root
entrypoint does not export `encodeAgUiSse` and does not import
`@ag-ui/encoder`. This keeps transport code out of the root module graph while
avoiding duplicate encoder logic in the CLI.

`@ag-ui/encoder` remains a package runtime dependency because the published SSE
subpath requires it.

## Canonical Dawn Stream Type

Replace the loose `{ type: string; data?: unknown }` public type with a
discriminated union that is structurally compatible with the langchain adapter:

```ts
export type DawnAgentStreamChunk =
  | { readonly type: "token"; readonly data: string }
  | {
      readonly type: "tool_call"
      readonly data: {
        readonly id?: string
        readonly name: string
        readonly input: unknown
      }
    }
  | {
      readonly type: "tool_result"
      readonly data: {
        readonly id?: string
        readonly name: string
        readonly output: unknown
      }
    }
  | { readonly type: "interrupt"; readonly data: unknown }
  | { readonly type: "done"; readonly data?: unknown }
  | { readonly type: string; readonly data?: unknown }
```

The open final member permits capability-contributed chunks without requiring a
dependency on Dawn core. Runtime narrowing still validates tool payloads at the
trust boundary. Internal helper types may use a stricter known-chunk union to
retain useful narrowing despite the open extension member.

Unknown chunks are ignored in v1. They do not produce state or custom events.
They flush an open text message, preserving the existing rule that every
non-token chunk is a framing boundary.

## Outbound Mapping

`toAguiEvents(chunks, context, options)` remains the only outbound mapper. It
emits:

| Dawn input | AG-UI output |
|---|---|
| stream start | `RUN_STARTED` |
| `token` | text message start/content framing |
| `tool_call` | tool call start/args/end |
| `tool_result` | tool call result |
| one or more interrupts | one `RUN_FINISHED` with interrupt outcome |
| `done` | `RUN_FINISHED` with success outcome and optional result |
| upstream throw | `RUN_ERROR` |

### Interrupt collection

Dawn can emit multiple interrupt chunks for one parked run, while AG-UI's
terminal interrupt outcome accepts an array. The mapper collects consecutive
interrupt chunks and emits one terminal event containing all of them.

Because an async generator cannot know that an interrupt is the last item until
it reads again, the state machine holds pending interrupts. The next event has
the following meaning:

- another `interrupt`: append it;
- `done` or natural stream end: emit one interrupt outcome and return;
- any other chunk: emit the accumulated interrupt outcome and return without
  consuming further run output as part of a completed AG-UI run.

The expected Dawn stream contract is that interruption terminates execution.
Tests cover multiple interrupts followed by Dawn's current terminal behavior.

### Terminal errors

Thrown upstream errors are the canonical failure signal and map to `RUN_ERROR`.
A `done` payload is opaque result data and does not become an error merely
because it contains an `error` property. This prevents protocol translation from
guessing application semantics. Runtime layers that represent failures as
values must throw before passing the stream to the adapter.

When `done.data` is defined, the mapper preserves it as
`RUN_FINISHED.result`. Natural stream completion has no result. Interrupt
outcomes do not include a result.

The publicly exported `streamResolvedRoute` currently represents
route-preparation failure as
`done { output: { error } }`. Change that internal generator to throw the
preparation error instead. Its existing Agent Protocol and resume consumers
already catch thrown stream errors and serialize their existing terminal error
shape, so their external behavior remains unchanged. The AG-UI path then
receives an actual upstream throw and emits `RUN_ERROR` without inspecting
application result values.

This is an intentional behavior change for direct callers of
`streamResolvedRoute`: preparation failure rejects during iteration instead of
yielding a terminal value. The outward Agent Protocol and AG-UI HTTP contracts
remain stable.

### Tool IDs

Upstream tool invocation IDs remain authoritative. Missing IDs use the existing
injectable factory and name-based FIFO correlation as graceful degradation.
Internal validation silently ignores malformed tool chunks rather than emitting
invalid AG-UI events.

An interrupt is different because an AG-UI interrupt without an addressable ID
cannot be resumed. If any interrupt chunk lacks a non-empty `interruptId`, the
mapper emits `RUN_ERROR` with a producer-contract message and returns. It does
not synthesize an interrupt ID.

## Inbound Mapping

`fromRunAgentInput(input)` remains a protocol-only structural conversion:

```ts
interface DawnRunInput {
  readonly messages: DawnMessage[]
  readonly resume?: DawnResumeRequest[]
  readonly raw: RunAgentInput
}
```

It converts all supported AG-UI messages and preserves the untouched input as
`raw`. It does not decide which messages a checkpointed runtime should replay.
Assistant `toolCalls`, message names, tool-call IDs, and other protocol fields
that Dawn does not yet execute remain accessible through `raw`; the typed Dawn
message projection documents the fields it intentionally preserves.

AG-UI's standard `resume` array maps losslessly to addressed Dawn resume
requests. The adapter does not interpret permission-decision vocabulary.

## Runtime Integration

The `/agui/{routeId}` endpoint remains in `@dawn-ai/cli`, but it becomes a
consumer of the canonical API. Because `dawn dev` and `dawn start` share
`createRuntimeRequestListener`, one handler implementation serves both.

### Middleware boundary

Before creating or mutating a thread, marking it busy, validating checkpoint
resume state, or starting route execution, the AG-UI handler runs the same
loaded `DawnMiddleware` used by Agent Protocol run endpoints.

The middleware request contains the resolved route's `assistantId` and
`routeId`, the actual HTTP method, URL and headers, and route params extracted
from the mapped Dawn input. A rejection returns the middleware's status and body
before SSE headers are sent. A continuation passes the middleware context to
`streamResolvedRoute` so tools and route execution observe the same
request-scoped context as Agent Protocol runs.

Shared request parsing/context helpers should be extracted within the CLI where
needed rather than creating a second interpretation in `agui-handler.ts`.
Middleware behavior is runtime policy and is not imported into
`@dawn-ai/ag-ui`.

### Input bridge

After validating `RunAgentInputSchema`, the handler calls
`fromRunAgentInput(input)`.

For a normal checkpointed turn, the CLI selects only the newest projected user
message and passes it as Dawn route input. Replaying the full AG-UI history would
duplicate messages already held by LangGraph's checkpoint. This is explicitly
CLI checkpoint policy, not adapter behavior.

Before choosing a normal or resume turn, the CLI reads the checkpoint's pending
`__interrupt__` writes and derives an address map from each capability-level
`interruptId` to its LangGraph task ID.

For a resume turn, the CLI requires the AG-UI resume array to address the exact
set of open checkpoint interrupts:

- `status: "cancelled"` maps to Dawn decision `"deny"`;
- `status: "resolved"` requires payload `"once"`, `"always"`, or `"deny"`;
- every open interrupt must appear exactly once;
- unknown, duplicate, or omitted interrupt IDs return HTTP 409;
- an unsupported or missing resolved payload returns HTTP 400;
- each addressed `interruptId` is validated against the pending checkpoint
  before execution, using the same state-based validation as the existing Dawn
  resume endpoint.

The bridge converts the validated answers to LangGraph's supported task-keyed
resume map and invokes `Command({ resume: { [taskId]: decision } })`. Task IDs
come from the first element of each pending-write tuple and are never accepted
from the client. This supports one or many parallel open interrupts without
weakening stale-interrupt protection.

If `RunAgentInput.resume` is absent or empty while the checkpoint has pending
interrupts, the request returns HTTP 409 instead of starting a new message turn.
If no interrupts are pending, an absent or empty resume array means a normal
turn. Resume entries supplied when no interrupts are pending also return 409.

The runtime's `streamResolvedRoute` resume option is broadened from a single
permission decision to the internal resume payload accepted by LangGraph. The
existing Agent Protocol resume endpoint may continue passing its scalar
decision; the AG-UI handler passes the validated task-keyed map.

The shared checkpoint lookup/validation should be extracted into a CLI-internal
helper rather than duplicated between the two handlers.

### Output bridge

`streamResolvedRoute` produces the CLI's flat `StreamChunk`. A CLI-internal async
generator normalizes it to `DawnAgentStreamChunk`:

| CLI chunk | Adapter chunk |
|---|---|
| `chunk` | `token` with string `data` |
| `tool_call` | `tool_call` with nested `data` |
| `tool_result` | `tool_result` with nested `data` |
| `interrupt` | `interrupt` |
| `done` | `done` with `data: output` |
| any other type | same type and `data` |

The endpoint iterates `toAguiEvents`, encodes each event with the SSE subpath,
and writes it to the response. It does not implement its own AG-UI state
machine.

The branch's existing cross-layer tool-ID work is part of this design and must
survive the rebase onto latest `main`:

- `packages/langchain/src/agent-adapter.ts` puts the shared tool invocation
  `event.run_id` on both `tool_call.data.id` and `tool_result.data.id`;
- `packages/cli/src/lib/runtime/stream-types.ts` carries optional IDs on flat
  tool chunks;
- `streamResolvedRoute` preserves those IDs when flattening langchain chunks;
- the CLI normalizer nests the same ID back under `data` for `toAguiEvents`.

This is tested at each boundary and end to end. Name-based fallback remains only
for structurally compatible older or custom chunk producers.

Before this normalization, `streamResolvedRoute` is changed to throw
route-preparation failures rather than encode them as successful `done` chunks,
as described under Terminal errors.

### Lifecycle and cancellation

The thread is marked busy before route execution and returned to idle in a
`finally` path. Request disconnect aborts route execution and closes the source
iterator. A client disconnect must not leave the thread busy or continue an
unobserved model run.

Once response headers have been sent, execution failures are represented by
the adapter's `RUN_ERROR` event. Request validation and route lookup failures
remain ordinary JSON HTTP errors before streaming starts.

These lifecycle rules apply identically under `dawn dev`, `dawn start`, and the
generated Node/Docker server because they share the listener and handler.

## Deliberate Behavior Changes

After this change, `/agui/{routeId}` no longer emits:

- `STATE_SNAPSHOT` for `plan_update` or arbitrary object chunks;
- `CUSTOM{name:"dawn.subagent.*"}`;
- `CUSTOM{name:"on_interrupt"}`.

Interrupts use `RUN_FINISHED { outcome: { type: "interrupt", interrupts } }` and
resume through `RunAgentInput.resume`.

The CopilotKit chat example's legacy `useInterrupt` component and comments rely
on the removed custom event path. They must be removed or rewritten against the
standard AG-UI interrupt API in the same change. Documentation must not claim
planning or subagent events are supported by the v1 adapter.

## Files and Ownership

### Remove

- `packages/ag-ui/src/translate.ts`
- `packages/ag-ui/src/run-input.ts`
- translator and run-input unit tests

### Modify

- `packages/ag-ui/src/index.ts`
- `packages/ag-ui/src/types.ts`
- `packages/ag-ui/src/outbound.ts`
- `packages/ag-ui/src/inbound.ts` as required to align its documented projection
- `packages/ag-ui/package.json` and build configuration for the `./sse` subpath
- `packages/cli/src/lib/dev/agui-handler.ts`
- CLI resume validation internals
- CLI middleware request/context helpers and route-table wiring
- `packages/cli/src/lib/runtime/execute-route.ts` resume payload and tool-ID
  propagation
- `packages/cli/src/lib/runtime/stream-types.ts` optional tool IDs
- `packages/langchain/src/agent-adapter.ts` upstream invocation IDs
- AG-UI package, CLI, API, and chat-example documentation
- changeset wording
- published-artifact smoke configuration

The exact CLI helper filenames are an implementation-plan decision. Helpers
remain internal and are not exported from `@dawn-ai/cli`.

## Testing

### Adapter tests

- exact text and tool framing sequences;
- upstream tool ID preservation and repeated same-name calls;
- missing-ID FIFO fallback;
- malformed known chunks do not emit invalid events;
- malformed interrupts emit `RUN_ERROR` and cannot produce an empty ID;
- multiple interrupts become one terminal outcome;
- standard interrupt/resume ID round trip;
- natural stream completion;
- explicit `done` success;
- successful `done.data` is preserved as `RUN_FINISHED.result`;
- thrown error becomes `RUN_ERROR`;
- unknown capability events do not emit state or custom events;
- all supported inbound message roles and content coercion;
- standard resume arrays remain lossless;
- SSE encoder is reachable only through the `./sse` public subpath.

### Conformance test

Feed `toAguiEvents` through a canned SSE server, parse it with
`@ag-ui/client`, and run `verifyEvents`. The fixture includes text, tool calls,
tool results, ignored capability chunks, and a terminal event. It must no longer
depend on the removed translator.

### CLI endpoint tests

- normal message turn emits a conforming AG-UI stream;
- a second turn forwards only the newest user message;
- tool-call IDs survive langchain -> CLI -> adapter -> AG-UI;
- one or multiple fully addressed resume decisions continue the parked run;
- cancelled resume entries map to deny;
- stale, unknown, duplicate, or incomplete interrupt sets return 409;
- a normal turn while interrupts remain pending returns 409;
- resume input when no interrupts are pending returns 409;
- unsupported or missing resolved decision payloads return 400;
- interrupt output uses a standard terminal outcome;
- execution errors emit `RUN_ERROR` and restore idle status;
- client disconnect aborts execution and restores idle status;
- middleware rejection prevents thread mutation and route execution;
- middleware continuation passes request-scoped context into route execution.

Run the endpoint integration once through `createRuntimeRequestListener` for
focused coverage and once through
`serveRuntime({ host: "127.0.0.1", port: 0 })` to prove that the `dawn start`
production assembly exposes the same canonical AG-UI behavior. No Docker build
is needed for this adapter change because the generated server entry calls that
same `serveRuntime` function.

### Published artifact

Extend `scripts/pack-check.mjs` with `@dawn-ai/ag-ui`, including
`dist/index.js`, `dist/index.d.ts`, `dist/sse.js`, `dist/sse.d.ts`, the README,
and the two package export paths. This is the local pre-publish tarball check.

Also extend `scripts/lib/published-artifacts.mjs` with an `ag-ui` package set and
file expectations. The post-publish command
`pnpm published:smoke -- --package-set ag-ui --version <version>` installs the
registry artifact and verifies:

- root imports include `toAguiEvents` and `fromRunAgentInput`;
- removed translator APIs are absent;
- `@dawn-ai/ag-ui/sse` resolves and encodes a valid event;
- declarations for both export paths resolve under NodeNext.

The published smoke's install probe must actually import the root and `./sse`
entrypoints and compile a small consumer project with TypeScript `NodeNext`
module resolution; version and file-presence checks alone are insufficient.

### Final verification

Run package build, typecheck, lint, and tests for `@dawn-ai/ag-ui` and
`@dawn-ai/cli`; build, typecheck, and test `@dawn-ai/langchain`; run the relevant
pack-check and published-artifact unit tests; then run the workspace build. The
registry-based `published:smoke` command is a release-time check and cannot test
the unpublished branch version.

## Documentation and Release Notes

Update all references to the dual API in:

- `packages/ag-ui/README.md`
- `packages/cli/docs/dev-server.md`
- production deployment and CLI docs that describe `dawn start`
- generated or source API documentation
- `examples/chat/web`
- the branch changeset

The changeset remains patch-level because Dawn's fixed 0.x group would otherwise
move to `1.0.0`. Its text should describe consolidation of the existing package,
not creation of a package that is already present on `main`.

The old July 7 design and plan remain as historical implementation records. This
document governs the cleanup where they conflict.

## Risks and Mitigations

**Loss of capability UI events.** Planning, subagent, and legacy interrupt UIs
stop receiving custom events. This is accepted. Documentation and examples are
updated atomically so unsupported behavior is not advertised.

**Checkpoint history duplication.** The canonical inbound mapper returns all
messages. The CLI explicitly selects the newest user message and tests a second
turn.

**Resume semantic mismatch.** AG-UI requires all open interrupts to be addressed
together. The CLI validates the exact checkpoint interrupt set, translates each
supported permission decision, and uses LangGraph's task-keyed resume map. It
rejects new turns while interrupts remain unresolved.

**Transport purity ambiguity.** SSE encoding is isolated behind a subpath whose
dependency graph is separate from the root adapter entrypoint.

**Published API drift.** Packed-artifact tests exercise both root and SSE
subpath exports.

**Production middleware bypass.** The shared runtime now serves AG-UI on a
public production bind, but the current handler does not call Dawn middleware.
The handler gains middleware parity and tests rejection before any thread or
execution side effect.

## Success Criteria

- There is one outbound mapper and one inbound mapper in `@dawn-ai/ag-ui`.
- The package root is transport-agnostic and does not load the SSE encoder.
- The shared development/production runtime endpoint uses the canonical mapper
  end to end.
- AG-UI requests pass through Dawn middleware before side effects or streaming.
- Standard AG-UI interrupts and resumes work through the shared endpoint.
- Parallel open interrupts are resumed together through a task-keyed LangGraph
  resume map, and unresolved interrupts block new turns.
- Unsupported resume shapes fail explicitly and stale interrupt IDs remain
  protected.
- Removed custom/state behaviors are absent from tests, examples, and current
  documentation.
- Workspace and published-artifact verification pass.
