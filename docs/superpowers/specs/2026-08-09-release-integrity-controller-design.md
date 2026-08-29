# Release Integrity Controller Design

Status: approved design, ready for implementation planning

Date: 2026-08-09

> **Partial supersession:** The live abandonment workflow surface and owner
> evidence/cutover sequence in this historical design are superseded by the
> approved [Temporarily Disable Release Abandonment](./2026-08-25-temporarily-disable-release-abandonment-design.md)
> and [Release Controller Reconciliation After Main Integration](./2026-08-27-release-controller-main-reconciliation-design.md)
> designs. The underlying runtime and historical evidence contracts remain as
> originally designed unless those later documents say otherwise.

## Summary

Dawn will replace its coupled Changesets publish workflow with a Dawn-owned,
resumable release controller. Changesets remains responsible for version intent,
changelogs, and the Version Packages pull request. A separate release workflow
will detect a release commit, prepare and attest one immutable set of package
tarballs, publish those exact tarballs through npm trusted publishing, reconcile
GitHub release metadata, run published-artifact smoke tests, independently audit
the complete draft, and only then publish and verify one immutable GitHub Release.

The controller is deliberately a repository script, not a new package. It treats
npm, GitHub Actions artifacts and attestations, the main branch, Git tags, GitHub
Releases, and smoke-test results as observable state. Each transition is
idempotent and fail-closed. Reruns resume from the last proven state rather than
rebuilding or assuming that a failed workflow made no external changes.

The rollout is split into two pull requests. The first introduces the model,
tests, and a read-only shadow reconciler while leaving publication unchanged.
The second switches workflow ownership and removes the overlapping legacy paths.
The first release after the switch is a deliberately monitored patch release
with local, in-workflow, and post-release smoke testing.

## Why this is needed

The current workflow asks one `changesets/action` step to choose between opening
a Version Packages pull request and publishing. That decision is based on whether
any changeset files exist, not on whether the package version at the current
commit is unpublished. This makes unrelated changesets arriving on `main` able
to suppress a valid release candidate.

Two recent incidents make the failure modes concrete:

- Version Packages pull request #422 merged version `0.8.20` at
  `5bb97cf3434e7c4afa95646982d510d79387ba5b`. The exact-commit CI passed, but
  `0.8.20` was never published because more changesets were already present when
  the release workflow ran. The later `0.8.21` release skipped over it.
