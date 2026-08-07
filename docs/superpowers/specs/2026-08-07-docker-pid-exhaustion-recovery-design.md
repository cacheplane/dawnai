# Docker PID Exhaustion Recovery Design

**Date:** 2026-08-07
**Status:** Approved for implementation

## Problem

The Docker sandbox correctly applies a per-container PID limit, but a process
storm can consume every available PID. The host remains protected, yet a
follow-up `docker exec` may fail before the requested command starts because
the OCI runtime cannot create its init process. The current adversarial test
assumes an immediate follow-up exec always succeeds, so it races the bounded
child processes and intermittently fails in CI.

Observed Docker failures contain an OCI exec-start error together with either
`Resource temporarily unavailable` or `read init-p: connection reset by peer`.
Ordinary commands can also fail or print `Cannot fork`; those command-level
failures must not trigger container replacement.

## Goals

- Keep the PID controller as the containment boundary that protects the host.
- Recover a thread sandbox when PID exhaustion prevents OCI from starting a
  new exec process.
- Preserve the thread's named workspace volume across recovery.
- Retry the original command at most once after successful recovery.
- Make the real-Docker containment test deterministic and condition-based.

## Non-goals

- Retrying arbitrary command failures or timeouts.
- Preserving background processes after the container is unrecoverably wedged.
- Changing the public `SandboxProvider` or policy types.
- Adding general-purpose container health management or retry configuration.
- Changing Kubernetes sandbox behavior.

## Considered approaches

### 1. Narrow exec-start recovery with a provider lifecycle callback (selected)

`dockerExec` classifies only known OCI exec-start PID-exhaustion results. When
matched, it invokes a recovery callback supplied by `dockerSandbox`, then runs
the exact same Docker exec once more. The callback force-removes the keeper
container and recreates it with the same policy and named volume.

This keeps classification beside Docker exec output and lifecycle ownership in
the provider. It is small, testable, and does not alter public interfaces.

### 2. Provider-wide generic operation retry

Wrapping filesystem and exec operations at the provider level would centralize
recovery, but it would duplicate backend behavior and make it easier to recycle
on ordinary command failures. It also expands scope beyond the observed bug.

### 3. Stabilize only the integration test

Polling until short-lived children exit removes the CI race, but leaves a real
thread sandbox unable to execute further tools after a sustained process storm.
It addresses the symptom without addressing runtime availability.

## Architecture

### PID-exhaustion classifier

`docker-exec.ts` owns a private predicate over the combined stdout and stderr of
the Docker exec result. A result is recoverable only when all are true:

1. the exec result is non-zero;
2. the text contains the exact case-sensitive marker
   `OCI runtime exec failed`; and
3. the text contains a PID/resource signature observed under a saturated PID
   cgroup: `Resource temporarily unavailable` or
   `read init-p: connection reset by peer`; and
4. the per-attempt wrapper did not emit its unguessable startup marker.

The classifier deliberately rejects a command-level `Cannot fork`, a generic
OCI error, all successful results, and command-controlled output that merely
copies Docker's diagnostics. `dockerExec` emits a random marker as the first
wrapper operation and strips it from returned stdout. Its presence proves the
shell started, so a non-idempotent command is never repeated based only on text
that the command itself can produce.

### One-shot retry

`dockerExec` accepts an internal paired recovery contract. Before the first
Docker exec it captures an opaque lifecycle token. On a matching result it
passes that token and the exact Docker-exec retry closure to the provider.
The provider invokes that closure only while holding the thread's lifecycle
fence. A stale token returns no retry result, so `dockerExec` returns the
original failure without executing an old command inside a newer lifecycle.
Otherwise the recovery result becomes the final result. There is exactly one
retry closure and no loop. Timeout annotation applies to the final result, and
configured timeout results never trigger recovery even if their output contains
the classifier markers.

### Per-thread lifecycle coordinator

The Docker provider owns a keyed fair shared/exclusive coordinator. Normal exec
and filesystem operations take shared leases, so admitted work for one thread
remains concurrent. `acquire`, PID-exhaustion recycle, `release`, and `destroy`
take exclusive leases and run to completion. An exclusive waiter starts only
after admitted shared work drains, and its queue position blocks later shared
work from entering the keeper. Operations for different threads remain
independent.

The coordinator is the long-term lifecycle boundary rather than a recovery-only
lock. It prevents an acquire from observing or returning a keeper while an older
release/destroy is still removing the prior container or volume. It also makes
same-generation recovery coalescing structural: the first queued recovery
replaces the keeper and advances its generation; later queued recoveries see the
advanced generation and run their own retry against that replacement without
another remove/create. Each recovery keeps the fence through its retry, so a
queued release/destroy/acquire cannot replace the deterministic keeper name
between recovery and the command retry. This same fence prevents recycle from
force-removing a keeper under an admitted command or filesystem operation. The
recovery retry runs directly under the exclusive lease rather than attempting a
nested shared lease.

Exclusive operations are FIFO by invocation order. Consecutive shared waiters
ahead of the next exclusive operation are admitted together. The keyed queue
removes its entry when the last operation finishes, and a rejected operation
does not poison later work for that thread.

### Volume-preserving recycle

`dockerSandbox.acquire` creates or reuses lifecycle state while holding the
thread coordinator and supplies an opaque token containing that state identity
and its keeper generation. Recovery holds the same coordinator and:

