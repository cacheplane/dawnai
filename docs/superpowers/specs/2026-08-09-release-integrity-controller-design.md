# Release Integrity Controller Design

Status: approved design, ready for implementation planning

Date: 2026-08-09

## Summary

Dawn will replace its coupled Changesets publish workflow with a Dawn-owned,
resumable release controller. Changesets remains responsible for version intent,
changelogs, and the Version Packages pull request. A separate release workflow
will detect a release commit, prepare and attest one immutable set of package
tarballs, publish those exact tarballs through npm trusted publishing, reconcile
GitHub release metadata, run published-artifact smoke tests, and independently
audit the final public state.

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
- Solving the existing subprocess disposal smoke-test failure. That is tracked in
  a separate session and is recorded only as a known baseline condition here.
- Combining dependency and security-health remediation into this change. That is
  the next workstream after release integrity is proven.

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
head. The initial push run has `GITHUB_SHA=commitSha`. Immediately after candidate
validation, the controller creates the consolidated tag at the same SHA. If a
manual or scheduled coordinator is running from a different SHA, it may validate
and create that tag but must then dispatch the workflow at `vX.Y.Z` and exit
before preparation, attestation, or npm publication. Every job that produces or
publishes release artifacts therefore has `GITHUB_SHA=commitSha`; recovery runs
also have `GITHUB_REF=refs/tags/vX.Y.Z`. npm and GitHub provenance identify the
candidate rather than the current default-branch head.

Because the `push` release run and the CI run start from the same event, candidate
validation polls the required check suite for that exact SHA with a bounded wait.
It proceeds only after success, fails immediately after a terminal CI failure,
and exits as retryable when the bound expires. A later push, schedule, or exact
manual dispatch resumes observation; it never substitutes a different SHA. A
scheduled run is a coordinator only: it creates a missing candidate tag when
needed, dispatches `.github/workflows/release.yml` at that tag, and does not build,
attest, or publish from its own default-branch invocation. The coordinator exits
after confirming dispatch so it releases the global concurrency lock; the tagged
run then acquires the lock and performs reconciliation. A push run that discovers
an older tagged candidate follows the same dispatch-and-exit rule.

The version is read from the fixed-group manifests at that commit. A new push is
a candidate only when all fixed-group versions changed together relative to the
first parent and the commit contains the post-cutover controller schema. This
version-delta rule is independent of the presence of changeset files. It prevents
the ownership-switch commit itself and legacy version commits from being mistaken
for new releases.

Manual recovery discovers an existing candidate from its candidate tag and release
record. Scheduled discovery enumerates managed draft/published Releases and scans
first-parent `main` history for the newest fixed-group version-change commit that
contains the controller schema. Once discovered, a candidate remains actionable
when at least one exact `name@version` is absent from npm or when npm is complete
but downstream release evidence is incomplete.

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
5. The consolidated GitHub Release contains the release record, manifest,
   tarballs, attestations, and links to npm provenance.
6. Every required exact-version published-artifact smoke lane has passed.
7. An independent Published Artifact Verification run can reproduce the public
   assertions without relying on the release job's workspace.

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
manifest and exact version. The release workflow invokes the same scripts after
publication, while the scheduled/manual workflow reruns them independently. This
second execution guards against release-job state, cache, and timing artifacts.
Independent runs are always dispatched at `vX.Y.Z` with required `version`,
`commitSha`, and `manifestSha256` inputs.

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
the same checks at the merged switch SHA and requires the replacement workflow
paths to be active. Both phases consume fresh, commit/digest-bound authenticated
owner evidence from `npm trust list` plus GitHub permission/environment probes.
They pass only for one uniform 21-package publisher tuple and the exact protected
abandonment environment. Unknown, mixed, or stale evidence fails closed.

Scheduled recovery recognizes `AUDIT_COMPLETE` and
`ABANDONED_PREPUBLICATION` only through shared exact-key terminal-record parsers.
A successful audit also requires the consolidated Release to be published and
must not hide a failed individual check. An abandonment tombstone requires the
Release to remain draft, protected-environment approval, proof that neither the
publish job nor a registry mutation started, and two time-ordered exact-E404
observations covering all 21 packages. The audit and abandonment writers reuse
the same parsers; skeletal identity-only JSON never unblocks a newer candidate.

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
  -> RELEASE_PUBLISHED
  -> AUDIT_DISPATCHED
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
- a required smoke result is absent or failed.

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
clearly as abandoned, and attaches `abandonment.json`. It never deletes or moves
the tag, Release, artifact, attestation, or other evidence. An abandoned version
can never be reactivated or published by the controller. If any package at that
version later appears on npm, the scheduled audit reports a hard conflict.

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
plus the manifest digest, to `release-record.json` and stores that record and all
attested files as assets on the candidate's draft GitHub Release.

