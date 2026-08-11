<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/ag-ui

Pure, transport-agnostic AG-UI protocol translation for Dawn. This package maps
Dawn agent stream chunks to AG-UI events and maps AG-UI run input back to a
Dawn-shaped run input. It does not host an HTTP server or import LangGraph.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [AG-UI and Web Clients](https://dawnai.org/docs/ag-ui),
[Agent Protocol](https://dawnai.org/docs/dev-server/agent-protocol), and the
[chat web example](https://github.com/cacheplane/dawnai/tree/main/examples/chat/web).

## Install

```bash
pnpm add @dawn-ai/ag-ui
```

Most apps do not import this package directly. `@dawn-ai/cli` uses the same
adapter in `dawn dev` and in the production runtime started by `dawn start`:

```text
POST /agui/{routeId}
```

The URL segment is the URL-encoded Dawn assistant id (`<routeId>#<kind>`). For
example, the Dawn route `/chat#agent` is exposed to AG-UI clients as:

```text
POST http://127.0.0.1:3001/agui/%2Fchat%23agent
```

## Adapter API

```ts
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  createCounterIdFactory,
  createDefaultIdFactory,
  fromRunAgentInput,
  toAguiEvents,
  type AguiOutboundEvent,
  type DawnAgentStreamChunk,
  type DawnInterruptEnvelope,
  type DawnMessage,
  type DawnPlanActivityContent,
  type DawnResumeRequest,
  type DawnRunInput,
  type DawnSubagentActivityContent,
  type IdFactory,
  type RunContext,
  type ToAguiOptions,
} from "@dawn-ai/ag-ui"
```

The root package is a pure, transport-agnostic adapter. It has no CLI, HTTP, or
LangGraph dependency.

### ID factories

`toAguiEvents` uses `createDefaultIdFactory()` to generate prefixed UUID-based
message, tool-call, and tool-result ids when it must synthesize them.
`createCounterIdFactory()` produces deterministic counters for tests. Inject
either factory, or a custom `IdFactory`, through `options.idFactory`:

```ts
const events = toAguiEvents(chunks, context, {
  idFactory: createCounterIdFactory(),
})
```

```ts
export type IdFactory = (kind: "message" | "toolCall" | "toolResult") => string

export interface ToAguiOptions {
  readonly idFactory?: IdFactory
}
```

### `toAguiEvents(chunks, ctx)`

Maps a Dawn agent stream to AG-UI events:

```ts
import { toAguiEvents } from "@dawn-ai/ag-ui"

for await (const event of toAguiEvents(dawnChunks, { threadId, runId })) {
  // Serialize the AG-UI event to your transport.
}
```

Supported chunks are:

```ts
type DawnAgentStreamChunk =
  | { type: "token"; data: string }
  | { type: "tool_call"; data: { id?: string; name: string; input: unknown } }
  | { type: "tool_result"; data: { id?: string; name: string; output: unknown } }
  | { type: "interrupt"; data: unknown }
  | { type: "done"; data?: unknown }
  | { type: string; data?: unknown }
```

`dawnChunks` can be any `AsyncIterable<DawnAgentStreamChunk>`, including the
LangChain adapter's `AgentStreamChunk` stream. An interrupt maps when its data is
a `DawnInterruptEnvelope` with a non-empty `interruptId`. Tool call ids from
Dawn chunks are preserved as AG-UI `toolCallId`. Valid root planning and
correlated subagent chunks map to the activity snapshots described below.
Other capability-contributed and unknown chunk types retain the existing
flush-and-ignore behavior.

### `fromRunAgentInput(input)`

Maps AG-UI `RunAgentInput` to a Dawn-shaped run input:

```ts
import { fromRunAgentInput } from "@dawn-ai/ag-ui"

const { messages, resume, raw } = fromRunAgentInput(runAgentInput)
```

`messages` contains all translated AG-UI messages. `resume` is omitted when the
top-level AG-UI `RunAgentInput.resume` array is absent or empty. That input field
has this exact shape:

```ts
resume?: Array<{
  interruptId: string
  status: "resolved" | "cancelled"
  payload?: unknown
}>
```

When present, the adapter preserves those fields in `DawnRunInput.resume`:

```ts
{
  messages: [{ role: "user", content: "Continue", id: "message-1" }],
  resume: [
    { interruptId: "perm-1", status: "resolved", payload: "once" },
    { interruptId: "perm-2", status: "cancelled" },
  ],
  raw: runAgentInput,
}
```

The adapter does not interpret AG-UI `tools`, `state`, or `context`; they
remain available through `raw`.

Interrupt chunks are accumulated and emitted as a standard AG-UI
`RUN_FINISHED` event with `outcome: { type: "interrupt", interrupts: [...] }`.
Each interrupt uses the Dawn `interruptId` as its AG-UI `id`, and the complete
Dawn envelope is retained in `metadata`. Successful runs finish with
`outcome: { type: "success" }`; upstream failures become one `RUN_ERROR`.

## Planning and subagent activities

The adapter projects an explicit allowlist of Dawn capability chunks into
standard `ACTIVITY_SNAPSHOT` events. Every snapshot has `replace: true`, so a
compatible client replaces the stable activity message instead of appending a
revision history.

A valid root `plan_update` uses the `messageId` value
`dawn:plan:${runId}` and
`activityType: DAWN_PLAN_ACTIVITY_TYPE` (`"dawn.plan"`). Its
`DawnPlanActivityContent` contains only the complete source todo list:

```ts
interface DawnPlanActivityContent {
  readonly todos: ReadonlyArray<{
    readonly content: string
    readonly status: "pending" | "in_progress" | "completed"
  }>
}
```

The adapter does not synthesize an initial activity from a seeded `plan.md`;
the first plan snapshot follows the first valid `plan_update`.

`subagent.start` and matching `subagent.plan_update`,
`subagent.tool_call`, `subagent.tool_result`, and `subagent.end` chunks use
the `messageId` value `dawn:subagent:${call_id}` and
`activityType: DAWN_SUBAGENT_ACTIVITY_TYPE` (`"dawn.subagent"`). Each complete
replacement has this bounded public content:

```ts
interface DawnSubagentActivityContent {
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
```

Only the five most recent child-tool name/status summaries are retained; the
total count still covers every observed child tool. A failure may include one
human-readable error truncated to 400 characters. A lifecycle event can update
an activity only when its full internal identity
`{ call_id, subagent, route_id, depth }` matches the original start.

`subagent.message` is consumed without emission. Public activity content never
contains child reasoning or prose, prompts, tool inputs, tool outputs, final
child answers, route ids, child tool ids, or raw runtime correlation ids;
`call_id` is used only to form the stable standard message id. This is not a
generic capability mapping, activity-delta API, or raw advanced stream. Unknown
chunks continue to flush any open assistant text message and are then ignored.

Activities are informational. Permission requests and decisions remain on the
standard interrupt and resume path; activity content does not add queued,
waiting, cancelled, or parent-task correlation states.

## SSE Transport

### `encodeAgUiSse(event, accept?)`

Encodes one AG-UI event as an SSE frame using `@ag-ui/encoder`:

```ts
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"

response.write(encodeAgUiSse(event, request.headers.accept))
```

The SSE helper is a focused subpath; it is not exported from the root adapter.

## CopilotKit

The canonical basic transport example is
[`examples/chat/web`](https://github.com/cacheplane/dawnai/tree/main/examples/chat/web).
It registers a CopilotKit `HttpAgent` that points at Dawn's AG-UI endpoint but
registers no activity renderers. The web app does not need model credentials;
the Dawn server holds `OPENAI_API_KEY`.

For an activity-aware client that renders plan and researcher cards, follow the
[Research assistant web UI recipe](https://dawnai.org/docs/recipes/research-web-ui)
or browse the
[`examples/research/web`](https://github.com/cacheplane/dawnai/tree/main/examples/research/web)
source.

```text
browser
  -> CopilotKit runtime
    -> HttpAgent -> POST /agui/%2Fchat%23agent
      -> Dawn /chat agent
```

## Limitations

- The CLI serves the same AG-UI endpoint through `dawn dev` and the production
  runtime started by `dawn start`; generated server entrypoints invoke the
  exported `serveRuntime()` function directly.
- `POST /agui/{routeId}` expects a URL-encoded Dawn assistant id such as
  `%2Fchat%23agent` for `/chat#agent`.
- Dawn middleware gates Agent Protocol run, wait, and resume execution plus
  AG-UI route execution. It does not gate thread create, read, delete, or state
  endpoints. Allowed middleware context is exposed to tools as `ctx.middleware`.
- Activity projection is request-local. The adapter does not buffer activity
  state or provide reconnect, replay, or durable activity history.
- The package translates protocol events; it does not host a web UI.

## License

MIT
