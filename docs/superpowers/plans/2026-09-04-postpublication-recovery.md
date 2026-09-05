# Post-publication Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reviewed current tooling verify and finish an already-published
candidate without rebuilding packages, changing npm provenance, or bypassing
smoke checks.

**Architecture:** Add a dormant, independently pinned post-publication workflow
and evidence version 2. Keep candidate artifacts unchanged; reserve ownership
before adoption, execute all five existing verification obligations, audit in a
separate run, and anchor final completion in an immutable release asset.

**Tech Stack:** Node 24 ESM repository scripts, node:test, existing GitHub/npm
adapters, canonical JSON evidence, pinned GitHub Actions, Ubuntu 24.04 strict
systemd/cgroup smoke runner, existing Docker integration probes.

---

Independent plan review: passed on 2026-09-04 after clarifying dispatch-race
evidence retention and finalization-time upload fencing. No implementation or
production recovery is claimed by this review.

## Approved scope and starting point

Spec: [Post-publication recovery](../specs/2026-09-04-postpublication-recovery-design.md).
Roadmap: [Release reliability architecture](../specs/2026-09-04-release-reliability-architecture.md).

Planning base: main `92cae0a3771473dd040c80520de177bcee0c7765`, with the approved
design in commit `7e7a97ad`. Worktree:
`/Users/blove/repos/dawn/.worktrees/release-reliability-design`, branch
`blove/release-reliability-design`. Re-fetch main before implementation; inspect
and reconcile release-path changes rather than assuming this base stays current.
Keep unrelated worktrees and their uncommitted changes untouched.

This plan implements sub-project 1 only. No npm publisher changes, package
rebuilds during recovery, smoke waivers, per-lane cross-run reuse, automatic
recovery scheduling, CI performance redesign, or chart publication changes.
Keep the production adoption directory empty until a separately reviewed
activation record. No live release mutation is authorized by this plan.

Use @superpowers:test-driven-development and
@superpowers:verification-before-completion during implementation. Run commands
from the implementation repository root. Source/test imports for these repository
scripts use `.mjs`, following their neighbors. Scope Biome to changed files.
Use the required release closure pins; do not relax them to make tests pass.

## Feasibility must precede activation

An exact source review found a concrete hazard in candidate `88c01c4a`:
`metadata.mjs:isManagedReleaseForTag` catches an unfamiliar marker parse and
returns false. `escrowCandidate` then calls `createDraftRelease` when no draft
matches. The frozen GitHub writer also fails to recognize the opaque-tag draft
unless its body equals the requested legacy body. A new marker is therefore
not, by itself, a universal old-writer rejection mechanism.

Task 1 must demonstrate every reachable legacy writer's behavior, including
failed-job-only reruns using old successful outputs. If an old writer can mutate,
the admission report must require a tested operational fence. Do not assume
disabling a workflow stops historical reruns: prove that behavior with a
disposable GitHub workflow and re-observe active jobs. If no safe fence can be
demonstrated, stop before production activation and return to the ownership
design. Dormant schema and read-only work can still be completed.

## File and interface map

New production modules live in `scripts/release/recovery/`. Keep node:test files
directly in `scripts/release/test/` so the existing test script discovers them.
Avoid adding the new protocol to the large version 1 `metadata.mjs`.

| File | Responsibility |
| --- | --- |
| `schema.mjs` | Canonical wire objects, exact fields, bounds, receipt/marker/finalization parsing |
| `policy.mjs`, `policy.json` | Required checks, approved verifier closure, environments, bounded retry policy |
| `authority.mjs` | Invocation CI/SHA checks, git adoption records, ownership and replay-fence admission |
| `invocation.mjs`, `fence.mjs`, `fence-evidence.mjs` | Trusted read adapters, reviewed legacy-fence contracts, and service-evidence validation |
| `observe.mjs` | Independently verified candidate/registry/asset facts, version 2 discovery |
| `metadata.mjs` | Version 2 marker envelope and pure canonical display reconstruction |
| `model.mjs` | Pure transition planning, terminal completion and display-drift classification |
| `writer.mjs` | Version 2-only bounded GitHub upload/body/publication effects |
| `adopt.mjs` | Legacy archive, retained migration receipts, ownership transition |
| `smoke.mjs` | Version 2 lane execution and receipt provenance; existing probe operations reused |
| `evidence.mjs` | Actions receipt correlation, release escrow, complete verification-set selection |
| `audit.mjs` | Exact independent dispatch/correlation and fresh external audit |
| `finalize.mjs` | Finalization asset, shared metadata renderer, publication/re-observation |
| `runtime.mjs`, `cli.mjs` | Dependency composition, strict CLI/environment projection, reports |
| `scripts/release/recovery-adoptions/.gitkeep` | Empty initial adoption inventory |
| `.github/workflows/release-postpublication.yml` | Manual recovery owner |
| `.github/workflows/release-postpublication-audit.yml` | Independent audit, separate concurrency group |

Existing integration points: `candidate.mjs`, `observe.mjs`, `cli.mjs`,
`state.mjs`, `planner.mjs`, `evidence.mjs`, `conflicts.mjs`,
`observation-schema.mjs`, `independent-audit-coordinator.mjs`, and
`post-publication-audit.mjs`. Every reader must dispatch by evidence version or
explicitly reject the new version; no silent legacy fallback.

Reuse the existing bounded HTTP/ZIP/file utilities, npm signature verification,
attestation anchor verifier, strict process runner, and probe assertions. The
legacy GitHub writer validates version 1 metadata internally: do not pass it
version 2 bodies or suppress its parser errors. Share low-level transport only
where its inputs and authority remain explicit.

## Contract decisions to encode before effects

All candidate objects contain `repository`, decimal-string `repositoryId`,
`version`, `candidateSha`, `tag`, `tagObjectSha`, decimal-string `releaseId`,
`manifestSha256`, and `releaseRecordSha256`. Normalize observed IDs once at the
API boundary; reject noncanonical caller IDs. Do not conflate candidate SHA with
the executor's `github.sha`.

Every canonical version 2 object contains `schemaVersion: 2` and a discriminating
`kind`. Enforce exact root/nested fields, safe descriptors, finite numeric values,
bounded bytes, lowercase digest syntax, unique sorted identities, and derived
outcomes. Canonical byte equality must reject duplicate JSON keys and alternate
encodings. Keep version 1 manifest and release-record bytes unchanged.

Define these named wire types in Task 2:

