---
"@dawn-ai/cli": patch
"@dawn-ai/sdk": patch
---

Add `GET /threads/{id}/runs/stream` — reattach to a running turn. A disconnected
client rejoins by attaching to this read-only GET mirror of the POST stream: one
`event: state` snapshot (channel values, the turn's coalesced frames so far, and
parked interrupts) followed by the live tail, or an immediate durable snapshot +
`done` when no live turn exists in this process. It is gated exactly as strictly
as `GET /threads/{id}/pending_interrupts` (thread-access `read` plus the parking
route's middleware). Backed by a bounded in-memory `LiveTurnHub`; the durable
path works across restarts, replicas, and serverless. Being a GET with no body,
it is the first Agent Protocol stream a stock `EventSource` can consume.

`@dawn-ai/sdk` gains one additive `ThreadOperation` member, `thread.attach`, for
the new endpoint. A thread-access policy that switches exhaustively over
`ThreadOperation` should add a `thread.attach` arm; a `fallback` handler already
covers it.
