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
| `observe.mjs` | Independently verified candidate/registry/asset facts, version 2 discovery |
| `model.mjs` | Pure transition planning, terminal completion and display-drift classification |
| `writer.mjs` | Version 2-only bounded GitHub upload/body/publication effects |
| `adopt.mjs` | Legacy archive, retained migration receipts, ownership transition |
| `smoke.mjs` | Version 2 lane execution and receipt provenance; existing probe operations reused |
| `evidence.mjs` | Actions receipt correlation, release escrow, complete verification-set selection |
| `audit.mjs` | Exact independent dispatch/correlation and fresh external audit |
| `finalize.mjs` | Finalization asset, canonical metadata rendering, publication/re-observation |
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

- [ ] Run `pnpm install --frozen-lockfile`, `pnpm build`, then
  `pnpm test:release-controller`. Record actual baseline failures separately;
  investigate relevant failures before changing behavior. Inspect open #568 for
  the known process-tree test issue; do not assume it has merged.
- [ ] Extract the exact candidate's workflow and full imported executable closure
  through `git show` into a temporary fixture, preserving original imports. Never
  execute a production entrypoint with live write credentials during this test.
- [ ] Create a recording HTTP transport that accepts real GitHub request shapes,
  models the opaque-tag draft and exact annotated tag, and records every attempted
  POST/PATCH/upload. Exercise escrow, npm reconciliation, smoke reconciliation,
  audit recording/correlation, and release publication with historical inputs.
- [ ] First demonstrate that the unsafe assumption is false: an assertion of zero
  legacy escrow effects must fail on the frozen implementation with a version 2
  opaque-tag draft. Preserve the real attempted request as fixture evidence.
- [ ] Change the regression to require classification `legacy-fence-required`
  when any writer can mutate. Do not alter the frozen implementation. Enumerate
  which historical run/job output paths make that writer reachable. Classification
  here is a recording-fixture report; production admission consumes and verifies
  the corresponding authority evidence in Task 3.
- [ ] Run `node --test scripts/release/test/recovery-legacy-fence.test.mjs`.
  Expected: the hazard is reproduced and admission denies it, never a fake claim
  that all old code rejects version 2.
- [ ] Commit these tests and the admission finding. Activation cannot proceed
  until Task 12 has validated a real fence for any unsafe replay path.
- [ ] Prepare the minimal disposable workflow-disable/rerun experiment using
  Task 12's repository allowlist and authorization constraints. Run it as soon
  as a disposable repository is authorized, preferably before broad controller
  implementation. A negative result triggers ownership-design revision then;
  do not defer a known feasibility decision until the entire pipeline is built.

## Task 2: Add strict schemas and a pure transition model

**Files:** Create `recovery/schema.mjs`, `recovery/model.mjs` under the production
directory above; create `test/recovery-schema.test.mjs`,
`test/recovery-model.test.mjs`, and `test/support/recovery-fixture.mjs` under
`scripts/release/`.

- [ ] Write table-driven tests for every wire kind and phase prerequisite. Use
  positive fixtures that describe real identifiers and receipt relationships;
  reject wrong source/executor identity, duplicate lanes/assets, bad JSON bytes,
  missing evidence, over-limit values, and unknown schema versions.
- [ ] Run `node --test scripts/release/test/recovery-schema.test.mjs scripts/release/test/recovery-model.test.mjs`;
  verify failure is the missing behavior/export, then implement the parsers.
- [ ] Implement the pure planner with the spec's six phase transitions. It accepts
  verified facts, never an effects adapter. A classified state without a matching
  executor capability returns blocked before an effect can be selected.
- [ ] Add this regression using the complete fixture helper from this task:

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

- [ ] Derive terminal publication from finalization asset plus external immutable
  release/tag proof; represent later title/body edits as `displayDrift` separate
  from completed ownership. Missing immutable proof is an integrity block.
- [ ] Re-run focused tests, mutate away one phase prerequisite and require failure,
  restore it, and commit. Do not export a setter that writes arbitrary phases.

## Task 3: Add policy, invocation authority, and empty admission

**Files:** Create `recovery/policy.mjs`, `recovery/policy.json`,
`recovery/authority.mjs`, `recovery-adoptions/.gitkeep`,
`test/recovery-authority.test.mjs`, `test/recovery-policy.test.mjs`.

- [ ] Test missing/malformed/mismatched intents, wrong actual workflow SHA, an
  unmerged controller, failed/absent CI, a different repository, unsupported
  policy, and a legacy-fence-required result without verified fencing evidence.