1. runs `docker rm -f <keeper>` and requires a successful result;
2. creates a fresh keeper with the lifecycle-owned launch configuration;
3. reuses `dawn-sbx-vol-<thread>` because only the container is removed; and
4. skips the ownership initializer because the named volume already exists;
5. advances the keeper generation only after recreation succeeds; and
6. invokes the calling command's exact retry closure before releasing the
   lifecycle fence.

Once removal starts, recycle is shared provider lifecycle work and uses a
provider-owned non-aborted signal. A canceled caller may stop waiting or fail
its retry, but cannot strand every handle after removal and before recreation.
`release` and `destroy` queue behind an active recycle and then perform their
full cleanup before any new acquire for that thread can begin.

If container removal or recreation fails, the command rejects with a clear
`Sandbox unavailable` error rather than retrying against uncertain state. The
provider retires and removes that lifecycle state before the coordinator admits
later work. A subsequent acquire creates a fresh state identity and forcibly
replaces any same-name leftover keeper before returning, so failed cleanup
cannot silently reactivate the exhausted container. Tokens from the failed
lifecycle remain stale.

The provider stores one lifecycle state per successfully acquired live thread.
`release` and `destroy` remove that state while holding the coordinator before
container/volume cleanup. Failed recovery also removes it. A repeated acquire
within the same live lifecycle reuses it. Thus state retention matches keeper
lifetime, while idle queue entries are removed independently after their FIFO
drains.

Lifecycle state owns an immutable resolved keeper launch configuration from the
first successful acquire: effective network mode, environment, CPU/memory
limits, hardening flags, and resolved UID/GID. Recovery always recreates from
that state, never from the policy captured by whichever handle reports
exhaustion. A repeated acquire whose effective keeper configuration differs is
rejected with `DAWN_E2001` and must release the lifecycle before changing it.
Semantically equivalent configurations reuse the state. Per-command
`resources.timeoutMs` remains handle-local because it does not configure the
keeper container.

Every keeper carries a SHA-256 identity label derived from the provider image
and canonical resolved launch configuration. Name matching alone never grants
trust. A keeper is reused or restarted only when this provider still owns an
in-memory lifecycle state and Docker inspection returns the exact persisted
identity. A missing or mismatched identity forces replacement. A new provider
instance also replaces any existing keeper rather than adopting unknown
process state; the named volume remains the only durable thread resource.

Both non-zero Docker lifecycle results and spawn-level exceptions are surfaced
as contextual `DAWN_E2001` sandbox-unavailable errors. Wrapped spawn errors
retain their original cause.
Container replacement intentionally terminates background processes. This is
acceptable only because the narrowly matched state already prevents the
sandbox from servicing a new command.

## Testing

### Unit tests

- `dockerExec` recovers and retries once for each observed OCI PID-exhaustion
  signature, regardless of whether Docker reports it in stdout or stderr.
- It returns the second result and never attempts a third exec.
- It does not recover for command-level fork failures, generic OCI failures,
  successes, timeouts, or a started command that prints spoofed OCI diagnostics.
- Provider recovery removes the keeper, recreates it with the original policy,
  preserves the named volume, skips chown-init for the existing volume, and
  returns the retried command result.
- Failed container removal surfaces as sandbox unavailable and prevents a retry.
- Concurrent failures for one keeper cause one replacement; each safe waiter
  retries only after recreation completes and while holding the lifecycle fence.
- Recovery waits for already-admitted exec/filesystem work to settle and blocks
  later work from entering until replacement and retry complete, so recycling
  cannot kill a successful peer command or race a new Docker exec start.
- A delayed failure from a released/destroyed lifecycle neither removes the new
  keeper nor retries the old command in it.
- Concurrent reacquire waits for release/destroy cleanup, then creates a fresh
  lifecycle; cleanup cannot tear down the returned handle or its volume.
- Caller cancellation during recovery does not interrupt shared recreation; the
  canceled command fails through its own signal while another waiter recovers.
- Removal or recreation failure retires lifecycle identity before a later
  acquire; the later acquire replaces any leftover keeper, and stale tokens
  cannot remove or execute against the new lifecycle.
- Reacquire with a different effective keeper policy is rejected; recovery from
  any valid handle retains the lifecycle's original launch flags and UID/GID.
- Reuse inside one provider requires the persisted image/config identity; a
  provider restart or identity mismatch replaces the keeper while preserving
  the volume.
- Different thread IDs retain independent lifecycle concurrency.

### Real-Docker test

The adversarial test uses a small explicit PID limit and a bounded process storm.
It asserts that the storm fails under the limit, then polls a real `echo alive`
condition until the sandbox can execute again. Polling has a deadline and no
fixed assumption about the instant the short-lived children release their PID
slots. This proves containment and eventual recovery without racing Docker.

The runtime recovery path is separately exercised against real Docker by
holding the PID cgroup at its limit, issuing a concurrent command wave through
the acquired handle, and asserting that every command succeeds after recycle
while a workspace sentinel remains present.

### Verification

- Repeated focused unit runs.
- Repeated real-Docker adversarial/recovery runs.
- Full sandbox package tests and repository `pnpm ci:validate`.
- The dedicated `sandbox-docker` CI lane must be green before merge.
- The release workflow installs the published `@dawn-ai/sandbox` artifact and
  repeats the real Docker PID-exhaustion recovery probe against that installed
  package.

## Release

This is a patch behavior change in `@dawn-ai/sandbox` and receives a changeset.
No new package or public compatibility surface is introduced.
