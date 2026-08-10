# @dawn-ai/ag-ui

## 0.8.21

## 0.8.20

## 0.8.19

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

## 0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).

## 0.8.15

## 0.8.14

## 0.8.13

### Patch Changes

- 20f0407: Consolidate the existing `@dawn-ai/ag-ui` package as Dawn's pure canonical AG-UI
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

## 0.8.12

## 0.8.11

### Patch Changes

- f0261f1: Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
  serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
  drive Dawn agents. Additive — the existing Agent-Protocol endpoints are unchanged.
