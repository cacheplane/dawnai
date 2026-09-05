# Early release integrity validation

## Problem and outcome

PR #574 first detected a stale release-script pin after 784,798 ms of controller tests in CI. The corrected focused workflow and recovery-policy tests ran locally in seconds. These are different hosts, so this is evidence for earlier failure detection, not a speedup benchmark.

Add `test:release-integrity` running a focused release content-pin suite and the existing recovery-policy suite. Run it after installation, before lint/build/source tests in the required CI validate job and first in local `ci:validate`. Keep the complete controller command and all existing gates unchanged. No release workflows, credentials, policy admission or publication behavior change.

## Alternatives

1. **Early checks within validate (selected):** minimal coordination, same required status, modest duplicate work on success.
2. Separate required preflight job: adds branch protection and job dependency coordination for little benefit here.
3. Split or narrow the controller suite: potentially greater savings, but needs measured dependencies and coverage analysis first.

## Implementation and verification

Use source-only tests; dependencies must be installed but built package output is unnecessary. Add workflow contracts asserting an unconditional preflight before expensive work, the exact selected suites, and retention of the full controller command in both entrypoints. The focused suite verifies its own wiring. Comprehensive workflow reachability, mutation isolation, and descriptor checks remain in the full controller suite; the early pin check does not replace them. Update the two exact workflow entrypoint/executable allowlists for the additional CI step, including subsequent validate step indexes, without changing other classifications.

Run these assertions red before editing commands. Run the resulting preflight green. In an owned temporary checkout of tracked files with installed dependencies, corrupt one pinned source file and verify the real command exits nonzero with a content-pin error. Never mutate production or the working source for this experiment. Verify the fixture has no package dist outputs.

Run the full controller suite and repository CI gates. Record preflight timing separately from total CI timing. Update contributor instructions to document the additive preflight. Existing authority admission blockers remain outside this PR.

## Integration finding

Explicitly running workflow-contracts.test.mjs trips the existing static isolation scanner on its negative fixture strings; the existing full-suite wildcard did not expose that conflict. Keep the scanner unchanged. The bounded preflight checks recorded pin bytes and recovery-policy closure, while the full suite retains comprehensive workflow checks. Do not add scanner exceptions or artificial glob syntax.
