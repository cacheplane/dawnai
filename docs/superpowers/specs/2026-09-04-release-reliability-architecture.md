# Release reliability architecture and rollout

Date: 2026-09-04

Status: proposed architecture, following the user's instruction to continue the
release-pipeline investigation. This document does not authorize production
mutation or declare the release recovered.

Independent spec review: passed on 2026-09-04 after correcting the boundary
between immutable assets/tags and editable release title/body.

## Decision

Keep immutable release payloads, exact package identity, npm trusted publishing,
and independent verification. Separate the controller that operates a release
from the source commit that produced it. Deliver this in bounded sub-projects,
beginning with [post-publication recovery](./2026-09-04-postpublication-recovery-design.md).

The normal path remains unattended, consistent with the existing release design.
Policy exceptions require separate, explicit review. The user has not requested
a mandatory human gate for every normal release.

## Evidence and limits

Repository evidence was read at main commit
`92cae0a3771473dd040c80520de177bcee0c7765`. GitHub was re-observed on 2026-09-04.
These observations are design inputs; execution must capture fresh evidence.

- Release `382873833`, named `Dawn v0.8.24`, remains draft with 45 base assets
  and marker phase `NPM_COMPLETE`. Its candidate is
  `88c01c4afd59866fc0ea4c8f3b8444439a01c8ea`; its manifest digest is
  `68e45c7d302147f387c4cd68586a4e6411ea6a7c7889f6e2edc32a0793696e5c`.
