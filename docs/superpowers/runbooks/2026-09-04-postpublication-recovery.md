# Post-publication recovery: feasibility and admission findings

Status on 2026-09-05: dormant version 2 observation, guarded adoption, five-lane
evidence collection, independent audit, finalization/publication orchestration,
production read adapters, CLI, and workflow composition are implemented and
reviewed in implementation slices. The YAML fence, operator publication, and
13-job topology experiments have now run against the authorized disposable
repository. Actual workflow-token publication, platform workflow coverage, and
complete live quota evidence remain outstanding. See the current
[service results and admission sequence](./2026-09-05-release-recovery-service-results.md);
later checkpoints below retain their historical scope. Production admission remains
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

## Disposable GitHub experiment

The extended experiment passed on 2026-09-05 in the authorized repository
`blove/dawn-release-recovery-test-20260905-baf081db` (ID `1358322370`). It was
archived after evidence retention. The user owns manual deletion; do not resume
experiments there. The following instructions describe a future separately
authorized run, not a request to alter that archived repository. Production `cacheplane/dawnai` is rejected by name and repository ID
`1210070282`, including a redirected alias resolving to that ID.

After authorization of a new run, provision
`scripts/release/test/fixtures/recovery-contract-workflow.yml` verbatim as
`.github/workflows/recovery-fence-probe.yml` on the disposable default branch.
Use an exclusively controlled disposable repository. The extended probe advances
the historical fixture to the current revision and creates both fixture tags;
no other operator may move the default branch during the run. This fixture has no token permissions,
checkout, release writes, npm operations, or external action dependencies. Its
detect job succeeds and emits an eligibility output; its dependent writer step
deliberately exits 1, making historical retry behavior observable.

The harness verifies repository identity, the exact fixture bytes at the captured
SHA, workflow identity/state, and the absence of active fixture runs before
mutation. It rechecks the branch before dispatch and rejects changed run SHAs.
This detects branch races; it does not lock the remote branch against another
operator. The extended lane records complete paginated inventories for all three
source contexts and retains the pre-advance historical seed lineage. Bounded
collection failures are inconclusive, never evidence of drainage.

Command for a future separately authorized repository, supplied in both variables:

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
The production fence observer is implemented and independently reviewed in
Task 10a. It accepts only a digest-bound reviewed contract and validated service
witness, then recaptures the complete workflow mapping, revocation, and all-SHA
drainage within one original deadline. Both contract/evidence directories remain
empty. Runtime wiring is implemented; YAML service proof is recorded in the
current results report, while production topology admission remains pending. Canonical
witness validation covers direct run/attempt/job identities and an ordered
execution consistent with the precision of the original GitHub timestamps.

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

## Observation and ownership routing

Task 4 separates recovery facts from the version 1 observation schema. Its
ownership decision must precede legacy marker parsing for scheduled, push, and
exact manual candidate selection. An incomplete reservation or adoption blocks
newer publication; independently verified terminal evidence can release that
block. Exact manual selection must not select a completed candidate again when
global arbitration has no incomplete candidate. Durable recovery identities must
also seed discovery independently of current tags and intent files, so a missing
tag blocks an adopted release instead of making it disappear from arbitration.

The observer uses canonical Release ID, annotated tag identity, and the fixed
`recovery-v2-finalization.json` asset to discover published recovery. Editable
title/body metadata cannot restore legacy ownership. Removing the current git
adoption record also cannot undo adoption: historical authority is checked at
the immutable reviewed source revision recorded by its receipt.

The new `recovery/metadata.mjs` helper owns the version 2 display envelope and
canonical reconstruction. It uses the existing marker comment delimiters with
version 2 canonical JSON. Notes cannot contain competing marker delimiters.
The later finalizer must reuse this helper so observation and publication agree
on the expected title/body without independently maintained renderers.

Legacy audit coordination must report recovery as explicitly unsupported until
the dedicated version 2 auditor is integrated. Scheduled, default-branch manual,
and exact-tag audit invocations must not relay recovery to the frozen candidate
executor. This routing rule does not revoke mutation authority from existing or
directly invoked legacy writers; the separately verified fence remains required.

Read-only asset metadata for release `382873833` showed that the inspector
tarball is 12,107,594 bytes. Its base64 transport representation exceeds the
ordinary one-megabyte JSON result limit. Binary reads therefore need a separate,
explicitly bounded transport allowance while receipt limits remain unchanged;
a real-size synthetic regression covers this boundary without downloading or
executing that production package.

Historical executor admission must independently establish approved policy,
source closure, main ancestry, successful exact-commit CI, and the correct owner
or auditor workflow role. A valid digest alone does not establish these facts.
The audit result currently needs surviving GitHub run/job metadata for independent
correlation; it does not require the expired Actions artifact download. Missing
metadata blocks verification instead of trusting the receipt's self-description.

A root-run isolated mutation replaced the unsupported-marker rejection with a
legacy fallback. The unknown-schema ownership regression failed on the returned
`null`, confirming that it detects this unsafe behavior; repository source was
not modified. The registry rehearsal passed independently with pnpm 10.33 on
`PATH` after an earlier full-suite startup failure without that child-process
version pin. That isolated pass does not establish the earlier failure's cause.

Verifier work shares a phase deadline. When work outlives that deadline, the
invocation cannot accept its late result or begin another verification. Temporary
resource cleanup is deferred until the pending operation settles. An idle verifier
still requires disposal when an ordinary read exhausts the observation deadline;
starting cleanup must not depend on remaining verification time. This does not
claim cancellation of an underlying verifier subprocess.