- Release run
  [31292769511](https://github.com/cacheplane/dawnai/actions/runs/31292769511)
  attempt 1 validated and published all `0.8.21` packages with npm provenance.
  It then failed while creating GitHub Releases because the configured token
  could push tags but could not create Releases. The attestation, asset upload,
  backfill, and published smoke steps were skipped. Rerunning the workflow
  repeated the entire privileged job; attempt 2 then failed in the unrelated
  subprocess smoke test before reaching publication reconciliation.

The current workflow also grants `contents: write`, `pull-requests: write`,
`id-token: write`, and `attestations: write` to the same job that checks out,
installs, builds, and tests the repository. That scope is broader than required
for publication and makes retries harder to reason about.

Finally, Dawn's Changesets fixed group currently contains 20 package names while
the repository exposes 21 public packages. `@dawn-ai/sandbox` is missing from the
fixed group even though the publisher discovers and publishes it. Release scope
therefore has multiple competing definitions.

## Research basis

The design was compared against current public release systems and the local
CopilotKit repository.

- [TanStack Query's release workflow](https://github.com/TanStack/query/blob/46d7f02f1c7b9fcd3255082cc7103e8bfa3dab76/.github/workflows/release.yml#L3-L66)
  is a clean Changesets and npm trusted-publishing baseline. It does not attempt
  post-registry smoke testing or recovery across partially completed metadata.
- TanStack Router follows the same intentionally simple model.
- [Vercel AI's provenance upload](https://github.com/vercel/ai/blob/63db19387ba71ec50820d146658ae720ab50c80b/.github/scripts/upload-provenance/index.mjs#L121-L186)
  usefully exposes npm provenance through GitHub Releases, but treats that upload
  as best effort and does not close the loop with published runtime smoke tests.
- pnpm has the strongest surveyed planning and fail-closed registry behavior. It
  tests tarball installs, publishes dependency gates late, and supports partial
  resume. Its workflow still does not provide the complete post-publication
  reconciliation Dawn needs.
- `/Users/blove/repos/copilotkit` provides a useful explicit release inventory
  and separates unprivileged build from privileged publish. Its current recovery
  is tied to mutable `main`, the publish job still installs and packs, and the
  early version-source guard prevents a general resume.
- Changesets CLI v3 and Action v2 preview releases move toward explicit planning,
  packing, and publishing. As of 2026-08-03 they are prereleases, so Dawn should
  align its boundaries with them without depending on them yet.
- npm trusted publishing binds package configuration to an exact GitHub workflow
  filename and automatically emits npm provenance. npm staged publishing still
  requires manual two-factor approval, and separate `dist-tag` mutation requires
  long-lived credentials. Neither is suitable for Dawn's unattended fixed-group
  release.
- GitHub Actions now supports `concurrency.queue: max`, which can serialize
  release candidates without canceling an older release in progress.
- GitHub REST API version `2026-03-10`
  [makes workflow dispatch return the created run identity](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)
  in an HTTP 200 response and removes the older opt-in field. Its
  [workflow-jobs endpoint](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10#list-jobs-for-a-workflow-run)
  still defaults to only the latest attempt, so the controller requests
  `filter=all` explicitly.
- GitHub's
  [repository immutable-Releases API](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#check-if-immutable-releases-are-enabled-for-a-repository)
  provides the owner-side enablement and verification boundary required before
  the first candidate draft is created.

No surveyed repository closes the complete loop from a fixed-group version
commit through immutable artifacts, least-privilege publication, partial-state
recovery, consolidated release evidence, and exact-version runtime smoke tests.
Dawn's controller is justified by that gap, not by a preference for bespoke
tooling.

## Goals

- Publish every Dawn public package at one fixed-group version from one exact
  commit and one immutable artifact set.
- Make every release phase observable, deterministic, resumable, and fail-closed.
- Preserve npm trusted publishing and npm-generated provenance.
- Minimize the code and dependency surface that receives OIDC publication
  authority.
- Detect candidates independently of the presence of newer changesets.
- Produce durable evidence connecting version, Git commit, CI run, tarball
  digests, GitHub attestations, npm provenance, and smoke results.
- Treat published-artifact verification as part of release completion, not an
  optional cleanup step.
- Provide enough local fault injection to assert recovery before the first live
  release.
- Consolidate Dawn's release operations without creating a new workspace package.

## Non-goals

- Atomic multi-package publication. npm does not provide a 21-package
  transaction, so the design instead makes partial publication safe to resume.
- Backward compatibility for the current per-package Git tags and GitHub Releases.
  Existing history remains untouched, but new releases use one `vX.Y.Z` tag and
  one GitHub Release.
- Unpublishing or destructively replacing a public npm version.
- Adding a long-lived npm token for `dist-tag` promotion.
- Depending on prerelease Changesets v3 or Action v2.
- Replacing Dawn's real Vercel deployment validation or removing the Vercel CLI.
  The existing Vercel-native CI lane remains a required production boundary; the
  release cutover must finish with a verified deployment of the exact release
  commit.

## Sources of truth and invariants

### Package inventory

The Changesets fixed group is the canonical release inventory. A repository check
derives all public workspace packages and requires exact set equality with that
group. The first pull request adds `@dawn-ai/sandbox` and fails on any future
missing, extra, duplicate, private, or unknown member.

All packages in the group must have the same version at a release candidate. The
controller never infers release scope from a directory scan alone.

### Candidate identity

A candidate is the pair `{version, commitSha}`. The SHA must be reachable from
`refs/heads/main`, and the exact SHA must have a successful required CI run. A
manual request supplies both values; it cannot infer them from a mutable branch
head. Immediately after candidate validation, a coordinator creates or validates
the consolidated annotated tag at the same SHA, dispatches the workflow at
`vX.Y.Z`, and exits before preparation even when its own `GITHUB_SHA` already
equals `commitSha`. Artifact preparation, attestation, escrow, npm publication,
smoke, audit, and GitHub Release publication may run only when both
`GITHUB_REF=refs/tags/vX.Y.Z` and `GITHUB_SHA=commitSha`. npm and GitHub
provenance therefore identify the immutable candidate tag rather than a
`refs/heads/main` invocation with coincidentally equal bytes.

Because the `push` release run and the CI run start from the same event, candidate
validation polls the required check suite for that exact SHA with a bounded wait.
It proceeds only after success, fails immediately after a terminal CI failure,
and exits as retryable when the bound expires. A later push, schedule, or exact
manual dispatch resumes observation; it never substitutes a different SHA. Every
non-tag invocation is a coordinator only: it creates a missing candidate tag when
needed, dispatches `.github/workflows/release.yml` at that tag with exact inputs,
and does not build, attest, escrow, publish, smoke, or audit from its own ref. The
coordinator exits after the dispatch API returns the created run identity so it
releases the global concurrency lock; the tagged run then acquires the lock and
performs reconciliation.

The version is read from the fixed-group manifests at that commit. A new push is
a candidate only when all fixed-group versions changed together relative to the
first parent and the commit contains the post-cutover controller schema. This
version-delta rule is independent of the presence of changeset files. It prevents
the ownership-switch commit itself and legacy version commits from being mistaken
for new releases.

Manual and scheduled recovery enumerate managed annotated `refs/tags/v*` as well
as managed draft/published Releases. A standalone tag whose peeled commit contains
the active controller schema and one valid fixed-group version delta is recovered
as `CANDIDATE_TAGGED` even when no Release or release record exists. A Release
record becomes mandatory only for phases after artifact preparation. Scheduled
discovery also scans first-parent `main` history for the newest untagged
fixed-group version-change commit that contains the controller schema. Once
discovered, a candidate remains actionable when at least one exact
`name@version` is absent from npm or when npm is complete but downstream release
evidence is incomplete.

Candidate arbitration is monotonic by semantic version:

- If an older version has no tag, draft Release, attested artifact, or npm package
  and a newer fixed-group version exists, the older version is terminally
  `SUPERSEDED_NOOP` and is never published.
- If an older version has any tagged, escrowed, or npm state, it must reach
  `AUDIT_COMPLETE` or the narrowly defined `ABANDONED_PREPUBLICATION` terminal
  state before a newer candidate may mutate public state. Newer candidates remain
  queued behind it.
- Before each npm mutation, every package's `latest` tag is checked. A `latest`
  version greater than the candidate makes an unstarted candidate superseded and
  makes a partial candidate a hard conflict requiring operator review. The
  controller never moves `latest` backward.
- A fully published newer version makes an unpublished historical version such as
  `0.8.20` audit-only history. Recovery never fills that skipped version later.

The global release lock and these rules prevent overlapping candidates from
interleaving their fixed-group package sets.

### Artifact identity

The release manifest is the immutable handoff between preparation and all later
phases. Its tarball digests, not a rebuilt workspace, define the bytes approved
for publication. No privileged job may install dependencies, build, or pack.

### Completion

A release is complete only when all of these assertions hold:

1. Every fixed-group `name@version` is visible on npm with the manifest digest.
2. npm provenance exists and identifies the trusted release workflow and exact
   candidate commit for every package.
3. The `latest` dist-tag for every package resolves to the version.
4. The consolidated `vX.Y.Z` tag points to the candidate commit.
5. The consolidated GitHub Release contains the exact 45 base escrow assets, the
   permitted audit receipts, and links to npm provenance.
6. Every required exact-version published-artifact smoke lane has passed.
7. An independent Published Artifact Verification run, dispatched at the exact
   tag, reproduced the npm and complete-draft assertions without relying on the
   release job's workspace, and its canonical success receipt was attached while
   the Release was still draft.
8. The controller published that exact audited draft without changing its body or
   assets, then re-read `draft: false`, `immutable: true`, the same annotated-tag
   target, and the same complete asset set.

## Workflow topology

### Version Packages workflow

`.github/workflows/version-pr.yml` runs Changesets' version behavior only. It
opens or updates the Version Packages pull request and synchronizes the Helm chart
application versions. When an application version advances, the same command
increments each affected chart's own patch version exactly once so the existing
OCI publisher creates a new immutable chart instead of skipping an already-used
chart version. An already-synchronized rerun is a no-op. The workflow cannot
publish to npm and receives no OIDC or attestation permission.

Separating it from publication prevents Changesets' `hasChangesets` branch from
deciding whether a release candidate exists. It also isolates the PAT requirement
for triggering CI on the generated pull request from the release workflow's
standard GitHub token.

### Release workflow

`.github/workflows/release.yml` remains the sole npm publisher. Keeping this exact
filename avoids invalidating the npm trusted-publisher configuration for 21
packages. It accepts three entry paths:

- `push` to `main`: detect and reconcile the version at the pushed SHA.
- `workflow_dispatch`: require exact `version` and full `commitSha` inputs.
- `schedule`: audit the latest fixed-group version and reconcile incomplete state.

The workflow uses a repository-global release concurrency group with
`queue: max` and never cancels an in-progress release. Each queued run re-reads
public state after acquiring the lock. A stale run that is already fully
reconciled becomes a successful no-op; it does not publish a superseded candidate
without first satisfying the exact-SHA, version, and monotonic arbitration checks.
Because ordinary GitHub concurrency retains only a limited pending set, the
workflow explicitly uses the 2026 `queue: max` policy rather than relying on
default pending-run replacement.

### Independent Published Artifact Verification

The existing manual verification workflow is expanded to accept the consolidated
manifest and exact version. The release controller dispatches it after all npm and
smoke evidence is reconciled but while the GitHub Release is still draft. This
independent execution guards against release-job state, cache, and timing
artifacts without requiring a forbidden post-publication asset mutation.
Independent runs are always dispatched at `vX.Y.Z` with required `version`,
`commitSha`, and `manifestSha256` inputs. A later manual verification may recheck
the published immutable Release, but it emits Actions evidence only and never
mutates that Release.

## Controller model

The controller is a small set of scripts under `scripts/release/` with pure logic
separated from side-effect adapters. It has no workspace package and no runtime
dependency on Dawn's publishable packages.

The pure core accepts a desired candidate plus observed state and returns a plan.
Adapters observe Git, GitHub, Actions artifacts and attestations, npm metadata and
tarballs, and smoke results. Commands execute one planned transition at a time and
then observe again. They do not optimistically mark a transition complete.

The workflow-facing observer constructs those bounded adapters and supplies the
complete exact-candidate observation to the pure planner; PR 1's shadow collector
is not a production entrypoint. Pre-enable strict preflight parses the final
candidate workflow topology and controller schema while proving the old remote
publisher/chart workflows remain disabled; post-enable strict preflight repeats
the same checks at the merged switch SHA, requires repository immutable Releases
to be enabled for future releases, and requires the replacement workflow paths to
be active. Both phases consume fresh, commit/digest-bound authenticated owner
evidence from `npm trust list` plus GitHub permission, environment, and
immutable-Release probes. They pass only for one uniform 21-package publisher
tuple, the exact protected abandonment environment, and the required post-enable
repository setting. Unknown, mixed, or stale evidence fails closed.

### GitHub effect boundary

Production code composes an explicit read adapter and an explicit five-method
write adapter as `Object.freeze({ reader, writer })`. The writer exposes only:

```js
createDraftRelease({ tag, targetSha, title, body })
updateDraftReleaseIfCurrent({ releaseId, tag, targetSha, expectedBodySha256, title, body })
uploadAssetIfAbsentAndEqual({ releaseId, tag, targetSha, name, bytes, sha256 })
publishReleaseIfCurrent({ releaseId, tag, targetSha, expectedBodySha256, assets })
dispatchWorkflowAtRef({ workflow, ref, inputs })
```

It has no generic request, delete, overwrite, force, or tag-mutation method.
Draft lookup uses the paginated Release list so an authenticated recovery run can
see drafts. Candidate identity is proven from the remote `refs/tags/vX.Y.Z`
object and the annotated-tag object peeled to one commit; `target_commitish` is
never identity evidence. PR 2 may add exactly these named reads to the existing
bounded PR 1 reader:

```js
getGitTag({ tagSha })
getRelease({ releaseId })
listActionsRunArtifacts({ runId })
listActionsRunJobs({ runId })
```

The existing `getActionsRun`, `getActionsArtifact`, and
`downloadActionsArtifact` operations provide exact run and result-artifact
retrieval. `listActionsRunArtifacts` is scoped by the already-recorded run ID;
it is not the repository-wide artifact listing. `listActionsRunJobs` always
calls the run-jobs endpoint with `filter=all`, retains `run_attempt` on every
normalized job, and returns every attempt in stable attempt/ID order. The adapter
rejects an omitted filter, missing or duplicate attempt coverage, and unsafe
pagination rather than silently accepting GitHub's default latest-attempt view.
This complete job history is the pre-escrow publication check; any attempt whose
`publish-npm` job has a non-null start time blocks escrow. These additions do not
create a generic transport escape hatch, and audit dispatch correlation must
never use the existing workflow-run listing to infer a run ID.

Every metadata mutation is compare-and-swap. A body update requires the exact
current body SHA-256 and draft identity, an asset upload accepts only absence or
downloaded byte equality, and publication requires the exact final body and
phase-appropriate asset set. Every mutation is re-read. Publication changes only
`draft: true` to `draft: false`; it cannot supply a new title, body, or asset. The
re-read must report `immutable: true`, the same annotated-tag target, and the same
body and asset digests.

Workflow dispatch is restricted to the controller and independent-verification
workflow paths. It uses GitHub API version `2026-03-10`, which always returns the
created run details and removed the older opt-in `return_run_details` request
field. The writer omits that removed field, requires the documented HTTP 200 body
containing exact `workflow_run_id`, `run_url`, and `html_url`, validates those URLs
against the repository and returned ID, and records that response directly.
Listing recent runs to guess which run a dispatch created is forbidden.

### Draft marker, attestations, and asset namespaces

The controller owns the complete Release body and embeds exactly one canonical
JSON marker in a delimited HTML comment. Duplicate, malformed, extra-key, or
noncanonical markers are conflicts. The marker always has these exact root keys:

```json
{
  "schemaVersion": 1,
  "epoch": "fixed-group-v1",
  "revision": 1,
  "phase": "ESCROWING",
  "version": "0.8.22",
  "commitSha": "<40-character SHA>",
  "tag": "v0.8.22",
  "manifestSha256": "<64 hex or null only for early abandonment>",
  "releaseRecordSha256": "<64 hex or null only for early abandonment>",
  "baseAssetSetSha256": "<64 hex or null only for early abandonment>",
  "attestationSet": {
    "repository": "cacheplane/dawnai",
    "workflow": ".github/workflows/release.yml",
    "sourceRef": "refs/tags/v0.8.22",
    "commitSha": "<40-character SHA>",
    "workflowRunId": 123456789,
    "runAttempt": 1,
    "subjects": ["<exactly 22 ordered subject records>"]
  },
  "npmEvidenceSha256": null,
  "smokeAggregateSha256": null,
  "audit": null,
  "abandonmentSha256": null
}
```

Allowed phases are `ESCROWING`, `ESCROWED`, `NPM_COMPLETE`,
`SMOKES_COMPLETE`, `AUDIT_DISPATCHED`, `AUDIT_RETRYABLE`, `AUDIT_VERIFIED`, and
`ABANDONED_PREPUBLICATION`. Revision increases by one for each successful body
CAS and phases never move backward except the explicit retry edge from
`AUDIT_RETRYABLE` to a new `AUDIT_DISPATCHED`. Phase-specific fields must be
present or null exactly as required. `manifestSha256`, `releaseRecordSha256`,
`baseAssetSetSha256`, and `attestationSet` are non-null from `ESCROWING` onward.
`ABANDONED_PREPUBLICATION` alone admits the exact predecessor evidence shapes:

- tagged only: all four artifact fields are null;
- prepared but not attested: manifest and release-record digests are non-null,
  while the base-set digest and attestation set are null;
- attested with no draft, or with zero, a matching subset, or all base assets
  escrowed: all four artifact fields are non-null.

No other partial combination is valid. An abandonment preserves the strongest
artifact context already produced; it never erases fields or fabricates later
ones. Npm evidence begins at `NPM_COMPLETE`, smoke evidence begins at
`SMOKES_COMPLETE`, an audit object is present only in audit phases, and only
abandonment has an abandonment digest. Evidence created by the immediately
preceding idempotent mutation may be one transition ahead of the marker after
runner loss; the next run reconciles that marker forward rather than classifying
matching evidence as a conflict.

The non-null `audit` value always has exactly these keys:

```json
{
  "workflow": ".github/workflows/published-artifact-verify.yml",
  "workflowRunId": 123456790,
  "runUrl": "https://api.github.com/repos/cacheplane/dawnai/actions/runs/123456790",
  "htmlUrl": "https://github.com/cacheplane/dawnai/actions/runs/123456790",
  "runAttempt": null,
  "attemptAssetName": null,
  "attemptSha256": null,
  "canonicalSha256": null,
  "conclusion": null
}
```

`AUDIT_DISPATCHED` contains the dispatch-returned ID and URLs with the final five
values null. `AUDIT_RETRYABLE` fills the run attempt, uniquely named attempt
asset, attempt digest, and `failure` conclusion while leaving
`canonicalSha256` null. A retry replaces the audit object with a new
dispatch-returned identity and null result fields; old attempt assets remain in
their disjoint namespace. `AUDIT_VERIFIED` fills both digests with the same value
and has conclusion `success`. The published terminal state is derived from an
unchanged `AUDIT_VERIFIED` marker plus the Release's observed
`draft: false`/`immutable: true` state; publication never mutates the marker to a
new phase.

`attestationSet` is metadata, not another Release asset. When present it has exact
repository, workflow, source-ref, candidate-SHA, workflow-run, and run-attempt
fields plus exactly 22 ordered subjects: `manifest.json` followed by the 21
tarballs in manifest package order. Every subject has exact `subjectName`,
`subjectSha256`, `bundleName`, and `bundleSha256` fields; the bundle name is
`<subjectName>.intoto.jsonl`. The workflow is
`.github/workflows/release.yml`, the source ref is
`refs/tags/vX.Y.Z`, and all 22 bundles must verify that identity before escrow.

The immutable base escrow is exactly 45 assets: `release-record.json`,
`manifest.json`, 21 tarballs, and 22 attestation bundles. Later evidence occupies
disjoint namespaces:

- audit attempts use `audit-attempt-<workflowRunId>-<runAttempt>.json`;
- exactly one canonical successful audit may use `audit-result.json`;
- pre-publication abandonment may use exactly one `abandonment.json`.

The canonical audit result is byte-identical to its successful attempt receipt.
Failed attempt receipts may accumulate under unique run/attempt names. Audit and
abandonment evidence cannot coexist, and every other asset name is unexpected.
Base-escrow exactness is evaluated independently from the phase-appropriate
terminal evidence set so adding a valid terminal receipt does not make the 45
base assets appear inexact.

Escrow mutation additionally requires an exact-key, deeply frozen
`publicationState` snapshot with this normalized shape:

```js
{
  schemaVersion: 1,
  version,
  commitSha,
  tag,
  observedAt,
  candidateRuns: [{ runId, runAttempt, headSha, headBranch, jobs: [
    { id, runAttempt, name, status, conclusion, startedAt, completedAt }
  ] }],
  registryMutationReceipts: [],
  packages: [{ name, version, status: "ABSENT", httpStatus: 404, observedAt }],
}
```

Candidate runs are every managed `release.yml` run observed for the exact
candidate SHA, ordered by run ID. `runAttempt` is the run's observed current
attempt. Each job array comes from `listActionsRunJobs` with the mandatory
`filter=all`, includes `runAttempt` on every job, and is ordered by attempt then
job ID. Coverage must include every observed attempt through the current attempt.
No `publish-npm` job in any attempt may have a non-null `startedAt`, no exact
candidate publication receipt may exist, and all 21 inventory-ordered package
observations must be unambiguous exact E404s. Missing attempt/job coverage,
duplicate run/attempt/job identities, a non-E404 package result, or any
ambiguous/auth/rate-limit/parse/server observation blocks escrow. The snapshot is
an authorization input, not a Release asset; every resumed escrow mutation takes
a fresh snapshot.

While that proof holds, a draft in `ESCROWING` with only a matching subset of the
45 assets is incomplete and resumable: upload only the missing assets. A
duplicate, unexpected, different-byte, ambiguous, wrong-tag, wrong-marker, or
wrong-record observation is conflicting. A body claiming `ESCROWED` with fewer
than 45 base assets is also conflicting. Once publication has started, an
incomplete escrow is a hard conflict and no missing asset may be filled; only an
already exact 45-asset escrow is acceptable.

Scheduled recovery recognizes `AUDIT_COMPLETE` and
`ABANDONED_PREPUBLICATION` only through shared exact-key terminal-record parsers.
A successful audit must not hide a failed individual check. Its canonical success
receipt means `AUDIT_VERIFIED` while the consolidated Release remains draft and
means `AUDIT_COMPLETE` only after that same Release is published and re-read as
immutable. An abandonment tombstone requires the Release to remain draft,
protected-environment approval, proof that neither the publish job nor a registry
mutation started, and two time-ordered exact-E404 observations covering all 21
packages while one exact manual run/attempt holds the shared non-cancelling
release lock. Approval history stores only facts GitHub exposes: approved state,
environment ID/name, reviewer ID/login, the run actor ID/login, and the API observation time. It never
invents an approval timestamp or deployment ID. The audit and abandonment
writers reuse the same parsers; skeletal identity-only JSON never unblocks a
newer candidate.

The state machine is:

```text
OBSERVED
  -> NO_CANDIDATE (terminal)
  -> SUPERSEDED_NOOP (terminal)
  -> CANDIDATE_VALIDATED
  -> CANDIDATE_TAGGED
  -> ARTIFACTS_PREPARED
  -> ARTIFACTS_ATTESTED
  -> CANDIDATE_ESCROWED
  -> NPM_PARTIAL
  -> NPM_COMPLETE
  -> RELEASE_DRAFT_COMPLETE
  -> SMOKES_COMPLETE
  -> AUDIT_DISPATCHED
  -> AUDIT_RETRYABLE -> AUDIT_DISPATCHED
  -> AUDIT_VERIFIED
  -> AUDIT_COMPLETE

CANDIDATE_TAGGED | ARTIFACTS_PREPARED | ARTIFACTS_ATTESTED | CANDIDATE_ESCROWED
  -> ABANDONED_PREPUBLICATION (manual, terminal, only before publish phase starts)
```

`NPM_PARTIAL` is an expected recoverable state, not an exceptional model gap.
Every command starts by observing the current state and verifies the preconditions
for its next transition.

### Fail-closed conflicts

The controller stops without mutation when it observes any of these conditions:

- a fixed-group package has a different manifest version;
- the candidate SHA is not on `main` or exact-commit CI is absent or unsuccessful;
- an older tagged release has reached neither `AUDIT_COMPLETE` nor
  `ABANDONED_PREPUBLICATION`;
- a registry `latest` tag is newer than the candidate;
- an existing npm `name@version` tarball has a different digest;
- registry lookup fails for any reason other than an exact package/version E404;
- an artifact is missing, corrupted, or not represented in the manifest;
- provenance identifies a different commit or workflow;
- `vX.Y.Z` exists at another commit;
- a GitHub Release asset with the expected name has different bytes;
- a required smoke result is absent or failed;
- an audit or publication job runs from any ref other than the exact candidate
  tag;
- a published managed Release lacks the canonical successful audit receipt or is
  not immutable;
- an unknown, duplicate, or phase-invalid Release asset or metadata marker is
  present.

Network, authorization, rate-limit, parse, and server errors are never interpreted
as "not published."

### Pre-publication abandonment

Tag-first recovery must not force a known-bad candidate to publish or block every
later version forever. `ABANDONED_PREPUBLICATION` is therefore a narrow manual
terminal transition, not an automatic error fallback.

An operator may request abandonment with exact version, SHA, and a non-empty
reason only when all of these assertions pass:

1. The controller's durable records and Actions job history show that the npm
   publish phase never started for the candidate. If the publish job or first
   registry mutation command started, the candidate is potentially partial and
   cannot be abandoned.
2. Two fail-closed registry observations separated by the normal visibility wait
   report exact E404 for every fixed-group `name@version`. Any ambiguous response
   or visible package rejects abandonment.
3. The candidate tag still resolves to the exact SHA, and no newer release has
   interleaved public state.
4. The manual action passes the repository's protected release environment and
   records the initiating actor, timestamp, reason, evidence run IDs, and package
   observations.

The transition creates or updates the draft GitHub Release for `vX.Y.Z`, marks it
clearly as abandoned, and attaches `abandonment.json` in its disjoint terminal
namespace. It accepts an explicit, exact-key artifact context for the observed
predecessor and preserves its strongest evidence: tagged-only has no artifact
fields; prepared retains manifest and release-record digests; attested retains
those plus the base-set digest and attestation set; an existing escrow also
retains every matching base asset already present. It rejects a weaker or
impossible context, any conflicting or unknown asset, and does not require
`release-record.json` for tagged-only abandonment. Candidate discovery therefore
checks a valid abandonment record before requiring the ordinary release record.
The transition never deletes or moves the tag, Release, artifact, attestation, or
other evidence. An attested abandoned draft may hold zero, a matching subset, or
all 45 base assets plus its tombstone; only the last shape has a complete base
set, and none satisfies the publication path because the terminal marker and
tombstone forbid it. An abandoned version can never be reactivated or published
by the controller. If any package at that version later appears on npm, the
scheduled audit reports a hard conflict.

This state unblocks newer candidates while preserving a durable explanation for
the skipped version. It is intended for deterministic preparation defects or a
workflow defect frozen into the candidate commit—not for smoke failures after npm
publication, which must remain visible and be reconciled.

## Release manifest

Preparation emits a versioned JSON document. At minimum it contains:

```json
{
  "schemaVersion": 1,
  "version": "0.8.22",
  "commitSha": "<40-character SHA>",
  "ci": {
    "workflow": "CI",
    "runId": 123456789,
    "runAttempt": 1
  },
  "artifact": {
    "name": "release-v0.8.22-0123456789ab",
    "prepareRunId": 123456790,
    "prepareRunAttempt": 1
  },
  "packageOrder": ["@dawn-ai/sdk", "...", "create-dawn-ai-app"],
  "packages": [
    {
      "name": "@dawn-ai/sdk",
      "version": "0.8.22",
      "filename": "dawn-ai-sdk-0.8.22.tgz",
      "size": 12345,
      "sha256": "...",
      "sha512": "...",
      "npmIntegrity": "sha512-...",
      "access": "public"
    }
  ]
}
```

The schema rejects unknown duplicate packages, path traversal, version mismatch,
digest mismatch, wrong access, and package order that violates internal workspace
dependencies. `packageOrder` is computed as a stable topological order. Packages
that aggregate or expose the rest of Dawn are placed last among valid topological
choices, with `create-dawn-ai-app` the final package. Registry reconciliation
still checks every member; the final package is an ordering safeguard, not a
substitute for per-package completion.

The manifest and every tarball are uploaded in one immutable Actions artifact.
Its deterministic name contains the version and candidate SHA, and the manifest
records the preparation run and attempt. The artifact-upload result provides the
Actions artifact ID and service digest. The escrow phase writes those values,
plus the manifest digest, to `release-record.json` and stores that record, the 22
subject files, and their 22 verified attestation bundles as the exact 45 base
assets on the candidate's draft GitHub Release.

Later jobs resolve the artifact only through the release record, require
`actions: read` when retrieving it from the preparation run, and verify both the
service digest and every inner manifest digest. The exact draft Release base
assets are the durable recovery escrow after Actions artifact retention expires.
They are valid only when their bytes match the manifest and all 22 GitHub
attestations verify. Fallback is allowed only for a classified retention-expired
Actions download and an exact draft escrow; authorization, timeout, malformed,
and other failures never select it. The controller never rebuilds a candidate
after any package is public. Before escrow or npm publication, it may replace a
lost preparation artifact while retaining the same candidate tag, but only after
proving that no durable release record or package version exists.

## Phase design and permissions

### 1. Detect and validate

An unprivileged job checks out the exact SHA, derives the fixed-group candidate,
confirms exact-commit CI, reads npm state, and emits the intended plan. It uses
`contents: read` and `actions: read` only. On a normal `main` push with no
candidate, a fully reconciled release, or a terminally superseded unstarted
candidate, it exits successfully with a clear no-op reason. An incomplete release
continues to its next safe transition or dispatches recovery at its immutable tag;
it is not a no-op. When exact-commit CI is still running, the job follows the
bounded polling policy above rather than treating missing results as success or
switching to the branch head.

### 2. Tag the candidate

A narrow job with `contents: write` creates or validates the annotated `vX.Y.Z`
tag at the candidate SHA. Unless the current workflow invocation already has both
`GITHUB_REF=refs/tags/vX.Y.Z` and `GITHUB_SHA=commitSha`, the coordinator
dispatches the same workflow at the tag and exits without waiting. A pre-existing
tag at another commit or a lightweight/malformed managed tag is a hard conflict.

Tagging before release artifacts are produced gives every artifact-producing and
publishing recovery run the exact candidate provenance identity. The tag denotes
an accepted release candidate; it does not claim npm publication or smoke success.

### 3. Prepare

An unprivileged exact-tag job installs with the frozen lockfile, builds, packs all
fixed-group packages, inspects their contents, and executes local tarball tests
and smokes. Exact-commit CI has already run the repository's full validation lane,
so the release workflow does not repeat `pnpm ci:validate`. It then creates the
manifest and immutable artifact.

Preparation always packs all 21 packages, even if npm observation says some are
already present. This makes a fresh candidate complete and deterministic. On a
partial resume, the existing manifest artifact is reused instead of repacked.

### 4. Attest artifacts

Before the first npm mutation, a narrow exact-tag job downloads the artifact,
verifies every digest, and creates GitHub build-provenance attestations for all
tarballs and the manifest. It emits the exact 22-subject attestation-set metadata
described above and the corresponding bundle bytes. It receives
`id-token: write`, `attestations: write`, and `contents: read` plus
`actions: read` for the recorded artifact, but no npm registry configuration.

Attesting before npm publication ensures the original build evidence survives
even when publication or later metadata work fails.

### 5. Escrow the candidate

A narrow metadata job with `contents: write`, `actions: read`, and
`attestations: read` verifies the attested artifact and required prepublication
state, peels the annotated tag to the candidate SHA, and creates or resumes the
consolidated draft GitHub Release before npm publication. It writes the canonical
`ESCROWING` marker and uploads only absent members of the exact 45-asset base set.
Matching subsets are resumable while publication is proven unstarted; conflicting
identity or bytes block. Once all 45 assets are re-read as exact, the body advances
by CAS to `ESCROWED`. This is the `CANDIDATE_ESCROWED` transition.

The tag provides the immutable workflow dispatch ref whose SHA matches
provenance; escrow adds a durable candidate-to-artifact locator and the exact
release bytes. The tag and draft Release intentionally remain visible if
publication later fails. They describe a candidate, not a claim that publication
completed.

Existing per-package tags and Releases remain historical and are not modified. A
pre-existing `vX.Y.Z` at a different commit, a same-name asset with different
bytes, an unexpected or duplicate asset, a release record pointing at another
artifact, or an attempted escrow repair after publication started is a hard
conflict.

### 6. Publish npm

The npm job receives `contents: read`, `actions: read`, `attestations: read`, and
`id-token: write`. Every initial and recovery run executes at the tagged
`vX.Y.Z` ref with the candidate SHA. It uses a pinned `actions/checkout`
invocation with
`ref: commitSha`, `persist-credentials: false`, and sparse checkout limited to the
dependency-free `scripts/release/` publisher entrypoint. Package directories,
the lockfile, and `node_modules` are absent. The job downloads the artifact by the
exact ID in `release-record.json` or, after retention expiry, the attested draft
Release escrow. It must not install, build, test, run package lifecycle scripts,
or pack.

The controller verifies the manifest and all digests, then handles packages
serially in manifest order:

1. Query exact `name@version` metadata.
2. If absent with exact E404, publish the manifest tarball using npm trusted
   publishing, public access, `latest`, and provenance.
3. If present, download the registry tarball and require digest equality.
4. Poll until exact metadata, tarball digest, `latest`, registry signature, and
   npm provenance are visible and correct.
5. Only then advance to the next package.

Publishing serially makes the partial state deterministic and avoids hiding which
package first violated an invariant. Dependency and gate packages are published
after their dependencies so early consumers cannot observe an aggregate package
whose required Dawn packages are still absent.

The npm job cannot create Git tags, GitHub Releases, or assets. A failure there
leaves a precisely observable `NPM_PARTIAL` state for the next run.

### 7. Reconcile consolidated release metadata

Two separate exact-tag reconciliation jobs own these body transitions. Immediately
after npm, `reconcile-npm` has `contents: write`, `actions: read`, and
`attestations: read`; it verifies `NPM_COMPLETE`, validates the existing candidate
tag and draft Release, and records observed npm evidence by exact body CAS. After
all read-only smoke jobs finish, `reconcile-smokes` has `contents: write` and
`actions: read`; it validates the correlated receipts and advances the same marker
from `NPM_COMPLETE` to `SMOKES_COMPLETE` by a second CAS. Each invocation performs
one named state transition, and neither creates a new release identity after
publication.

The draft Release includes:

- the release manifest;
- every package tarball;
- GitHub attestation bundles;
- a generated package table with npm links and tarball digests;
- npm provenance and transparency-log links;
- the candidate commit and exact CI run;
- the required smoke checklist and current results.

The 45 base assets remain unchanged. Body updates are idempotent by prior body
hash, and any unexpected asset or body drift is a conflict, never an overwrite.

### 8. Smoke exact published artifacts

Required smoke lanes install `name@exactVersion` in clean temporary projects
outside the checkout and use the real npm registry. They include:

- all-package metadata, tarball, dependency-spec, export, type, and provenance
  verification;
- TypeScript compiler/tooling behavior across the supported compiler matrix;
- scaffold creation, install, build, typecheck, and representative runtime use;
- Docker sandbox PID-exhaustion recovery;
- pgvector and Postgres storage integrations with real disposable databases;
- representative Node and edge-target imports/runtime checks;
- existing framework and runtime harness smoke coverage adapted to exact tarballs.

Every lane emits machine-readable results tied to version, commit, manifest
digest, workflow run, and attempt. Failure keeps the GitHub Release in draft and
does not alter npm.

### 9. Independently audit, then publish immutably

After `reconcile-smokes` proves all required results, an exact-tag
`dispatch-audit` job with only `actions: write` dispatches the Published Artifact
Verification workflow at `vX.Y.Z` with exact `version`, `commitSha`, and
`manifestSha256` inputs while the consolidated Release is still draft. Under API
version `2026-03-10`, the request omits the removed run-details opt-in and uses the
mandatory HTTP 200 response containing the created workflow run ID and URLs. It
emits that validated receipt but cannot mutate the Release. A following exact-tag
`record-audit-dispatch` job with only `contents: write` revalidates the draft and
body-CASes that exact receipt into `AUDIT_DISPATCHED`. The controller never lists
recent runs and guesses which one it created. If dispatch succeeds but its receipt
is lost before the CAS, that uncorrelated audit remains read-only and times out;
the next controller run safely dispatches a new directly correlated run.

The independent workflow runs from the exact tag, waits within a fixed bound for
the draft marker to name its own run ID, and re-observes npm, provenance, the
annotated tag, the complete draft body, all 45 base assets, and smoke evidence
without consuming the release job's checkout or caches. An `if: always()`
finalizer uploads one machine-readable result artifact scoped to its workflow run
and attempt. That result repeats the three correlation fields, workflow run and
attempt, timestamps, individual checks, and final conclusion.

The release controller polls only the returned run ID and lists result artifacts
only for that run. A bounded poll that finds the run still nonterminal leaves
`AUDIT_DISPATCHED` for a later run to resume. A terminal failed result is attached
as `audit-attempt-<workflowRunId>-<runAttempt>.json`, and the marker advances to
`AUDIT_RETRYABLE`; another exact-tag dispatch receives a new run identity. If a
dispatch was accepted but its response was lost before the marker CAS, a later
duplicate read-only audit is harmless, but it is never rediscovered by guessing.

For a successful correlated result, the controller first attaches the
attempt-scoped receipt, then attaches byte-identical canonical bytes as
`audit-result.json`, and finally advances the draft marker to `AUDIT_VERIFIED`.
Runner loss between any of those idempotent operations is resumed from observed
bytes. Only then may `publishReleaseIfCurrent` verify the final body and allowed
asset union and change `draft` to false without supplying new metadata. Its re-read
must show `immutable: true`, the same body/assets, and the same annotated-tag
target; that observation produces `AUDIT_COMPLETE`. A published Release missing
canonical success evidence or reporting `immutable: false` is an unrecoverable
conflict because post-publication mutation is forbidden. A clean scheduled audit
of an `AUDIT_COMPLETE` release is a no-op success; later independent verification
may emit Actions evidence but never alter the immutable Release.

## Recovery behavior

Recovery is reconciliation, not rollback:

| Observed state | Action |
| --- | --- |
| Valid untagged candidate, nothing published | Validate arbitration, create the annotated tag, dispatch at that exact tag, and exit the coordinator. |
| Candidate tagged, no escrow or npm state | Dispatch at the tag, prepare, attest, and escrow the artifact. |
| Tagged candidate has an irrecoverable deterministic defect, publish phase never started | After protected manual approval and double registry absence proof, record `ABANDONED_PREPUBLICATION`; preserve all evidence and unblock the next version. |
| Artifact prepared, npm untouched | Verify and reuse the artifact; never rebuild needlessly. |
| Draft escrow contains only matching base assets and npm never started | Resume only the missing members of the exact 45-asset base set, then advance the marker to `ESCROWED`. |
| Some packages published with matching digests | Skip verified packages and publish the first missing package onward. |
| All packages published, metadata incomplete | Reconcile tag, draft Release, assets, and attestations. |
| Metadata complete, smoke incomplete or failed | Rerun exact-version smoke; keep Release draft until green. |
| Smoke complete, audit absent or failed | Dispatch or retry the independent workflow at `vX.Y.Z`; attach attempt-scoped evidence while the Release remains draft. |
| Canonical audit success attached to the draft | CAS the marker to `AUDIT_VERIFIED`, publish without changing body/assets, and re-read immutable completion. |
| Release published without canonical success or immutability | Stop as an unrecoverable conflict; never attempt post-publication repair. |
| Existing bytes, provenance, tag, or asset conflict | Stop with a conflict report; no destructive repair. |
| Registry or GitHub observation is ambiguous | Retry within bounded policy, then fail closed. |

Manual dispatch is the operator recovery entrypoint and always requires exact
version and SHA. If `vX.Y.Z` is absent, the coordinator may create it only after
candidate and arbitration checks; if it exists, the annotated tag must peel to
that SHA. Every non-tag push, schedule, or manual invocation dispatches tagged
recovery and exits. Artifact production, attestation, escrow, npm publication,
smoke, audit, and Release publication never run from the coordinator ref and never
substitute a newer `main` head for the candidate SHA.

## Error reporting

Each run publishes a compact reconciliation report even on failure:

- candidate version and SHA;
- manifest and artifact identifiers;
- exact-commit CI evidence;
- state of each package on npm;
- the last proven transition and next safe transition;
- conflict or transient-error classification;
- abandonment eligibility or tombstone evidence when applicable;
- tag, Release, asset, attestation, provenance, and smoke state;
- exact manual recovery command inputs.

Secrets and OIDC material are never included. Registry responses are normalized
so package absence is distinguishable from authorization, network, throttling,
and server failures.

## Testing strategy

Verification is the central acceptance criterion for this design.

### Pure model tests

Table-driven tests cover every observed state and planned transition, including:

- no candidate, new candidate, partial publish, npm complete, draft metadata,
  smoke failure, audit dispatch/retry/verification, immutable publication, and
  audited completion;
- unstarted older candidate superseded by a newer version, a tagged older
  candidate blocking a newer version, and prevention of `latest` rollback;
- valid and rejected abandonment transitions, permanent abandonment, and a later
  package appearance conflicting with an abandonment tombstone;
- newer changesets present while the current version is unpublished;
- exact-set inventory validation and `@dawn-ai/sandbox` membership;
- dependency-topological publish ordering and gate packages last;
- exact E404 classification versus auth, timeout, rate-limit, malformed JSON, and
  5xx failures;
- digest, provenance, version, SHA, annotated-tag, marker, base/evidence asset,
  and immutability conflicts;
- idempotent repeated planning at every state.

### Fault-injection integration harness

A three-package fixture repository uses a disposable Verdaccio registry and a
temporary Git remote. It runs the real controller adapters where practical and
injects failure after every external transition:

- before and after first, middle, and last npm publish;
- delayed registry visibility and delayed provenance;
- registry auth, timeout, rate-limit, and server errors;
- runner loss after npm accepts a publish but before local success is recorded;
- `main` advancing between a partial publish and an exact-tag recovery run;
- a newer candidate arriving while an older candidate is tagged or partial;
- deterministic pre-publish failure followed by protected abandonment, plus
  rejection when the publish job started or any registry response is ambiguous;
- missing, truncated, or modified artifact and manifest files;
- expired Actions artifact with valid draft-Release recovery escrow;
- matching partial escrow resumed after failure following asset 0, 1, a middle
  asset, and asset 44, plus refusal to fill a missing asset after npm starts;
- missing or conflicting tag, Release, marker, asset, or attestation;
- GitHub token failure after npm completes;
- smoke failure and smoke-result upload failure;
- runner loss around each post-npm and post-smoke marker CAS, after audit dispatch
  and before its separate receipt CAS, and after attempt-receipt upload,
  canonical-receipt upload, `AUDIT_VERIFIED` marker CAS, and Release publication
  acceptance;
- repeated failed audit attempt receipts followed by one canonical success, and
  rejection of a published non-immutable or unaudited managed Release;
- rerun after each injected failure.

Every rerun must either reach the intended final state without republishing an
existing version or stop on a deliberate conflict. The harness asserts registry
bytes, not only command exit codes.

### Workflow contract tests

Pull request 1 adds shadow-era contracts. They assert the read-only workflow's
triggers, inputs, permissions, action pinning, no publish commands, and no
mutation paths while deliberately allowing the unchanged legacy publisher to
retain its current topology.

Pull request 2 replaces those allowances with final-topology contracts that parse
the workflow YAML and assert:

- the exact triggers and required manual inputs;
- global `queue: max` concurrency with cancellation disabled;
- all third-party actions pinned to full commit SHAs;
- no OIDC or write permission in detect, prepare, or smoke jobs;
- no install, build, test, pack, or lifecycle-script execution in the npm job;
- no npm configuration or publish command outside `.github/workflows/release.yml`;
- no release publication permission in `version-pr.yml`;
- attestation occurs before the first possible npm publish;
- every artifact or mutation job requires the exact tag ref and candidate SHA;
- the candidate is tagged and exactly escrowed before npm, and every coordinator
  dispatches and exits even when its SHA already equals the candidate;
- abandonment is manual, protected, pre-publish-only, evidence-preserving, and
  terminal;
- independent audit dispatch and result correlation require version, commit SHA,
  manifest digest, and the direct dispatch-returned run ID;
- audit attempt and canonical success receipts are attached while the Release is
  draft, publication depends on `AUDIT_VERIFIED`, and no post-publication writer
  exists;
- final publication is re-read as immutable without body or asset drift.

### Full local rehearsal

Before the ownership switch, run the complete 21-package prepare, pack, manifest,
local install, and smoke flow. Publish all 21 packages to disposable Verdaccio,
inject a middle-package failure, resume, and compare downloaded registry tarballs
with the manifest. Run `pnpm ci:validate` after building from the isolated
worktree. The complete command, every controller-specific test, and every targeted
release rehearsal must be green; there is no baseline-failure waiver.

### First live release

The first release after the switch is a patch release with active monitoring:

1. Confirm the Version Packages pull request and exact-commit CI.
2. Observe artifact preparation and attestations before npm mutation.
3. Confirm the candidate tag, draft Release, release record, and recovery escrow
   all identify the exact candidate SHA and artifact before npm mutation.
4. Verify every package's serial publication and digest from an independent
   machine or clean environment.
5. Confirm the consolidated Release remains draft during smoke testing.
6. Run all exact-version smoke lanes, including Docker and database lanes.
7. Run Published Artifact Verification independently at `vX.Y.Z` while the
   Release remains draft; attach its attempt receipt and canonical successful
   `audit-result.json`.
8. Confirm the draft marker is `AUDIT_VERIFIED`, then publish without changing
   body or assets and re-read `immutable: true` plus the locked tag target.
9. Run one clean post-publication exact-tag verification that emits Actions
   evidence only, then confirm the next scheduled reconciliation is a no-op.
10. Verify that the exact release commit has a successful production Vercel
    deployment, exercise the public documentation routes including
    `/docs/api/cli`, and check the rendered pages plus browser console and network
    requests. The real Vercel-native CI lane and its CLI dependency remain in
    place.

## Rollout

The two pull requests receive separate implementation plans so each produces a
working, independently verifiable state. Within pull request 2, implementation is
sequenced as three workstreams—artifact/controller, privileged workflow, and
smoke/audit—with a full local integration rehearsal before the ownership switch
commit. They are parts of one release system, not independently deployable
features.

### Pull request 1: model and shadow reconciliation

- Add `@dawn-ai/sandbox` to the Changesets fixed group.
- Add the exact-set repository invariant.
- Introduce manifest schema, state model, planner, and read-only adapters.
- Add pure tests, workflow contracts, Verdaccio fault harness, and historical
  incident fixtures.
- Add a read-only manual/scheduled shadow reconciler that reports what the new
  controller would do without mutating npm or GitHub release state.
- Add shadow-era workflow contracts that permit the unchanged legacy publisher
  while proving the shadow path cannot mutate release state.
- Add a trusted-publisher and GitHub permission preflight report.
- Preserve the current publisher unchanged for this pull request.

The shadow report is run against `0.8.20`, `0.8.21`, and the current `main` state.
It must identify `0.8.20` as skipped history without proposing destructive
publication, identify the incomplete `0.8.21` GitHub evidence, and produce a
clean/no-candidate result where appropriate.

### Pull request 2: ownership switch

- Add the version-only workflow.
- Convert `release.yml` to the phased controller while preserving its filename
  for npm trusted publishing.
- Move preparation out of the privileged job.
- Replace direct workspace publication with manifest-tarball publication.
- Add consolidated tag/draft Release and required exact-version smokes.
- Integrate independent Published Artifact Verification.
- Replace shadow-era workflow allowances with final topology, permission,
  recovery-ref, and audit-correlation contracts.
- Remove the shadow workflow when the production controller becomes active, and
  refresh the pinned workflow-entrypoint, safe-executable, and release-script hash
  inventories in the same ownership-switch commit.
- Remove the old publisher, per-package release creation, backfill, and upload
  paths that would otherwise create split-brain ownership.
- Re-run trusted-publisher and permission preflight before merge.
- After the switch commit reaches `main` but before enabling the replacement
  release workflow or creating any candidate draft, enable repository immutable
  Releases and bind that setting into fresh post-enable owner evidence.

The switch is complete only after the first patch release and independent audit
pass. Legacy scripts are removed in the same pull request so there is one owner
for each release transition.

## Long-term direction

The controller's planner, artifact manifest, and registry adapters should remain
small enough to replace with stable upstream Changesets primitives when CLI v3
and Action v2 mature. Workflow boundaries intentionally mirror plan, pack,
publish, and report phases so adopting upstream implementations does not require
changing Dawn's integrity model.

Dependency and security-health remediation was completed before this cutover.
Future dependency updates should continue using stable upstream releases and the
existing security gates without adding temporary overrides to this controller.