- [ ] Run `node --test scripts/release/test/recovery-authority.test.mjs scripts/release/test/recovery-policy.test.mjs`
  and verify red before implementation.
- [ ] Require main-ref invocation and equality of expected SHA with actual
  invocation SHA. Use independently observed main ancestry and successful CI
  at that SHA. Read intent bytes from that immutable checkout through the git
  reader; CLI strings never grant authority.
- [ ] Policy lists the five exact lanes, mandatory checks, approved verifier
  executable closure digest, supported receipt versions, environment profile,
  and retry budgets. Hash verifier source inputs without hashing policy.json
  into itself. The separate repository import-closure pins cover all code/data.
- [ ] Centralize retry classification: 15-second reads, at most five transport
  retries bounded by 90 seconds per operation, bounded Retry-After; reuse the
  registry's existing propagation classification and enforce an overall phase
  deadline. Schema/identity/signature failures never retry. Test injected clocks.
- [ ] Make verified fence evidence a prerequisite to adoption and every later
  write while unsafe legacy reruns remain reachable. An expired/missing fence
  observation blocks. No enabling/disabling API is called by this module.
- [ ] Re-run tests, prove an arbitrary `controllerSha` input cannot authorize
  execution, and commit with no production adoption record.

## Task 4: Observe artifacts and route versioned ownership

**Files:** Create `recovery/observe.mjs`, `test/recovery-observe.test.mjs`,
`test/recovery-routing.test.mjs`. Modify `candidate.mjs`, `observe.mjs`,
`cli.mjs`, `observation-schema.mjs`, `state.mjs`, `planner.mjs`, `evidence.mjs`,
`conflicts.mjs`, `independent-audit-coordinator.mjs`, `post-publication-audit.mjs`.

- [ ] Test an exact reserved legacy draft, adopted draft, complete version 2
  release with corrupt/absent body marker, unknown version, removed intent,
  duplicate drafts, absent registry package, conflicting tarball, and a newer
  candidate. Preserve version 1 incident fixtures unchanged.
- [ ] Run `node --test scripts/release/test/recovery-observe.test.mjs scripts/release/test/recovery-routing.test.mjs`
  to establish red.
- [ ] Independently verify base manifest/record, exact tarballs, original
  attestation bundle, npm package source/bytes, canonical Release ID, and exact
  annotated tag. Reuse low-level verification functions; do not construct a fake
  version 1 observation to get version 2 through old assertions.
- [ ] Consult ownership before legacy marker classification. Add a distinct
  recovery-owned selection/disposition that legacy CLI maps to no continuation,
  and a verified recovery-terminal selection for candidate arbitration. Do not
  reuse `SMOKES_COMPLETE` or forge `evidence.assets.publishedExact`.
- [ ] Wire all invocation types through the same ownership router. A reserved
  candidate without an active recovery run reports recovery-required, not a
  successful no-op. Every incomplete recovery-owned candidate blocks newer
  publication; terminal proof lets newer candidates proceed.
- [ ] Published discovery uses tag + canonical Release ID and the fixed final
  asset name even after title/body edits. Read-only scheduled legacy audit routes
  version 2 into its compatible observer or reports explicit unsupported mode;
  it never sends new evidence to the candidate's frozen audit executor.
- [ ] Run focused tests plus candidate/state/planner/observation/coordinator
  suites with `node --test` on their exact files. Mutate the router to fall back
  on parse failure and require the ownership regression to fail. Commit.

## Task 5: Implement the bounded version 2 writer and adoption

**Files:** Create `recovery/writer.mjs`, `recovery/adopt.mjs`,
`test/recovery-writer.test.mjs`, `test/recovery-adopt.test.mjs`.
Use `adapters/github.mjs` reads and existing normalization/HTTP transport.

- [ ] Write failing transport tests that enumerate the only allowed effects:
  upload a permitted recovery asset to the exact Release ID, update that draft's
  canonical version 2 body, and publish that same draft after final verification.
  Forbid draft creation/deletion, tag changes, arbitrary URLs, npm calls, and
  overwriting differing bytes. Do not broaden the legacy writer.
- [ ] Run `node --test scripts/release/test/recovery-writer.test.mjs scripts/release/test/recovery-adopt.test.mjs`.
- [ ] Implement read-compare-write-read under the verified fence; validate
  argument identity and phase before any write. Treat uncertain responses as
  re-observation, never proof that the write did not happen.