Task 4 specification and code-quality reviews passed. Review corrections cover
idle-verifier cleanup after deadline expiry, discovery without current tag or
intent, unknown schemas, valid-but-edited published markers, canonical metadata
without drift, and titles that resemble a newer release. The specification
reviewer independently verified 118 affected tests and all 66 source/data pins;
the final quality reviewer independently verified 478 tests and the original
failure reproductions. Frozen version 1 incident fixtures remain unchanged.

Asset discovery evicts failed or rejected reads so transport retries actually
reach the adapter. Successful reads remain memoized for the invocation. The real
discovery regression starts with HTTP 503, reaches the adapter again, and succeeds.
The built-in global discovery's selected recovery proof is reused within the
same invocation: the regression now performs one verifier session and 21 package
verifications, down from two sessions and 42 verifications. Exact-candidate
fallback and injected discovery results still receive independent observation;
this is not a persistent proof cache or a grant of write authority.

Root verified all 68 focused recovery tests on the approved files. Intermediate
full-controller runs passed 2,654, 2,659, and 2,668 tests; each preceded additional
review corrections. The definitive full-controller run on the approved files
passed all 2,670 tests with zero failures in approximately 256 seconds
(`/tmp/dawn-recovery-task4-controller-verified.log`). Scoped Biome passed for all
19 changed source/test/data files; release inventory, docs, and diff checks passed.
The earlier package
build, typecheck, source, pack, and harness results remain recorded below; those
lanes were not repeated for this repository-script change, and the existing
source-suite failure still prevents a full-CI-green claim.

Draft-marker repair after a finalization upload is tracked explicitly in Task 9:
that integration must expose independently verified finalization facts to the
finalizer even when the unpublished draft marker is missing or corrupt. Task 4
preserves ownership and blocks that case; no repair writer is implemented here.

## Bounded writer and adoption (Task 5)

The recovery writer has three effects: upload a permitted recovery asset to the
identified release, update that draft's canonical recovery metadata, and publish
that same draft after final verification. Adoption archives the exact legacy
body and stores npm and authority proofs inside the attempt-qualified adoption
receipt. It re-downloads these assets before writing revision 1. Original assets
remain the independently verified base inventory.

Each mutation compares current release metadata, assets, and annotated tag,
then captures fresh authority immediately before the request. An uncertain
response stops the invocation; a later invocation must observe the result.
The comparison is cooperative under the verified fence, not an atomic GitHub
compare-and-swap. The phase deadline spans the writer instance. Unsettled
write-transport operations and concurrent transactions exclude another transaction
sharing the same trusted transport function. A late read from an expired
transaction cannot resume into a mutation; independent read-only observation
may start again after that transaction ends.

