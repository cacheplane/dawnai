# Agent Protocol stream reattachment — anchored live-turn attach

Status: approved (2026-08-09)
Author: Brian Love (with Claude)

## Problem

The 2026-08-06 cancellation spec made Agent Protocol (AP) the durable surface: a client
disconnect does not cancel a run — the run continues and checkpoints — and it explicitly
deferred reattachment as the paired follow-up. That gap is now the sharpest failure on the
surface:

1. **A disconnected client cannot rejoin a still-running run.** Browser reload, network
   blip, laptop sleep: the run keeps producing output that nobody can see until it finishes
   and the client polls `GET /threads/{id}/state`.

2. **A reloaded client silently loses HITL permission prompts.** A parked turn writes
   thread status `"idle"` (`runtime-fetch-core.ts:1312` — parked turns take the normal
   completion path), indistinguishable from done. The interrupt payload is durable in the
   checkpointer (`packages/cli/src/lib/dev/pending-interrupts.ts:45`, today consumed only
   internally by `POST /resume` and the AG-UI endpoint's resume validation) but has no read
   endpoint. This is the worst reconnect outcome: the agent is waiting on the human, and
   the human's UI says the agent finished.

## Rejected approaches

Three architectures were designed independently from a shared code/prior-art audit and
judged. Two were rejected:

- **Process-local event-replay registry** (run ids, numbered SSE events, bounded replay
  buffer, `Last-Event-ID` resume — the direction originally floated and reconsidered at
  Brian's request). Rejected on premises: `runtime-fetch-core.ts` is not dev-only — it is
  the canonical surface behind `dawn dev`, `dawn start`, the testing harness, and the
  build-emitted hono edge entry. Dawn's fetch surface plumbs no `waitUntil` (deliberately —
  see Non-goals) and workerd forbids sharing I/O objects across requests, so a replay
  buffer is only trustworthy on long-lived Node hosts — and `dawn dev` kills the run with
  the child on every file save, exactly when reconnects happen. No AP SSE client exists in
  the repo (UIs speak AG-UI), the wire has no `id:` fields, and the primary stream is a
  POST that `EventSource` cannot issue, so "standard" resume requires custom clients
  anyway. The AP base spec makes the join endpoint forward-only; buffered replay is an
  optional MAY whose own overflow fallback is "resync through state" — meaning every
  robust client must implement the snapshot path regardless, and replay is dual state
  machines for an optimization. Revisit only if a concrete third-party client demanding
  `Last-Event-ID` materializes; sequence numbers can be layered onto this design's digest
  later without unwinding anything.

- **Durable event log in sqlite/postgres.** Touches both storage packages, migrations, and
  conformance kits; creates a second source of truth beside checkpoints (a new GC/parity
  surface, plus the NUL-in-jsonb payload class the postgres-storage work already paid to
  learn); still does not provide cross-replica live fan-out.

- **Plain checkpoint-snapshot rejoin** (no in-memory turn state at all) was the runner-up.
  Checkpoints are per-super-step, so it loses the in-flight assistant message's partial
  text and all `subagent.*` events, which are pure `streamEvents` projections that never
  touch state (`agent-adapter.ts:412-512`) — a research UI's subagent activity goes dark
  on rejoin. (Plan state, by contrast, *does* survive a plain snapshot: the planning
  capability's `todos` is a checkpointed state field already served by `/state`; only the
  `plan_update` event itself is unreplayable.) Partial text and subagent visibility are
  what justify keeping one bounded in-memory digest of the current turn.

## Design

Reattachment is resumable **state**, not a resumable stream. Checkpoints remain the single
durable source of truth; the only new artifact is a bounded, in-memory digest of the
current run's stream chunks, anchored to an immutable checkpoint. Reconnect always
re-snapshots — there are no cursors, no retention windows, no run identity, and every
failure is self-healed by reconnecting.

### 1. `GET /threads/{thread_id}/runs/stream` — the attach endpoint

The GET mirror of the existing `POST /threads/{thread_id}/runs/stream`. Thread-scoped, not
run-scoped: the cancellation spec already established that with one run per thread
enforced, the thread *is* the run identity, and a `run_id` would be shape without
substance — it would also go stale across HITL park/resume boundaries where thread-scoped
attach survives. (The AP base spec's `GET /threads/{id}/runs/{run_id}/stream` join is
forward-only anyway; we diverge honestly, as with thread-scoped cancel.)

**Request handling order:** resolve the thread first — `404 {code:"thread_not_found"}` on
unknown thread (code parity with `POST /cancel` and `POST /resume`; `/state`'s 404 is
uncoded and the odd one out) — then resolve route identity as `threadRouteMap` ??
the route recorded in thread metadata, then run the standard middleware with
`method: "GET"` and that identity. A thread with no resolvable route has never run and is
refused with `409 {code:"thread_route_unknown"}` — fail closed rather than letting
route-gating middleware silently fall through, because attach exposes everything the POST
stream exposed (channel values, run input, live tokens, interrupt payloads) and must be
gated identically. `method:"GET"` is a new observable middleware input — changeset
callout.

Responds `200 text/event-stream` with the identical header set as the POST streams
(per the 2026-08-08 keepalives spec). Attach never touches the run slot — no 409s from
concurrency, any number of viewers up to a per-thread cap. Wire sequence:

1. **One `event: state` frame**, data:

   ```jsonc
   {
     "status": "busy" | "idle" | "interrupted",
     "live": boolean,           // a streaming live turn is attachable in this process
     "anchor": "<checkpoint_id>" | null,
     "run_started_at": "<ISO>" | null,
     "resume": boolean,
     "values": { /* channel_values */ } | null,
     "input": /* payload that started the live turn */ | null,
     "turn": [ /* StreamChunk[] */ ] | null,
     "turn_truncated": true,    // present only when the digest overflowed
     "interrupts": [ { "interruptId": "...", "resumeKey": "...", "value": /* payload */ } ]
   }
   ```

   **When `live: true`:** `values` is the checkpoint at `anchor` (the instant the run
   claimed its slot; `null` on a brand-new thread), `run_started_at` is the wall-clock
   instant *this* live turn claimed the slot (a resume turn gets a fresh value; clients
   detect replacement by comparing it across frames and correlate a resume turn to its
   original run via `anchor`, the parked checkpoint id), `input` is the validated payload
   that started the turn, and `turn` is the turn's chunks so far in emission order,
   coalesced (below). `interrupts` is `[]`: a live turn is by definition not parked, and
   it must **never** be populated from `readPendingInterrupts` here — during a resume run
   the latest tuple is still the parked checkpoint whose pending writes contain the
   *already-answered* interrupt, and echoing it would make clients re-render a resolved
   prompt (the inverse of the bug this spec fixes). Interrupt frames the turn emits appear
   in `turn[]` / the live tail. A client renders `values.messages`, applies `input` as a
   user message **only when `resume` is false** (when `resume` is true, `input` is the
   resume payload — echoed for correlation and debugging only, never applied to the
   transcript), then feeds `turn[]` through the **same reducer it uses for live frames**.

   **When `live: false`** (the durable path): `values` is the latest checkpoint (`null` if
   the thread has none), `interrupts` carries the parked interrupts with their payload
   `value` (see §3), and the remaining fields are pinned: `anchor: null`,
   `run_started_at: null`, `resume: false`, `input: null`, `turn: null`, `turn_truncated`
   absent.

2. **iff `live: true`** — live AP frames from now, byte-identical vocabulary to the POST
   stream (`chunk` / `tool_call` / `tool_result` / `interrupt` / capability types),
   terminated by the turn's own `done` frame (`{output}` | `{output:{error}}` |
   `{output:{cancelled:true}}` — a `POST /cancel` is visible in-band to attachers). A park
   ends the stream the same way the primary sees it: the `interrupt` frame, then the
   normal `done{output}`; clients learn parked state from the interrupt frame or from the
   next attach's `status: "interrupted"`.