- [PR #567](https://github.com/cacheplane/dawnai/pull/567) adds a git-resident
  adjudication that lets the state classifier return `SMOKES_COMPLETE`. It does
  not write the descriptor and receipt assets required by the marker parser.
- [Release run 33924807602](https://github.com/cacheplane/dawnai/actions/runs/33924807602)
  concluded successfully after dispatching an audit. Recording the dispatch,
  correlating the audit, and publishing the release were skipped. The candidate's
  frozen workflow lacks the newer recovery condition changes.
- [Audit run 33925263071](https://github.com/cacheplane/dawnai/actions/runs/33925263071)
  failed because the draft's durable phase was not auditable.
- [PR #562](https://github.com/cacheplane/dawnai/pull/562) tried a new version;
  the older incomplete candidate still wins arbitration.
- [PR #561](https://github.com/cacheplane/dawnai/pull/561) and
  [PR #569](https://github.com/cacheplane/dawnai/pull/569) describe test doubles
  accepting behavior the production subprocess runner and GitHub API reject.
- [PR #554](https://github.com/cacheplane/dawnai/pull/554) already parallelized
  pack and harness verification. [PR #558](https://github.com/cacheplane/dawnai/pull/558)
  reduced escrow attestation verification from 22 network calls to one plus
  local subject verification. [PR #559](https://github.com/cacheplane/dawnai/pull/559)
  handles delayed registry tarball visibility. [PR #566](https://github.com/cacheplane/dawnai/pull/566)
  pins the imported release-code closure. Preserve these gains.

The existing adjudication reports two passing lanes, two deterministic runner or
probe failures, and one sandbox flake. This investigation did not independently
re-run all packages or prove that the flake is unrelated to product behavior.
Those statements cannot substitute for new verification.

## Alternatives

| Approach | Advantage | Cost |
| --- | --- | --- |
| Continue candidate-bound patches and bespoke recovery | Small individual diffs | Cannot reliably repair frozen orchestration; recurring operator work |
| Independently version controller and evidence contracts | Repairs old candidates while preserving payload identity | Requires migration and compatibility rules |
| Standard publication with advisory post-release checks | Less custom machinery | Weakens the existing release-completion guarantee |

Select the second approach. Keep GitHub Actions and GitHub-hosted evidence for
now. A new daemon, database, or general workflow engine is not justified.

## Identity and authority

Separate four identities:

| Identity | Meaning | Change rule |
| --- | --- | --- |
| Candidate | Repository ID, version, source SHA, annotated tag object | Never changes for an adopted release |
| Payload | Manifest digest, exact tarball inventory, build/attestation evidence | Never rebuild or replace after adoption |
| Executor | Controller SHA, verifier SHA, workflow/run/attempt identity | May change through a reviewed compatible revision |
| Policy | Required checks, accepted verifier revisions, evidence schemas | Changes explicitly; old evidence is re-evaluated |

A changed executor must not silently change policy. Pin both in every receipt.
An invocation snapshots its controller SHA once; later jobs never check out a
moving main branch. A corrected verifier must prove the same obligations or use
an explicitly reviewed policy revision. Changing the artifact source to match
new tooling is forbidden.

Post-publication jobs can operate from current reviewed tooling because they do
not generate npm provenance. Changes to build, attestation, or npm publication
are a later sub-project. Preserve candidate-ref invocation for npm until an
integration test proves the intended caller, source, and builder claims.
[npm's trusted-publisher rules](https://docs.npmjs.com/trusted-publishers/)
include caller-workflow identity behavior for reusable workflows; checking out a
candidate inside a main-triggered job is insufficient proof of candidate
provenance.

## Evidence and transitions

Use one versioned contract for observation, planning, execution, audit, and final
publication. A transition declares its required facts, permitted effects, and
the postcondition that proves completion. An unavailable executor or unsupported
schema produces an explicit blocked result before mutation.

Receipts are immutable facts; the current release marker is their validated
summary. Observed external truth remains authoritative for mutable facts such
as tag identity, asset presence, and registry state. Neither a receipt nor a
summary alone permits skipping a required fresh observation.

Persist evidence before advancing the marker. Recover interrupted operations
by re-observing the remote object and matching its exact bytes. Do not infer
absence from a failed command, and do not claim an exactly-once external API.

Keep recovery evidence namespaces distinct from base payload assets. A schema
migration archives the old marker and binds the unchanged payload; it does not
rewrite the sealed manifest. Before publication, a finalization asset binds the
complete selected evidence and reconstructs the expected release title/body.
GitHub freezes assets and the tag, but permits editing title and release notes;
the body is therefore a display of evidence, never its immutable anchor.
Subsequent health checks live in separately retained evidence and cannot add
assets to that release. See [GitHub's immutability contract](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

## Execution model

The target components are a small observer/planner, payload preparation,
publication executor, verifier workers, and metadata reconciler. Each has an
explicit input contract and scoped effects. The privileged publisher receives
only verified tarballs and publication parameters; it never installs, builds,
tests, or runs package lifecycle scripts.

Initially retain the existing global writer concurrency group. The first
recovery path shares it, while independent read-only audit execution uses a
different group so a parent waiting for audit cannot deadlock.

Later, allow preparation and verification to run concurrently, with serialized
registry publication and per-candidate metadata ownership. Introduce narrower
locks only after proving ordering around publication, candidate selection, and
the registry's latest tags. GitHub concurrency orders cooperative work; it is
not a transactional lock against manual API edits.

Every invocation produces a durable result:

- `completed`: the requested release postcondition was independently observed;
- `handed-off`: an exact successor run is recorded, and completion is still pending;
- `waiting`: a classified transient condition with bounded next retry;
- `blocked`: a deterministic defect, identity conflict, unsupported contract, or
  policy failure with a concrete remediation.

Only `completed` represents release success. A failed child audit or a skipped
required writer cannot be hidden by a green dispatcher. Final summaries must
run even when an earlier job fails; hard runner loss is recovered by observation
on the next invocation.

## Verification placement and reuse

Before npm, exercise exact packed artifacts with local installation, type,
scaffold, runtime, and infrastructure checks where feasible. Exercise production
runner plumbing there as well. After npm, verify public registry visibility,
tarball bytes, provenance, dependency resolution, and representative runtime
behavior. Independent audit re-reads external evidence in a clean job.

Source correctness, local tarball correctness, public registry correctness, and
independent evidence audit serve different purposes. Consolidate duplicate work
only after mapping each obligation to its owner.

Lane reuse is a later optimization. Select receipts using candidate and manifest
identity, policy and verifier compatibility, environment profile, dependency
resolution evidence, and explicit freshness rules. A failed lane can rerun
without discarding unrelated successes. Record a new immutable verification-set
selection; never edit a previous receipt or combine arbitrary green attempts.
This deliberately supersedes the current same-run/same-attempt restriction only
when the replacement contract ships across every consumer.

An exception outcome must be named and reported separately from normal verified
completion. Its authority, allowed scope, later-version arbitration, and ongoing
verification obligations require a separate design. The first recovery delivery
does not implement exceptions or let the existing adjudication count as a pass.

## Performance work grounded in measurements

[CI run 33924658340](https://github.com/cacheplane/dawnai/actions/runs/33924658340)
completed in about 20 minutes. Its validate job took 15m07s, including source
tests 9m09s, controller tests 2m52s, and build 1m35s. Validate started 4m49s after
the run was created. Harness verification took 12m17s; pack-smoke took 3m03s.
These are a single sample, not a baseline or a promised improvement.

Collect per-phase queue time, execution time, runner-minutes, retry count,
registry propagation delay, bytes downloaded, operator interventions, and
end-to-end time to verified completion. Establish p50/p95 only with a stated
sample size and comparable runner/workload conditions.

Prioritize measured source-test partitioning, independent controller checks,
avoiding repeat setup and observation within one run, and CI-completion-driven
reconciliation with a scheduled repair path. Preserve fresh reads at mutation
boundaries and the independence of the audit. More jobs are not automatically
faster when runner queues dominate. Caches are performance inputs, never release
authority. Reuse the sealed release payload rather than rebuilding on recovery.

Fix flaky process tests rather than removing their cleanup assertions. Assess
the still-open [PR #568](https://github.com/cacheplane/dawnai/pull/568) in that
workstream. Update AGENTS.md's serial-validate description when documenting the
already split CI topology.

## 2026-09-05 implementation findings

The post-publication controller now has full HTTP recovery rehearsals with
immutable payload checks, five lane obligations, independent audit, all 32
write boundaries, zero-write replay and next-version arbitration. The disposable
service experiment verified YAML disable/re-enable behavior and operator
publication. These are distinct evidence layers; neither establishes production
admission. See the [service results and admission sequence](../runbooks/2026-09-05-release-recovery-service-results.md).

Keep the observer small by returning explicit authority projections from
validated service data. Actual GitHub workflow history contained enough unused
metadata to exceed the recovery snapshot's structural bound even while fitting
its byte budget. Projecting after complete raw validation preserves every run
and every checked authority field without raising global limits.

Optimize repeated reads through fresh authenticated conditional requests. Retain
raw page bytes, ETags and separately identified pagination metadata only within
one reader lifetime; revalidate every page on both complete fence passes.
A new job or resume starts with cold readers. This reduces primary consumption
and transfer volume without turning cache entries into permission to write.
The [paginated-read contract](./2026-09-05-recovery-paginated-reads.md) records
these invariants and actual 200/304 behavior.

The current topology still has two platform-generated workflows that the
Git-YAML fence cannot represent. Resolve their authority explicitly before
admitting recovery. A dedicated release-control repository remains a possible
future isolation boundary, but requires scoped cross-repository credentials,
exact source/controller identity, independent audit and revocation of old
writers. Moving orchestration alone does not resolve the existing candidate.

The next performance experiment should split controller validation from source
tests while retaining a required aggregate check that fails on every missing,
failed or unexpectedly skipped lane. Measure runner queue time and added setup
cost before claiming faster releases. Keep a complete test inventory across
shards; historical green checks and missing shards cannot satisfy the aggregate.
This is a proposed subsequent change, not part of the pagination implementation.

## Other publication surfaces

The current chart workflow is a separate push/path-triggered publisher; it is
not gated by the completed npm release. A later change must make that choice
explicit: bind a chart's appVersion to an eligible application release, or
document and verify a separately versioned compatibility policy. Keep website
deployment checks as a distinct product boundary. Neither is silently added to
the critical path of the first recovery change.

## Rollout and acceptance

| Sub-project | Deliverable | Exit evidence |
| --- | --- | --- |
| 1. Post-publication recovery | Current controller finishes an existing published candidate; versioned evidence bridge | Old candidate/new executor rehearsal, real GitHub contract lane, independently verified completion |
| 2. Normal controller separation | New candidates use independently pinned orchestration; publisher provenance retained | Partial publication resumes across a controller upgrade without changed source claims |
| 3. Receipt selection and retry | Per-lane resumability and reviewed compatibility/freshness rules | Retry one failed lane, retain eligible receipts, reject obsolete or conflicting evidence |
| 4. Scheduling and performance | Measured test partitioning, event-driven reconciliation, reduced duplicate work | Comparable queue/runtime/cost measurements and unchanged verification coverage |
| 5. Exceptional outcomes and publication alignment | Explicit terminal-exception policy and chart compatibility | Truthful status, safe later-version arbitration, preserved historical evidence |

Each sub-project gets its own implementation plan and review. The architecture
is not one large implementation PR. Sub-project 1 is specified separately;
later entries are sequencing decisions rather than implementation-ready specs.

Do not claim reliability from test count alone. The decisive acceptance scenario
is a candidate produced under controller A that fails, then completes under
controller B without changing its packages, tag, or provenance. Also interrupt
after each external effect, replay, verify remote bytes, and prove that no
required step was silently skipped. Use real GitHub disposable integration
resources for draft identity, permissions, job conditions, and workflow dispatch;
local fakes must fail on the same invalid shapes as production.
