# Post-publication recovery: feasibility and admission findings

Status on 2026-09-04: local legacy-writer regression implemented; disposable
GitHub experiment prepared but **not run**. Production admission remains
`legacy-fence-required`. This report does not authorize or perform recovery.

Design: [post-publication recovery](../specs/2026-09-04-postpublication-recovery-design.md).
Plan: [implementation tasks](../plans/2026-09-04-postpublication-recovery.md).

A read-only GitHub recheck at 2026-09-05 00:25 UTC found release `382873833`
still a mutable draft with 45 assets, opaque tag
`untagged-a4a022eb7414255884bc`, and the version 1 `NPM_COMPLETE` marker. This
metadata check did not independently reverify production artifact bytes.

## What the local experiment establishes

The tests execute original modules from candidate
`88c01c4afd59866fc0ea4c8f3b8444439a01c8ea`. The fixture contains both original
workflows and their executable imports, extracted from Git and committed as a
compressed archive. Its SHA256 is
`0d248ff546dd1937d25d15ca6ad0849a9b45f7ccc05fa1519998f0c61de2ba66`.
All 59 file contents were checked against `git show` during extraction. At test
runtime, the archive digest and embedded source commit are checked before
extraction; no Git history, dependency installation, or network is required.

Synthetic package bytes, receipts, tag objects, and a marker with incompatible
schema version 2 exercise the affected version 0.8.24. They are **not** downloaded
production evidence or the final version 2 wire format. The attestation
prerequisite is an explicit offline stub that checks all expected subject bytes,
names, bundles, and bindings; this is not cryptographic attestation verification.
The original GitHub reader and writer use a recording HTTP transport. No live
credentials or production entrypoint are used.

| Boundary exercised | Observed outcome | Admission implication |
| --- | --- | --- |
| Frozen `escrowCandidate`, opaque draft, incompatible marker | Attempts `POST /repos/cacheplane/dawnai/releases` with a new legacy ATTACHING draft body; the fixture returns a simulated 422 conflict | Marker replacement cannot prevent duplicate-draft attempts |
| Frozen `uploadAssetIfAbsentAndEqual`, known release ID | Uploads `audit-attempt-501-1.json` through the real writer's upload request | A writer that passed an earlier read can still append assets |
| Frozen `dispatchIndependentAudit` | Sends the real workflow-dispatch POST and accepts its direct run receipt without reading the release | The marker does not prevent legacy audit dispatch |
| npm and smoke reconciliation; audit dispatch/attempt recording and success verification; consolidated publication | Reach the original release lookup or marker parser and reject, for both opaque and exact-tag drafts | No mutation observed at these specific boundaries; not a universal fence |
| Stale version 1 body update | Rejects the stale body digest before PATCH | Demonstrates read-before-write stale-state protection, not server-side atomic CAS |
| Adoption between a version 1 writer's GET and PATCH | Sends an unconditional PATCH and overwrites the newly adopted body in the fixture | Existing jobs must drain before adoption; the stale-body check does not close this race |
| Low-level publication | Rejects the incompatible marker before PATCH | No publication observed in this tested ordering |
| Version 1 controls | Recognize existing escrow, read all 45 base assets, and complete a real recorded npm-reconciliation PATCH | The fixture can reach successful legacy behavior; rejection is not just malformed setup |

The initial zero-mutation escrow assertion was run and failed on the actual
recorded POST. The permanent regression asserts that request and returns
`legacy-fence-required`. A failure before release observation is classified
`inconclusive`; a tested rejection is only `no-mutation-observed`.

Run the local regression from the repository root:

```sh
node --test scripts/release/test/recovery-legacy-fence.test.mjs
```

Result: 24 tests passed. Independent review also ran the final set in a standalone
copy of only the test, helper, and archive without `.git` or `node_modules`, with
native `fetch` replaced by a function that throws. All 24 tests passed there.

## Historical execution paths requiring a fence

The archived `release.yml` uses successful `detect`, `hydrate`, and `tag` outputs
to select later jobs. Updating today's detector does not invalidate outputs
already retained by a historical run. These are source-level eligibility paths;
this local test does not claim that GitHub actually reran them.

- **Escrow:** a run whose retained `next_transition` is `prepare-artifacts`,
  `attest-artifacts`, or `escrow-candidate`, with successful attestation and tag
  continuation, can select the frozen escrow writer. Recovery must account for
  earlier runs, not only the latest run that selected `dispatch-release-audit`.
- **Evidence writers:** npm reconciliation and smoke reconciliation use the
  same historical candidate identity and transition outputs. Smoke reconciliation
  also requires all five lane successes. Audit recording and correlation consume
  their earlier dispatch/result handoffs. The tested lookup/parser rejection
  occurs when adoption is already visible before those reads.
- **In-flight asset append:** escrow, smoke reconciliation, and audit evidence
  recording can retain a release ID after their earlier checks. The low-level
  uploader does not require the current marker to parse as version 1. Drain
  existing jobs as well as preventing new dispatches and historical reruns.
- **Audit dispatch:** frozen `dispatchIndependentAudit` directly calls the workflow
  writer without observing the release. A retained `dispatch-release-audit`
  transition, or eligible prior transition plus successful smoke reconciliation,
  can reach it through `dispatch-audit`.
- **In-flight body update:** a writer that read version 1 before adoption can
  PATCH afterward without an HTTP `If-Match` precondition. The race regression
  records the version 2 body immediately before that overwrite.