- [ ] Adoption validates exact legacy `NPM_COMPLETE`, archives its raw body,
  uploads attempt-qualified npm/authority/adoption receipts, re-downloads them,
  then writes revision 1 `RECOVERY_ADOPTED`. Derive base inventory from the
  verified original record; do not modify original assets.
- [ ] Interrupt after each upload and body update. Resume with same and changed
  controller/run identities; select existing canonical timestamps when replaying
  an attempt, retain valid earlier attempts, reject foreign recovery assets.
- [ ] Prove a fence lost before mutation, changed legacy body, or incomplete npm
  inventory produces zero effects. Restore mutation tests and commit.

## Task 6: Reuse actual probes with version 2 receipts

**Files:** Create `recovery/smoke.mjs`, `test/recovery-smoke.test.mjs`.
Modify `smoke/runtime-targets.mjs`, `smoke/scaffold.mjs`, `smoke/storage.mjs`,
`smoke/published-harness.mjs`, `smoke-result.mjs`, and
`scripts/published-artifact-verify.mjs` only at their operation/receipt boundary.
Add `test/recovery-strict-runner.integration.mjs` for Linux infrastructure checks.

- [ ] Write identity tests with candidate A and executor B. Require B in executor
  evidence, A in package identity, all mandatory checks, and failure on bad
  cleanup. Confirm existing version 1 entrypoints still emit identical schemas.
- [ ] Extract existing probe operations from their version 1 receipt wrappers
  into named functions in those same modules. Keep strict runner construction,
  allowed command fields, package versions, and assertions intact. Recovery
  invokes those operations with a version 2 collector; it does not manufacture
  a successful v1 result or spoof any GitHub environment variable.
- [ ] Give metadata the same separation: run its actual exact-package byte and
  provenance checks, then serialize under the selected receipt protocol.
- [ ] Capture the environment/toolchain and complete installed dependency tree
  during each install check, before temporary directories are removed. Bind
  canonical resolution bytes or separately bounded digest-qualified assets.
  Record actual Docker image identity for storage/sandbox checks, not just a tag.
- [ ] Run `node --test scripts/release/test/recovery-smoke.test.mjs scripts/release/test/runtime-targets-smoke.test.mjs scripts/release/test/scaffold-smoke.test.mjs scripts/release/test/storage-smoke.test.mjs scripts/release/test/published-harness-smoke.test.mjs scripts/release/test/smoke-result.test.mjs`.
- [ ] On an eligible Ubuntu runner, run
  `DAWN_TEST_RECOVERY_RUNNER=1 node --test scripts/release/test/recovery-strict-runner.integration.mjs`.
  Exercise real systemd execution and cleanup with the exact strict option
  allowlist; classify an ineligible local OS as explicitly skipped, not passed.
- [ ] Commit only after old receipt behavior and new identity tests pass. Never
  reclassify the sandbox PID assertion as a harmless flake to finish this task.

## Task 7: Escrow complete verification and provenance

**Files:** Create `recovery/evidence.mjs`, `test/recovery-evidence.test.mjs`.

- [ ] Test every missing/failed lane, duplicate/foreign artifact, incorrect
  job/run/attempt/SHA, noncanonical receipt, forged self-claimed identity, and
  interrupted escrow. All five selected receipts must belong to one run/attempt.
- [ ] Run `node --test scripts/release/test/recovery-evidence.test.mjs` for red.
- [ ] Correlate API-observed workflow/run/jobs and exact artifact IDs/digests;
  download bounded ZIPs and require their exact files/bytes. Then upload raw
  receipts plus independently observed provenance descriptors to the release.
- [ ] Persist a complete immutable selection including retained receipt inventory,
  re-read it, then advance to `VERIFICATION_COMPLETE`. Missing/failed checks stay
  nonterminal with diagnostic receipts. A repeat with durable selection is a
  no-op, independent of Actions download retention.
- [ ] Test expiry before escrow blocks missing proof, while expiry after valid
  escrow succeeds without downloading the expired artifact. Reject a fabricated
  descriptor with no accepted trusted escrow chain. Commit after tests pass.

## Task 8: Independent audit dispatch and correlation

**Files:** Create `recovery/audit.mjs`, `test/recovery-audit.test.mjs`.
Add a narrowly scoped default-branch dispatch method to `recovery/writer.mjs`;
do not loosen the legacy exact-tag dispatch API.

- [ ] Test actual auditor SHA mismatch, main advancing during dispatch, wrong
  verification-set selection, failed audit, missing result, foreign run, and
  ambiguous dispatch acceptance. Require direct returned run identity.
