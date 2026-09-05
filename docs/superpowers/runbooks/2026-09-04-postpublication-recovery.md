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
