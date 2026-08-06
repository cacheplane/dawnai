# Agent Protocol run cancellation + deliberate disconnect semantics

Status: approved (2026-08-06)
Author: Brian Love (with Claude)

## Problem

Two related gaps on Dawn's Agent Protocol (AP) HTTP surface:

1. **An in-flight AP run cannot be stopped.** The only `AbortSignal` reaching the graph
   is the server shutdown signal (`runtime-fetch-handler.ts:133-143` → `:684`). A client
   that disconnects, or an operator watching a runaway agent burn tokens, has exactly one
   remedy: kill the process. `/runs/stream`, `/runs/wait`, and `/resume` are all affected.

2. **Disconnect behaviour is accidental, not designed.** AP runs continue after client
   disconnect; AG-UI aborts. That split is currently justified only by a code comment
   ending "Whether AP streams *should* abort on disconnect is a follow-up question"
   (`runtime-fetch-handler.ts:662-666`). Nobody can tell whether it is a decision or a leftover.

A third defect surfaced while grounding this work, and it is a prerequisite (see below):

3. **Concurrent runs on one thread silently corrupt each other.** Nothing in the runtime
   ever *reads* `thread.status` — `"busy"` is written at six sites and read only for JSON
   serialization. Two simultaneous `POST /threads/X/runs/stream` are both admitted and both
   drive the *same* LangGraph checkpoint thread (`thread_id: threadId, checkpoint_ns: ""`),
   interleaving checkpoint writes last-writer-wins. Whichever finishes first flips the shared
   thread to `"idle"` while the other still runs, so the status field already lies.

## Research verdict: keep the split, don't unify

The intuitive fix — make both endpoints behave the same — is wrong. Evidence:

- **LangGraph Platform, the reference AP server, defaults to `continue`.** Verified in the
  shipped `langgraph-api==0.12.0` wheel's `openapi.json` and in the open-source JS server:
  `on_disconnect: z.enum(["cancel","continue"]).optional().default("continue")`, applied to
  the same `runs/stream` + `runs/wait` pair Dawn serves.
- **The `agent-protocol` spec repo says `default: "cancel"`** — LangChain's own spec and
  LangChain's own server contradict each other, with no changelog explaining it. We follow
  the server, because real clients talk to real deployments.
- **Durable → continue, ephemeral → abort** holds across the field: OpenAI background
  responses continue and reconnect while sync ones die with the socket; Vercel AI SDK's
  `streamText` dies unless you call `consumeStream()`; Mastra's `chatRoute()` aborts but
  `DurableAgent` continues.
- **The concrete failure mode** is LangGraph issue #5672: cancelling a checkpointed run
  loses streamed-but-not-yet-checkpointed state, leaving the thread *behind what the user
  already saw*, unrecoverably.
- **The framing that settles it** (Ably): a deliberate stop and a network drop look
  identical on the wire. Never infer cancel intent from connection state — signal it explicitly.

A separate code trace confirmed aborting AP would be *safe* in Dawn today (threads settle
`idle`, LangGraph's `finally` flushes in-flight checkpoint writes, parked HITL interrupts
resume from SQLite pending writes). Safe is not the same as correct: the durable surface
should keep running, and cancellation should be requested out of band.

Therefore the real defect is not the behaviour — it is that the behaviour is undocumented
and that there is no explicit way to ask for cancellation.

## Design

### 1. Run registry (enables everything else)

A `Map<string, AbortController>` keyed by thread id, living in the `buildRouteTable`
closure alongside the existing `threadRouteMap` precedent (`runtime-fetch-handler.ts:314`).

Deliberately **not** on `ThreadsStore`: an `AbortController` is not serializable, and thread
status is persisted SQLite state. Deliberately **not** a module-level singleton: that leaks
across handler instances in tests and breaks the multiple-instances-per-process property
the `(Request) => Response` core exists to provide.

Entries are registered where `updateStatus(threadId, "busy")` is written today and removed
in the same `finally` that restores `"idle"`.

### 2. Concurrency gate — a prerequisite, not scope creep

Thread-scoped cancellation is undefined while two runs can share a thread: the second run's
registry entry would overwrite the first's, orphaning that controller permanently and
producing precisely the unkillable run this work exists to prevent.

So: a second run on a thread with a live registry entry is rejected with **409 Conflict**.

**The gate reads the in-memory registry, not the persisted `status` column.** This is the
key detail. Gating on the DB flag would mean a process that crashes mid-run leaves `"busy"`
written to SQLite and *permanently* bricks that thread — every later run 409s forever. The
registry is process-local and empty after restart, so a crash self-heals.