Later jobs resolve the artifact only through the release record, require
`actions: read` when retrieving it from the preparation run, and verify both the
service digest and every inner manifest digest. The draft Release assets are the
durable recovery escrow after Actions artifact retention expires. They are valid
only when their bytes match the manifest and their GitHub attestations verify.
The controller never rebuilds a candidate after any package is public. Before
escrow or npm publication, it may replace a lost preparation artifact while
retaining the same candidate tag, but only after proving that no durable release
record or package version exists.

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
tag at the candidate SHA. If the current workflow invocation already has
`GITHUB_SHA=commitSha`, the run continues. Otherwise the coordinator dispatches
the same workflow at the new tag and exits. A pre-existing tag at another commit
is a hard conflict.

Tagging before release artifacts are produced gives every artifact-producing and
publishing recovery run the exact candidate provenance identity. The tag denotes
an accepted release candidate; it does not claim npm publication or smoke success.

### 3. Prepare

An unprivileged job installs with the frozen lockfile, builds, packs all fixed-
group packages, inspects their contents, and executes local tarball tests and
smokes. Exact-commit CI has already run the repository's full validation lane, so
the release workflow does not repeat `pnpm ci:validate`. It then creates the
manifest and immutable artifact.

Preparation always packs all 21 packages, even if npm observation says some are
already present. This makes a fresh candidate complete and deterministic. On a
partial resume, the existing manifest artifact is reused instead of repacked.

### 4. Attest artifacts

Before the first npm mutation, a narrow job downloads the artifact, verifies every
digest, and creates GitHub build-provenance attestations for all tarballs and the
manifest. It receives `id-token: write`, `attestations: write`, and
`contents: read` plus `actions: read` for the recorded artifact, but no npm
registry configuration.

Attesting before npm publication ensures the original build evidence survives
even when publication or later metadata work fails.

### 5. Escrow the candidate

A narrow metadata job with `contents: write`, `actions: read`, and
`attestations: read` verifies the attested artifact and creates the consolidated
draft GitHub Release for the existing `vX.Y.Z` tag before npm publication. It
uploads the release record, manifest, tarballs, and attestation bundles as digest-
checked assets. This is the `CANDIDATE_ESCROWED` transition.

The tag provides the immutable workflow dispatch ref whose SHA matches
provenance; escrow adds a durable candidate-to-artifact locator and the exact
release bytes. The tag and draft Release intentionally remain visible if
publication later fails. They describe a candidate, not a claim that publication
completed.

Existing per-package tags and Releases remain historical and are not modified. A
pre-existing `vX.Y.Z` at a different commit, a same-name asset with different
bytes, or a release record pointing at another artifact is a hard conflict.

### 6. Publish npm

The npm job receives `contents: read`, `actions: read`, `attestations: read`, and
`id-token: write`. The initial run executes at the candidate push SHA; every
recovery run executes at the tagged `vX.Y.Z` ref. It uses a pinned
`actions/checkout` invocation with
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

A separate job with `contents: write`, `actions: read`, and `attestations: read`
verifies `NPM_COMPLETE`, validates the existing candidate tag and draft Release,
and updates that Release with observed npm evidence. It does not create a new
release identity after publication.

The draft Release includes:

- the release manifest;
- every package tarball;
- GitHub attestation bundles;
- a generated package table with npm links and tarball digests;
- npm provenance and transparency-log links;
- the candidate commit and exact CI run;
- the required smoke checklist and current results.

Asset upload is idempotent by filename and digest. A same-name, different-byte
asset is a conflict, never an overwrite.

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

### 9. Publish and independently audit

After all required smoke results pass, the metadata job updates the draft Release
with final evidence and publishes it. A narrow coordinator with `actions: write`
then dispatches the Published Artifact Verification workflow at `vX.Y.Z` with
exact `version`, `commitSha`, and `manifestSha256` inputs. The dispatched run ID
comes directly from the workflow-dispatch API's run-details response and is
recorded in the reconciliation report, creating `AUDIT_DISPATCHED`; the controller
does not race by listing recent runs and guessing which one it created.

The independent workflow re-observes npm, provenance, tag, Release, assets, and
smokes without consuming the release job's checkout or caches. An `if: always()`
finalizer uploads a machine-readable result named from the version and manifest
digest. That result repeats the three correlation fields, workflow run and
attempt, timestamps, individual checks, and final conclusion.