3. **iff `live: false`** — an immediate `event: done` with `{output: null}` plus a
   `retry:` hint (2000 ms ± random 500 to break multi-tab lockstep), then the stream
   **closes**; no heartbeat, no subscriber machinery. Fetch clients get an unambiguous
   app-level terminator; a stock `EventSource` degrades to sane-cadence snapshot polling —
   consumers MUST treat `done` as end-of-stream (`dawn threads tail` models this).
   `live: false` with `status: "busy"` is deliberately **not** an HTTP error (an error
   status would break `EventSource`'s reconnect loop): it covers a crashed process's stale
   status, a wrong-replica attach, and an in-process `/runs/wait` run (wait runs hold the
   run slot but produce no chunk stream and open no live turn).

As a consequence of being a GET with no body, this is Dawn's first AP stream a stock
`EventSource` can consume.

### 2. `LiveTurnHub` — the one new in-memory artifact

`packages/cli/src/lib/dev/live-turn-hub.ts` (~200 lines): `createLiveTurnHub()` returning
`open / publish / close / attach` over `Map<threadId, LiveTurn>`, where `LiveTurn` holds
`{anchorCheckpointId, runStartedAt, resume, input, digest, digestBytes, truncated,
terminal, subscribers}`. Handler-scoped — instantiated in `buildRouteTable` beside
`threadRouteMap`, per the same no-module-singleton rule the run registry follows.
`RunRegistry` is untouched.

**Produce.** In `handleApStreamRequest` and the resume handler, after `runRegistry.begin`
succeeds and **before the route stream begins executing**, capture the anchor with one
`checkpointer.getTuple` (latest tuple; the run's own puts cannot race a read that
completes before the route starts) and `hub.open(threadId, …)`. A failed anchor read is
logged and the run proceeds **without** a live turn (attach degrades to the durable path);
it never fails the run and never leaks the run slot. Beside the existing `safeEnqueue`
(`runtime-fetch-core.ts:1310`) and the catch-path synthesized terminal `done`, add
`turn.publish(chunk)`. The adapter's silent `streamEvents` retry is safe: its `hasYielded`
guard means a retry can only happen when nothing was published.

**Pre-stream failure window.** Between `hub.open` and stream construction, existing code
can throw (the metadata/status writes at `runtime-fetch-core.ts:1248-1257`). That catch is
extended to `hub.close(entry)` before rethrowing, so an entry cannot leak open with the
run slot already released. Belt-and-braces: `hub.open` force-closes any existing entry for
the thread — fanning a terminal frame to its subscribers — before installing the new one,
so even a leaked entry's viewers get a terminal frame instead of hanging heartbeats.

**Delivery model — pull, not push.** `publish` appends to the shared digest (with
coalescing, under the byte cap) and to each subscriber's bounded queue, then resolves each
subscriber's wake promise. These are plain data mutations — no I/O on foreign objects — so
they are legal cross-request on workerd. Each attacher runs its **own** drain loop inside
its own response stream, in its own request context: wake → move queued frames to its
controller → repeat. This is what makes the queue cap enforceable (overflow is detected at
append), makes workerd live-tail actually work (an attach landing on the isolate whose
streaming response holds the run *does* find a live turn — the primary response keeps the
invocation alive), and gives `close` clean semantics: mark ended with the terminal frame,
resolve all wakes, let each drain loop deliver its queue and then the terminal, then
close. The primary POST stream keeps today's direct enqueue path untouched and is never
blocked by viewers.

**Close ordering — the concurrency-sensitive seam.** `hub.close(threadId)` fires at
*client-visible stream end* for every producer exit — normal done, error, park, cancel —
in the `finally` alongside `stopHeartbeat`, unconditionally: **never** deferred behind
`sourceCleanup` the way `run.release()` deliberately is for cancelled runs
(`runtime-fetch-core.ts:1329-1347`). Attachers must see the terminal frame when the
primary client does; response lifetime, not run-slot lifetime, is what viewers share. A
park therefore closes the live turn — a reload-while-parked attach is always the durable
path. Because a cancelled route can still be unwinding while a new run opens a new entry
on the same thread, `close` and `publish` carry the same identity guard the run registry
uses (`run-registry.ts:96`): a publisher holds a reference to *its* `LiveTurn` and is
inert once that entry is closed or replaced — a zombie route can never write into a
successor turn. Terminal `done` frames fan out to subscribers and are recorded as
`terminal` on the entry but are **never appended to the digest**; an attach that lands in
the tiny window between the terminal publish and `close` re-emits the stored terminal as
`event: done` after its state frame, so `turn[]` never smuggles the terminator.

**Attach sequence (live path), inside the response stream's `start()`:**

1. Start the #428 heartbeat (comment frames may precede the state frame).
2. `await` values at `anchorCheckpointId` — old checkpoints are immutable
   (checkpoint-id-addressed `getTuple` exists in both the sqlite and postgres savers), so
   this read races nothing.
3. In **one synchronous section**: copy the digest, capture the stored terminal if any,
   register the subscriber, build and enqueue the state frame. Single-threaded JS makes
   the section atomic against `publish`: a publish during step 2's await lands in the
   digest and is included in the copy; a publish after step 3 lands only in the subscriber
   queue. **No frame appears in both, and their concatenation is the full turn** — the
   gap/dup invariant, with zero sequence numbers.
4. Run the drain loop (frames published since step 3, then live delivery, then the
   terminal `done`), stop the heartbeat in the same `finally` that closes the response.

If no `LiveTurn` exists: one latest-tuple read serves both `values` and the pending-writes
parse (§3) → `state{live:false}` → `done{output:null}` → close.

**Bounds.** `apAttachDigestMaxBytes` (default 2 MiB serialized, accounted incrementally —
never recomputed per frame) caps the digest. Consecutive `chunk` frames coalesce into one
`{type:"chunk", data:"<text so far>"}`; `subagent.message` token deltas — emitted one
capability frame *per token* (`agent-adapter.ts:438-448`) — coalesce per `callId` into one
concatenated entry, preserving interleaving with other frame types. Without subagent
coalescing, a single deep-research turn blows any reasonable cap and the flagship workload
would degrade to exactly the rejected runner-up design. On overflow the digest is dropped
**whole** and the state frame carries `turn: null, turn_truncated: true` — degrade to
values-plus-live-tail rather than ever emitting misleading partial-middle text. Each
subscriber gets a bounded queue (1 MiB / 1024 frames); overflow emits a best-effort
`event: detached {reason:"overflow"}` and drops **that subscriber only**. Viewers are
capped per thread (`apAttachMaxViewers`, default 16); an attach beyond the cap receives
`event: detached {reason:"capacity"}` immediately (no snapshot work) and closes. The
documented recovery for every degraded case is the same: reconnect for a fresh snapshot.

### 3. `GET /threads/{thread_id}/pending_interrupts`

A small standalone JSON endpoint returning `{interrupts: [{interruptId, resumeKey,
value}]}`. `readPendingInterrupts` today returns only ids and keys — the parsed
`__interrupt__` payload is discarded (`pending-interrupts.ts:54-84`) — so it is extended
(or given a sibling over the same tuple-parse) to surface the interrupt `value`: the
renderable content of a permission prompt lives there, and without it neither this
endpoint nor the state frame can actually fix Problem #2. The same enriched shape is
embedded in the attach state frame's `interrupts` field on the durable path, so the SSE
path alone suffices to re-render the prompt. Contract: unknown thread →
`404 {code:"thread_not_found"}`; none pending → `200 {interrupts: []}`; standard AP
middleware applies with the same route-resolution rule as attach; response is `no-store`
JSON. Works across restarts, replicas, and serverless because it is checkpoint-backed.

### 4. Parked-status honesty

When a turn parks on an interrupt, both completion paths (`runtime-fetch-core.ts:1312`
and its twin in the resume handler) write `"interrupted"` instead of `"idle"`, tracked by
the handler's own saw-interrupt flag — deliberately independent of the hub, so this rides
the leading PR (below). Note the overload: the cancel path already writes `"interrupted"`
(cancellation spec §3), so the status alone means *cancelled-or-parked*; the
discriminator is `pending_interrupts` — non-empty means waiting on a human. Documented,
and asserted in the integration suite. Observable behavior change on `GET /threads/{id}` —
changeset callout in the leading PR.

### 5. `dawn threads tail <thread-id>`

A CLI command consuming the attach stream: renders the snapshot, tails live frames, exits
on `done` (modeling the mandatory close-on-done client behavior). The first first-party AP
stream client — it forces the client-side reducer contract to be real, and gives the docs
a copy-pasteable consumer.

### Resume-run semantics

After a HITL park, `POST /resume` starts a new live turn whose `anchor` is the parked
checkpoint and whose `input` is the resume payload. The state frame marks this with
`resume: true`; clients do not apply `input` to the transcript at all in that case, and
`interrupts` is `[]` even though the durable path still reports the parked interrupt
(§1). Attach-during-resume gets dedicated integration tests.

## Restart, serverless, multi-replica

- **Dev restart / crash:** the run dies with the process (Dawn's fetch surface plumbs no
  `waitUntil`), so there is deliberately no buffer to lose — the only buffer was the
  current turn of a run that no longer exists. Attach then serves the durable path:
  checkpoint at the last completed super-step + durable interrupts. Nothing pretends the
  run survived.
- **workerd/serverless:** the durable path is the *supported* path (one checkpoint read +
  two SSE frames, no cross-request I/O). Live attach is possible when the attach lands on
  the isolate whose streaming response is holding the run alive: the pull model makes this
  legal by construction (publish is pure data mutation; each attacher drains in its own
  request context). This remains *best-effort until proven* by the deploy-anywhere PR3
  lane; docs state the durable path as the workerd guarantee.
- **Multi-replica:** any replica serves a correct durable snapshot + interrupts; only the
  live tail requires the owning replica — the identical single-replica constraint the
  cancellation spec documents for cancel, restored fully by session affinity, and owned by
  the future shared-backend sub-project.

## Error cases

| Case | Response |
|---|---|
| Unknown thread | `404 {code:"thread_not_found"}` (parity with `POST /cancel` / `POST /resume`) |
| No resolvable route for the thread | `409 {code:"thread_route_unknown"}` — fail closed (§1) |
| Middleware reject | its status/body, as on every AP endpoint |
| Digest overflowed during the turn | `state.turn: null, turn_truncated: true` — values + live tail |
| Slow viewer exceeds queue cap | `event: detached {reason:"overflow"}`, then close; others unaffected |
| Viewer cap exceeded | `event: detached {reason:"capacity"}` immediately, then close |
| Run exists but not attachable here | `state{live:false, status:"busy"}` + `done{output:null}` + retry hint — in-band, not an HTTP error; covers crashed-process stale status, wrong replica, and in-process `/runs/wait` runs |

The replay design's cursor-too-old / expired-run / unknown-run error class cannot occur:
there are no cursors and no retention.

## Non-goals

- **`run_id`, run table, or run-scoped join** — upholds the cancellation spec's rejection.
- **SSE `id:` fields, `Last-Event-ID`, sequence numbers** — reconnect always re-snapshots.
  Layerable later onto digest entries without unwinding anything.
- **Durable event log in storage packages** — checkpoints stay the single source of truth.
- **Post-completion retention** — durable state answers late joiners.
- **Cross-replica live tail** — belongs with the shared-backend sub-project.
- **AG-UI changes** — AG-UI keeps abort-on-disconnect; a later slice can reuse the
  state-frame composer for `STATE_SNAPSHOT` / `MESSAGES_SNAPSHOT`.
- **A distinct `ThreadStatus` member for parked** — `"interrupted"` is overloaded
  (cancelled-or-parked) with `pending_interrupts` as the discriminator; a schema change is
  not worth it in this slice.
- **`on_disconnect` parameter, WebSocket upgrade, `waitUntil` edge run-continuation**
  (deploy-anywhere PR3's question), **chunk streaming / live turns for `/runs/wait`**, and
  **token-granularity replay of text emitted while disconnected** (coalesced replay is
  cosmetically inferior, semantically identical).

## Delivery slices

1. **PR1 — durable honesty (no hub):** `GET /pending_interrupts` (with the `value`
   extension to `readPendingInterrupts`) + §4 parked-status writes in both handlers.
   Checkpoint-backed only; independently reviewable; carries the status-change changeset
   callout.
2. **PR2 — the hub and the attach endpoint:** `LiveTurnHub`, `GET /threads/{id}/runs/stream`,
   producer hooks, the integration suite against both checkpointer backends.
3. **PR3 — client and docs:** `dawn threads tail`, docs pages (attach endpoint,
   disambiguation of `"interrupted"`, the do-not-mix-`/state`-with-attach caveat), amend
   the cancellation spec's deferred-reattach note, Chrome smoke.

## Code delta

- `packages/cli/src/lib/dev/live-turn-hub.ts` — NEW (~200 lines), pure in-memory,
  pull-model subscribers.
- `packages/cli/src/lib/dev/pending-interrupts.ts` — surface the interrupt `value`;
  expose the tuple-parse so the attach durable path reuses one `getTuple` for values +
  interrupts.
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` — two new GET routes +
  `handleApAttachRequest`; producer hooks in the stream and resume handlers (anchor read,
  `hub.open`/`publish`/`close`, extended pre-stream catch); parked-status writes; new
  options `apAttachDigestMaxBytes`, `apAttachMaxViewers`.
- `packages/cli/src/lib/runtime/stream-types.ts` — `StreamChunk` union unchanged; add
  attach-frame types.
- `packages/cli` — `dawn threads tail` command.
- **No changes** to sqlite-storage, postgres-storage (id-addressed `getTuple` already
  exists in both), migrations, or `@dawn-ai/langchain`. No new packages.

## Test strategy

Unit — a small abstract contract suite over the hub interface (conformance-kit style):
chunk and `subagent.message`-per-`callId` coalescing preserve interleaving and exact
concatenated text; incremental byte accounting matches serialized size; cap overflow drops
the whole digest and sets the flag; the atomicity invariant (**no frame is both in the
copied digest and in a subscriber queue, and their concatenation equals the full turn** —
publishes during the anchor await land in the copy, publishes after the sync section land
in the queue); slow-subscriber overflow drops only that subscriber; the viewer cap;
`close()` after replacement fans out nothing and a zombie publisher is inert (identity
guard); `open()` over a leaked entry terminates its subscribers; terminal frames are
fanned out and stored but never digested; the attach-during-terminal-window re-emit.

Integration — `@dawn-ai/testing` http-inject against the real fetch handler with aimock
fixtures (Node 24 per the repo gotcha), run against **both** sqlite and postgres
checkpointer fixtures (postgres env-gated, matching the conformance-kit culture):

1. **Transcript equivalence** — run a multi-node fixture, attach at randomized mid-run
   points, assert `reduce(primary frames) === reduce(state.values + input + turn + tail)`
   (where `reduce` applies `input` only when `resume` is false) and coalesced-turn text +
   tailed text equals primary token text exactly.
2. Attach while parked → durable path with `interrupts` carrying `value`s that re-render
   the prompt; resume completes; a second attach shows `live:false`, status `"idle"`.
3. Attach after done / on empty thread / unknown thread / unresolvable route.
4. Two concurrent attachers + one artificially slow one (detached; others and the run
   unaffected); viewer-cap rejection.
5. Attach during a resume run → `resume: true`, the parked `anchor`, and `interrupts: []`
   even though the durable read still reports the parked interrupt.
6. `POST /cancel` mid-attach → attacher receives `done` with `{output:{cancelled:true}}`;
   a cancelled route still unwinding cannot publish into a successor turn (identity guard,
   all producer exits: normal done, error, cancel, park, resume).
7. **Anchor correctness** — attach immediately after a mid-run checkpoint put shows no
   duplicated messages (values from anchor, not latest); anchor-read failure degrades to
   the durable path without failing the run.
8. Digest overflow → `turn:null`, values + tail still transcript-consistent at node
   granularity.
9. Parked turn reads status `"interrupted"` from both the stream and resume handlers
   (park-after-resume covered); `"interrupted"` + empty `pending_interrupts` means
   cancelled; stale `"busy"` after restart still attaches via the durable path.
10. A route-gating middleware rejects/allows attach and `pending_interrupts` identically
    to the POST stream.
11. Existing pins: the disconnect-does-not-abort parity tests stay green;
    `runtime-exports.test.ts` if new symbols are exported.

`dawn threads tail` gets a dev-server smoke. The digest cap is validated as a **pass/fail
gate**: a full `examples/research` deep-research turn must fit under the default cap after
coalescing. Real-browser verification (per standing instruction): Chrome smoke — reload
mid-run recovers partial text and subagent activity; reload while parked re-renders the
permission prompt from the state frame alone; `EventSource` polling cadence on the
`live:false` path.

## Risks

| Risk | Mitigation |
|---|---|
| Producer close ordering under the cancelled-run split (release is deferred; hub.close must not be) | Close at client-visible stream end for every exit incl. park; identity-guarded publish/close; pre-stream failure window closes the entry; tests at every producer exit. |
| Up to `apAttachDigestMaxBytes` held per **active** run, attached or not | Chunk + per-`callId` subagent coalescing keep the digest near one string per stream; `examples/research` pass/fail gate before trusting the default; overflow degrades cleanly to values+tail. |
| Anchor `getTuple` adds a hot-path DB read per streaming run | One point read of the latest tuple before the route starts; failure degrades instead of failing the run; anchor-correctness test pins the no-duplicate property. |
| Middleware identity on a body-less GET | Route resolved thread-first from `threadRouteMap` ?? metadata; fail-closed 409 when unresolvable; gating parity integration test; `method:"GET"` changeset callout. |
| Resume-run attach mis-rendered by clients | `resume: true` + fresh `run_started_at` + `interrupts: []` contract; dedicated tests; reducer exercised by `dawn threads tail`. |
| workerd live-tail unproven until the PR3 lane exists | Pull model is workerd-legal by construction, but docs promise only the durable path there until the lane proves it. |
| Mixing `GET /state` (advances mid-run) with an attach snapshot (anchored) double-counts | Documented: the attach stream is self-contained; do not merge it with `/state` reads. |
| `state` frame is a Dawn extension unknown to generic AP clients | Documented divergence, like thread-scoped cancel. Nothing regresses — no such client can reconnect today. If third-party `Last-Event-ID` demand materializes, sequence numbers layer onto the digest. |
| `"interrupted"` now means cancelled-or-parked | Deliberate overload; `pending_interrupts` is the discriminator; documented and asserted in tests; distinct status member is an explicit non-goal. |