This also makes `status` honest for the first time, and gives the corrupting-interleaved-
checkpoint bug (#3 above) a fix.

### 3. `POST /threads/{thread_id}/cancel`

Thread-scoped, not `runs/{run_id}/cancel`. Dawn has no run identity — no `run_id`, no run
table, zero hits for `run_id` across `packages/cli/src` and `packages/sqlite-storage/src`.
With §2 in force, "the run on this thread" is unambiguous, so the thread *is* the run
identity. Inventing a synthetic `run_id` to imitate LangGraph's URL shape would be shape
without substance; we diverge honestly and document it.

| Case | Response |
|---|---|
| Unknown thread | `404` |
| No run in flight on this process | `409` |
| Cancelled | `200 {thread_id, status: "interrupted"}` |

The no-run case returns 409 rather than an idempotent 200 on purpose: a silent success
would hide the multi-replica coin-flip described below.

Semantics are LangGraph's `action=interrupt` — stop the run, keep checkpointed state.
`rollback` (discarding checkpoints) is a non-goal.

Cancellation writes `"interrupted"`, a `ThreadStatus` member that already exists in the
schema and is currently written by no production code — a free terminal state, no migration.

Enforcement mirrors AG-UI's proven belt-and-braces shape (`agui-handler.ts:119-126, 207-233`):
compose via `AbortSignal.any([shutdownSignal, runController.signal])`, pass it into the route,
**and** wrap the iterator in `abortableAsyncIterable` so a route that ignores its `ctx.signal`
still stops.

A cancelled stream must be distinguishable on the wire from a completed one — clients cannot
be left inferring it from a truncated stream.

### 4. Document the disconnect split

Replace the "follow-up question" comment with the rationale from the research above: AP is
the durable, resumable surface and keeps running; AG-UI is ephemeral with nothing to reattach
to and aborts. Both sides get a comment, and the split is covered in user-facing docs.

## Non-goals

- **`on_disconnect: "cancel"|"continue"`.** LangGraph-compatible, but with an explicit cancel
  endpoint shipped and no reattach endpoint to pair it with, it buys nothing today. Revisit
  alongside run reattachment.
- **A `run_id` / run table.** Out of scope; would change the AP surface shape broadly.
- **Cross-replica cancellation.** See below.
- **SSE keepalives.** Real (an idle proxy timeout is indistinguishable from a disconnect), but
  independent of cancellation. File separately.

## Known constraint: single replica

An in-memory registry means `POST /threads/X/cancel` only works if it lands on the replica
running the graph. `charts/dawn-app` ships an HPA with `maxReplicas: 5` and no session
affinity, so at N>1 this is a 1-in-N coin flip.

This is **not a regression introduced here**. Dawn's AP surface is already single-replica-only:
`threadsStore` is `<appRoot>/.dawn/threads.sqlite` on a pod-local filesystem (the deployment
mounts only an `emptyDir`), as is the checkpointer, so two replicas already means two divergent
thread databases. `threadRouteMap` has the identical property today.

Scope accordingly: ship the in-memory registry, and **document the constraint explicitly** in
`charts/dawn-app/README.md`, which currently describes `replicaCount` with no statefulness
caveat. Durable cross-replica cancellation belongs with a shared threads/checkpoint backend —
the same gap `@dawn-ai/memory-pgvector` closed for memory, and the natural next sub-project.

## Test strategy

Implement once in `runtime-fetch-handler.ts`; it is the canonical surface, with
`runtime-server.ts` a 162-line Node adapter over it, so coverage flows to `dawn dev`,
`dawn start`, and the B3 edge targets alike.

New coverage: 409 on concurrent run; registry cleared after normal completion, after error,
and after cancel; 404/409/200 cancel cases; cancel actually aborts a route that ignores
`ctx.signal` (via `abortableAsyncIterable`); cancelled run is distinguishable on the wire;
stale-`busy`-after-restart does **not** 409.

Existing pins to update:
- `test/runtime-fetch-parity.test.ts:212-234` — "client disconnect does not abort the run"
  **stays green and gains a comment**: it now pins a deliberate decision rather than
  incidental parity. Its sibling at `:236-260` (unread-SSE drain) depends on the same property.
- `test/agui-endpoint.test.ts:437,496` — invariants any shared-abort refactor must preserve.
- `test/resume-endpoint.test.ts` — `/resume` carries the same parity comment.
- `test/runtime-exports.test.ts` — if new symbols are exported.

## Risks

| Risk | Mitigation |
|---|---|
| 409 breaks a client that fires concurrent runs today | Today that path silently corrupts checkpoints; 409 converts data loss into a clear error. Call it out in the changeset. |
| Crashed process bricks a thread | Gate on the in-memory registry, never the persisted flag (§2). Explicitly tested. |
| Registry leak on an unusual throw path | Register/unregister in the same `try/finally` as the existing `idle` restore; test the error path. |
| False sense of safety at N>1 replicas | 409 rather than silent 200 on the no-run case; chart README caveat. |
