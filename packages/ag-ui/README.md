<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/ag-ui

Pure, transport-agnostic AG-UI protocol translation for Dawn. This package maps
Dawn agent stream chunks to AG-UI events and maps AG-UI run input back to a
Dawn-shaped run input. It does not host an HTTP server or import LangGraph.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Dev Server](https://dawnai.org/docs/dev-server) and the
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
  fromRunAgentInput,
  toAguiEvents,
  type AguiOutboundEvent,
  type DawnAgentStreamChunk,
  type DawnInterruptEnvelope,
  type DawnMessage,
  type DawnResumeRequest,
  type DawnRunInput,
  type RunContext,
} from "@dawn-ai/ag-ui"
```

The root package is a pure, transport-agnostic adapter. It has no CLI, HTTP, or
LangGraph dependency.

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
Dawn chunks are preserved as AG-UI `toolCallId`. Capability-contributed and
other unknown chunk types are ignored.

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

The adapter does not interpret AG-UI `tools`, `state`, or `context` in v1; they
remain available through `raw`.

Interrupt chunks are accumulated and emitted as a standard AG-UI
`RUN_FINISHED` event with `outcome: { type: "interrupt", interrupts: [...] }`.
Each interrupt uses the Dawn `interruptId` as its AG-UI `id`, and the complete
Dawn envelope is retained in `metadata`. Successful runs finish with
`outcome: { type: "success" }`; upstream failures become one `RUN_ERROR`.

Planning updates, subagent capability events, and other unknown Dawn chunk types
have no v1 mapping and are ignored.

## SSE Transport

### `encodeAgUiSse(event, accept?)`

Encodes one AG-UI event as an SSE frame using `@ag-ui/encoder`:

```ts
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"

response.write(encodeAgUiSse(event, request.headers.accept))
```

The SSE helper is a focused subpath; it is not exported from the root adapter.

## CopilotKit

The canonical example is `examples/chat/web`. It registers a CopilotKit
`HttpAgent` that points at Dawn's AG-UI endpoint. The web app does not need
model credentials; the Dawn server holds `OPENAI_API_KEY`.

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
- The package translates protocol events; it does not host a web UI.

## License

MIT
