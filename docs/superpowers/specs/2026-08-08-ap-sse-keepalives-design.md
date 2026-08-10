# Agent Protocol SSE keepalives and cache-control parity

Status: approved (2026-08-08)
Author: Brian Love

## Problem

Dawn's durable Agent Protocol streams can be silent while a route waits on a
model, tool, permission decision, or other long-running operation. During that
silence an HTTP proxy may close the connection as idle. The runtime cannot tell
that transport failure from a deliberate client disconnect, so the durable run
correctly continues in the background. Dawn does not yet expose stream
reattachment, however, which leaves the caller unable to observe the remainder
of the run.

The two Agent Protocol SSE responses also advertise inconsistent cache policy:

- `POST /threads/{thread_id}/runs/stream` returns `no-cache`.
- `POST /threads/{thread_id}/resume` returns `no-cache, no-transform`.

The difference is accidental. Intermediaries should neither cache nor transform
either live event stream.

## Scope

Add a periodic SSE comment heartbeat to both durable Agent Protocol stream
responses and give both responses the same cache-control value. Keep the wire
shape of application events, run cancellation, disconnect behavior, and AG-UI
unchanged.

## Design

### Heartbeat behavior

Both Agent Protocol stream handlers emit this standards-compliant SSE comment
frame after each 15 seconds of elapsed stream lifetime:

```text
: ping

```

The encoded bytes are `: ping\n\n`. SSE clients ignore comment frames, while
proxies and other intermediaries observe traffic and do not classify the
connection as idle.

The interval begins when the response stream starts. It is independent of
application events: regular output does not reset the interval. This keeps the
implementation deterministic and avoids coupling heartbeat lifecycle to route
chunk timing. At one eight-byte frame every 15 seconds, the extra traffic is
negligible.

### Shared lifecycle helper

One internal helper in `runtime-fetch-core.ts` owns heartbeat setup and teardown.
It receives the stream controller and encoded heartbeat, starts the interval,
and returns a cleanup function. Each AP handler starts it at stream startup and
calls cleanup in its outer `finally` before closing the controller.

The helper uses the existing `safeEnqueue` behavior, so a client that has
already cancelled its readable side does not turn a background durable run into
an exception. No Node-only timer methods are used; the fetch core must remain
compatible with edge runtimes.

`createRuntimeFetchHandler` gains an internal/test-only heartbeat interval
override alongside its existing drain-deadline test hook. The production
default remains fixed at 15 seconds, and no public Dawn configuration surface is
added.

### Cache headers

Both Agent Protocol responses return:

```text
Cache-Control: no-cache, no-transform
Connection: keep-alive
Content-Type: text/event-stream
```

`no-transform` prevents intermediaries from buffering, compressing, or otherwise
rewriting a live stream. AG-UI remains outside this change because the defect is
specifically the durable Agent Protocol pair and AG-UI retains different
disconnect semantics.

### Run and error semantics

Heartbeat frames carry no Dawn event and never mutate thread state. Existing
application events retain their exact framing and order. A normal completion,
route error, explicit cancellation, or source cleanup clears the heartbeat
timer through the stream's outer `finally`.

Client disconnect behavior remains deliberate:

- Agent Protocol runs continue until completion or explicit cancellation.
- AG-UI runs abort on disconnect.

This change keeps the viewer connection alive when possible; it does not add
reattachment, change cancellation, or solve a route whose source never unwinds.

## Alternatives considered

### Duplicate an interval in each handler

This is the smallest initial diff, but the two handlers already drifted on
cache-control. Duplicating another transport concern makes future divergence
more likely.

### Race each iterator read against a timeout

This avoids a standing interval, but it inserts new concurrency into the route
iterator and its cancellation/source-cleanup handshake. That path deliberately
distinguishes response lifetime from run lifetime and should not be complicated
for a transport heartbeat.

### Wrap each response with a transform stream

A response-level transform could inject heartbeats, but introduces another
cancel/close propagation layer and makes the durable-disconnect semantics harder
to audit. A small shared controller helper is more direct.

## Test strategy

### Automated tests

Use a short internal heartbeat interval with controlled routes so the suite does
not wait 15 seconds.

1. `/runs/stream`: hold a route before its first application event and assert a
   `: ping\n\n` frame arrives while the run remains active.
2. `/resume`: hold a resumed route and assert the same idle heartbeat.
3. Both endpoints: assert `cache-control` is exactly
   `no-cache, no-transform` and existing SSE event frames remain parseable.
4. Lifecycle: complete or explicitly cancel a controlled run and prove no
   heartbeat interval survives route teardown. Consumer-side stream
   cancellation remains a disconnect and must not stop the durable run or its
   heartbeat lifecycle prematurely.
5. Run the focused CLI tests, package lint/typecheck/build as appropriate, and
   the repository's broader validation lane if time and local prerequisites
   permit.

### Real-user browser smoke

Run a local Dawn fixture whose AP route intentionally remains silent for longer
than 15 seconds. Use the connected browser to exercise the same HTTP surface a
user-facing client consumes:

1. Create a thread and start `/runs/stream` from a small local smoke page.
2. Observe the response remain open and record at least one heartbeat before the
   first application event.
3. Release the route and confirm normal Dawn events arrive and the stream closes
   cleanly.
4. Exercise a permission/resume-style parked route through
   `/threads/{thread_id}/resume`, observe its heartbeat, then release it and
   confirm completion.
5. Inspect the browser-visible response headers for
   `no-cache, no-transform` on both paths.
6. Confirm no console errors, truncated final event, duplicated application
   event, or request left open after normal completion.

The smoke page and fixture are disposable verification aids, not repository
artifacts. Automated tests remain the regression guard.

## Packaging

Add a patch changeset for `@dawn-ai/cli`. This is a user-visible reliability fix
to the local and built Dawn runtime, with no new public configuration or API.

## Non-goals

- Run-stream reattachment or replay.
- Configurable heartbeat intervals.
- Changing Agent Protocol or AG-UI disconnect policy.
- Cross-replica run routing or cancellation.
- A bounded timeout for route sources that never unwind.
- Heartbeats on non-SSE or AG-UI responses.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Timer leaks after completion | Start and clear the timer in the same stream lifecycle, with cleanup in the outer `finally`; cover teardown in tests. |
| Heartbeat changes client event parsing | Use an SSE comment, which conforming clients ignore; keep application frames unchanged and test parsing. |
| Edge runtime incompatibility | Use web-compatible timers only and avoid Node-specific `unref()`. |
| A proxy timeout shorter than 15 seconds remains possible | Fifteen seconds is a conservative conventional interval; making it configurable is unnecessary surface area for this fix. |
| Browser smoke passes but regression coverage is weak | Treat browser testing as end-to-end evidence and automated controlled-route tests as the durable guard. |