| Kind | Fields beyond schemaVersion/kind |
| --- | --- |
| `recovery-adoption-intent` | candidate, legacyBodySha256, legacyPhase, policySha256, operations |
| `recovery-marker` | candidate, revision, phase, policySha256, adoption, verificationSet, audit, finalization |
| `recovery-adoption` | candidate, policySha256, authority, executor, archive, baseAssets, npmEvidence, retainedAttempts |
| `recovery-lane` | candidate, policySha256, lane, executor, environment, startedAt, finishedAt, checks, resolutions, conclusion |
| `recovery-verification-set` | candidate, policySha256, executor, lanes, provenance, retainedReceipts, conclusion |
| `recovery-audit-intent` | candidate, policySha256, requestId, expectedAuditorSha, verificationSetSha256, inventory, executor |
| `recovery-audit-dispatch` | candidate, requestId, intentSha256, runId, expectedAuditorSha, executor |
| `recovery-audit-result` | candidate, policySha256, requestId, verificationSetSha256, inventorySha256, executor, checks, conclusion |
| `recovery-finalization` | candidate, policySha256, adoption, verificationSet, audit, assets, metadata |
| `recovery-run-result` | candidate, executor, before, after, outcome, effects, evidence, nextAction, errors |

`executor` records actual controller SHA, verifier closure digest where relevant,
workflow path, run/attempt, and job identity. Authority records the checked git
intent path/digest and reviewed controller commit. Receipt references bind asset
name, ID, byte digest and size. `metadata` contains all semantic final title/body
fields including marker revision, but no recursively defined final body digest.
`operations` is the fixed post-publication allowlist. Null phase-specific values
are explicit; reject a completed phase missing its required references.

Use existing payload caps for original assets. Start new JSON receipts at 256 KiB,
selection/finalization at 1 MiB, retained recovery assets at 2,048 and 64 MiB
cumulative. Bound dependency-resolution details separately; oversize is failure,
not truncation into a successful proof. Test limits with generated inputs and
check these budgets against a real read-only inventory before activation.

## Task 1: Establish baseline and prove legacy-writer fencing

**Files:** Create `scripts/release/test/recovery-legacy-fence.test.mjs` and
`scripts/release/test/support/recovery-legacy-fixture.mjs`. Create the eventual
read-only report in `docs/superpowers/runbooks/2026-09-04-postpublication-recovery.md`.
Create the minimal fence experiment in
`scripts/release/test/recovery-github.integration.mjs`; Task 12 extends it.

- [x] Run `pnpm install --frozen-lockfile`, `pnpm build`, then
  `pnpm test:release-controller`. Record actual baseline failures separately;
  investigate relevant failures before changing behavior. Inspect open #568 for
  the known process-tree test issue; do not assume it has merged.
- [x] Extract the exact candidate's workflow and full imported executable closure
  through `git show` into a temporary fixture, preserving original imports. Never
  execute a production entrypoint with live write credentials during this test.
  Implementation packages the extracted closure as a pinned archive so shallow
  CI checkouts can run without Git history or network access.
- [x] Create a recording HTTP transport that accepts real GitHub request shapes,
  models the opaque-tag draft and exact annotated tag, and records every attempted
  POST/PATCH/upload. Exercise escrow, npm reconciliation, smoke reconciliation,
  audit recording/correlation, and release publication with historical inputs.
- [x] First demonstrate that the unsafe assumption is false: an assertion of zero
  legacy escrow effects must fail on the frozen implementation with a version 2
  opaque-tag draft. Preserve the real attempted request as fixture evidence.
- [x] Change the regression to require classification `legacy-fence-required`
  when any writer can mutate. Do not alter the frozen implementation. Enumerate
  which historical run/job output paths make that writer reachable. Classification
  here is a recording-fixture report; production admission consumes and verifies
  the corresponding authority evidence in Task 3.
- [x] Run `node --test scripts/release/test/recovery-legacy-fence.test.mjs`.
  Expected: the hazard is reproduced and admission denies it, never a fake claim
  that all old code rejects version 2.
- [x] Commit these tests and the admission finding. Activation cannot proceed
  until Task 12 has validated a real fence for any unsafe replay path.
- [x] Prepare the minimal disposable workflow-disable/rerun experiment using
  Task 12's repository allowlist and authorization constraints.
- [ ] Run the prepared experiment as soon as a disposable repository is
  authorized, preferably before broad controller implementation. A negative
  result triggers ownership-design revision then;
  do not defer a known feasibility decision until the entire pipeline is built.

Local findings and limits: [feasibility report](../runbooks/2026-09-04-postpublication-recovery.md).
The local regression slice is implemented; the live feasibility requirement and
production admission remain unresolved. No production recovery code is enabled.

## Task 2: Add strict schemas and a pure transition model

**Files:** Create `recovery/schema.mjs`, `recovery/model.mjs` under the production
directory above; create `test/recovery-schema.test.mjs`,
`test/recovery-model.test.mjs`, and `test/support/recovery-fixture.mjs` under
`scripts/release/`.

- [x] Write table-driven tests for every wire kind and phase prerequisite. Use
  positive fixtures that describe real identifiers and receipt relationships;
  reject wrong source/executor identity, duplicate lanes/assets, bad JSON bytes,
  missing evidence, over-limit values, and unknown schema versions.
- [x] Run `node --test scripts/release/test/recovery-schema.test.mjs scripts/release/test/recovery-model.test.mjs`;
  verify failure is the missing behavior/export, then implement the parsers.
- [x] Implement the pure planner with the spec's six phase transitions. It accepts
  verified facts, never an effects adapter. A classified state without a matching
  executor capability returns blocked before an effect can be selected.
- [x] Add this regression using the complete fixture helper from this task:

```js
test("an adjudication cannot replace a failed lane", () => {
  const facts = recoveryFacts({ phase: "RECOVERY_ADOPTED" })
  facts.verification.lanes.storage.conclusion = "failure"
  facts.legacyAdjudication = { kind: "smoke-gate-adjudicated" }
  const plan = planRecovery(facts)
  assert.equal(plan.after, "RECOVERY_ADOPTED")
  assert.equal(plan.outcome, "blocked")
  assert.equal(plan.effects.length, 0)
})
```

- [x] Derive terminal publication from finalization asset plus external immutable
  release/tag proof; represent later title/body edits as `displayDrift` separate
  from completed ownership. Missing immutable proof is an integrity block.
- [x] Re-run focused tests, mutate away one phase prerequisite and require failure,
  restore it, and commit. Do not export a setter that writes arbitrary phases.

Task 2 is implemented as dormant code. Both review stages passed; the focused
suite contains 118 passing tests. An isolated prerequisite-removal experiment
failed as expected and passed after restoration. Validation details and existing
test failures are recorded in the [runbook](../runbooks/2026-09-04-postpublication-recovery.md).
No production workflow, writer, CLI, or adoption record is enabled by this task.

## Task 3: Add policy, invocation authority, and empty admission