- **Publication:** historical `publish-release` can be selected by an eligible
  transition or successful audit correlation. The local test covers its current
  parser rejection; it does not model every read/adopt/PATCH interleaving.

This is not complete permission or concurrency coverage. Actual historical
run/job inventories, token permissions, dispatch and rerun behavior, npm
publication, GitHub service races, and all possible in-flight interleavings
remain outside the local proof. A shared cooperative workflow queue helps
serialize writers but does not revoke an old writer's authority.

## Prepared disposable GitHub experiment

No disposable repository has yet been designated. The plan requires a separately
authorized repository before any external fixture installation or workflow
mutation. Production `cacheplane/dawnai` is rejected by name and repository ID
`1210070282`, including a redirected alias resolving to that ID.

After authorization, provision
`scripts/release/test/fixtures/recovery-contract-workflow.yml` verbatim as
`.github/workflows/recovery-fence-probe.yml` on the disposable default branch.
Use an exclusively controlled disposable repository and keep its default branch
unchanged throughout the experiment. This fixture has no token permissions,
checkout, release writes, npm operations, or external action dependencies. Its
detect job succeeds and emits an eligibility output; its dependent writer step
deliberately exits 1, making historical retry behavior observable.

The harness verifies repository identity, the exact fixture bytes at the captured
SHA, workflow identity/state, and the absence of active fixture runs before
mutation. It rechecks the branch before dispatch and rejects changed run SHAs.
This detects branch races; it does not lock the remote branch against another
operator. The minimal lane refuses inventories larger than 100 runs; fuller
pagination and production topology coverage belong to Task 12.

Future command, after supplying the authorized repository in both variables:

```sh
DAWN_TEST_RECOVERY_GITHUB=1 \
DAWN_RECOVERY_TEST_REPOSITORY=OWNER/DISPOSABLE_REPO \
DAWN_RECOVERY_AUTHORIZED_REPOSITORY=OWNER/DISPOSABLE_REPO \
node --test scripts/release/test/recovery-github.integration.mjs
```

The values record previously granted authorization; setting environment variables
does not grant it. The ordinary release-controller suite does not invoke this
integration file. Direct execution without the opt-in skips it before network or
credential access.

The experiment tests fresh dispatch, whole-run rerun, failed-job-only rerun, and
single-job rerun with the workflow active, disabled, then active again. It checks
that the named writer step executed, so a runner setup failure cannot satisfy the
positive control. A new dispatch is correlated by the API-returned run ID and
unique run title. Denied requests also require unchanged run/attempt inventory;
an error response alone is not evidence of exclusion.

Requests, repository/workflow IDs, run/attempt/job IDs, step evidence, observations,
and restoration results are retained in a mode-0600 temporary evidence file,
updated through same-directory rename to avoid truncating the previous snapshot.
Known runs must complete; unknown or undrained runs make the result inconclusive.
The harness restores only the captured workflow's original active state, including
after an ambiguous disable response. It retains runs and the fixture as evidence;
it deletes no remote resources. If interrupted, inspect the evidence file, restore
that exact fixture workflow if necessary, and drain its runs before interpreting
any result. Do not cancel or delete resources outside the recorded fixture.

Any accepted disabled dispatch/rerun disproves a workflow-disable fence. Denials
without complete before/after positive controls remain inconclusive. A fully
observed disposable result is still only a service-contract observation, not a
production admission certificate: production permissions, every historical writer,
and active-job drainage must separately be verified. The final controller remains
dormant until that evidence exists. If disabling does not prevent unsafe replay,
revise the ownership design before activating recovery.

## Implementation validation

- Node 24.20.0; Corepack pnpm 10.33.0; frozen install passed.
- Baseline build: all 25 tasks passed.
- Initial controller suite: 2,421 passed / 1 failed. The existing registry-harness
  startup failed because its subprocess discovery selected pnpm 11.19.0 from PATH.
  The targeted test passed after prepending a temporary executable link to the
  cached pnpm 10.33.0 CLI. No repository behavior was changed for this adjustment.
- [PR #568](https://github.com/cacheplane/dawnai/pull/568) remained open when checked;
  the known descendant-PID test issue did not cause this baseline failure.
- New offline legacy tests: 24 passed. Experiment authority/report tests: 3 passed.
  The external integration test skipped as expected; it has not been run on GitHub.
- Full `ci:validate` passed lint, build-cache checks, build, and typecheck, then
  stopped at source tests: 5,622 passed, 218 skipped, and one failed in
  `test/k8s-compat/harness.test.ts` ("waits for confirmed detached provider
  descendants before token and cluster cleanup"). The same test passed in an
  isolated rerun. This existing test does not import the new release fixtures;
  its root cause remains unconfirmed. Its PID readiness helper accepts file
  existence before validating contents, a timing hypothesis for a separate
  follow-up. PR #568 changes a different test file and does not fix this test.
- Independent specification and code-quality reviews passed. Review explicitly
  confirmed that this local slice does not establish a production fence.

After investigating the source-test failure, all ten remaining validation steps
were run and passed: release inventory; the full release-controller suite
(2,449 tests); chart-version tests; docs; pack checks; TypeScript tooling pack;
and harness self-test, framework, runtime, and smoke. Scoped Biome and
`git diff --check` also passed. The final external integration test remains
unrun, not passed.

The full `ci:validate` invocation is **not green** because of the source-suite
failure above. This commit preserves the reviewed local feasibility work; it
does not claim that the complete implementation, repository Definition of Done,
live fence experiment, or production recovery is complete.