- [ ] Run `node --test scripts/release/test/recovery-audit.test.mjs` for red.
- [ ] Persist uniquely named intent before dispatch. Use the current supported
  API response to capture run ID; verify actual head SHA equals expected audited
  controller SHA. Uncorrelated attempts are retained but never selected.
- [ ] The auditor re-downloads registry/release evidence into its own clean
  workspace and performs all spec checks. API provenance must match the
  recovery evidence policy; uploaded JSON's own assertions are insufficient.
- [ ] Persist and re-read the correlated dispatch before `AUDIT_PENDING`; escrow
  a successful matching audit before `AUDIT_VERIFIED`. Never scan recent runs
  to guess a lost identity. A newly dispatched attempt must have a new request ID.
- [ ] Distinguish admission mismatch from a dispatch-time race. Admission SHA
  mismatch produces zero effects. An unexpected auditor SHA discovered after
  dispatch retains the already-uploaded intent and a classified failed-attempt
  receipt, never selects that audit, and never advances to verification or
  publication. Test both boundaries. Restore mutation tests and commit.

## Task 9: Final evidence anchor and publication

**Files:** Create `recovery/finalize.mjs`, `test/recovery-finalize.test.mjs`.

- [ ] Write tests for the nonrecursive finalization inventory, lost upload/body/
  publish responses, later title/body edits including removal of the marker,
  extra assets, invalid finalization, and exact no-op replay.
- [ ] Run `node --test scripts/release/test/recovery-finalize.test.mjs` for red.
- [ ] Build `recovery-v2-finalization.json` from the accepted audit selection plus
  permitted audit bookkeeping. Inventory includes every other final asset, not
  itself. Render canonical title/body from semantic metadata plus the computed
  finalization digest. No field hashes the body that embeds its own digest.
- [ ] The upload freeze begins as soon as the canonical finalization asset exists,
  even if its upload response was lost or the marker still says `AUDIT_VERIFIED`.
  Every writer entrypoint checks this before any new evidence upload or audit
  dispatch. Re-read finalization bytes, then write `PUBLICATION_READY`. Existing
  valid finalization is reused; an ineligible selection blocks without overwrite
  or silent new audit.
- [ ] Interrupt immediately after finalization upload, before the marker update.
  Attempt every receipt-producing entrypoint and require zero new uploads;
  retry must reconstruct readiness from existing finalization bytes alone.
- [ ] After fresh registry/tag/asset/fence checks, publish the existing draft;
  re-observe immutable assets/tag and derive completion. Never write a complete
  stamp afterward. Future mutable display edits report drift without reopening
  ownership or npm publication.
- [ ] Run the task tests and routing tests together; prove a marker claiming
  readiness without its finalization asset cannot publish. Commit.

## Task 10: Compose CLI, workflows, and truthful outcomes

**Files:** Create `recovery/runtime.mjs`, `recovery/cli.mjs`,
`test/recovery-cli.test.mjs`, `test/recovery-workflow.test.mjs`, and the two
workflow files in the map. Modify `package.json` to add `release:recover:inspect`
as a read-only CLI wrapper; keep mutation available only through explicit commands.

- [ ] Implement strict subcommands: `inspect`, `adopt`, `smoke`,
  `reconcile-verification`, `dispatch-audit`, `audit`, `reconcile-audit`,
  `finalize`, `publish`, and `report`. Each accepts bounded named input paths,
  parses canonical objects, and rechecks authority relevant to its effects.
  `inspect --request <path> --output <path>` never constructs a write adapter.
- [ ] Test every wrong/missing input, early failed guard, writer-unavailable phase,
  skipped required job, audit failure, and actual completed observation.
  Test report output even when command execution fails. Sanitize failure detail.
- [ ] Use this explicit recovery graph with phase predicates generated/tested
  against `model.mjs`: `admit -> adopt-or-observe -> five smoke jobs ->
  reconcile-verification -> dispatch-audit -> reconcile-audit -> finalize ->
  publish -> report`. Resume paths consume durable evidence, not outputs from
  jobs skipped on that invocation. Audit-ready resumes do not rerun smoke.
- [ ] Keep jobs that receive publication contents-write separate from smoke
  subprocesses. Recovery admission/metadata/audit-reader jobs may require
  contents-write for draft visibility; no tokens flow into smoke commands.
  Audit dispatch alone needs actions-write. No OIDC, npm token, build, pack, or
  package lifecycle script runs in the metadata writer jobs.
- [ ] Every checkout uses `github.sha`; each workflow requires expected SHA
  equality. Use the existing pinned Node/pnpm/action versions. Avoid injecting
  workflow input strings directly into shell program text; pass environment
  strings or validated canonical request files.