**Files:** Create `recovery/policy.mjs`, `recovery/policy.json`,
`recovery/authority.mjs`, `recovery-adoptions/.gitkeep`,
`test/recovery-authority.test.mjs`, `test/recovery-policy.test.mjs`.
Modify `adapters/github.mjs`, `test/github-adapter.test.mjs`,
`test/workflow-contracts.test.mjs`, and `test/fixtures/release-script-hashes.json`
to preserve transport failures before
HTTP status classification. Review exposed body timeouts being masked as
retryable server errors; this prerequisite keeps retry decisions grounded in
the original transport outcome.

- [x] Test missing/malformed/mismatched intents, wrong actual workflow SHA, an
  unmerged controller, failed/absent CI, a different repository, unsupported
  policy, and a legacy-fence-required result without verified fencing evidence.
- [x] Run `node --test scripts/release/test/recovery-authority.test.mjs scripts/release/test/recovery-policy.test.mjs`
  and verify red before implementation.
- [x] Require main-ref invocation and equality of expected SHA with actual
  invocation SHA. Use independently observed main ancestry and successful CI
  at that SHA. Read intent bytes from that immutable checkout through the git
  reader; CLI strings never grant authority.
- [x] Policy lists the five exact lanes, mandatory checks, approved verifier
  executable closure digest, supported receipt versions, environment profile,
  and retry budgets. Hash verifier source inputs without hashing policy.json
  into itself. The separate repository import-closure pins cover all code/data.
- [x] Centralize retry classification: 15-second reads, at most five transport
  retries bounded by 90 seconds per operation, bounded Retry-After; reuse the
  registry's existing propagation classification and enforce an overall phase
  deadline. Schema/identity/signature failures never retry. Test injected clocks.
- [x] Make verified fence evidence a prerequisite to adoption and every later
  write while unsafe legacy reruns remain reachable. An expired/missing fence
  observation blocks. No enabling/disabling API is called by this module.
- [x] Re-run tests, prove an arbitrary `controllerSha` input cannot authorize
  execution, and commit with no production adoption record.

Task 3 is implemented with dormant admission. Both review stages passed;
64 affected tests and all 2,601 controller tests pass. An isolated SHA-guard
removal failed as expected and passed after restoration. The shared reader now
preserves transport failure provenance; both source and aggregate integrity pins
were updated. See the [runbook](../runbooks/2026-09-04-postpublication-recovery.md)
for validation history and the unresolved earlier source-suite failure. Production
fencing, writers, and workflow integration remain pending; Task 4 below adds
ownership routing.

## Task 4: Observe artifacts and route versioned ownership

**Files:** Create `recovery/observe.mjs`, `recovery/metadata.mjs`,
`test/recovery-observe.test.mjs`, `test/recovery-routing.test.mjs`, and
`test/support/recovery-observe-fixture.mjs`. Modify `candidate.mjs`, `observe.mjs`,
`cli.mjs`, `state.mjs`, `planner.mjs`, `independent-audit-coordinator.mjs`,
`recovery/model.mjs`, `recovery/policy.mjs`, their affected tests, and the release
closure pin fixture/contract. Version 2 uses a separate observation result, so
`observation-schema.mjs`, `evidence.mjs`, and `conflicts.mjs` retain their version 1
contracts. The coordinator rejects recovery before reaching the legacy auditor.

- [x] Test an exact reserved legacy draft, adopted draft, complete version 2
  release with corrupt/absent body marker, unknown version, removed intent,
  duplicate drafts, absent registry package, conflicting tarball, and a newer
  candidate. Preserve version 1 incident fixtures unchanged.
- [x] Run `node --test scripts/release/test/recovery-observe.test.mjs scripts/release/test/recovery-routing.test.mjs`
  to establish red.
- [x] Independently verify base manifest/record, exact tarballs, original
  attestation bundle, npm package source/bytes, canonical Release ID, and exact
  annotated tag. Reuse low-level verification functions; do not construct a fake
  version 1 observation to get version 2 through old assertions.
- [x] Consult ownership before legacy marker classification. Add a distinct
  recovery-owned selection/disposition that legacy CLI maps to no continuation,
  and a verified recovery-terminal selection for candidate arbitration. Do not
  reuse `SMOKES_COMPLETE` or forge `evidence.assets.publishedExact`.
- [x] Wire all invocation types through the same ownership router. A reserved
  candidate without an active recovery run reports recovery-required, not a
  successful no-op. Every incomplete recovery-owned candidate blocks newer
  publication; terminal proof lets newer candidates proceed.
- [x] Published discovery uses tag + canonical Release ID and the fixed final
  asset name even after title/body edits. A valid but edited body marker cannot
  override verified immutable finalization. Read-only scheduled legacy audit routes
  version 2 into its compatible observer or reports explicit unsupported mode;
  it never sends new evidence to the candidate's frozen audit executor.
- [x] Run focused tests plus candidate/state/planner/observation/coordinator
  suites with `node --test` on their exact files. Mutate the router to fall back
  on parse failure and require the ownership regression to fail. Commit.

Task 4 is implemented. Both review stages passed, with 68 focused recovery tests
and all 2,670 controller tests passing on the approved files. Ownership survives
missing tags/intents and edited display metadata; transient reads retry, and the
built-in resolver avoids duplicate verification. Recovery remains dormant with
no adoption record or production fence. See the runbook for validation details.

## Task 5: Implement the bounded version 2 writer and adoption

**Files:** Create `recovery/writer.mjs`, `recovery/adopt.mjs`,
`test/recovery-writer.test.mjs`, `test/recovery-adopt.test.mjs`, and
`test/support/recovery-write-fixture.mjs`. Extract the existing HTTP transport to
`adapters/github-write-transport.mjs`; retain the legacy writer interface.
Update `recovery/observe.mjs` for persisted partial adoption and
`recovery/model.mjs` to validate finalization when the marker lags. Refresh the
reachable-source pins and aggregate contract hash. Use `adapters/github.mjs`
reads and existing normalization/HTTP transport.

- [x] Write failing transport tests that enumerate the only allowed effects:
  upload a permitted recovery asset to the exact Release ID, update that draft's
  canonical version 2 body, and publish that same draft after final verification.
  Publication explicitly associates the draft with the already verified candidate
  tag through `{ tag_name: candidate.tag, draft: false }`. Forbid draft
  creation/deletion, Git ref creation/movement, arbitrary URLs, npm calls, and
  overwriting differing bytes. Do not broaden the legacy writer.
- [x] Run `node --test scripts/release/test/recovery-writer.test.mjs scripts/release/test/recovery-adopt.test.mjs`.
- [x] Implement read-compare-write-read under the verified fence; validate
  argument identity and phase before any write. Treat uncertain responses as
  re-observation, never proof that the write did not happen.
