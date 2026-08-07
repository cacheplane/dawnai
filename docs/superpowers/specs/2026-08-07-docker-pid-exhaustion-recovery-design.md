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
   `read init-p: connection reset by peer`.

The classifier deliberately rejects a command-level `Cannot fork`, a generic
OCI error, and all successful results.

### One-shot retry

`dockerExec` accepts an internal optional `recoverFromPidExhaustion(signal)`
callback. It executes the requested command once. On a matching result, it
passes the active `runCommand` context signal to the callback, awaits recovery,
and repeats the same Docker exec exactly once. The second result is returned
unchanged, including another PID-exhaustion error; there is no loop. Timeout
annotation continues to apply to the final result.

### Volume-preserving recycle

`dockerSandbox.acquire` supplies a callback closed over the thread ID and
policy. The callback uses the active command signal passed by `dockerExec`, not
the earlier acquire signal. Recovery:

1. runs `docker rm -f <keeper>` and requires a successful result;
2. calls the existing create-or-reattach path with the same thread and policy;
3. reuses `dawn-sbx-vol-<thread>` because only the container is removed; and
4. skips the ownership initializer because the named volume already exists.

If container removal or recreation fails, the command rejects with a clear
`Sandbox unavailable` error rather than retrying against uncertain state.
Container replacement intentionally terminates background processes. This is
acceptable only because the narrowly matched state already prevents the
sandbox from servicing a new command.

## Testing

### Unit tests

- `dockerExec` recovers and retries once for each observed OCI PID-exhaustion
  signature, regardless of whether Docker reports it in stdout or stderr.
- It returns the second result and never attempts a third exec.
- It does not recover for command-level fork failures, generic OCI failures,
  successes, or timeouts.
- Provider recovery removes the keeper, recreates it with the original policy,
  preserves the named volume, skips chown-init for the existing volume, and
  returns the retried command result.
- Failed container removal surfaces as sandbox unavailable and prevents a retry.

### Real-Docker test

The adversarial test uses a small explicit PID limit and a bounded process storm.
It asserts that the storm fails under the limit, then polls a real `echo alive`
condition until the sandbox can execute again. Polling has a deadline and no
fixed assumption about the instant the short-lived children release their PID
slots. This proves containment and eventual recovery without racing Docker.

The runtime recovery path is separately exercised against real Docker by
holding the PID cgroup at its limit, issuing a command through the acquired
handle, and asserting that the command succeeds after recycle while a workspace
sentinel remains present.

### Verification

- Repeated focused unit runs.
- Repeated real-Docker adversarial/recovery runs.
- Full sandbox package tests and repository `pnpm ci:validate`.
- The dedicated `sandbox-docker` CI lane must be green before merge.

## Release

This is a patch behavior change in `@dawn-ai/sandbox` and receives a changeset.
No new package or public compatibility surface is introduced.
