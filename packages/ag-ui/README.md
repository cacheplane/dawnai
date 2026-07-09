<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/ag-ui

AG-UI protocol translation for Dawn's local runtime. This package maps Dawn
runtime stream chunks to AG-UI events and maps AG-UI run input back to Dawn route
input, so CopilotKit and other AG-UI clients can drive Dawn agents.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Dev Server](https://dawnai.org/docs/dev-server) and the
[chat web example](https://github.com/cacheplane/dawnai/tree/main/examples/chat/web).

## Install

```bash
pnpm add @dawn-ai/ag-ui
```

Most apps do not import this package directly. `@dawn-ai/cli` uses it to serve
the local dev endpoint:

```text
POST /agui/{routeId}
```

The URL segment is the URL-encoded Dawn assistant id (`<routeId>#<kind>`). For
example, the Dawn route `/chat#agent` is exposed to AG-UI clients as:

```text
POST http://127.0.0.1:3001/agui/%2Fchat%23agent
```

## Public API

```ts
import {
  createAgUiTranslator,
  encodeAgUiSse,
  fromRunAgentInput,
  mapRunInput,
  toAguiEvents,
  type AgUiEvent,
  type DawnRunInput,
  type DawnStreamChunk,
  type MappedRunInput,
  type ResumeDecision,
  type RunContext,
  type TranslatorOptions,
} from "@dawn-ai/ag-ui"
```

## Transport Helpers

Use `toAguiEvents` and `fromRunAgentInput` when you own the transport and only
need pure mapping helpers. These helpers do not depend on the CLI, HTTP, or
LangGraph.

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
type DawnChunk =
  | { type: "token"; data: string }
  | { type: "tool_call"; data: { id?: string; name: string; input: unknown } }
  | { type: "tool_result"; data: { id?: string; name: string; output: unknown } }
  | { type: "interrupt"; data: { interruptId: string; kind?: string; [key: string]: unknown } }
  | { type: "done"; data?: unknown }
```

`dawnChunks` can be any `AsyncIterable<DawnChunk>`, including the langchain
adapter's `AgentStreamChunk` stream. Tool call ids from Dawn chunks are preserved
as AG-UI `toolCallId`.

### `fromRunAgentInput(input)`

Maps AG-UI `RunAgentInput` to a Dawn-shaped run input:

```ts
import { fromRunAgentInput } from "@dawn-ai/ag-ui"

const { messages, resume, raw } = fromRunAgentInput(runAgentInput)
```

`resume` is omitted when empty. When present, it is an array of answers addressed
by `interruptId`, for example:

```ts
[{ interruptId: "perm-1", status: "resolved", payload: "once" }]
```

Translate those answers to your runtime's resume call. `raw` exposes the
untouched AG-UI input for `tools`/`state`/`context`.

## Dev Server Helpers

### `mapRunInput(input)`

Maps an AG-UI `RunAgentInput` to Dawn's route input for the built-in local dev
endpoint:

- The newest user message becomes `{ messages: [{ role: "user", content }] }`.
- Dawn keeps conversation history in the checkpoint keyed by AG-UI `threadId`,
  so only the newest turn is forwarded.
- Human-in-the-loop resume decisions are read from
  `forwardedProps.command.resume`.

Resume accepts either a string decision:

```json
{ "forwardedProps": { "command": { "resume": "once" } } }
```

or an object carrying both the decision and interrupt id:

```json
{
  "forwardedProps": {
    "command": {
      "resume": { "decision": "once", "interruptId": "perm-abc123" }
    }
  }
}
```

`ResumeDecision` is `"once" | "always" | "deny"`.

### `createAgUiTranslator(options)`

Creates a translator for one AG-UI run:

```ts
const translator = createAgUiTranslator({ threadId, runId })
```

Call `begin()` once, feed each Dawn stream chunk to `translate(chunk)`, then call
`end()` if the stream finishes without a Dawn `done` chunk.

The translator emits:

- `RUN_STARTED` / `RUN_FINISHED`
- assistant text message start/content/end events
- tool call start/args/end/result events
- `STATE_SNAPSHOT` for `plan_update` and other object state chunks
- `CUSTOM{name:"on_interrupt"}` for Dawn permission or memory interrupts
- `CUSTOM{name:"dawn.<subagent event>"}` for `subagent.*` chunks
- `RUN_ERROR` when Dawn reports an error

### `encodeAgUiSse(event, accept?)`

Encodes one AG-UI event as an SSE frame using `@ag-ui/encoder`:

```ts
response.write(encodeAgUiSse(event, request.headers.accept))
```

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

The example also shows how Dawn's `CUSTOM{name:"on_interrupt"}` event flows to a
CopilotKit interrupt card, and how the card sends `{ decision, interruptId }`
back through `forwardedProps.command.resume`.

## Limitations

- The AG-UI endpoint is a local `dawn dev` integration surface. It is additive;
  the Agent Protocol thread endpoints remain unchanged.
- `POST /agui/{routeId}` expects a URL-encoded Dawn assistant id such as
  `%2Fchat%23agent` for `/chat#agent`.
- Dawn middleware currently documents and targets the Agent Protocol
  `/threads/:thread_id/runs/*` endpoints. Do not rely on middleware behavior as
  the AG-UI authorization boundary.
- The package translates protocol events; it does not host a web UI.

## License

MIT