- [x] Adoption validates exact legacy `NPM_COMPLETE`, archives its raw body,
  uploads an attempt-qualified adoption receipt containing the npm and authority
  proofs, re-downloads the exact assets, then writes revision 1 `RECOVERY_ADOPTED`.
  The existing adoption wire embeds these proofs; no separate untyped npm or
  authority receipt is introduced. Derive base inventory from the verified
  original record; do not modify original assets.
- [x] Interrupt after each upload and body update. Resume with same and changed
  controller/run identities; reuse existing canonical receipt bytes when replaying
  an attempt, retain valid earlier attempts, reject foreign recovery assets.
  The adoption schema has no timestamp field.
- [x] Prove a fence lost before mutation, changed legacy body, or incomplete npm
  inventory produces zero effects. Restore mutation tests and commit.

Task 5 is implemented as dormant code. Both independent reviews passed after
closing the legacy-marker/finalization validation bypass. Each reviewer verified
318 affected tests and workflow contracts. The final full-controller run passed
all 2,713 tests with zero failures; scoped Biome (12 files), release inventory,
docs, and diff checks passed. Root also verified an isolated mutation of the
existing-asset byte guard. No policy activation, workflow integration, live fence
experiment, production adoption, or production publication occurred.

## Task 6: Reuse actual probes with version 2 receipts

**Files:** Create `recovery/smoke.mjs`, `test/recovery-smoke.test.mjs`.
Modify `smoke/runtime-targets.mjs`, `smoke/scaffold.mjs`, `smoke/storage.mjs`,
`smoke/published-harness.mjs`, `smoke-result.mjs`, and
`scripts/published-artifact-verify.mjs` only at their operation/receipt boundary.
Add `test/recovery-strict-runner.integration.mjs` for Linux infrastructure checks.
Extend the dormant `recovery/schema.mjs` with typed installation sidecars and
required lane descriptors; update `recovery/model.mjs`, `recovery/observe.mjs`,
and their nonfrozen v2 fixtures/tests to verify the linked evidence. Keep the
existing receipt bounds and add a one-MiB/4,096-package sidecar bound. Refresh
reachable source pins and the aggregate contract hash. Add a narrow image-evidence
hook in `scripts/published-artifact-smoke.mjs` while the sandbox containers still
exist; preserve its PID assertions and cleanup. Extend the dormant approved
Docker inventory with the probe's existing `node:22-slim` image and validate
required images per lane.

- [x] Write identity tests with candidate A and executor B. Require B in executor
  evidence, A in package identity, all mandatory checks, and failure on bad
  cleanup. Confirm existing version 1 entrypoints still emit identical schemas.
- [x] Extract existing probe operations from their version 1 receipt wrappers
  into named functions in those same modules. Keep strict runner construction,
  allowed command fields, package versions, and assertions intact. Recovery
  invokes those operations with a version 2 collector; it does not manufacture
  a successful v1 result or spoof any GitHub environment variable.
- [x] Give metadata the same separation: run its actual exact-package byte and
  provenance checks, then serialize under the selected receipt protocol.
- [x] Capture the environment/toolchain and complete installed dependency tree
  during each install check, before temporary directories are removed. Bind
  canonical resolution bytes or separately bounded digest-qualified assets.
  Record actual Docker image identity for storage/sandbox checks, not just a tag.
  Bind each actual install through `{ check, assetName, sha256, size, count }`
  to a typed `recovery-installation` sidecar. Keep inline lane resolutions as
  a bounded subject summary. Failed lanes and metadata may have an empty summary;
  unknown npm version is null only on failure, never fabricated. Reject oversized,
  missing, mismatched, or incomplete snapshots. Preserve repeated installation
  paths in distinct check snapshots.
- [x] Run `node --test scripts/release/test/recovery-smoke.test.mjs scripts/release/test/runtime-targets-smoke.test.mjs scripts/release/test/scaffold-smoke.test.mjs scripts/release/test/storage-smoke.test.mjs scripts/release/test/published-harness-smoke.test.mjs scripts/release/test/smoke-result.test.mjs`.
- [ ] On an eligible Ubuntu runner, run
  `DAWN_TEST_RECOVERY_RUNNER=1 node --test scripts/release/test/recovery-strict-runner.integration.mjs`.
  Exercise real systemd execution and cleanup with the exact strict option
  allowlist; classify an ineligible local OS as explicitly skipped, not passed.
- [x] Commit only after old receipt behavior and new identity tests pass. Never
  reclassify the sandbox PID assertion as a harmless flake to finish this task.

Task 6 is implemented as dormant code. Specification and code-quality reviews
passed. Root independently passed 636 focused tests and the full controller suite
(2,766 passed, zero failed, approximately 161 seconds). The quality reviewer
passed 204 tests. Scoped Biome (23 files, one existing warning), release inventory,
docs, and diff checks passed. The eligible Linux
execution remains pending: explicitly enabling the gated integration on this
Mac produced zero passed, zero failed, and one ineligible-host skip. This does
not establish real systemd containment or resolve the earlier source-suite
PID cleanup failure. No workflow dispatch or production mutation occurred.

## Task 7: Escrow complete verification and provenance

**Files:** Create `recovery/evidence.mjs`, `test/recovery-evidence.test.mjs`.
Extend `recovery/writer.mjs` with the corresponding independently verified escrow
admission gates and tests; Task 5 intentionally rejects these uploads until this
controller exists. Add a bounded `recovery-provenance` receipt to the dormant
wire schema, and extend observation to verify partial escrow and a selection
whose upload completed before its marker update. Provenance must bind the
admitted escrow executor as well as the independently observed lane and artifact
identities; receipt-supplied assertions alone confer no authority.

- [x] Test every missing/failed lane, duplicate/foreign artifact, incorrect
  job/run/attempt/SHA, noncanonical receipt, forged self-claimed identity, and
  interrupted escrow. All five selected receipts must belong to one run/attempt.
- [x] Run `node --test scripts/release/test/recovery-evidence.test.mjs` for red.
- [x] Correlate API-observed workflow/run/jobs and exact artifact IDs/digests;
  download bounded ZIPs and require their exact files/bytes. Then upload raw
  receipts plus independently observed provenance descriptors to the release.
  Include every digest-linked installation sidecar from Task 6, verifying exact
  checkpoint identity, canonical bytes, size, count, and artifact-file membership.
  Escrow sidecars in the retained inventory before selecting their lane receipts;
  do not omit them from ZIP validation, upload admission, or resume checks.
- [x] Persist a complete immutable selection including retained receipt inventory,
  re-read it, then advance to `VERIFICATION_COMPLETE`. Missing/failed checks stay
  nonterminal with diagnostic receipts. A repeat with durable selection is a
  no-op, independent of Actions download retention.
- [x] Test expiry before escrow blocks missing proof, while expiry after valid
  escrow succeeds without downloading the expired artifact. Reject a fabricated
  descriptor with no accepted trusted escrow chain. Commit after tests pass.

