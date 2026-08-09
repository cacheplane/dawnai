# Subprocess Shutdown Barrier Design

**Status:** Approved 2026-08-09

## Summary

`createSubprocessApp()` exposes `close()` and async disposal as asynchronous
teardown APIs, but the current implementation resolves immediately after
sending `SIGTERM`. Signal delivery and Dawn's HTTP/process shutdown happen
later, so callers can observe a live server after `await app.close()`.

Make successful closure a completion barrier: the owned CLI process has
closed, its process group has been signalled, its stdio has closed, and its
`baseUrl` no longer serves. Preserve graceful shutdown first, add bounded
`SIGKILL` escalation, and make repeated or concurrent closure share one result.

## Goals

- Make `await app.close()` mean that subprocess teardown completed.
- Give `[Symbol.asyncDispose]()` the same completion guarantee.
- Preserve graceful `SIGTERM` shutdown when Dawn exits promptly.
- Prevent teardown from hanging forever when a subprocess wedges.
- Make repeated and concurrent `close()` calls idempotent.
- Apply the same bounded teardown to readiness-failure cleanup.

## Non-Goals

- Changing Dawn's production `dawn dev` signal handling.
- Adding a public process ID, signal, or timeout API.
- Polling the health endpoint as the primary lifecycle signal.
- Changing how ports are selected or readiness is detected.
- Refactoring unrelated testing harness factories.

## Root Cause

`packages/testing/src/subprocess.ts` marks the app stopped, sends `SIGTERM` to
the detached process group, and returns without awaiting a child lifecycle
event. `process.kill()` requests signal delivery; it does not wait for the
target to handle the signal or exit.

The outer Dawn CLI handles `SIGTERM` by asynchronously closing its dev session.
That session in turn stops its dev child and drains the HTTP runtime. The
testing helper therefore reports completion before the asynchronous work it
initiated has completed.

The existing disposal test is timing-sensitive. Repeated execution reproduced
the failure: `/healthz` still returned `200 OK` after disposal. Timing probes
showed `close()` resolving in less than 0.11 ms while connection rejection
followed roughly 0.7–3.5 ms later.

## Lifecycle Contract

`SubprocessApp.close()` returns a single memoized promise. Every call, including
async disposal, receives that promise.

Successful resolution guarantees:

1. The detached process group received graceful termination or forced
   termination after the grace deadline.
2. The spawned CLI child's `close` event fired, which occurs after exit and
   stdio closure.
3. A bounded TCP probe confirms that the `baseUrl` port no longer accepts
   connections, covering a descendant that might briefly outlive the outer CLI.

If the process has already closed, `close()` resolves without sending another
signal. If bounded graceful and forced termination both fail to produce a
`close` event, `close()` rejects with the process identifier and termination
context instead of falsely reporting success.

## Termination Algorithm

Create the child-closure promise immediately after spawning the CLI, before any
signal can be sent or exit can be missed.

The shared termination helper:

1. Returns the existing closure result when the child is already closed.
2. Sends `SIGTERM` to the negative PID so the detached process group is
   targeted; if group signalling is unavailable, falls back to `child.kill()`.
3. Waits up to a 2,000 ms internal grace deadline for both the child `close`
   event and the `baseUrl` port to stop accepting TCP connections.
4. On expiry, sends `SIGKILL` to the same target.
5. Waits up to a final 2,000 ms for both observations and rejects if the child
   still cannot be reaped or the port still accepts connections.

The TCP observation uses `node:net`, a 100 ms connection-attempt timeout, and a
25 ms polling interval. A connection timeout is treated as still potentially
available; only connection refusal or another socket error establishes
unavailability. The termination deadlines and probe timings are internal
defaults, not public API. The internal termination helper accepts shorter
deadlines for deterministic unit tests.

The helper is also used when readiness fails so a failed constructor does not
leave the same process tree running in the background.

## Error Handling

- A signal race with an already-exited process is treated as successful once
  the closure promise resolves.
- Group-signal failure falls back to signalling the direct child.
- A wedged process escalates from `SIGTERM` to `SIGKILL`.
- Failure to observe closure after forced termination rejects rather than
  hanging indefinitely.
- Readiness errors are rethrown after bounded cleanup; a teardown failure is
  surfaced when cleanup itself cannot complete.

## Testing

Use the real `createSubprocessApp()` path and make the existing race
deterministic by temporarily delaying the real negative-PID `SIGTERM` call.

The regression test will:

1. Start a healthy subprocess.
2. Delay actual group signal delivery for about 100 ms.
3. Call `close()` twice before termination completes.
4. Race closure against a shorter timer and prove the timer wins. The current
   implementation fails because both closure promises resolve immediately.
5. Await both calls and prove `/healthz` is unreachable.

Focused internal-helper tests will use disposable real child processes and
short test deadlines to verify the other new branches:

- a child that ignores `SIGTERM` receives `SIGKILL` and is reaped;
- a scoped signal stub that leaves a child alive causes the final deadline to
  reject, after which the test forcibly cleans up the child;
- a negative-PID signal failure falls back to `child.kill()`;
- a constructor with an immediate readiness timeout does not reject until its
  delayed termination finishes, proving readiness-failure cleanup is awaited.

The focused test must be observed failing before production code changes and
passing afterward. Package build, typecheck, lint, and tests plus the repository
Definition of Done complete verification.

## Files

- Modify `packages/testing/src/subprocess.ts` for the memoized completion
  barrier and bounded process-tree termination helper.
- Modify `packages/testing/test/subprocess.test.ts` for deterministic closure,
  concurrency, and reachability assertions.
- Add a patch changeset for `@dawn-ai/testing`.

## Release

This is a patch fix to the documented testing lifecycle. The release note will
state that subprocess closure and async disposal now wait for actual process
termination instead of returning after signal dispatch.
