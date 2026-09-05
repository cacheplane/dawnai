# Post-publication recovery: feasibility and admission findings

Status on 2026-09-04: local legacy-writer regression and dormant version 2
schemas, planner, and invocation authority implemented; disposable GitHub
experiment prepared but **not run**.
Production admission remains
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

## Dormant version 2 protocol

Task 2 adds wire schemas and a pure planner under `scripts/release/recovery/`.
These modules are not connected to the release workflow, CLI, or GitHub writer.
The planner consumes independently verified facts and returns declarative effects;
it does not establish invocation authority, verify signatures, or perform effects.
Those responsibilities remain in later implementation tasks.

Candidate identity and executing controller identity are separate. Selected lane
receipts must describe all five lanes from one run and attempt, while the audit
must come from its independently correlated run at the original dispatch's
expected controller revision. A compatible newer controller can resume that
evidence without rewriting its historical executor identity.

The writable marker ends at `PUBLICATION_READY`. `COMPLETE` is derived from the
persisted finalization asset and external immutable publication proof. Valid
completion survives a removed or corrupted editable marker; title/body changes
are reported separately as display drift. The presence of a finalization asset
freezes further evidence uploads and audit dispatch, including when a marker
update was interrupted. Invalid finalization blocks recovery rather than
reopening an earlier write path.

Missing first-run work must have an explicit next operation without claiming
that evidence already exists. Missing or failed evidence within a submitted
selection cannot advance the phase. Historical smoke adjudication cannot replace
a failed required lane.

Wire formats preserve the original `manifest.json`, `release-record.json`,
tarballs, and `.intoto.jsonl` bundle identities. New ordinary JSON receipts are
bounded at 256 KiB, selections/finalization at 1 MiB, and retained recovery assets
at 2,048 assets and 64 MiB. Dependency-resolution details have a separate bounded
budget. These proposed budgets still require calibration against actual release
inventories and installed dependency trees before activation; exceeding a budget
must fail rather than truncate successful evidence.

The schema exports `parseRecovery`, `canonicalRecoveryBytes`, `recoveryDigest`,
the phase/lane/limit constants, and the bounded `snapshotRecoveryData` helper.
`planRecovery` returns a frozen plan. Its `planned.after` is prospective when
persisted prerequisites support a marker change; it does not mean that a write
succeeded. The eventual run-result must report re-observed durable phases and
completed effects. Reports can represent an unknown starting marker and a
proof-backed readiness repair, but cannot reopen `COMPLETE`.

The facts graph permits 16 MiB because it repeats individually bounded receipts
and inventories; depth remains capped at 24 and nodes at 100,000. A synthetic
1,400-retained-receipt graph larger than 1 MiB exercises this distinction.
Dependency resolutions currently permit 512 entries and 64 KiB. These are
implementation bounds, not measurements of a real published smoke installation.

Proposed finalization contains canonical payload data without a remote asset ID.
Only persisted finalization proof requires the observed asset ID, digest, size,
and inventory. Current write eligibility and monotonic marker revision checks
still apply when reusing an unpublished finalization asset. An immutable completed
release retains its historical evidence independently of current write eligibility.

Task 2 verification records the following:

- Specification and code-quality reviews passed after correcting first-upload
  finalization planning, historical adoption takeover, distinct lane job identity,
  marker revision monotonicity, current verifier eligibility, and report consistency.
- The final focused schema/model suite has 118 passing tests. Parser regressions
  cover proxy inputs without executing their traps, ordinary accessors, malformed
  Unicode and canonical encodings, nested fields, identities, and byte budgets.
- An independent generated audit rejected all 870 nested unknown-field and
  missing-field mutations across the ten wire kinds and all five lane fixtures.
- In an isolated copy, removing the fresh annotated-tag prerequisite made the
  corresponding `AUDIT_VERIFIED` regression fail (`planned` instead of `blocked`).
  Restoring the source made it pass; repository source was never weakened.