Task 7 is implemented and reviewed as dormant code. Both independent
reviews passed (111 tests each); root passed 515 affected tests and all
2,803 controller tests with zero failures (approximately 149 seconds).
Scoped Biome checked 14 files; inventory, docs, and diff checks passed.
An isolated mutation of the independent provenance comparison caused its
forgery regression to fail as expected. The measured repeated-observation
cost is tracked as required Task 12 work. No live recovery effects occurred.

## Task 8: Independent audit dispatch and correlation

**Files:** Create `recovery/audit.mjs`, `test/recovery-audit.test.mjs`.
Add a narrowly scoped default-branch dispatch method to `recovery/writer.mjs`;
do not loosen the legacy exact-tag dispatch API.
Add shared `recovery/audit-proof.mjs`, classified immutable audit-attempt
bookkeeping, and a durable audit-escrow receipt with exact result and
independently observed artifact bindings. Extend observer/model admission
and final inventory to retain permitted prior attempts. Require the
complete named audit checks, and give the auditor a read-only eligibility
role without granting owner mutation or fence authority. A failed selected
audit can be replaced at `AUDIT_PENDING` only after independently validated
failure bookkeeping and a freshly correlated request ID. Preserve the
verification selection and phase; finalization freezes retries.

- [x] Test actual auditor SHA mismatch, main advancing during dispatch, wrong
  verification-set selection, failed audit, missing result, foreign run, and
  ambiguous dispatch acceptance. Require direct returned run identity.
- [x] Run `node --test scripts/release/test/recovery-audit.test.mjs` for red.
- [x] Persist uniquely named intent before dispatch. Use the current supported
  API response to capture run ID; verify actual head SHA equals expected audited
  controller SHA. Uncorrelated attempts are retained but never selected.
- [x] The auditor re-downloads registry/release evidence into its own clean
  workspace and performs all spec checks. API provenance must match the
  recovery evidence policy; uploaded JSON's own assertions are insufficient.
- [x] Persist and re-read the correlated dispatch before `AUDIT_PENDING`; escrow
  a successful matching audit before `AUDIT_VERIFIED`. Never scan recent runs
  to guess a lost identity. A newly dispatched attempt must have a new request ID.
- [x] Distinguish admission mismatch from a dispatch-time race. Admission SHA
  mismatch produces zero effects. An unexpected auditor SHA discovered after
  dispatch retains the already-uploaded intent and a classified failed-attempt
  receipt, never selects that audit, and never advances to verification or
  publication. Test both boundaries. Restore mutation tests and commit.

Task 8 is implemented and independently reviewed as dormant code. Root
passed the definitive controller suite: 2,843 tests, zero failures, about
163 seconds. Specification review passed 260 cases; final quality rereview
passed 119 after correcting transient foreign-run classification and
unavailable terminal conclusions. Root independently reproduced the fresh
intent guard's necessity in an isolated mutation and passed nine targeted
correction cases. Scoped Biome checked 18 files; inventory, docs, and diff
checks passed. No workflow dispatch, activation, or production mutation occurred.

## Task 9: Final evidence anchor and publication

**Files:** Create `recovery/finalize.mjs`, `test/recovery-finalize.test.mjs`.

- [x] Write tests for the nonrecursive finalization inventory, lost upload/body/
  publish responses, later title/body edits including removal of the marker,
  extra assets, invalid finalization, and exact no-op replay.
- [x] Run `node --test scripts/release/test/recovery-finalize.test.mjs` for red.
- [x] Build `recovery-v2-finalization.json` from the accepted audit selection plus
  permitted audit bookkeeping. Inventory includes every other final asset, not
  itself. Render canonical title/body from semantic metadata plus the computed
  finalization digest. No field hashes the body that embeds its own digest.
- [x] The upload freeze begins as soon as the canonical finalization asset exists,
  even if its upload response was lost or the marker still says `AUDIT_VERIFIED`.
  Every writer entrypoint checks this before any new evidence upload or audit
  dispatch. Re-read finalization bytes, then write `PUBLICATION_READY`. Existing
  valid finalization is reused; an ineligible selection blocks without overwrite
  or silent new audit.
- [x] Interrupt immediately after finalization upload, before the marker update.
  Attempt every receipt-producing entrypoint and require zero new uploads;
  retry must reconstruct readiness from existing finalization bytes alone.
  Extend read-only observation to expose the independently verified existing
  finalization proof when a draft marker is missing or corrupt, so repair can
  consume those facts without fabricating a persisted marker.
- [x] After fresh registry/tag/asset/fence checks, publish the existing draft;
  re-observe immutable assets/tag and derive completion. Never write a complete
  stamp afterward. Future mutable display edits report drift without reopening
  ownership or npm publication.
- [x] Run the task tests and routing tests together; prove a marker claiming
  readiness without its finalization asset cannot publish. Commit.

Task 9 is implemented and independently reviewed as dormant code. The final
controller suite passed 2,875 tests with zero failures in about 150 seconds.
Root passed four targeted lifecycle checks and two isolated mutation experiments:
removing the metadata bound failed its regression, and removing the managed
verifier lease failed both nested-timeout regressions. Specification and quality
reviews approved the corrected lifecycle, including late verifier rejection and
delayed disposal. The affected correction suite passed 351 tests. Scoped Biome
checked 12 files; release inventory, docs and diff checks passed. No release
mutation, workflow dispatch, activation or publication occurred.

## Task 10: Compose CLI, workflows, and truthful outcomes

**Files:** Create `recovery/runtime.mjs`, `recovery/cli.mjs`,
`test/recovery-cli.test.mjs`, `test/recovery-workflow.test.mjs`, and the two
workflow files in the map. Modify `package.json` to add `release:recover:inspect`
as a read-only CLI wrapper; keep mutation available only through explicit commands.

Runtime preparation found three missing production adapters: trusted
repository/invocation/numeric-job observation, repository immutability policy
read, and legacy-fence observation. Add bounded GET-only GitHub methods and
a small recovery fence-contract module with digest-derived git locators.
Keep the contract directory empty until actual service rehearsal is reviewed;
a disabled workflow flag alone cannot authorize recovery.

Implement Task 10 in two sequential reviewed slices: first the missing read
adapters and [fence contract](../specs/2026-09-05-recovery-fence-contract.md), then
runtime/CLI/workflows. This keeps source ownership and review boundaries clear.