- [ ] Recovery uses `dawn-release-controller`, cancellation false, queue max.
  Independent audit uses a distinct group and bounded timeout; it can run while
  the parent holds the writer group. Set audit polling below parent job budget.
  Phase budgets live in policy; workflow timeout literals are generous outer
  bounds enforced by contract tests, never independent retry rules.
- [ ] Final report uses `always()` and explicit result checks. Missing required
  work cannot imply completion. Exit 0 only for proven completion (with optional
  display-drift warning) or an explicitly labeled dispatch-only handoff; waiting
  or blocked recovery reports remain non-success. Hard runner loss is identified
  on the next observation.
- [ ] Run `node --test scripts/release/test/recovery-cli.test.mjs scripts/release/test/recovery-workflow.test.mjs`.
  Mutate a required dependency or remove an `always()` recovery guard, require
  failure, restore, then commit with workflows dormant through empty admission.

## Task 11: Extend workflow policy and release closure pins

**Files:** Modify `test/workflow-contracts.test.mjs`,
`test/fixtures/workflow-entrypoints.json`,
`test/fixtures/workflow-safe-executables.json`,
`test/fixtures/release-script-hashes.json`, and applicable abandonment policy
fixtures under `scripts/release/`. Modify owner checks only where new workflow
authority actually requires it; preserve npm's sole owner `release.yml`.

- [ ] Add tests for the two new workflow identities, exact allowed methods,
  scopes, SHA guards, empty adoption defaults, and independent-audit group.
  Distinguish allowed version 2 GitHub publication from npm publication ownership.
- [ ] Extend closure discovery to every new static/dynamic entrypoint and
  `recovery/policy.json`. Adoption data is independently git-reviewed and bound
  by its digest; unknown/unreviewed records still confer no runtime authority.
- [ ] Recompute each content pin from actual final bytes using SHA-256; update
  the fixture's aggregate hash and readable execution allowlist together.
  Preserve existing workflow contracts instead of broadening catch-all patterns.
- [ ] Run `node --test scripts/release/test/workflow-contracts.test.mjs` and then
  `pnpm test:release-controller`. As earlier tasks change imported source,
  maintain affected pins in those commits too; this task verifies complete
  final reachability and ownership coverage.
- [ ] Add an unpinned imported module and a forbidden npm command in a fixture,
  verify both fail, restore, and commit the final pin/policy changes.

## Task 12: Local fault rehearsal and real GitHub contract lane

**Files:** Create `test/recovery-rehearsal.test.mjs`,
`test/support/recovery-rehearsal.mjs`,
`test/recovery-github.integration.mjs`, and
`test/fixtures/recovery-contract-workflow.yml` under `scripts/release/`.
Update `test:release-fault-harness` to include the new local rehearsal explicitly.

- [ ] Reuse production effects and adapters against disposable local HTTP/npm
  fixtures, with independent readback. Exercise the whole legacy adoption ->
  five lanes -> audit -> finalization -> publish -> no-op -> next-version path.
  Interrupt after every external effect. Separate fixture trust roots from
  production; never add an environment bypass to production signature checks.
- [ ] Run `node --test --test-concurrency=1 scripts/release/test/recovery-rehearsal.test.mjs`.
  Expected: each fault resumes with unchanged payload bytes or an intentional,
  specifically classified conflict. Require zero duplicate drafts or republish
  attempts, and exact retained evidence inventory.
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
- [ ] Specifically disable the disposable legacy workflow and test fresh
  dispatch, whole-run rerun, and job-only rerun. A proposed operational fence is
  accepted only if observed service behavior prevents all unsafe writers and
  active executions are drained. If not, report the ownership design blocked;
  do not invent a successful fence from a disabled status flag.
- [ ] The future authorized command is
  `DAWN_TEST_RECOVERY_GITHUB=1 node --test scripts/release/test/recovery-github.integration.mjs`.
  Record exact repository/run/attempt/resource IDs and cleanup results.
  Separately exercise production package/attestation verification read-only;
  do not weaken repository identity to make disposable npm evidence appear real.
- [ ] Commit rehearsal code and evidence summary. Distinguish unrun external
  checks from passed local checks in every status report.

## Task 13: Run final implementation gates and prepare activation review

**Files:** Complete
`docs/superpowers/runbooks/2026-09-04-postpublication-recovery.md` with the
tested admission/fencing/retry operations and references to actual rehearsal
evidence. Do not add a production adoption record in this commit.

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