- A full controller run before the final review changes passed 2,560 tests.
  A subsequent run passed 2,562 and failed one existing descendant-tree test in
  `scripts/published-artifacts.test.mjs`, with `processExists(NaN)` masking the
  earlier failure. That test passed alone. Read-only inspection confirmed that
  open [PR #568](https://github.com/cacheplane/dawnai/pull/568), head
  `96c50ba9633a50a0903f87946712fe201e3eff71`, describes this exact failure and
  changes only that existing test file. No fix from that PR was applied here.
  This is distinct from the earlier `test/k8s-compat/harness.test.ts` source-suite
  failure described below.
- The final reviewed files passed the full controller suite: 2,567 tests,
  zero failures, in approximately 159 seconds. This passing rerun does not erase
  the intermittent failure above. Scoped Biome, release inventory, docs checks,
  and `git diff --check` passed. Package build/typecheck/source/pack/harness gates
  were not repeated for these dormant repository-script changes; their earlier
  results and the unresolved source-suite failure remain recorded below.

## Policy and invocation authority

Task 3 keeps policy status `DORMANT`, its approved fence-contract list empty,
and `scripts/release/recovery-adoptions/` without an adoption record. Neither
a candidate version nor a caller-supplied controller SHA enables recovery.

The policy pins the current five probes and their transitive local source
dependencies: 23 files, 353,163 bytes at the Task 2 commit. An independent
TypeScript AST traversal found no unresolved imports or repository data-directory
loads from those entrypoints. Generated probe programs are embedded in these
source files; installed npm packages are separately verified subjects. Future
version 2 wrappers must join this inventory before activation. The source digest
excludes `policy.json`; policy identity hashes its canonical sorted JSON token
stream, allowing presentation whitespace while rejecting duplicate keys and
noncanonical encodings. Adoption intent retains its strict canonical wire format.
Repository-wide
workflow/import pins remain a separate integration requirement.

Required CI evidence includes `validate`, `pack-smoke`, and `harness-verify`,
correlated to one successful main-push CI run at the actual invocation SHA.
Checking only `validate` would miss the pack/harness jobs that now run separately.
A read-only API check of main `92cae0a3771473dd040c80520de177bcee0c7765`
found successful CI run `33924658340`, suite `91941573529`, and matching job/check
IDs for all three obligations. This is an adapter-contract observation, not CI
approval of this unmerged recovery implementation.

The actual invocation context is supplied by a trusted runtime reader, separate
from CLI inputs. GitHub run/workflow/job records independently bind its repository,
SHA, run, attempt, and job; git ancestry establishes main membership. Policy and
adoption intent are read at that immutable SHA. The existing GitHub reader returns
normalized job fields such as `runAttempt`, and its workflow arguments are file
names, so authority tests also exercise the real adapter with a recording HTTP
transport. The run API's nested repository object need not contain `default_branch`;
the trusted invocation reader must obtain that value from GitHub's invocation
context and require the main ref.

Only the recovery owner workflow can acquire writer eligibility; the audit
workflow cannot. Initial adoption adds the exact immutable git intent to current
eligibility.
Later eligibility is checked independently of historical adoption authority,
preserving the recorded executor on already accepted receipts. Every future
writer must recapture current eligibility and fresh fence evidence immediately
before mutation. A workflow-disable claim alone is insufficient; the fence
contract must have been reviewed and its writer coverage and drainage observed.
The production fence observer and service rehearsal are still pending.

Version 2 lane integration must emit explicit successful cleanup and registry
obligations. The metadata probe currently records some audit/cleanup checks only
on failure, and storage uses three separate cleanup checks. The new policy
requires the aggregate `cleanup` result as well as the concrete underlying
obligations; metadata also requires `registry-packages` and manifest-derived
package coverage. Task 7 must derive those results from actual probe evidence.

Retry policy bounds reads at 15 seconds, with at most five retries and 90 seconds
per operation inside a 20-minute phase budget. Recognized throttling (including
GitHub's normalized 403 `RATE_LIMITED`), settled transient errors, and the existing
exact-metadata-present/tarball-404 propagation class are retryable.
Missing packages, identity conflicts, invalid signatures, and schema failures
cannot become propagation retries. The current transport's `TIMEOUT` envelope
can precede actual request settlement, so recovery treats it as terminal for the
invocation and requires a later resume. The shared GitHub reader preserves
transport failures before HTTP status classification: a 503 response whose body
times out must remain `TIMEOUT`, rather than becoming retryable `SERVER_ERROR`.
This existing-adapter correction is included with its content-hash update.
Malformed or wrong-content-type error bodies now surface their transport error;
completed, valid 404 responses still remain ambiguous. Neither proves absence.
An unsettled timed-out read stops without
starting an overlapping retry or admitting its late result. A stalled backoff
wait is also bounded by the deadline. Optional Retry-After
hints are bounded; the existing shared HTTP/registry adapters do not yet preserve
that header, so future transport integration must project it explicitly.

Task 3 verification records the following:

- Specification and code-quality reviews passed after correcting audit-workflow
  writer admission, stalled backoff deadlines, recognized GitHub rate limits,
  and timeout provenance through the actual HTTP/GitHub adapters.
- All 64 affected adapter/policy/authority tests pass, including 32 new recovery
  tests. Real-adapter regressions cover a fetch that ignores cancellation and
  stalled response bodies behind HTTP 503, 429, and 403. Each stops with one
  underlying read; no retry starts while that read remains unsettled.
- In an isolated source copy, removing expected-controller-SHA equality made the
  authority rejection regression fail. Restoring the check made it pass.
  Repository source was never weakened during this experiment.
- A controller run before the final transport changes passed 2,595 tests in
  approximately 187 seconds. This is an intermediate result, not validation of
  the final transport correction. A subsequent run passed 2,600 and failed the
  aggregate hash pin in `workflow-contracts.test.mjs`; the source hash had been
  updated, but the second pin over that fixture still needed recomputation.
  After that correction, all 137 workflow-contract tests passed. The final full
  controller suite passed all 2,601 tests, zero failures, in approximately
  157 seconds. Both review stages approved the final files.
- Scoped Biome, release inventory, and `git diff --check` pass. No package source,
  workflow, writer, or adoption record changed. The shared GitHub reader change
  and its content-hash update are covered by the affected adapter tests and
  controller suite. Earlier package build/typecheck/source/pack/harness results
  and the unresolved source-suite failure remain recorded below.

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