- [x] Implement and independently review the production read-adapter slice:
  repository/run/numeric-job identity, a confined immutable-policy credential,
  complete all-SHA workflow drainage, and canonical fence contract/evidence
  validation. Keep policy dormant and contract/evidence directories empty.
  Spec and quality reviews approved the final implementation. The final focused
  adapter/policy run passed 162 tests, pin checks passed 18 tests, and the root
  interval-guard mutation made all three seed/dispatch/rerun causality regressions
  fail. Recorded timestamp precision is handled through feasible ordered
  execution intervals, without general clock-skew tolerance. This completes
  Task 10a only; actual service proof and runtime wiring remain outstanding.
  The final full controller run passed all 2,973 tests in 149.51 seconds. Scoped
  Biome (14 files), release inventory, docs completeness, and whitespace checks
  passed. Final controller evidence is retained at
  `/tmp/dawn-recovery-task10a-controller-verified.log`; independent final spec and
  quality runs passed 83 and 142 focused tests respectively.
- [x] Implement strict subcommands: `inspect`, `adopt`, `smoke`,
  `reconcile-verification`, `dispatch-audit`, `audit`, `reconcile-audit`,
  `finalize`, `publish`, and `report`. Each accepts bounded named input paths,
  parses canonical objects, and rechecks authority relevant to its effects.
  `inspect --request <path> --output <path>` never constructs a write adapter.
  Provide a distinct read-only pre-adoption inspection path: the strict writer
  observer currently requires an already committed adoption record even for
  `NPM_COMPLETE`. Empty admission must yield useful original-payload evidence
  and an explicitly unreserved/blocked report, without injecting a proposed
  record into trusted git reads or authorizing a writer. Proposed records remain
  outside the active admission path for the later activation review.
  Keep pre-adoption output in a distinct diagnostic envelope with an
  `originalPayload` proof section, rather than returning the writer model's
  `facts`. Share the original artifact/tag/npm verification internally; do not
  add a permissive mode to `observeRecoveryCandidate`. A proposed intent binds
  the inspected policy digest and must be regenerated after any admission-policy
  change; its presence is never evidence of a committed reservation.
- [x] Test every wrong/missing input, early failed guard, writer-unavailable phase,
  skipped required job, audit failure, and actual completed observation.
  Test report output even when command execution fails. Sanitize failure detail.
- [x] Use this explicit recovery graph with phase predicates generated/tested
  against `model.mjs`: `admit -> adopt-or-observe -> five smoke jobs ->
  reconcile-verification -> dispatch-audit -> reconcile-audit -> finalize ->
  publish -> report`. Resume paths consume durable evidence, not outputs from
  jobs skipped on that invocation. Audit-ready resumes do not rerun smoke.
- [x] Keep jobs that receive publication contents-write separate from smoke
  subprocesses. Recovery admission/metadata/audit-reader jobs may require
  contents-write for draft visibility; no tokens flow into smoke commands.
  Audit dispatch alone needs actions-write. No OIDC, npm token, build, pack, or
  package lifecycle script runs in the metadata writer jobs.
- [x] Supply the immutability-policy GET through a separate read-only policy
  credential/channel, confined to that adapter and metadata jobs. The endpoint
  requires Administration(read), which ordinary contents-write alone does not
  document. Never grant administration-write or pass this credential to smoke
  processes. Missing/denied policy proof blocks before publication effects.
- [x] Every checkout uses `github.sha`; each workflow requires expected SHA
  equality. Align dormant recovery policy and fixtures with the repository's
  actual Node 24.19.0 / bundled npm 11.17.0 pair, pnpm 10.33.0, and pinned
  actions. The earlier Node 24.17.0 profile bundles npm 11.13.0 and would
  fail the required npm verifier check. Avoid injecting
  workflow input strings directly into shell program text; pass environment
  strings or validated canonical request files.
- [x] Wire audit job `recovery-audit` and owner escrow job
  `recovery-audit-evidence` to Task 8's exact provenance contracts. The audit
  artifact `recovery-v2-audit-result-${runId}-${attempt}-${jobId}` contains
  exactly one same-basename `.json`. Use API-observed numeric job identity;
  `GITHUB_JOB` is a symbolic name. Require all ten named checks, including
  actual verifier cleanup, before accepting a successful result.
- [x] Recovery uses `dawn-release-controller`, cancellation false, queue max.
  Independent audit uses a distinct group and bounded timeout; it can run while
  the parent holds the writer group. Set audit polling below parent job budget.
  Phase budgets live in policy; workflow timeout literals are generous outer
  bounds enforced by contract tests, never independent retry rules.
- [x] Final report uses `always()` and explicit result checks. Missing required
  work cannot imply completion. Exit 0 only for proven completion (with optional
  display-drift warning) or an explicitly labeled dispatch-only handoff; waiting
  or blocked recovery reports remain non-success. Hard runner loss is identified
  on the next observation.
- [x] Run `node --test scripts/release/test/recovery-cli.test.mjs scripts/release/test/recovery-workflow.test.mjs`.
  Mutate a required dependency or remove an `always()` recovery guard, require
  failure, restore, then commit with workflows dormant through empty admission.

Task 10b is implemented and independently reviewed as dormant code. The final
controller suite passed 3,023 tests with zero failures in 152.09 seconds;
scoped Biome checked 23 files, and inventory, docs, and diff checks passed.
Final specification checks passed 75 tests; independent quality review passed
94. Review corrections made reservation status truthful, retained bounded
outcome context, corrected metadata-repair guidance, and excluded the policy
credential from attestation subprocesses. Historical starting phase and completed
mutation telemetry are explicitly unavailable in the diagnostic envelope;
current durable evidence and receipt locations are independently observed.
Root's isolated environment-projection mutation failed its regression, then
passed after restoration. The definitive controller log is
`/tmp/dawn-recovery-task10b-controller-verified.log`. No live dispatch, activation,
policy credential provisioning, or release mutation occurred.

## Task 11: Extend workflow policy and release closure pins

**Files:** Modify `test/workflow-contracts.test.mjs`,
`test/fixtures/workflow-entrypoints.json`,
`test/fixtures/workflow-safe-executables.json`,
`test/fixtures/release-script-hashes.json`, and applicable abandonment policy
fixtures under `scripts/release/`. Modify owner checks only where new workflow
authority actually requires it; preserve npm's sole owner `release.yml`.

- [x] Add tests for the two new workflow identities, exact allowed methods,
  scopes, SHA guards, empty adoption defaults, and independent-audit group.
  Distinguish allowed version 2 GitHub publication from npm publication ownership.
- [ ] Resolve the live platform-workflow topology gap before claiming fence
  feasibility. A complete 15-workflow API response also includes
  `342414828` / `dynamic/agents/copilot-pull-request-reviewer` and `272837823` /
  `dynamic/dependabot/dependabot-updates`; neither has workflow bytes in Git.
  The current contract cannot represent them. Do not filter these entries or
  infer absent write authority from their names. Any platform-owned contract
  variant needs explicit reviewed identity, service/configuration trust, and
  applicable fencing evidence; unsupported authority keeps admission blocked.
  See the [platform workflow assessment](../specs/2026-09-05-platform-workflow-fence-assessment.md)
  for observed permissions, configuration boundaries, and required service tests.
  The raw read-only inventory is retained at
  `/tmp/dawn-recovery-live-workflows-20260905.json`.
