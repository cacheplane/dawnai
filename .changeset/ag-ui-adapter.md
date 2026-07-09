---
"@dawn-ai/ag-ui": patch
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
---

Add `@dawn-ai/ag-ui`, a transport-agnostic adapter that maps Dawn agent stream
events to and from the AG-UI protocol. `toAguiEvents` turns a Dawn stream
(`token`/`tool_call`/`tool_result`/`interrupt`/`done`) into AG-UI events;
`fromRunAgentInput` maps AG-UI input (messages + interrupt resume) back to a Dawn
run input. No server or transport is bundled — consumers own the transport.

The langchain adapter now surfaces each tool invocation's `run_id` as `id` on its
`tool_call`/`tool_result` stream chunks, so AG-UI `toolCallId` correlation is
faithful even when a tool is called more than once.

The CLI runtime now preserves those optional tool invocation ids in Dawn SSE
`tool_call`/`tool_result` payloads. Local in-process `dawn run` also generates a
one-shot thread id for agent routes so the default SQLite checkpointer can run
the same agent route shape that `dawn dev` already supports.

Release note: this uses `patch` for all packages to preserve the 0.8.x release
line and avoid fixed-group surprises; confirm the intended bump with the
maintainer at release time.