The release controller polls the dispatched run within a bounded window. On a
successful correlated result, a metadata job attaches `audit-result.json` to the
GitHub Release and records the independent run link, producing `AUDIT_COMPLETE`.
A timeout or failure leaves the already published Release intact but incomplete;
the scheduled coordinator dispatches another exact-tag audit, and a manual exact-
tag run can do the same. A clean scheduled audit of an `AUDIT_COMPLETE` release is
a no-op success. Drift opens a visible failure and never rewrites prior evidence.

## Recovery behavior

Recovery is reconciliation, not rollback:

| Observed state | Action |
| --- | --- |
| Valid untagged candidate, nothing published | Validate arbitration, create the tag, and continue only from an exact-SHA invocation. |
| Candidate tagged, no escrow or npm state | Dispatch at the tag, prepare, attest, and escrow the artifact. |
| Tagged candidate has an irrecoverable deterministic defect, publish phase never started | After protected manual approval and double registry absence proof, record `ABANDONED_PREPUBLICATION`; preserve all evidence and unblock the next version. |
| Artifact prepared, npm untouched | Verify and reuse the artifact; never rebuild needlessly. |
| Some packages published with matching digests | Skip verified packages and publish the first missing package onward. |
| All packages published, metadata incomplete | Reconcile tag, draft Release, assets, and attestations. |
| Metadata complete, smoke incomplete or failed | Rerun exact-version smoke; keep Release draft until green. |
| Release published, audit absent or failed | Dispatch the independent workflow at `vX.Y.Z`, correlate its result, and attach successful evidence. |
| Existing bytes, provenance, tag, or asset conflict | Stop with a conflict report; no destructive repair. |
| Registry or GitHub observation is ambiguous | Retry within bounded policy, then fail closed. |

Manual dispatch is the operator recovery entrypoint and always requires exact
version and SHA. If `vX.Y.Z` is absent, the coordinator may create it only after
candidate and arbitration checks; if it exists, it must resolve to that SHA. A
scheduled coordinator may audit from its own SHA, but artifact production,
attestation, npm publication, and provenance recovery are redispatched at the
exact tag whenever the coordinator's SHA differs. Push-triggered runs can detect
and reconcile their own candidate or dispatch tagged recovery, but never
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
  smoke failure, published Release, audit dispatch/failure, and audited
  completion;
- unstarted older candidate superseded by a newer version, a tagged older
  candidate blocking a newer version, and prevention of `latest` rollback;
- valid and rejected abandonment transitions, permanent abandonment, and a later
  package appearance conflicting with an abandonment tombstone;
- newer changesets present while the current version is unpublished;
- exact-set inventory validation and `@dawn-ai/sandbox` membership;
- dependency-topological publish ordering and gate packages last;
- exact E404 classification versus auth, timeout, rate-limit, malformed JSON, and
  5xx failures;
- digest, provenance, version, SHA, tag, and asset conflicts;
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
- missing or conflicting tag, Release, asset, or attestation;
- GitHub token failure after npm completes;
- smoke failure and smoke-result upload failure;
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
- the candidate is tagged and escrowed before npm, and recovery dispatch targets
  that tag;
- abandonment is manual, protected, pre-publish-only, evidence-preserving, and
  terminal;
- GitHub Release publication depends on required smoke results;
- independent audit dispatch and result correlation require version, commit SHA,
  and manifest digest.

### Full local rehearsal

Before the ownership switch, run the complete 21-package prepare, pack, manifest,
local install, and smoke flow. Publish all 21 packages to disposable Verdaccio,
inject a middle-package failure, resume, and compare downloaded registry tarballs
with the manifest. Run `pnpm ci:validate` after building from the isolated
worktree.

The known baseline subprocess test failure is reported separately and must not be
silently reclassified as a release-controller success. Controller-specific tests,
all other validation gates, and targeted release rehearsals must be green before
the second pull request.

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
7. Publish the consolidated Release only after every required result is green.
8. Run Published Artifact Verification independently at `vX.Y.Z` and attach its
   correlated result.
9. Confirm the next scheduled audit is a successful no-op.

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

The switch is complete only after the first patch release and independent audit
pass. Legacy scripts are removed in the same pull request so there is one owner
for each release transition.

## Long-term direction

The controller's planner, artifact manifest, and registry adapters should remain
small enough to replace with stable upstream Changesets primitives when CLI v3
and Action v2 mature. Workflow boundaries intentionally mirror plan, pack,
publish, and report phases so adopting upstream implementations does not require
changing Dawn's integrity model.

After release integrity is proven, the next project is dependency and security
health: inventorying direct and transitive risk, automating update policy,
validating supply-chain controls, and reducing Dependabot backlog without
weakening the release evidence established here.