- [x] Extend closure discovery to every new static/dynamic entrypoint and
  `recovery/policy.json`. Adoption data is independently git-reviewed and bound
  by its digest; unknown/unreviewed records still confer no runtime authority.
- [x] Recompute each content pin from actual final bytes using SHA-256; update
  the fixture's aggregate hash and readable execution allowlist together.
  Preserve existing workflow contracts instead of broadening catch-all patterns.
- [x] Run `node --test scripts/release/test/workflow-contracts.test.mjs` and then
  `pnpm test:release-controller`. As earlier tasks change imported source,
  maintain affected pins in those commits too; this task verifies complete
  final reachability and ownership coverage.
- [x] Add an unpinned imported module and a forbidden npm command in a fixture,
  verify both fail, restore, and commit the final pin/policy changes.

The software closure and ownership checks were completed with Task 10b and
included in both independent reviews. Root's isolated source-copy experiment
passed its baseline, rejected an unpinned transitive import and an npm publish
command in the recovery workflow for their intended reasons, then passed after
restoration. Evidence is in `/tmp/dawn-recovery-task10b-root-mutations.log`.
The platform-workflow representation and service proof remain unresolved;
these passing code checks do not establish live fence feasibility.

## Task 12: Local fault rehearsal and real GitHub contract lane

**Files:** Create `test/recovery-rehearsal.test.mjs`,
`test/support/recovery-rehearsal.mjs`,
`test/recovery-github.integration.mjs`, and
`test/fixtures/recovery-contract-workflow.yml` under `scripts/release/`.
Update `test:release-fault-harness` to include the new local rehearsal explicitly.
For measured efficiency work, extend `scripts/release/npm-audit.mjs` with a
batch API and its tests, wire recovery observation to that API, and add a
small bounded byte-reuse module plus dedicated tests. Keep legacy verifier
methods unchanged. Add the bounded eligible-host check to `ci.yml` and its
workflow contract tests. Maintain actual transitive pins in the same change.

Execute this task in sequential reviewed slices: first fresh complete-inventory
npm verification; then invocation-scoped payload reuse and the initial managed
observation settlement gap; then the full fault rehearsal and dedicated service
and Linux entrypoints. This separates performance changes from rehearsal
infrastructure without weakening any final gate. Keep the same underlying writer
transport identity across retries; a read-cache wrapper must not create a new
identity that discards unsettled-write exclusion. Prefer reusing the existing
writer transaction and verifier lease for initial controller reads when that
preserves the read-only boundary, rather than adding another lifecycle manager.

- [x] Slice 12a: add fresh exact-inventory npm batching while preserving legacy
  verifier methods. Independent specification and quality reviews approved the
  final source; all 3,072 controller tests passed in 150.48 seconds. The 19-write
  fixture reduced signature commands from 861 to 41; transfer counts remain for
  slice 12b. The actual new verifier also passed all 21 production packages in
  one official npm 11.17.0 audit command. Evidence:
  `/tmp/dawn-recovery-task12a-controller-verified.log`,
  `/tmp/dawn-task12a-observation-cost.json`, `/tmp/dawn-task12a-real-npm.json`.
- [x] Slice 12b: bounded invocation-only payload reuse and initial managed
  observation settlement. Root reviewed the implementer's frozen source and
  independently measured each phase; all 3,096 controller tests passed in
  146.74 seconds. The platform rejected both new and resumed review agents at
  its thread limit, so specification and quality review were performed directly
  by root, not represented as additional agent approvals. Isolated mutations
  restored the old unmanaged adoption read and left a cache generation open;
  both failed the intended regression, with all 24 regressions passing before
  and after restoration. Evidence: `/tmp/dawn-task12b-root-review.json` and
  `/tmp/dawn-recovery-task12b-controller-verified.log`.
- [ ] Slice 12c: production-adapter fault rehearsal, explicit service-probe
  entrypoint, and eligible Linux runner CI evidence.

- [x] Reuse production effects and adapters against disposable local HTTP/npm
  fixtures, with independent readback. Exercise the whole legacy adoption ->
  five lanes -> audit -> finalization -> publish -> no-op -> next-version path.
  Interrupt after every external effect. Separate fixture trust roots from
  production; never add an environment bypass to production signature checks.
- [x] Run `node --test --test-concurrency=1 scripts/release/test/recovery-rehearsal.test.mjs`.
  Expected: each fault resumes with unchanged payload bytes or an intentional,
  specifically classified conflict. Require zero duplicate drafts or republish
  attempts, and exact retained evidence inventory. Retain deterministic regressions
  for cancellation that remains unsettled after a write timeout across writer
  recreation, and a late observation resolving after the phase deadline; neither
  may permit a late or overlapping mutation. Task 5 quality review verified
  these cases with independent probes.
- [x] Measure the production-adapter work per complete recovery phase. The
  Task 7 deterministic fixture exposed 2,322 Release-asset downloads, 861
  npm tarball downloads, and 41 npm-audit setups for 19 writes. Reduce
  repeated payload transfer/setup within one invocation before calling the
  pipeline ready. Examine batching the exact inventory in one official npm
  signature command per fresh observation while preserving every package
  trust binding and complete-set validation. Reuse bounded payload bytes only
  against independently fresh exact identities; caches never authorize a transition. Preserve
  fresh mutation guards, verifier cleanup/settlement, and the independent
  audit workspace. Test changed IDs/digests, cache corruption, expiry,
  deadlines, and interrupted resume, and report measured before/after
  counts without presenting fixture timings as production performance.
  A separate late-phase fixture baseline recorded audit escrow at 546 Release
  downloads / 168 npm tarballs / 8 verifier factories for 3 writes; finalization
  at 418 / 126 / 6 for 2 writes; publication at 210 / 63 / 3 for 1 write; and
  published no-op at 70 / 21 / 1 for zero writes. The exact observed source
  hashes and stage counts are in `/tmp/dawn-task12-late-phase-cost.json`.
  This sample used a fixture-supplied audit result and the 55347198-based worktree
  during Task 10b; it is not a complete service rehearsal or an npm timing claim.
- [ ] Prepare a GitHub contract harness with an explicit disposable repository
  allowlist, fixture-owned ID ledger, and cleanup limited to those resources.
  Require `DAWN_TEST_RECOVERY_GITHUB=1` and a separately supplied authorized test
  repository; fail before writes if absent or equal to production. Ordinary
  `pnpm test` must not create external resources.