Publication sends `{ tag_name: candidate.tag, draft: false }` to the same release
after verifying that the annotated tag already exists, then verifies its original
object and commit again. GitHub documents this tag association and additional
workflow-file authorization rules for some resolved targets. Task 12 must test
those rules with the intended credential in an authorized disposable repository;
a local fixture cannot establish permission sufficiency. See GitHub's
[update-release API](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28#update-a-release).

Current new uploads are limited to the legacy archive, adoption receipt, and an
independently validated fixed finalization receipt. Later lane, verification-set,
audit, and run-result uploads and intermediate marker transitions fail closed
until their controllers supply the corresponding admission checks. An observed
finalization is validated even when the marker lags, and freezes new uploads.

Root independently passed all 178 focused writer, adoption, observer, model, and
legacy-writer tests. In an isolated copy, removing the same-name asset byte check
made its regression fail with a missing expected rejection; the repository was
not weakened (`/tmp/dawn-recovery-task5-root-mutation.log`). The specification
review found a bypass when a legacy marker coexisted with a finalization asset:
neither partial-adoption nor finalization validation ran. The correction rejects
this contradictory state, including equal-byte reuse, while preserving published
finalization verification after display edits. Three regressions reproduced the
bypass before the correction. Both independent reviews passed, each verifying
318 affected tests including workflow contracts. The quality review also used
deterministic probes for unsettled cancellation across writer recreation and
late observations after deadline expiry, and confirmed that the extracted
transport preserves the legacy implementation. Task 12 will retain those two
additional probes as permanent fault-rehearsal cases.

The definitive full-controller run on the reviewed files passed all 2,713 tests
with zero failures in approximately 162 seconds
(`/tmp/dawn-recovery-task5-controller-verified.log`). Scoped Biome passed for all
12 changed source/test/data files; release inventory, docs, and diff checks passed.
The earlier build, typecheck, package, and harness results remain recorded below;
these lanes were not repeated for this repository-script slice. The unresolved
source-suite failure still prevents a full-CI-green claim.

Policy activation, the live fence experiment, workflow integration, production
adoption, and the later smoke/audit/finalization controllers remain pending.

## Smoke operations and v2 receipts (Task 6)

The five lanes reuse the existing probe operations with separate v1 and v2
receipt collectors. Candidate identity describes the published packages;
executor identity describes the reviewed controller that ran the checks.
Containment, exact package assertions, and cleanup remain mandatory.

The dormant wire contract now includes per-installation sidecars because the
original inline list cannot distinguish repeated paths across separate installs
or represent every complete dependency tree within its small limit. The published
harness has three install checkpoints: exact packages, AG-UI TypeScript, and
TypeScript tooling. Each is captured before its subsequent checks can fail. Sidecars
bind check, candidate, executor, policy, exact bytes, count, and physical package
paths. Inline resolutions remain a subject summary. Collection finishes
before cleanup and rejects incomplete or oversized evidence.

The sandbox PID probe uses `node:22-slim` and replaces its keeper container.
Image evidence is captured while each actual container exists. Inspecting
a mutable tag after disposal cannot establish what executed. Adding this existing
probe image to the dormant policy inventory does not activate recovery or alter
the probe's PID and cleanup assertions.

npm documents that `npm ls` describes a logical dependency tree. Its hidden
lockfile records package locations and integrity metadata, with freshness
conditions. Collection therefore needs to reconcile physical installed paths
and lock records; a top-level list or unverified lockfile alone is insufficient.
See [npm ls](https://docs.npmjs.com/cli/v11/commands/npm-ls/) and
[package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/).

Root independently installed `@dawn-ai/sdk@0.8.24` and
`mini-build@npm:esbuild@0.28.1` with scripts disabled in an owned temporary
consumer outside the checkout. The collector and sidecar parser accepted all
three physical packages, including the platform binary, and preserved the alias
path, actual name, and requested selector. Canonical evidence was 1,656 bytes;
the temporary consumer was removed (`/tmp/dawn-recovery-task6-real-tree.log`).
This verifies collection and serialization, not provenance or strict containment.

Root also removed the installation-proof call in an isolated copy. The
wrong-executor regression failed because the mutated model returned `planned`
instead of `blocked`, proving that the test detects this bypass. Repository
source was not weakened (`/tmp/dawn-recovery-task6-root-mutation.log`).

The local host is macOS. Docker Desktop provides Linux/aarch64 containers, but
that does not establish the required Ubuntu 24 runner with stock systemd 255,
non-root execution, sudo control, and cgroup-v2 cleanup. The gated real runner
integration must report local ineligibility explicitly; no GitHub runner
identity or containment capability will be fabricated to claim a pass.
Root ran `DAWN_TEST_RECOVERY_RUNNER=1 node --test
scripts/release/test/recovery-strict-runner.integration.mjs`: zero passed,
zero failed, one explicitly skipped because the local host is ineligible.
This is not a successful Linux containment rehearsal.

Both independent reviews passed with no remaining findings: the specification
review ran 361 passing tests and one gated skip; the quality review ran 204
passing tests. Root independently passed 636 focused tests. Scoped Biome
checked all 23 changed source/test/data files with no errors and one verified
pre-existing `OPENAI_API_KEY` environment warning. Release inventory, docs,
and diff checks passed.

The definitive full-controller run on the reviewed files passed all 2,766 tests
with zero failures in approximately 161 seconds
(`/tmp/dawn-recovery-task6-controller-verified.log`). Existing v1 receipt and
probe behavior tests passed alongside the new identity and evidence tests.
The gated Linux check remains pending on eligible infrastructure. Earlier
package build/typecheck/pack/harness results and the unresolved source-suite
failure remain recorded below; this is not a full-CI-green claim.

Task 7 will add independently verified Actions artifact correlation, escrow
admission for lane receipts and every installation sidecar, and durable
verification selection. These uploads remain rejected by the writer until
those admission checks exist. Recovery policy remains dormant, the adoption
inventory is empty, and no live release record has been changed.

## Complete evidence escrow (Task 7)

A retained lane receipt needs durable proof of who checked its GitHub
provenance. Task 7 adds a typed provenance receipt, independent writer
admission, and observation of interrupted escrow. The descriptor binds
the admitted escrow executor to the exact lane and installation bytes,
as well as API-observed run, job, artifact, and validation identities.
A fabricated descriptor cannot replace those checks.

The durable descriptor is trusted through the admitted controller and exclusive
recovery namespace ownership. It is not a cryptographic job-authorship
signature. Once Actions bytes expire, REST cannot distinguish a deliberately
forged compatible descriptor naming a real admitted producer. Manual writes
outside the guarded owner invalidate this model. Direct writer admission
must reject invented artifact IDs, while later observation rejects missing
descriptors, invalid adoption chains, and invented producer runs/jobs.

GitHub artifact metadata exposes a service digest and workflow-run
identity, but does not directly identify its producing job or run attempt.
Correlation therefore also requires the attempt-specific job inventory
and the reviewed artifact naming and upload contract. See the
[artifact API](https://docs.github.com/en/rest/actions/artifacts).

A fresh read-only check found release `382873833` still a mutable draft
with 45 assets and the same opaque tag; the production release workflow
remains active. This metadata check is not a new artifact-byte or fence
verification. Main advanced to `67d92077828780762ec4c31028f7aba8d7fc7167`
through PR #570 (CORS), without release-path changes. Reconcile that base
before final implementation validation.

Root independently downloaded existing Actions artifact `9963893629` from
run `33947431338`. Its ZIP was exactly 944 bytes and SHA-256
`b0eefc7d22818728f96b5d5e251c51e2985d26f0581ee42acda99ac615ae2852`,
matching the service size and digest. The API timestamps had second
precision. This read-only check verifies the service metadata/download
contract, not the new recovery workflow or a production fence
(`/tmp/dawn-task7-live-artifact-contract.json`).

A root-owned deterministic adapter-count probe completed escrow with 19
effects, 2,322 Release-asset downloads, 861 npm tarball downloads, 41
npm-audit setups, and 22 Actions artifact downloads
(`/tmp/dawn-task7-observation-cost.json`). These are fixture call counts,
not measured production latency. Task 12 must reduce repeated transfer
and setup within an invocation while preserving independently fresh
identity checks, exact bytes, strict cleanup, and audit independence.
This performance acceptance work remains pending.

Both independent Task 7 reviews passed, each running 111 evidence, observer,
and writer tests. Root independently passed 515 affected recovery/workflow
tests and the definitive full-controller run: 2,803 passed, zero failed,
approximately 149 seconds (`/tmp/dawn-recovery-task7-controller-verified.log`).
Scoped Biome passed for 14 source/test/data files; inventory, docs, and
diff checks passed. Removing the independent provenance comparison in
an isolated source copy made the fake-artifact regression fail with a
missing expected rejection (`/tmp/dawn-recovery-task7-root-mutation.log`).
Repository source was not weakened. Policy remains dormant; no live
workflow or Release mutation occurred.

## Independent audit (Task 8, implemented)

The audit controller persists an intent before dispatch and requires
the direct API-returned run identity. API version `2026-03-10` returns
`workflow_run_id`, `run_url`, and `html_url`; the existing legacy adapter
already uses that contract. The recovery adapter must preserve its
narrow default-branch authority and never search recent runs to guess a
lost correlation. See the [workflow API](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10).

Classified attempt records preserve failed and uncorrelated work.
An audit-escrow receipt binds the result to independently observed
artifact metadata under the same guarded namespace trust model as lane
escrow. The auditor gets a separate read-only eligibility role, not the
metadata writer role. Required audit checks and retained bookkeeping
must be verified before finalization can select the result.

The required audit checks are `admission`, `annotated-tag`, `asset-inventory`,
`attestations`, `candidate`, `cleanup`, `dispatch-correlation`,
`original-payload`, `registry-packages`, and `selected-evidence`.
The audit job is `recovery-audit`; its ZIP artifact is
`recovery-v2-audit-result-${runId}-${attempt}-${jobId}` and contains exactly
one same-basename `.json` file. The owner escrow job is
`recovery-audit-evidence`. Cleanup must reflect actual verifier disposal.
A failed selected audit may be replaced at `AUDIT_PENDING` only after
validated immutable failure bookkeeping and a freshly correlated request;
the verification selection and phase remain unchanged. Finalization freezes
this retry path along with other evidence-producing operations.

Review reproduced a guarded-writer classification bug: a transient workflow
lookup error could be persisted as `foreign-run` for the valid selected run.
That immutable filename then prevented retaining its later genuine failure.
The correction rejects the transient claim without writing and shares
structured mismatch validation with the observer. Independent specification
rereview passed all 260 focused cases. Quality review then exposed a related
boundary: completed runs with missing or malformed conclusions must not be
retained as failures. Shared terminal-failure validation now rejects those
claims without writing. Quality rereview independently passed all 119
audit, observer, and writer tests and reproduced recovery to audit success
after the previously unavailable conclusion. Both review findings are closed.

A temporary byte-reuse experiment still ran the existing metadata and
proof checks while reducing fixture download calls to 65 Release assets,
21 npm tarballs, and five Actions archives. Corrupting a cached manifest
then blocked replay with no new effects
(`/tmp/dawn-task12-byte-reuse-prototype.json`). This is diagnostic evidence
for Task 12, not a production cache implementation or latency claim.

A read-only benchmark using the production npm verifier and exact npm
11.17.0 checked `@dawn-ai/sdk@0.8.24` three times. All signature/provenance
checks passed: 1,314 ms for the first call, 456 ms for a repeat in that
verifier, and 737 ms in a fresh verifier. Setup took 149 and 101 ms.
Evidence: `/tmp/dawn-task12-npm-audit-benchmark.json`. These are three
single-package samples on macOS with Node 24.20.0, not a full inventory,
Linux containment test, pipeline latency, or percentile estimate. Task 12
must examine repeated signature subprocesses as well as payload transfer;
reusing bytes alone does not remove that cost.

A subsequent full-inventory feasibility probe ran the same official npm
command over 21 synthetic exact-version leaves. All 21 packages passed
signature verification and the existing per-package provenance parser in
both calls: 1,638 ms cold and 716 ms on repeat. Each complete JSON output
was 373,312 bytes, below the existing 2 MiB bound. Evidence:
`/tmp/dawn-task12-npm-batch-benchmark.json`. This demonstrates feasibility
on this macOS host, not implemented batching or production pipeline speed.
The production batch must additionally enforce exact inventory membership,
pre/post synthetic-tree integrity, fresh invocation, and settled cleanup.
The owned npm benchmark installation and temporary consumer were removed.

Task 8's definitive full-controller run passed 2,843 tests with zero
failures in approximately 163 seconds
(`/tmp/dawn-recovery-task8-controller-verified.log`). Specification review
passed 260 focused tests; final quality rereview passed 119. Root passed
nine targeted correction cases and killed an isolated mutation that
removed the fresh-intent guard: the recreated writer then made an extra
dispatch (`/tmp/dawn-recovery-task8-root-mutation.log`). The temporary
source copy was removed; repository source was never weakened. Scoped
Biome checked 18 files; inventory, docs, and diff checks passed. Policy
remains dormant, with no production admission or live recovery effects.

## Runtime integration (Task 10)

The production read adapters now observe repository/default-branch and numeric
job identity, immutability policy, and the complete legacy-workflow inventory.
The reviewed fence contract connects digest-bound service evidence to fresh
disabled/drained observations. The real YAML workflow experiment demonstrated
the tested disable/rerun behavior; the production contract inventory remains empty. The complete live inventory also
contains two platform-generated workflows that the current contract cannot
represent; see the [platform workflow assessment](../specs/2026-09-05-platform-workflow-fence-assessment.md).

CLI and workflow composition is implemented and independently reviewed.
The owner workflow admits the exact committed intent, adopts or observes the
candidate, runs five lanes when durable evidence is absent, escrows their
results, dispatches and reconciles the independent audit, finalizes, publishes,
and always reports. A resume with valid finalization uses that evidence even
when the display marker needs repair. Job outputs select work; fresh observation
establishes completion.

Admission transfers the verified original manifest through an Actions artifact.
Each smoke parent independently checks its canonical bytes and candidate digest
before launching the strict child. Smoke jobs have read-only contents permission;
their child environment excludes GitHub, npm, OIDC, and policy credentials.
The independent auditor uses a separate concurrency group so the owner can wait
without holding up its own audit. Only the dispatch job needs Actions write.

The read-only `release:recover:inspect` command accepts a canonical request and
absolute output path. Omitting `intentPath` selects original-payload inspection
and returns an explicitly unreserved diagnostic with a proposed intent. It does
not construct a writer or insert a reservation. Retain this diagnostic outside
`scripts/release/recovery-adoptions/`; regenerate the proposal after a policy
change because its policy digest is part of the proposed identity.

Root independently read the repository immutability endpoint on 2026-09-05:
`enabled: true`, `enforced_by_owner: false`
(`/tmp/dawn-recovery-immutable-policy-current.json`). This proves the setting
under the existing local operator credential, not access from a workflow token.
GitHub documents Administration(read) for this GET. Runtime wiring keeps
a separate policy-read credential/channel out of smoke and attestation subprocesses; unavailable
proof must block publication. See the [GitHub endpoint contract](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#check-if-immutable-releases-are-enabled-for-a-repository).

The dormant recovery profile originally names Node 24.17.0, whose bundled npm
is 11.13.0. Existing release workflows now pin Node 24.19.0 and assert npm
11.17.0. Task 10 aligns the dormant profile and its fixtures with that
existing pair, preserving the exact official npm verifier contract and avoiding
an additional tooling installation. The [Node 24.19.0 release](https://nodejs.org/id/blog/release/v24.19.0)
records the npm 11.17.0 update. No active recovery evidence is being migrated.

## Final validation investigation

A bounded investigation independently reproduced a PID-readiness defect in
`test/k8s-compat/harness.test.ts`. The fixture accepts an empty PID marker,
then converts it to zero and incorrectly reports a live descendant even
when the actual owned process is gone. Delaying stdout after publishing a
valid PID passed; all 20 sequential and 24 concurrent baseline reruns passed.
The controlled failure had a different event count from the historical
CI failure, so historical causality remains unconfirmed. Task 13 will fix
the demonstrated fixture defect and preserve the cleanup assertions.
Evidence and the exact reproduction are recorded in
`/tmp/dawn-pid-diag-summary.md`, `/tmp/dawn-pid-diag-repetitions.jsonl`,
`/tmp/dawn-pid-diag-concurrent.jsonl`, and
`/tmp/dawn-pid-diag-reproduction.patch`. Temporary checkout files and owned
descendants were cleaned; the investigation changed no tracked code.

Upstream main CI [run 33947398526](https://github.com/cacheplane/dawnai/actions/runs/33947398526)
at `67d92077828780762ec4c31028f7aba8d7fc7167` failed its native Vercel
preview job before this recovery implementation was integrated. Its
verified diagnostic artifact `9963890376` reports `native Vercel source
deploy attempt failed`; the deeper deploy cause was not present in the
downloaded diagnostic files. Track this external CI boundary during
final validation; local checks cannot establish that it passes.

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

## Finalization implementation verification (Task 9)

The fixed finalization asset now commits to the complete nonrecursive inventory,
including retained audit bookkeeping and escrow. Its verified existence freezes
new evidence and dispatch even after an interrupted upload or missing marker.
A draft can reconstruct canonical metadata from that fixed proof; publication
requires fresh independent evidence and immutable-release policy. Published
completion remains terminal after mutable title/body edits, reporting drift
without reopening the release or writing a completion stamp.

Metadata write bounds are checked before the final asset can become durable.
The guarded writer also retains managed npm verifier ownership from raw factory
creation through verification and cleanup, including nested timeouts and late
settlement. A pending harmless GET does not keep that lease; the stopped
invocation still cannot start managed work or perform a late mutation.

On 2026-09-05, independent specification and quality reviews approved Task 9.
The definitive controller run passed 2,875 tests, zero failures (about 150 seconds),
recorded locally at `/tmp/dawn-recovery-task9-controller-verified.log`.
Root's metadata-bound and managed-lifecycle mutation experiments both failed the
intended regression when the guard was removed. These are code and fixture
checks; production recovery and disposable service rehearsal remain unrun.

## CI diagnostic retention finding (Task 13 preparation)

The latest observed main CI remains run `33947398526` at `67d92077`, failed in
`vercel-native`. Read-only inspection on 2026-09-05 found a concrete reason the
uploaded artifact omitted the deeper deployment error: the fixture writer
allows and writes `source-deploy-failure.log`/`prebuilt-deploy-failure.log`, but
`NATIVE_UPLOAD_ARTIFACT_NAMES` includes neither. The artifact preparation function
copies only that allowlist. Task 13 will correct both names and test the full
redacted diagnostic-to-upload path before the next real CI run. The underlying
Vercel failure is still unclassified; no live preview or credential was changed.

## Workflow integration verification (Task 10b)

Independent specification and quality reviews approved the corrected integration.
The final full controller suite passed 3,023 tests, zero failures, in 152.09
seconds. Scoped Biome checked 23 files; release inventory, docs, and whitespace
checks passed. Root independently removed the attestation environment projection
in an isolated copy: the credential-boundary regression failed, and passed again
after restoration. Logs: `/tmp/dawn-recovery-task10b-controller-verified.log` and
`/tmp/dawn-recovery-task10b-env-mutation.log`.

Inspection now distinguishes empty admission from an existing committed
reservation. Final diagnostics report requested identity, current verified
phase, selected receipt locations, and the next action. Starting phase and
completed mutation history are explicitly unavailable; successful job results
are never converted into a fictitious mutation journal. Readiness metadata drift
recommends finalization repair before publication. Live recovery remains dormant.

## Fresh production payload verification

On 2026-09-05, the read-only inspector from committed controller
`e38e6f28bd70e8dafda8986838f87c885ded8742` independently verified all 45 original
Release assets and all 21 published packages, including the real GitHub
attestation anchor and official npm signature/provenance checks. It returned
`unreserved` and `original-payload-verified`, with no errors or release writes.
The source was extracted from that commit, independently of the concurrent
batching implementation. The check took 43.916 seconds on macOS with Node
24.20.0 and a temporary, isolated npm 11.17.0 installation. This is a single
read-only inspection, not a Linux smoke result or pipeline latency estimate.

The exact candidate remains release `382873833`, tag `v0.8.24`, candidate SHA
`88c01c4afd59866fc0ea4c8f3b8444439a01c8ea`, and annotated tag object
`f2b401a29fe13141d1a71a919f0cf5b5eb05314b`. Its mutable draft still uses the
opaque release tag and original `NPM_COMPLETE` marker. Evidence is retained at
`/tmp/dawn-recovery-production-read-1789d99n/evidence/inspection.json` and
`summary.json` in the same directory. Package counts come from the inspection's
`originalPayload.npmEvidence.packages` array.

The proposed intent is retained outside active admission at
`/tmp/dawn-recovery-production-read-1789d99n/evidence/proposed-intent-dormant.json`.
It binds the inspected **DORMANT** policy and is a diagnostic only. It must be
regenerated after admission policy changes; this evidence does not establish a
legacy fence, workflow credential sufficiency, or authorization to activate.


## Fresh npm batching verification (Task 12a)

The new recovery batch method verifies the exact manifest inventory in one
fresh official npm 11.17.0 signature command per observation. It retains
complete-output membership checks and every per-package provenance binding.
Each observation still fetches fresh npm metadata and validates all tarball
bytes. The batch consumer has an exact filesystem inventory checked before
and after npm; malformed identities and nonregular package files reject before
reading them. Legacy verifier methods retain their compatibility.

The deterministic evidence-collection fixture still reaches
`VERIFICATION_COMPLETE` with 19 writes. Its signature-command count drops from
861 per-package commands to 41 complete-inventory commands, one for each fresh
observation. This slice deliberately leaves payload-transfer counts unchanged:
2,322 Release downloads, 861 npm tarball downloads, and 22 Actions downloads.
These are fixture call counts, not production throughput. Evidence:
`/tmp/dawn-task12a-observation-cost.json`.

Root also ran the new verifier against all 21 real published packages using the
manifest from the verified production inspection. Official npm 11.17.0 verified
every package with one audit command (plus its version check), taking 1.526
seconds on macOS/Node 24.20.0 including disposal. The source SHA256 was
`ae879f6ce01abe9af898fec0764553287f57542471718acf3d8c03f8bd7f8cfe`.
This was read-only cryptographic verification, not a full recovery invocation,
Linux smoke, service fence, or publication. Evidence:
`/tmp/dawn-task12a-real-npm.json`.

Independent specification and quality reviews approved Task 12a. The final
controller suite passed 3,072 tests, zero failures, in 150.48 seconds. Scoped
Biome checked 14 files; docs, inventory, and whitespace checks passed. The
complete controller log is `/tmp/dawn-recovery-task12a-controller-verified.log`.
Owned temporary production-inspection source and npm tooling were removed;
inspection and batch-verification evidence remain available at the paths above.


## Payload reuse and initial observation settlement (Task 12b)

Payload reuse is private to one controller call and retains only exact bytes
verified against freshly observed identities, sizes, digests, and Actions
expiry. It holds at most 128 entries and 64 MiB of base64 strings, conservatively
counted at two bytes per character. Payloads over 16 MiB use the original fresh
read path. Closed or expired generations cannot serve or accept late results.
Metadata, cryptographic verification, and mutation authority remain fresh;
the independent auditor has no shared cache.

Initial adoption, evidence, and audit reads now use the same writer's guarded
read-only method. Managed verifier creation, verification, and disposal retain
ownership through settlement, even after timeout. Harmless pending reads cannot
start late managed work. The original writer transport identity is preserved
across recreated controllers.

Root's independently measured adapter-call counts are:

| Phase | Writes | Release downloads before → after | npm tarballs before → after | Fresh batch audits |
|---|---:|---:|---:|---:|
| Evidence collection | 19 | 2,322 → 65 | 861 → 21 | 41 |
| Audit escrow | 3 | 546 → 69 | 168 → 21 | 8 |
| Finalization | 2 | 418 → 70 | 126 → 21 | 6 |
| Publication | 1 | 210 → 70 | 63 → 21 | 3 |
| Published no-op | 0 | 70 → 70 | 21 → 21 | 1 |

Evidence collection's Actions archive downloads fell from 22 to five. Fresh
npm metadata calls remained 861, 168, 126, 63, and 21 respectively. These are
deterministic fixture adapter calls, not service throughput or full production
rehearsal. The npm reader makes two HTTP requests per metadata observation.
Reports: `/tmp/dawn-task12b-observation-cost.json` and
`/tmp/dawn-task12b-late-phase-cost.json`. A separate owned-loopback experiment
using the unchanged production readers confirmed one tarball transfer across
two payload reads while both metadata HTTP requests repeated. It is recorded
at `/tmp/dawn-task12b-real-adapter-reuse.json`.

All 3,096 controller tests passed in 146.74 seconds. Root reviewed specification
compliance and code quality independently of the implementer after the app
rejected new and resumed review agents at its thread limit. Root's isolated
unmanaged-read and open-generation mutations failed their intended regressions;
all 24 targeted tests passed before and after restoration. Logs:
`/tmp/dawn-recovery-task12b-controller-verified.log` and
`/tmp/dawn-task12b-root-review.json`. No live effects or activation occurred.


## CI fixture corrections before final validation

The Vercel upload allowlist now retains both already-redacted deployment-failure
logs. Tests run each actual deployment composition through an intentional failure,
the real diagnostic store, and upload preparation, preserving the cause text and
redaction. Both tests failed first on the missing uploaded filename; the corrected
lane unit suite passed 299 tests, with one existing external opt-in test skipped.
This repairs diagnostic loss; the original live Vercel failure remains unclassified.

The descendant fixture now waits for a nonempty decimal PID in the supported
positive range, excluding the current process. It retains that validated PID for
cleanup observation and never converts an empty marker into zero. A real-filesystem
barrier proves readiness remains pending while the marker is empty; nine invalid
values reject without a process probe. The original descendant termination and
token-before-cluster-cleanup assertions remain, with PID, marker, error, and event
diagnostics. All 115 harness tests and both affected TypeScript projects passed.
The earlier CI containment failure is still not attributed solely to this defect.

The task's agent limit also prevented further independent agent review; root
reviewed these narrow changes directly. Full repository gates and real CI are
still outstanding. Logs: `/tmp/dawn-task13-vercel-red.log`,
`/tmp/dawn-task13-vercel-green.log`, `/tmp/dawn-task13-pid-red.log`,
`/tmp/dawn-task13-pid-green.log`, `/tmp/dawn-task13-cli-typecheck.log`, and
`/tmp/dawn-task13-k8s-typecheck.log`.


## Local recovery arc and service-probe verification (Task 12c)

The owned-loopback rehearsal runs production GitHub/npm readers and the guarded
HTTP writer through adoption, five-lane evidence collection, independent audit,
finalization, publication, published retry and next-version arbitration. Its
baseline has 32 durable writes. All 64 before/after interruptions resumed to
COMPLETE; the suite passed 67 tests in 545.83 seconds. It checks unchanged
original asset bytes and exact final receipt inventory, zero duplicate uploads
or audit request IDs, zero duplicate drafts/npm publications, and zero writes
on a published retry. Evidence: `/tmp/dawn-task12c-full-rehearsal.log`.

The fixture supplies synthetic npm signatures/attestations, five lane artifacts,
Git policy/invocation/fence callbacks and immutable-release policy. Canonical
service hosts are mapped only to the fixture's owned loopback server. These
seams never enter production verification. Actual service requests and counts
are recorded in `/tmp/dawn-task12c-http-cost.json`; these are fixture HTTP counts,
not production latency or provenance evidence.

The GitHub fence lane now advances the installed historical fixture on the
explicitly authorized disposable default branch, creates two UUID-named tags,
and exercises all 36 combinations of source, workflow state and replay method.
It preserves the pre-advance historical run for reruns. Every inventory is
unfiltered, paginated and drained; denials settle for at least five seconds.
It restores the workflow and checks drainage after uncertain disable/dispatch
outcomes without blindly repeating the ambiguous mutation. Raw polling/setup
calls remain in a bounded ledger; a separate digest-bound witness is validated
with the production parser. Tags, fixture commits and owned runs are retained
and listed for review. No broad resource deletion or production mutation occurs.

Six local driver regressions plus fence, policy, workflow and runner checks
passed (224 tests). They exercise two-page inventories, changed totals, duplicate
IDs, active runs, exact 36-case correlations, complete source closure, and
restoration after rejected or unknown responses. The real GitHub lane remains
unrun until a disposable repository is explicitly authorized. This lane covers
workflow fencing; release publication credentials and platform-owned workflow
fencing still require separate service evidence.

CI now contains a five-minute, contents-read-only `recovery-strict-runner` job
on Ubuntu 24.04 with pinned checkout/Node actions. An opted-in ineligible host
fails, preventing a skipped check from being mistaken for containment proof.
The local macOS integration remains explicitly skipped; actual Linux evidence
must come from CI. No production activation or release writes were performed.

## Verified implementation checkpoint and publication service preparation

Commit `0464c51430216d10748d6e9dfe1f489b9dc72f19` passed the complete local
`pnpm ci:validate` lane: 5,664 source tests (218 skips), 3,171 controller tests,
packing, TypeScript tooling and all three harness lanes. The separately invoked
fault harness passed 116 tests. Logs: `/tmp/dawn-task13-ci-0464c514.log` and
`/tmp/dawn-task13-fault-0464c514.log`.
[CI run 33962137902](https://github.com/cacheplane/dawnai/actions/runs/33962137902)
concluded success, including real Vercel, CopilotKit, Kubernetes and the new
Ubuntu containment check (one pass, zero skips). PR #572 remains draft. Its
separate automated reviewer failed before review due to insufficient service
account credit; that failure was not bypassed. A new local reviewer was also
unavailable because the app rejected the request at its agent thread limit.

Read-only inspection at that controller commit independently verified the 45
original assets and all 21 production packages using npm 11.17.0 in 32.762 seconds.
The candidate remained unreserved at NPM_COMPLETE; the policy remained DORMANT.
Evidence lives under
`/var/folders/_b/0t5_pyt94n7dlqkv1gmt29300000gn/T/dawn-recovery-final-read-lqy8dta0/evidence/`.
Its inspection SHA256 is
`f9bc7073b060b6221f64c65fcd42346870a79b1aafd66960b8eec87d7abc4036`.
The temporary verifier installation and frozen source were removed after the
inspection; evidence and the diagnostic-only proposal remain. Regenerate the
proposal at the reviewed activation commit.

A separately gated `recovery-publication-github.integration.mjs` now prepares
actual publication-credential testing. It requires BOTH the original disposable
repository authorization variables and `DAWN_TEST_RECOVERY_PUBLICATION_GITHUB=1`,
an explicit `DAWN_RECOVERY_PUBLICATION_TOKEN`, separate
`DAWN_RECOVERY_TEST_POLICY_TOKEN`, `DAWN_RECOVERY_TEST_SOURCE_SHA`, and credential
kind `DAWN_RECOVERY_TEST_CREDENTIAL_KIND=operator|workflow`. It refuses production
name/ID aliases, private test repositories, disabled immutable-release policy,
and a source equal to the current default branch. The two revisions must contain the exact reviewed historical/current fence
fixtures. The complete workflow inventory may contain only that fixture and
`.github/workflows/recovery-topology-probe.yml`; when present, the latter must
match the checked-out topology fixture bytes. Default-branch and workflow
identity are rechecked before tag creation and publication. The probe never
enables policy itself.

The probe creates a UUID-named annotated tag and prerelease, checks anonymous
draft invisibility and authenticated visibility, uploads one exact small asset,
reads it through the production download adapter, publishes against the existing
non-default annotated tag, and verifies immutable publication, public visibility
and unchanged payload/tag/default-branch identity. The tag and immutable
prerelease are deliberately retained and listed in the evidence ledger. This
is an additional authorized experiment beyond harmless workflow fencing.
The operator variant has since passed against GitHub, including both response-loss
cases. The actual workflow-token variant remains unrun; see the current results
report. The operator credential was used locally and was never uploaded to Actions.

`DAWN_RECOVERY_TEST_DISCARD_RESPONSE=upload|publication` can deliberately discard
one already-recorded successful response before the driver receives it. The
probe must recover through exact readback without repeating the mutation. This
is labelled injected client response loss, not represented as an observed GitHub
transport failure. Unknown draft creation stops without an inferred release ID
or a second draft. Operator credentials do not establish workflow-token authority.

The optional `test/fixtures/recovery-topology-workflow.yml` keeps all 13 production
job IDs, dependency lists, conditions and admission outputs. Its fixed harmless
commands support `full`, `published-noop`, `publish-only` and a selected first-attempt
job failure for real skip/rerun checks. A local contract test detects topology drift.
By default it publishes nothing. Only its optional publication step receives the
disposable repository's actual workflow token; a separately reviewed controller
SHA selects probe source, `RECOVERY_AUTHORIZED_REPOSITORY` selects the repository,
and `RECOVERY_POLICY_READ_TOKEN` supplies the separate policy-read credential.
All other jobs have no permissions. This fixture is not installed in production
or a substitute for real five-lane recovery evidence.

### GitHub quota readiness

Recovery now revalidates eligible JSON representations with an authenticated
conditional GET on every read. A matching fresh 304 preserves its real status;
it does not reuse an old authorization decision. Array-only inventories and
multi-page collections remain unconditional. Runtime state is bounded and
cleared at completion; the independent auditor starts separately. The separate
Administration(read) policy reader remains unconditional.

The local complete arc records 2,193 HTTP 304 responses and 866 other GitHub API
responses; evidence collection accounts for 150 of the latter. Those counts
exclude the supplied fence/admission callbacks, workflow bootstrap, and upload
host. Before activation, retain actual workflow quota observations including
historical fence pagination and all five smoke jobs. The repository's 1,000-call
hourly GITHUB_TOKEN primary quota is shared across its jobs; job boundaries do
not reset it. Green synthetic checks cannot certify that complete live budget.
See `../specs/2026-09-05-recovery-conditional-reads.md` for the contract and
read-only service evidence. No production reservation or dispatch follows from
these measurements.
