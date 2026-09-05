# Parallel release and source validation

## Problem and intended behavior

Main CI run 33989054403 serialized build/source validation before the complete release controller suite. The 64 interruption cases alone took about 606 seconds. Keep those cases and every existing validation gate, but run independent work concurrently.

Rename the current implementation job to `source-validate`, preserving install, early pin/policy checks, lint, build-cache checks, build, typecheck, source tests, inventory and docs. Move only the complete `pnpm test:release-controller` command to a new `release-controller` job with its own pinned Node/pnpm setup, frozen install and early preflight. Run it from a fresh unbuilt checkout. If that reveals a real build dependency, resolve or explicitly include that dependency before merging; never skip the test.

Keep `validate` as the required public check name. It becomes an unconditional aggregate job with `needs: [source-validate, release-controller, pack-smoke, harness-verify]` and `if: always()`. A shell check succeeds only when every dependency result is exactly `success`; failures, cancellations, skips, empty and unknown values fail. Jobs have the same workflow run and checked-out commit. No path exclusions, branch protection changes, new release credentials, or publication changes.

## Alternatives

1. **Concurrent lanes with required aggregate (selected):** preserves commands and required status while overlapping independent computation. Adds one dependency installation and a small aggregate runner job; measure wall time and summed job time separately.
2. Larger runner: may help CPU-bound work but changes spend and does not remove unnecessary sequencing.
3. Reduce or shard fault cases: requires a separate coverage/budget design. No coverage reduction here.

## Verification and scope

Update the preflight wiring test to inspect source validation. Add assertions for the controller lane's complete command, source-only ordering, unconditional aggregate, exact dependencies and dependency-result environment bindings. Execute the aggregate shell in tests with success and each non-success result in each position. Keep tests in the early suite so invalid gates fail early.

Update exact workflow entrypoint and executable fixtures for renamed/new jobs. Keep the comprehensive controller workflow checks unchanged. Update AGENTS.md/CONTRIBUTORS.md to describe CI concurrency and the local sequential validation command. Run focused tests and all CI lanes; specifically require a green full controller job without any build step. Record elapsed and runner durations without presenting one run as a robust performance benchmark.

## Kubernetes report lifetime correction

The corrected CI graph passed every core lane, but Kubernetes compatibility failed
with a reserved report identity. Report accounting stores device/inode identities
while unlinking and closing each accepted report. A filesystem may reuse that freed
inode for the next phase, incorrectly rejecting a fresh report. The job artifact
has no inode numbers, so the observed instance is consistent with this defect rather
than a forensic proof of reuse.

Keep each accepted report's open descriptor until accounting-session disposal.
There are exactly two provider phases, bounding retained descriptors to two. Reports
remain unlinked immediately after validation; hard-link aliases remain rejected by
the existing identity set even when their content or timestamps change. Failed
records close immediately and release reservations for retries.

Add awaited, idempotent session disposal that seals the session, drains in-flight
records and closes retained descriptors. Harness cleanup runs it on success and
failure, preserving both the original error and any disposal error. Finish remains
the synchronous completeness check. Tests observe real descriptors through a test
spy, avoiding a probabilistic inode-allocation test or a production filesystem seam.

A rejected concurrent hard-link contender must release only reservations it acquired.
The regression pauses the first report read, rejects an alias, then retries the alias
before allowing the first read to finish. Both alias attempts must reject. Explicit
ownership flags preserve the first operation's canonical-path and inode reservations.