- [ ] Exercise real pagination, opaque-tag drafts, token visibility, exact asset
  upload/download, unknown-response retries, default-branch dispatch identity,
  job skip behavior, and failed-job-only reruns. Use the production job topology
  and validate any fixture command substitutions explicitly. These are GitHub
  API/workflow contracts, not proof that synthetic packages have npm provenance.
  Rehearse publication against an existing annotated tag using the intended
  credential, including GitHub workflow-file authorization rules when the
  resolved target differs from the default branch. Do not infer credential
  sufficiency from a local fixture or broaden permissions before this rehearsal.
- [ ] Specifically disable the disposable legacy workflow and test fresh
  dispatch, whole-run rerun, and job-only rerun. A proposed operational fence is
  accepted only if observed service behavior prevents all unsafe writers and
  active executions are drained. If not, report the ownership design blocked;
  do not invent a successful fence from a disabled status flag.
- [ ] The future authorized command is
  `DAWN_TEST_RECOVERY_GITHUB=1 node --test scripts/release/test/recovery-github.integration.mjs`.
  Record exact repository/run/attempt/resource IDs and cleanup results.
- [ ] Wire the gated strict-runner integration into a bounded read-only CI job
  on actual `ubuntu-24.04`, using pinned checkout and Node actions. It needs
  neither publication authority nor a production adoption. This supplies the
  eligible-host evidence that macOS cannot provide; do not spoof host fields.
- [ ] Separately exercise production package/attestation verification read-only;
  do not weaken repository identity to make disposable npm evidence appear real.
- [ ] Commit rehearsal code and evidence summary. Distinguish unrun external
  checks from passed local checks in every status report.

## Task 13: Run final implementation gates and prepare activation review

**Files:** Complete
`docs/superpowers/runbooks/2026-09-04-postpublication-recovery.md` with the
tested admission/fencing/retry operations and references to actual rehearsal
evidence. Do not add a production adoption record in this commit.

- [x] Preserve Vercel deployment-failure diagnostics before the next real CI run.
  `runNativeDeploymentKind` writes `source-deploy-failure.log` and
  `prebuilt-deploy-failure.log`, but `NATIVE_UPLOAD_ARTIFACT_NAMES` currently
  omits both. Add the two already-redacted diagnostics to the bounded upload
  allowlist and exercise writer-to-upload behavior for both kinds, retaining
  secret checks and filesystem guards. This fixes lost diagnostic evidence;
  it does not establish the underlying deployment failure's cause.
- [x] Correct the independently reproduced PID-readiness fixture defect before
  final gates: wait for a validated descendant PID, retain it for guarded
  cleanup observation, and add a barrier-based empty-marker regression. Keep
  all descendant-termination and token/cluster cleanup-order assertions. Add
  failure diagnostics that distinguish invalid PID publication from actual
  unconfirmed containment. The earlier full-CI failure is not yet attributed
  to this defect; do not call it resolved solely from the controlled repro.
The two confirmed CI fixture defects were corrected before the larger Task 12c
rehearsal so final validation can retain meaningful failures. Both Vercel modes
failed first because their written diagnostics were omitted from upload; after
adding the two names, the complete lane unit suite passed 299 tests (one existing
external opt-in test skipped). PID readiness failed first for the deterministic
empty-marker barrier and nine invalid values; all 115 harness tests passed after
validated PID retention and guarded cleanup. Both affected TypeScript projects
passed. Logs: `/tmp/dawn-task13-vercel-{red,green}.log`,
`/tmp/dawn-task13-pid-{red,green}.log`, and the two
`/tmp/dawn-task13-*-typecheck.log` files. Neither historical CI root cause is
claimed resolved by these fixture fixes; full CI remains required below.

- [ ] Run `pnpm ci:validate` at the final implementation head. It includes lint,
  build-cache, build, typecheck, source tests, inventory, controller tests, docs,
  packing, TypeScript tooling, and harness lanes. Run
  `pnpm test:release-fault-harness` and the applicable strict-runner/GitHub lanes.
  Run `node scripts/check-changesets.mjs` under the same base/head environment
  as CI if any user-facing package files changed. Pure release scripts need no
  fabricated package changeset.
- [ ] Complete required CI including relevant real Vercel/CopilotKit boundaries;
  do not label local-only checks as equivalent to the repository's CI evidence.
  Review actual diffs and tests using @superpowers:requesting-code-review.
- [ ] Prepare a read-only `inspect` request for the exact current candidate,
  confirm canonical release ID/body digest/manifest/tag/npm evidence, and produce
  the proposed adoption record in an output directory outside the active
  admission path. Re-observe before approval; no old timestamp is release authority.
- [ ] Present the exact controller commit, proposed record, fresh report, proof
  of the legacy-writer fence, and expected remote effects. Production record
  merge/reservation, any workflow disabling, and recovery dispatch are separate
  reviewed operations. No gate bypass or marker edit is an acceptable substitute.
- [ ] After separately authorized activation, verify all five real lanes, the
  independent audit, immutable finalization, no-op replay, and next-version
  arbitration. If a lane fails, leave the candidate blocked and diagnose it.
  Do not mark this plan's live-recovery objective complete from code completion.

## Completion accounting

Track three outcomes separately: implementation ready, disposable rehearsal
verified, and production candidate completed. The plan is complete as a document
after independent review and reference checks. Executable implementation requires
the tests above. Live recovery requires the separately authorized activation and
fresh terminal evidence. Keep original tag/tarball/provenance identity visible in
all three reports.


### Task 12c local verification update

The complete production HTTP adapter rehearsal passed 67 tests, including
interruptions before and after all 32 durable writes (64 fault cases), in
545.83 seconds. Every case reached COMPLETE with the original 45 assets,
no duplicate uploads, no repeated audit request IDs, no duplicate drafts,
no npm publication, a zero-write published retry, and next-version selection.
Fixtures supply npm/attestation trust, five lane artifacts, admission/fence
callbacks, and immutable-release policy; this is not live smoke or provenance
proof. Log: `/tmp/dawn-task12c-full-rehearsal.log`.

The real GitHub workflow-fence entrypoint now prepares distinct historical and
current fixture revisions and tags, retains the pre-advance seed lineage,
collects the full 36-case matrix with paginated all-SHA inventories, restores
and drains after ambiguous effects, and projects untouched raw calls through
the production evidence validator. Its executable closure is pinned as 13
files. Six new local service-driver tests and the existing fence, policy,
workflow and runner-gate tests passed (224 total). Log:
`/tmp/dawn-task12c-focused.log`. The external lane is still unrun: no authorized
disposable repository has been supplied. Publication/credential service
contracts and the platform workflow topology gap remain open.

The bounded read-only Ubuntu job is wired. The negative-host regression was
verified failing against the former skip behavior and passing after the fix.
A macOS opt-out is reported as skipped, never eligible-runner evidence. Actual
Linux CI and the complete final implementation gates remain pending.
