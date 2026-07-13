---
"@dawn-ai/ag-ui": patch
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
---

Consolidate the existing `@dawn-ai/ag-ui` package as Dawn's pure canonical AG-UI
adapter. Its root API now maps standard `RunAgentInput` requests and Dawn stream
chunks, including standard interrupt outcomes and addressed resume decisions,
while the focused `@dawn-ai/ag-ui/sse` subpath provides event-stream encoding
without taking ownership of a server or runtime transport.

The CLI AG-UI endpoint now uses the canonical adapter, applies the same request
projection as other runtime middleware, and emits canonical events without the
former custom state event shapes. Pending checkpoint interrupts are resolved
through the standard resume contract.

The langchain adapter surfaces each tool invocation's `run_id` on its
`tool_call` and `tool_result` chunks, and the CLI preserves those IDs through
Dawn and AG-UI streams for reliable `toolCallId` correlation. Local in-process
`dawn run` also assigns agent routes a one-shot thread ID so the default SQLite
checkpointer can execute the same route shape supported by `dawn dev`.
