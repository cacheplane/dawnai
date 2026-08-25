# Release Integrity Controller PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Dawn to the phased release-integrity controller, publish one immutable 21-package artifact set with narrow npm authority, reconcile one consolidated draft Release, run exact published-package smokes, independently audit that complete draft, and publish it only after audit success.

**Architecture:** Extend PR 1's pure inventory/manifest/planner and read-only adapters with narrowly scoped effect modules. The fixed workflow filename `.github/workflows/release.yml` coordinates candidate validation, exact-tag dispatch, preparation, GitHub attestation, durable draft-Release escrow, serial npm publication, metadata reconciliation, smoke testing, independent draft audit, canonical receipt attachment, and final immutable Release publication. A separate version-only workflow owns Changesets' Version Packages pull request. One atomic final commit switches workflow ownership and deletes every legacy publishing path.

**Tech Stack:** Node.js 24 ESM, `node:test`, npm 11 trusted publishing and provenance, GitHub Actions OIDC/attestations/artifacts/Releases, Changesets Action v1, Verdaccio 6, YAML 2.9, Docker, PostgreSQL/pgvector, pnpm 10.33

**Spec:** `docs/superpowers/specs/2026-08-09-release-integrity-controller-design.md`

**Prerequisite:** PR 1 is merged and its inventory, manifest, topology, state, planner, observer, report, preflight, workflow-contract, and fault-harness interfaces are green. Start this PR from the resulting `main`; do not re-create parallel versions of those modules.

---

## File Structure

### Candidate and artifact effects

- Create `scripts/release/controller-schema.json` as the active ownership/cutover marker.
- Create `scripts/release/candidate.mjs` for version-delta discovery, exact-CI polling, arbitration, and tag-redispatch decisions.
- Create `scripts/release/adapters/git-write.mjs` exposing annotated candidate-tag creation only.
- Extend `scripts/release/adapters/github.mjs` only with the named reads required
  for annotated-tag peeling, exact Release CAS, run artifacts, and workflow jobs.
- Create `scripts/release/adapters/github-write.mjs` exposing exact-ref dispatch,
  draft Release/body/asset CAS, and final publication only.
- Create `scripts/release/prepare.mjs` to build, pack, inspect, smoke, hash, and manifest all fixed-group tarballs.
- Create `scripts/release/release-record.mjs` for the Actions artifact locator/service digest and durable escrow record.
- Create `scripts/release/artifact-store.mjs` to resolve and verify recorded Actions artifacts or attested escrow fallback.

### Publication, recovery, and evidence

- Create `scripts/release/publisher.mjs` as the dependency-free sparse-checkout OIDC entrypoint.
- Create `scripts/release/metadata.mjs` for the exact attestation-set and Release
  marker schemas, resumable draft escrow, evidence reconciliation, and immutable
  consolidated Release publication.
- Create `scripts/release/abandonment.mjs` for protected, pre-publish-only terminal tombstones.
- Create `scripts/release/smoke-result.mjs` for correlated per-lane and aggregate receipts.
- Create `scripts/release/audit.mjs` for exact-tag dispatch, direct run-ID receipt,
  bounded polling, attempt-scoped receipts, canonical success, and three-field
  correlation before Release publication.
- Create `scripts/release/controller.mjs` for one-transition-at-a-time orchestration.
- Create `scripts/release/cli.mjs` as the small command router used by workflows and local rehearsal.

### Published smoke extensions

- Extend `scripts/lib/published-artifacts.mjs`, `scripts/published-artifact-verify.mjs`, `scripts/published-artifact-smoke.mjs`, and `scripts/published-artifacts.test.mjs` for exact manifest correlation.
- Create `scripts/release/smoke/scaffold.mjs` for clean `create-dawn-ai-app@version` install/build/typecheck/runtime.
- Create `scripts/release/smoke/storage.mjs` for disposable pgvector and Postgres-storage probes.
- Create `scripts/release/smoke/runtime-targets.mjs` for Node and edge-target imports/runtime.
- Create `scripts/release/smoke/published-harness.mjs` for exact npm versions through framework/runtime/smoke assertions.

### Workflow and migration

- Create `.github/workflows/version-pr.yml` for Changesets version PRs only.
- Replace `.github/workflows/release.yml` in place; never rename it or delegate npm publication elsewhere.
- Replace `.github/workflows/published-artifact-verify.yml` with the exact-tag independent audit workflow.
- Replace PR 1 shadow-era workflow contracts with final parsed-YAML contracts.
- Delete legacy publisher/backfill/upload scripts and tests only in the atomic ownership-switch commit.
- Create `docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md` for configuration preflight, first patch release, recovery, abandonment, and post-release smoke.

## Execution Prerequisite

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node -e '
  if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)
  console.log(process.version)
'
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm --version
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:release-controller
```

Expected: Node 24+, pnpm 10.33.0, a fresh build, and the merged PR 1 contract green.

Before coding, capture the live preflight report. Treat these as external merge blockers, not code assumptions:

- every npm package's trusted publisher names `cacheplane/dawnai` and `.github/workflows/release.yml`, plus the exact configured environment if any;
- `RELEASE_GITHUB_TOKEN` can push/update the Version Packages branch, create/update its PR, and trigger CI;
- the standard `GITHUB_TOKEN` can create annotated `v*` tags and draft/published Releases under repository rules;
- owner credentials can read and enable repository immutable Releases before the
  replacement release workflow becomes active;
- the protected abandonment environment exists and requires approval;
- required exact-SHA CI is workflow `CI`, job/check `validate`.

### Execution corrections discovered during the 0.8.22 cutover

The implementation audit on 2026-08-24 found several obligations that the original
task breakdown did not assign to an implementation step. These corrections are
mandatory and take precedence over narrower wording later in this plan:

- Use the installed Node 24 runtime (currently `v24.19.0`) for every command below;
  the older absolute `v24.18.0` examples are illustrative, not a requirement to
  reinstall or downgrade Node.
- Task 8 must wire a real workflow-facing observer. The `observe` command may not
  stop at PR 1's shadow-only pure functions: it must construct the bounded Git,
  GitHub, npm, inventory, and candidate readers, observe the exact candidate, and
  feed that observation to the planner. Adapter ambiguity must remain fail-closed.
- Task 8 must migrate `preflight.mjs` from its frozen legacy-workflow model to the
  active controller schema and final workflow contracts. Strict preflight must be
  capable of passing with authenticated owner evidence; hard-coded
  `UNPROVABLE` results and the legacy Changesets publish topology are not valid
  merge gates for the ownership switch.
- Task 10 must delete `release-shadow.yml` so there is no second controller
  entrypoint, and must update
  `workflow-entrypoints.json`, `workflow-safe-executables.json`, and
  `release-script-hashes.json` for every workflow/script ownership change.
- The version command must increment each Helm chart's own patch `version` exactly
  once whenever its `appVersion` advances, while remaining a no-op when already
  synchronized. Merely changing `appVersion` causes the Publish Chart workflow to
  find the old OCI version and silently skip publication, as happened for 0.8.21.
  The first 0.8.22 Version Packages PR therefore advances both charts' package
  versions and app versions, and post-merge verification must prove the new OCI
  chart versions rather than accepting a skipped job.
- `release.yml` and `publish-chart.yml` remain manually disabled until the atomic
  ownership switch, strict preflight, and configuration checks are green. Their
  later enablement is an explicit cutover action, not an implementation shortcut.
- Every artifact-producing or mutating release job is exact-tag-only. A
  `refs/heads/main` run whose SHA equals the candidate still creates/validates the
  annotated tag, dispatches `release.yml` at `vX.Y.Z`, and exits before
  preparation. This avoids branch-ref GitHub attestation provenance.
- The independent audit runs while the consolidated Release is still draft.
  Attempt-scoped and canonical success receipts are attached before publication;
  final publication changes only `draft` and must re-read `immutable: true`.

## Task 1: Activate exact candidate discovery and tag identity

**Files:**
- Create: `scripts/release/controller-schema.json`
- Create: `scripts/release/candidate.mjs`
- Create: `scripts/release/terminal-records.mjs`
- Create: `scripts/release/adapters/git-write.mjs`
- Create: `scripts/release/test/candidate.test.mjs`
- Create: `scripts/release/test/terminal-records.test.mjs`
- Create: `scripts/release/test/git-write.test.mjs`
- Modify: `scripts/release/state.mjs`
- Modify: `scripts/release/planner.mjs`

- [ ] **Step 1: Write failing cutover and candidate tests**

Cover:

- the ownership-switch commit has the marker but no version delta and is `NO_CANDIDATE`;
- a later first-parent commit changes every fixed-group version once and is a candidate even when new changesets exist;
- a legacy version commit without the active marker is audit-only;
- scheduled discovery enumerates managed draft/published Releases and their
  release records plus standalone managed `refs/tags/v*`, then selects the
  lowest-version tagged candidate that has not reached `AUDIT_COMPLETE` or
  `ABANDONED_PREPUBLICATION`;
- a candidate tag with no corresponding Release is recovered as
  `CANDIDATE_TAGGED` rather than omitted;
- when no tagged candidate is incomplete, scheduled discovery scans first-parent
  `main` history for managed version-delta commits and selects the newest
  unsuperseded untagged candidate;
- an older incomplete tagged candidate wins over a newer version commit and is
  redispatched at its immutable tag;
- exact required `CI / validate` success gates tagging;
- pending CI polls within a fixed budget, terminal failure stops, and timeout is retryable;
- only `GITHUB_REF=refs/tags/vX.Y.Z` together with
  `GITHUB_SHA=commitSha` continues after tag validation;
- every branch, schedule, or manual coordinator creates/validates the annotated
  tag, dispatches at `vX.Y.Z`, and exits before preparation even when its SHA
  already equals the candidate;
- existing tag at another commit is a conflict;
- older tagged/partial release blocks a newer candidate, while audited/abandoned releases do not;
- `latest` is never moved backward.

Use an active marker with an explicit epoch:

```json
{
  "schemaVersion": 1,
  "publishingOwner": "release-controller",
  "epoch": "fixed-group-v1",
  "npmTrustedPublisherEnvironment": null,
  "abandonmentEnvironment": "release-abandonment"
}
```

`npmTrustedPublisherEnvironment` is `null` only when all 21 verified npm trusted
publishers have no environment restriction; otherwise set it to their one uniform
exact environment name. The current successful workflow has no job environment,
so `null` is the expected starting value, but strict owner-side preflight must
reconfirm it. Mixed package settings are a merge blocker, not a value the
controller normalizes.

Candidate recovery must parse terminal assets through reusable, exact-key
`audit-result.json` and `abandonment.json` schemas in `terminal-records.mjs`.
Audit verification requires canonical success and aggregate/check consistency;
terminal audit completion additionally requires the same consolidated Release to
be published and immutable. Abandonment requires a draft Release,
protected-environment approval evidence, publish/registry-mutation absence,
one exact authorizing workflow run/attempt, and two time-ordered exact-E404
observations covering the full 21-package inventory while that run holds the
shared non-cancelling release lock. The GitHub approval-history response proves
the approved state, environment ID/name, and reviewer numeric identity; the run
response and `GITHUB_ACTOR_ID` bind the independent workflow actor; the record stores
the API observation time because that response exposes neither an approval
timestamp nor a deployment ID. Tasks 5 and 7 import these parsers for their
canonical writers; they may not redefine looser shapes or synthesize unavailable
fields.

Expose and test:

```js
export function parseAuditResult(value)
export function parseAbandonmentRecord(value, { candidate, environment, packageNames })
```

Both parsers snapshot JSON input without invoking accessors, reject extra keys,
validate bounded scalar values and time ordering, and return deeply frozen data.

- [ ] **Step 2: Run red**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/candidate.test.mjs \
  scripts/release/test/terminal-records.test.mjs \
  scripts/release/test/git-write.test.mjs
```

Expected: missing modules/exports.

- [ ] **Step 3: Implement exact candidate discovery**

Expose:

```js
export async function discoverManagedCandidate({ ref, inventory, git, marker })
export async function discoverScheduledCandidate({ inventory, git, github, marker })
export async function waitForRequiredCi({ sha, github, attempts, delayMs, delay })
export function arbitrateCandidate({ candidate, managedReleases, registryLatest })
export function decideInvocation({ candidateVersion, candidateSha, githubSha, githubRef, tagState })
```

`discoverManagedCandidate` compares the fixed-group manifests with the first parent and requires all 21 versions to change together. It does not inspect remaining `.changeset/*.md` files.

`discoverScheduledCandidate` first enumerates managed `refs/tags/v*` and reads
consolidated `v*` draft/published Releases, then validates the union of their
tag/terminal/release-record identities. It checks a valid `abandonment.json`
before requiring `release-record.json`, because abandonment is legal from
`CANDIDATE_TAGGED` before a release record exists. Audit completion always
requires the exact record and manifest. A standalone tag at an active-marker
version-delta commit is an incomplete `CANDIDATE_TAGGED` candidate even when no
Release exists.
The function returns the oldest incomplete tagged candidate before considering
new work. Only when no such candidate exists does it scan first-parent `main`
history for commits containing the active marker and a fixed-group version delta,
discard audited/abandoned or semantically superseded versions, and select the
newest remaining untagged candidate. Every selection is passed through
`arbitrateCandidate`; the schedule never assumes current `main` is the release
candidate. Extend the PR 1 GitHub reader's named ref API if needed, but do not add
a generic request escape hatch.

`decideInvocation` continues only for the exact tag ref and candidate SHA. Every
other invocation returns `dispatch-and-exit` after tag validation; SHA equality
alone is insufficient provenance.

- [ ] **Step 4: Implement the one-purpose Git writer**

```js
export function createCandidateTagWriter({ root, run = runCommand })
// returned interface: createAnnotatedTag({ tag, sha, message }) and pushTag({ tag }) only
```

Validate `tag === v${version}`, full SHA, ancestry on `main`, and exact existing-tag equality before mutation. Do not expose delete, force, move, checkout, or generic Git methods.

- [ ] **Step 5: Run focused green tests and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/candidate.test.mjs \
  scripts/release/test/terminal-records.test.mjs \
  scripts/release/test/git-write.test.mjs \
  scripts/release/test/planner.test.mjs
git add scripts/release/controller-schema.json scripts/release/candidate.mjs \
  scripts/release/terminal-records.mjs \
  scripts/release/adapters/git-write.mjs scripts/release/state.mjs scripts/release/planner.mjs \
  scripts/release/test/candidate.test.mjs scripts/release/test/terminal-records.test.mjs \
  scripts/release/test/git-write.test.mjs
git commit -m "feat(release): activate exact release candidates"
```

## Task 2: Prepare and verify one immutable 21-package artifact set

**Files:**
- Create: `scripts/release/prepare.mjs`
- Create: `scripts/release/prepare-checks.mjs`
- Create: `scripts/release/limits.mjs`
- Create: `scripts/release/process-runner.mjs`
- Create: `scripts/release/release-record.mjs`
- Create: `scripts/release/artifact-store.mjs`
- Create: `scripts/release/test/prepare.test.mjs`
- Create: `scripts/release/test/limits.test.mjs`
- Create: `scripts/release/test/process-runner.test.mjs`
- Create: `scripts/release/test/release-record.test.mjs`
- Create: `scripts/release/test/artifact-store.test.mjs`
- Modify: `scripts/release/manifest.mjs`
- Modify: `scripts/release/test/manifest.test.mjs`
- Modify: `scripts/release/adapters/github.mjs`
- Modify: `scripts/release/test/github-adapter.test.mjs`

- [ ] **Step 1: Write failing preparation tests**

Inject command and filesystem adapters. Assert:

- all and only 21 fixed-group packages are packed;
- dependency-first stable order is derived, with `create-dawn-ai-app` final;
- `pnpm build` occurs before any pack;
- local pack inspection and required local tarball smokes occur before manifest output;
- each entry contains basename, positive size, SHA-256, SHA-512, npm integrity, access, and exact version;
- preparation never runs `pnpm ci:validate` because exact-commit CI already did;
- durable record/npm state forbids repacking;
- candidate-tag-only state may retry a lost preparation;
- caller-owned candidate, CI, run, authority, and inventory objects are snapshotted
  synchronously without invoking accessors and cannot change meaning across awaits;
- the output directory is outside the canonical repository root, and the exact
  clean checkout/tag identity is rechecked immediately before manifest sealing;
- the default process runner has bounded time/output, kills the child process tree,
  and preserves the primary failure while always attempting registry and temporary
  directory cleanup;
- per-file, cumulative payload, archive-entry, and expanded-byte limits reject
  oversized data before allocation or extraction;
- local publication passes the loopback registry explicitly, rejects a conflicting
  `publishConfig.registry`, and rejects HTTP, Git, file, workspace, or other direct
  dependency sources while allowing semver ranges and npm aliases.

- [ ] **Step 2: Implement the preparation interface**

```js
export async function prepareReleaseArtifacts({
  candidate,
  inventory,
  root,
  outputDir,
  ci,
  prepareRun,
  preparationAuthority,
  sourceRef,
  run?,
  inspectTarball?,
  smokeTarballs?,
  createProductionChecks?,
  fileSystem?,
})
```

The implementation snapshots all caller data before its first await, proves a clean
exact tagged checkout, requires output outside that checkout, builds and packs with
lifecycle behavior already approved by CI, validates tarball contents, and runs
real local clean-install, TypeScript, and scaffold typecheck/build probes against a
loopback Verdaccio registry. The production runner and cleanup are bounded, and
the shared payload/archive limits leave headroom below GitHub's durable escrow
limit. Immediately before writing canonical `manifest.json`, it re-proves the
same clean HEAD and annotated tag. It returns the manifest digest plus deterministic
Actions artifact name `release-vX.Y.Z-<12-sha>`.

- [ ] **Step 3: Write and implement the release-record schema**

The immutable record contains:

```js
{
  schemaVersion: 1,
  version,
  commitSha,
  tag,
  manifestSha256,
  actionsArtifact: {
    id,
    name,
    serviceDigest,
    prepareRunId,
    prepareRunAttempt,
  },
}
```

Expose `parseReleaseRecord`, `canonicalReleaseRecordBytes`, and `releaseRecordSha256`. Reject unknown identity, malformed IDs/digests, and tag/version/SHA mismatch.

Also implement the transition that creates the record from the immutable payload
upload receipt:

```js
export function createReleaseRecord({
  candidate,
  manifestSha256,
  artifact: { name },
  artifactUpload: { id, digest },
  prepareRun: { id, attempt },
})
```

The prepare job uploads the manifest/tarball payload first, passes the upload
action's exact artifact ID and digest into the standalone release-record function,
and supplies the name only from Task 2's deterministic preparation result. GitHub's
upload action returns ID, URL, and a bare digest; it does not return a name. The
function canonicalizes the bare digest to the stored service-digest form and never
infers or discovers an artifact by name. The job uploads the resulting small
`release-record.json` as a separate immutable handoff for the attest/escrow jobs.
The record is later copied into draft-Release escrow. Task 8 adds the workflow-facing
`record-artifact` CLI after the shared router exists.

- [ ] **Step 4: Write artifact resolution tests before implementation**

Cover exact recorded Actions artifact, wrong service digest, inner manifest/tarball corruption, missing record, artifact expiry with valid attested escrow, expiry with missing/invalid escrow, and refusal to rebuild after durable record/npm state.

```js
export async function loadVerifiedReleaseArtifact({ record, actionsReader, releaseReader, attestations })
```

Make `artifact-store.mjs` a dependency-free executable as well as an importable
module. Its `resolve` command accepts an exact release record and output
directory, retrieves the payload by recorded Actions artifact ID, and on an
explicit retention-expired response retrieves the named draft-Release escrow
assets instead. Fallback requires the exact 45-asset base escrow; a published,
partial, unknown-asset, or terminal-evidence-only Release is not an escrow source.
Both paths verify the service/manifest/file digests and all 22 GitHub attestations
before materializing files. Authorization, timeout, malformed, and other API
failures never select fallback. Task 4 proves this executable inside the exact
sparse npm-job filesystem; its allowlist includes the shared limits module but not
the preparation-only process runner. ZIP parsing and tar inspection enforce the
same entry/count/compressed/expanded-byte contract before allocation or extraction.
Task 10 invokes it before `publisher.mjs`.

- [ ] **Step 5: Run focused verification and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/prepare.test.mjs \
  scripts/release/test/limits.test.mjs \
  scripts/release/test/process-runner.test.mjs \
  scripts/release/test/release-record.test.mjs \
  scripts/release/test/artifact-store.test.mjs \
  scripts/release/test/manifest.test.mjs \
  scripts/release/test/github-adapter.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm pack:check
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm verify:typescript-tooling-pack
git add scripts/release/prepare.mjs scripts/release/prepare-checks.mjs \
  scripts/release/limits.mjs scripts/release/process-runner.mjs \
  scripts/release/release-record.mjs scripts/release/artifact-store.mjs \
  scripts/release/manifest.mjs scripts/release/adapters/github.mjs \
  scripts/release/test/prepare.test.mjs scripts/release/test/limits.test.mjs \
  scripts/release/test/process-runner.test.mjs \
  scripts/release/test/release-record.test.mjs scripts/release/test/artifact-store.test.mjs \
  scripts/release/test/manifest.test.mjs scripts/release/test/github-adapter.test.mjs
git commit -m "feat(release): prepare immutable release artifacts"
```

## Task 3: Add exact draft escrow, metadata markers, and bounded GitHub effects

**Files:**
- Create: `scripts/release/adapters/github-write.mjs`
- Create: `scripts/release/metadata.mjs`
- Create: `scripts/release/test/github-write.test.mjs`
- Create: `scripts/release/test/metadata.test.mjs`
- Create: `scripts/release/test/observation-schema.test.mjs`
- Create: `scripts/release/test/evidence.test.mjs`
- Create: `scripts/release/test/conflicts.test.mjs`
- Create: `scripts/release/test/state.test.mjs`
- Modify: `scripts/release/adapters/github.mjs`
- Modify: `scripts/release/test/github-adapter.test.mjs`
- Modify: `scripts/release/observation-schema.mjs`
- Modify: `scripts/release/evidence.mjs`
- Modify: `scripts/release/conflicts.mjs`
- Modify: `scripts/release/state.mjs`
- Modify: `scripts/release/planner.mjs`

- [ ] **Step 1: Write failing composed-reader and five-method writer tests**

Extend the existing bounded reader only with these named methods:

```js
getGitTag({ tagSha })
getRelease({ releaseId })
listActionsRunArtifacts({ runId })
listActionsRunJobs({ runId })
```

The existing `getActionsRun`, `getActionsArtifact`, and
`downloadActionsArtifact` methods remain the exact-run result path. The new
artifact list is run-scoped and the new job list is used to prove pre-escrow
publication absence; neither may be implemented through an unfiltered
repository-wide lookup. Compose production GitHub effects as
`Object.freeze({ reader, writer })`. The writer exposes exactly:

```js
createDraftRelease({ tag, targetSha, title, body })
updateDraftReleaseIfCurrent({ releaseId, tag, targetSha, expectedBodySha256, title, body })
uploadAssetIfAbsentAndEqual({ releaseId, tag, targetSha, name, bytes, sha256 })
publishReleaseIfCurrent({ releaseId, tag, targetSha, expectedBodySha256, assets })
dispatchWorkflowAtRef({ workflow, ref, inputs })
```

Assert the writer has no delete, overwrite, clobber, force, tag-mutation, or
generic-request method. Draft discovery must use paginated `listReleases`; do not
assume get-by-tag returns drafts. Every Release operation reads
`refs/tags/vX.Y.Z`, requires an annotated-tag object, peels it through
`getGitTag`, and compares the resulting commit with `targetSha` instead of trusting
`target_commitish`. Reject a lightweight tag, wrong peeled SHA, duplicate matching
Releases, unsafe remote data, and ambiguous reader envelopes.

Test compare-and-swap behavior for create races, stale body hashes, wrong tags,
already-published Releases, identical body no-ops, same-name asset download/hash
equality, different bytes, upload races, and re-read mismatch. Publication must
accept only an `AUDIT_VERIFIED` final body and exact allowed asset set, PATCH only
`draft: false`, and re-read `immutable: true` with unchanged body/assets/tag.

For dispatch, whitelist only `.github/workflows/release.yml` and
`.github/workflows/published-artifact-verify.yml`; use API version `2026-03-10`,
omit the removed `return_run_details` request field, and require its mandatory
HTTP 200 response with exact `workflow_run_id`, `run_url`, and `html_url` bound to
the repository and returned ID. Reject a request containing the removed field,
202/204, missing or malformed IDs/URLs, redirects or response overflow, and any
implementation that lists recent runs.

`listActionsRunJobs` must call the exact run-jobs endpoint with `filter=all`, not
GitHub's default latest-attempt view. Its normalized jobs retain `runAttempt` and
are stably ordered by attempt then job ID. Tests cover multiple rerun attempts,
prove that a started `publish-npm` job in an older attempt blocks escrow, and
reject omitted filters, incomplete attempt coverage, duplicate attempt/job
identities, pagination ambiguity, and reordered or malformed responses.

- [ ] **Step 2: Write exact marker and 22-attestation schema tests**

Expose:

```js
export function parseReleaseMarker(value)
export function canonicalReleaseBody(input)
export function releaseBodySha256(body)
export function parseAttestationSet(value, { candidate, manifest, repository })
export function canonicalBaseAssetSet({ record, artifact, attestationSet, bundles })
```

The body contains exactly one delimited canonical marker with the exact root
schema and phases from the design. Reject duplicate markers, extra keys,
noncanonical JSON, invalid phase-specific nullability, a backward revision/phase,
and identity or digest mismatch. The human-readable package/evidence sections are
rendered deterministically from validated data; arbitrary body text is not
preserved through a controller update.

Test the exact audit object in the marker. `AUDIT_DISPATCHED` records only the
dispatch-returned run ID/API URL/HTML URL; `AUDIT_RETRYABLE` records a failed
run/attempt and its unique attempt asset/digest; retry replaces the current audit
identity without removing older attempt assets; and `AUDIT_VERIFIED` records
equal attempt/canonical digests and conclusion `success`. `AUDIT_COMPLETE` is an
observed controller state, not a marker phase: it combines the unchanged
`AUDIT_VERIFIED` marker with a published immutable Release.

The attestation set has one exact repository/workflow/source-ref/SHA/run identity
and exactly 22 ordered subjects: `manifest.json`, then the 21 manifest tarballs in
package order. Each subject has exact subject name/digest and bundle name/digest;
bundle names are `<subjectName>.intoto.jsonl`. Reject 21/23 subjects, duplicates,
wrong order, wrong workflow, non-tag source ref, wrong SHA/run, unexpected bundle,
bundle digest mismatch, or any failed bundle verification. The attestation set is
marker metadata, not a 46th Release asset.

- [ ] **Step 3: Write resumable escrow and asset-namespace tests**

Require this interface:

```js
export function parsePublicationState(value, { candidate, inventory })
export async function escrowCandidate({
  candidate,
  record,
  artifact,
  attestationSet,
  bundles,
  publicationState,
  github,
})
```

`publicationState` snapshots exact Actions job history, registry-mutation evidence,
and all 21 exact package observations. Escrow mutation requires no started
`publish-npm` job, no registry mutation receipt, and exact E404 for every package.
Parse it as the design's exact-key, deeply frozen schema. It includes every
managed `release.yml` run for the candidate SHA and each run's exact
`listActionsRunJobs` `filter=all` result, with `runAttempt` retained per job and
stable attempt/ID ordering; missing attempt or job coverage, duplicate
run/attempt/job identities, a non-null `publish-npm.startedAt` in any attempt, a
candidate publication receipt, or any ambiguous registry observation blocks
before Release mutation. A resumed escrow takes a new snapshot rather than
trusting the previous run's absence proof. It creates or resumes a draft with
phase `ATTACHING`; that marker binds the prepared manifest and release record but
deliberately leaves `baseAssetSetSha256` and `attestationSet` null. It first
uploads the release record, manifest, and 21 tarballs. The first
cryptographically valid exact multi-subject bundle durably attached to the
Release becomes the anchor. A concurrent replay that produced different valid
bundle bytes downloads, verifies, and adopts that existing anchor rather than
merging bundle sets or trusting the losing caller. The writer copies the anchored
bytes to all 22 deterministic bundle names and only then CASes directly to
`ESCROWED`, recording the signed winning workflow run/attempt and exact 45-asset
base digest.

Inject runner loss after draft creation, every prepared-asset write, anchor
selection, every bundle copy, and the final marker CAS. A matching `ATTACHING`
subset is resumable while its exact bytes remain available; repeated complete
escrow is a no-op. Fence every write with an unchanged annotated tag, draft
identity/body revision, asset inventory, and fresh publication-absence snapshot,
so an abandonment or competing writer cannot poison the namespace. Duplicate,
unexpected, ambiguous, different-byte, wrong-marker, wrong-record, wrong-tag, or
unverifiable bundle state blocks. Missing escrow after the publish job starts is
a hard conflict and may not be repaired.

Partition later assets without weakening base exactness: audit attempts are named
`audit-attempt-<runId>-<attempt>.json`, canonical success is
`audit-result.json`, and abandonment is `abandonment.json`. Unknown names,
audit/abandonment coexistence, duplicate evidence, or a canonical result unequal
to its successful attempt receipt block. `escrowComplete` evaluates the exact 45
base assets separately from the phase-appropriate evidence union. An audit may
add receipts only after the exact 45-member base set is complete. A tagged-only
or prepared/no-Release abandonment tombstone may retain zero base assets and must
bind that predecessor explicitly. Once an `ATTACHING` draft exists, abandonment
must first resume it to a cryptographically verified exact 45-member `ESCROWED`
base; retention loss that makes this impossible blocks rather than synthesizing
or discarding evidence. A terminal abandonment is never classified as complete
escrow and can never be published.

- [ ] **Step 4: Implement marker-driven reconciliation and immutable publication guard**

```js
export async function reconcileNpmEvidence({ candidate, record, npmEvidence, github })
export async function reconcileSmokeEvidence({
  candidate,
  record,
  npmEvidence,
  smokeResults,
  github,
})
export async function publishConsolidatedRelease({ candidate, record, auditResult, github })
```

`reconcileNpmEvidence` advances by body CAS only from `ESCROWED` to
`NPM_COMPLETE`. After the read-only smoke jobs,
`reconcileSmokeEvidence` advances only from `NPM_COMPLETE` to `SMOKES_COMPLETE`
when exact correlated evidence permits it. Matching evidence may be one transition
ahead of a stale marker after runner loss; the corresponding function reconciles
that one marker forward. `publishConsolidatedRelease` accepts only canonical
successful audit bytes already attached to a draft whose marker is
`AUDIT_VERIFIED`; it delegates to `publishReleaseIfCurrent` and never changes
published metadata.

Update the observation schema/evidence/conflict/state/planner layers so an
`ATTACHING` matching subset is incomplete/resumable rather than
`escrow-draft-incomplete`, terminal evidence does not pollute base exactness, and
metadata state is derived from the canonical marker rather than the current
hard-coded `metadataReconciled: false` placeholder.

- [ ] **Step 5: Run tests and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/github-adapter.test.mjs \
  scripts/release/test/github-write.test.mjs \
  scripts/release/test/metadata.test.mjs \
  scripts/release/test/observation-schema.test.mjs \
  scripts/release/test/evidence.test.mjs \
  scripts/release/test/conflicts.test.mjs \
  scripts/release/test/state.test.mjs \
  scripts/release/test/planner.test.mjs
git add scripts/release/adapters/github.mjs scripts/release/adapters/github-write.mjs \
  scripts/release/metadata.mjs scripts/release/observation-schema.mjs \
  scripts/release/evidence.mjs scripts/release/conflicts.mjs scripts/release/state.mjs \
  scripts/release/planner.mjs scripts/release/test/github-adapter.test.mjs \
  scripts/release/test/github-write.test.mjs scripts/release/test/metadata.test.mjs \
  scripts/release/test/observation-schema.test.mjs scripts/release/test/evidence.test.mjs \
  scripts/release/test/conflicts.test.mjs scripts/release/test/state.test.mjs \
  scripts/release/test/planner.test.mjs
git commit -m "feat(release): add exact candidate escrow"
```

## Task 4: Publish manifest tarballs serially and resume partial npm state

**Files:**
- Create: `scripts/release/publisher.mjs`
- Create: `scripts/release/test/publisher.test.mjs`
- Modify: `scripts/release/adapters/npm.mjs`
- Modify: `scripts/release/test/npm-adapter.test.mjs`

- [ ] **Step 1: Write fail-closed exact registry tests**

Extend the PR 1 adapter to observe exact tarball bytes/digest, `latest`, registry signature, and npm provenance workflow/commit. Exact package/version E404 is absent; auth, timeout, 429, parse, and 5xx never mean missing.

- [ ] **Step 2: Write the serial publisher test table**

Cover:

- first/middle/last missing package;
- all present with matching manifest bytes;
- existing version with mismatched bytes;
- runner loss after registry accepts first/middle/last publish;
- delayed exact metadata, signature, provenance, or `latest`;
- a newer `latest` before any mutation (`SUPERSEDED_NOOP`) and during partial state (hard conflict);
- topological order and `create-dawn-ai-app` final;
- stop on first conflict/error;
- second run resumes missing packages and third run is a no-op.

- [ ] **Step 3: Implement the dependency-free publisher**

```js
export async function publishManifestSerially({
  candidate,
  manifest,
  observeRegistry,
  downloadRegistryTarball,
  publishTarball,
  poll,
  log,
})
```

The production `publishTarball` executes only:

```text
npm publish <recorded.tgz> --tag latest --access public --provenance --ignore-scripts
```

The module must have only Node built-in imports and sibling `scripts/release/` imports. It cannot read package directories, run install/build/test/pack, or use the lockfile. It re-verifies the artifact before the loop and every package's `latest` before each mutation.

`publisher.mjs` is also its own production executable. Its main guard accepts
only `--candidate`, `--record`, `--artifact-dir`, `--report`, and
`--github-output`; it does not route through `cli.mjs` or import inventory/YAML.

- [ ] **Step 4: Verify the exact sparse-checkout and recovery surface**

Add a test fixture representing the npm job filesystem and spawn the exact
production sequence:

```text
node scripts/release/artifact-store.mjs resolve \
  --record release-input/release-record.json --output-dir release-materialized
node scripts/release/publisher.mjs --candidate release-input/candidate.json \
  --record release-input/release-record.json --artifact-dir release-materialized \
  --report release-output/publish.json --github-output release-output/github-output
```

Use an isolated fixture path in the test rather than relying on the illustrative
directory names above. Run the sequence once with a fake GitHub API serving the
exact recorded Actions artifact ID and once with that ID explicitly expired plus
valid attested draft-Release assets. Assert both materialize identical manifest
tarball bytes. Auth, timeout, malformed, and non-retention failures must stop
before `npm publish` and must not use escrow.

Assert it succeeds with only:

```text
scripts/release/publisher.mjs
scripts/release/artifact-store.mjs
scripts/release/limits.mjs
scripts/release/manifest.mjs
scripts/release/release-record.mjs
scripts/release/semver.mjs
scripts/release/adapters/github.mjs
scripts/release/adapters/http.mjs
scripts/release/adapters/npm.mjs
scripts/release/topology.mjs
release-input/candidate.json
release-input/release-record.json
```

The resolver must create only the verified
`release-materialized/manifest.json` and `release-materialized/*.tgz` payload
(plus an explicit verification receipt if the implementation needs one) before
the publisher starts.

If implementation adds another dependency-free sibling import or archive helper,
add it explicitly to this tested allowlist. `inventory.mjs`, `candidate.mjs`,
`controller.mjs`, `cli.mjs`, `preflight.mjs`, `package.json`, and `node_modules`
must remain absent. The resolver or publisher fails if any manifest tarball is
absent. No package lifecycle script may execute.

- [ ] **Step 5: Run tests and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/npm-adapter.test.mjs \
  scripts/release/test/publisher.test.mjs
git add scripts/release/publisher.mjs scripts/release/adapters/npm.mjs \
  scripts/release/test/publisher.test.mjs scripts/release/test/npm-adapter.test.mjs
git commit -m "feat(release): publish manifest tarballs serially"
```

## Task 5: Implement protected pre-publication abandonment

**Files:**
- Create: `scripts/release/abandonment.mjs`
- Create: `scripts/release/test/abandonment.test.mjs`
- Modify: `scripts/release/metadata.mjs`
- Modify: `scripts/release/planner.mjs`

- [ ] **Step 1: Write every rejection case first**

Reject abandonment when:

- version/SHA/reason is missing or malformed;
- the publish job or first registry mutation command ever started;
- any fixed-group `name@version` is visible;
- either of two separated observations is ambiguous or not exact E404;
- tag identity differs;
- a newer release interleaved;
- the candidate was previously abandoned and inputs/evidence differ.

- [ ] **Step 2: Write the successful terminal transition test**

Require protected-environment approval evidence (approved state, environment
ID/name, reviewer ID/login, and API observation time), an independent actor ID/login, one
exact run/attempt, reason, two package-observation sets separated by at least 60
seconds, and exact tag identity. The same non-cancelling global release lock must
cover the Actions read, both registry observations, and final mutation. Assert
`abandonment.json` canonical bytes, draft Release title/body, preservation of
every existing asset/attestation, permanent non-reactivation, and newer-candidate
unblocking.

Cover every legal predecessor and its one exact marker shape:

- `CANDIDATE_TAGGED`: manifest, release-record, base-set, and attestation fields
  are all null, and the only asset is `abandonment.json`; candidate discovery
  recognizes it before trying to load `release-record.json`;
- `ARTIFACTS_PREPARED`: manifest and release-record digests are non-null, while
  base-set and attestation fields remain null;
- a successful attestation action with no durable Release anchor remains
  `ARTIFACTS_PREPARED`; it is safe to replay and cannot create a digest-only
  `ARTIFACTS_ATTESTED` predecessor;
- `CANDIDATE_ESCROWED`: all four artifact fields are non-null and the exact 45
  cryptographically verified base assets are preserved. An interrupted matching
  `ATTACHING` draft must resume to that state before abandonment; zero/subset
  terminal rewrites are rejected.

Reject every other nullability combination or any artifact context weaker than
the durable evidence already observed. Unknown, duplicate, different-byte, or
audit assets block. A terminal abandonment never satisfies the 45-asset
publication precondition.

- [ ] **Step 3: Implement the narrow interface**

```js
export async function evaluateAbandonment({
  candidate,
  reason,
  actionsHistory,
  observations,
  approval,
  artifactContext,
})
export function canonicalAbandonmentBytes(tombstone)
export async function recordAbandonment({ candidate, tombstone, artifactContext, github })
```

No automatic caller may invoke it. The workflow command is manual-only and the job must name the protected abandonment environment configured during preflight.
It derives approval history from `GET /actions/runs/{run_id}/approvals`; it must
not accept caller-authored approval timestamps, deployment IDs, or registry
absence evidence.
The canonical writer must round-trip its output through Task 1's
`parseAbandonmentRecord`; it may not define or accept a second tombstone schema.
The exact-key, deeply frozen `artifactContext` carries the observed predecessor,
phase-appropriate digests/attestation set, and retained base-asset evidence; both
evaluation and recording reject stale or inconsistent context.

- [ ] **Step 4: Run tests and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/abandonment.test.mjs
git add scripts/release/abandonment.mjs scripts/release/metadata.mjs \
  scripts/release/planner.mjs scripts/release/test/abandonment.test.mjs
git commit -m "feat(release): add prepublication abandonment"
```

## Task 6: Extend exact published verification and smoke receipts

**Files:**
- Create: `scripts/release/smoke-result.mjs`
- Create: `scripts/release/test/smoke-result.test.mjs`
- Create: `scripts/release/smoke/scaffold.mjs`
- Create: `scripts/release/smoke/storage.mjs`
- Create: `scripts/release/smoke/runtime-targets.mjs`
- Create: `scripts/release/smoke/published-harness.mjs`
- Create: corresponding `scripts/release/test/*-smoke.test.mjs`
- Modify: `scripts/lib/published-artifacts.mjs`
- Modify: `scripts/published-artifact-verify.mjs`
- Modify: `scripts/published-artifact-smoke.mjs`
- Modify: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Define and test the correlated result schema**

```js
{
  schemaVersion: 1,
  lane,
  version,
  commitSha,
  manifestSha256,
  workflowRunId,
  runAttempt,
  startedAt,
  finishedAt,
  checks: [{ name, conclusion, detail }],
  conclusion: "success" | "failure",
}
```

Expose `parseSmokeResult`, `correlateSmokeResults`, `aggregateSmokeResults`, and canonical bytes. Reject duplicates, missing required lanes, identity mismatch, or a failure hidden by an aggregate success.

- [ ] **Step 2: Extend metadata verification in release mode**

Add CLI options:

```text
--version <exact>
--commit-sha <40-sha>
--manifest <path>
--manifest-sha256 <digest>
--result <path>
--release-mode
```

Release mode rejects dist-tags, verifies all manifest packages, downloads registry tarballs, compares manifest digests, checks `latest`, signature, and npm provenance workflow/commit. Preserve existing manual package-set behavior outside release mode.

- [ ] **Step 3: Add failing clean-consumer smoke tests**

Reuse existing TypeScript, AG-UI, Docker PID, and pgvector probes. Add isolated modules/tests for:

- scaffold create/install/build/typecheck/representative runtime at exact version;
- pgvector and Postgres storage against disposable databases;
- Node import/runtime and edge-target bundle/import checks;
- framework/runtime/smoke assertions installed from npm exact versions, without publishing the checkout to Verdaccio.

Each lane writes its correlated result even on failure and always cleans temp directories/containers.

- [ ] **Step 4: Implement and run the focused lanes**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm test:published-artifacts
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/smoke-result.test.mjs \
  scripts/release/test/*-smoke.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/published-artifacts.mjs scripts/published-artifact-verify.mjs \
  scripts/published-artifact-smoke.mjs scripts/published-artifacts.test.mjs \
  scripts/release/smoke-result.mjs scripts/release/smoke \
  scripts/release/test/smoke-result.test.mjs scripts/release/test/*-smoke.test.mjs
git commit -m "feat(release): add exact published smoke receipts"
```

## Task 7: Audit the complete draft and create pre-publication receipts

**Files:**
- Create: `scripts/release/audit.mjs`
- Create: `scripts/release/test/audit.test.mjs`
- Modify: `scripts/release/adapters/github-write.mjs`
- Modify: `scripts/release/adapters/github.mjs`
- Modify: `scripts/release/metadata.mjs`

- [ ] **Step 1: Write dispatch receipt tests**

Assert dispatch uses `.github/workflows/published-artifact-verify.yml`, ref
`vX.Y.Z`, and exact `version`, `commitSha`, and `manifestSha256`. Under API version
`2026-03-10`, the GitHub workflow-dispatch request omits the removed run-details
opt-in and uses the mandatory returned run ID directly; never list recent runs and
guess.

Require API version `2026-03-10`, HTTP 200, and exact
`workflow_run_id`/`run_url`/`html_url` validation from Task 3's bounded writer.
The actions-only dispatcher emits that exact receipt without Release authority.
A distinct contents-only `recordAuditDispatch` transition revalidates the draft
and body-CASes that identity into an `AUDIT_DISPATCHED` marker. The independent
run waits within a fixed bound until the marker names its own run ID, so a runner
lost after dispatch but before marker CAS cannot cause the controller to guess. A
duplicate uncorrelated audit is read-only and harmless.

- [ ] **Step 2: Write correlation and retry tests**

Use the exact run-scoped reader path: `getActionsRun({ runId })`,
`listActionsRunArtifacts({ runId })`, `getActionsArtifact({ artifactId })`, and
`downloadActionsArtifact({ artifactId })`. Cover successful result, wrong
version/SHA/digest, wrong run ID/attempt, result artifact from another run,
missing or duplicate `if: always()` result artifact, audit failure, bounded
nonterminal timeout, repeat dispatch after failure, same successful result as a
no-op, and same-name/different-byte conflicts.

Every terminal attempt is attached as
`audit-attempt-<workflowRunId>-<runAttempt>.json`. Replaying identical bytes is a
no-op and different bytes at that name are a conflict. A failed attempt advances
the marker to `AUDIT_RETRYABLE` and leaves the exact 45 base assets unchanged; a
new dispatch uses a new run ID, so failures never compete for one filename. A
successful attempt is attached first, copied byte-for-byte to
`audit-result.json`, and then recorded by marker CAS as `AUDIT_VERIFIED`.
Runner-loss tests cover each boundary. The canonical name is unavailable to
failed attempts, and audit/abandonment evidence cannot coexist.

- [ ] **Step 3: Implement the audit interface**

```js
export async function dispatchIndependentAudit({ candidate, manifestSha256, github })
export async function recordAuditDispatch({ candidate, dispatch, github })
export async function waitForAudit({ runId, github, attempts, delayMs, delay })
export function correlateAuditResult({ dispatch, result, candidate, manifestSha256 })
export async function recordAuditAttempt({ candidate, dispatch, result, github })
export async function verifyAuditSuccess({ candidate, dispatch, result, github })
```

`dispatchIndependentAudit` uses only the actions writer and returns the validated
direct response. `recordAuditDispatch` uses only Release/body CAS and performs one
`SMOKES_COMPLETE` or `AUDIT_RETRYABLE` to `AUDIT_DISPATCHED` transition. Audit
correlation and the
canonical writer must use Task 1's `parseAuditResult`;
they may not define or accept a second audit-result schema. Both writers use the
Task 3 Release/body/asset CAS operations and re-read after every mutation.
`recordAuditAttempt` accepts success or failure and writes only the unique attempt
asset. `verifyAuditSuccess` accepts only a successful already-attached attempt,
writes byte-identical canonical bytes, and advances the marker to
`AUDIT_VERIFIED`. Neither function publishes the Release. Publication remains the
separate Task 3 `publishConsolidatedRelease` transition, which accepts only the
complete draft with exact 45 base assets, allowed audit receipts, and canonical
success.

- [ ] **Step 4: Run tests and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/audit.test.mjs
git add scripts/release/audit.mjs scripts/release/adapters/github.mjs \
  scripts/release/adapters/github-write.mjs scripts/release/metadata.mjs \
  scripts/release/test/audit.test.mjs
git commit -m "feat(release): correlate independent release audits"
```

## Task 8: Assemble the controller CLI and complete fault injection

**Files:**
- Create: `scripts/release/controller.mjs`
- Create: `scripts/release/cli.mjs`
- Create: `scripts/release/test/controller.test.mjs`
- Modify: `scripts/release/observe.mjs`
- Modify: `scripts/release/preflight.mjs`
- Create or modify: `scripts/release/test/observe-production.test.mjs`
- Modify: `scripts/release/test/preflight.test.mjs`
- Modify: `scripts/release/test/support/fault-harness.mjs`
- Modify: `scripts/release/test/support/fault-proxy.mjs`
- Create: `scripts/release/test/support/release-rehearsal.mjs`
- Create: `scripts/release/test/support/release-rehearsal-github.mjs`
- Modify: `scripts/release/test/fault-harness.integration.mjs`
- Create: `scripts/release/test/rehearsal.test.mjs`
- Create: `docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md`
- Modify: `package.json`

- [ ] **Step 1: Write one-transition controller tests**

The controller observes, plans, executes at most one named transition, then re-observes before returning. Test every state, effect dependency, dry run, conflict, retryable error, and report emission. No code path may jump directly from preparation to Release publication.

CLI commands:

```text
observe --event <event.json> --report <path> --github-output <path>
tag --candidate <path>
prepare --candidate <path> --inventory <path> --root <dir> --output-dir <dir> \
  --ci-receipt <path> --prepare-run <path> --preparation-authority <path> \
  --source-ref <refs/tags/vX.Y.Z>
record-artifact --candidate <path> --manifest <path> --artifact-upload-result <path> --output <path>
attestation-input --record <path> --artifact-dir <dir>
escrow --candidate <path> --record <path> --artifact-dir <dir> \
  --attestation-set <path> --attestation-bundles-dir <dir>
reconcile-npm --candidate <path> --record <path> --npm-evidence <path>
reconcile-smokes --candidate <path> --record <path> --npm-evidence <path> \
  --smoke-results <dir>
abandon --version <exact> --commit-sha <sha> --reason <text> --artifact-context <path>
dispatch-audit --version <exact> --commit-sha <sha> --manifest-sha256 <digest> --output <path>
record-audit-dispatch --candidate <path> --dispatch-result <path>
correlate-audit --candidate <path> --dispatch-result <path> --audit-result <path>
publish-release --candidate <path> --record <path> --audit-result <path>
```

Add router coverage that invokes:

```text
record-artifact --candidate <path> --manifest <path> \
  --artifact-upload-result <path> --output <release-record.json>
```

The upload-result file is the raw, exact-key output adapter for
`actions/upload-artifact`: artifact ID, URL, and bare artifact digest. It has no
name output. Assert this command takes the deterministic artifact name from the
validated manifest/preparation result, canonicalizes the returned digest,
delegates to Task 2's `createReleaseRecord`, writes canonical bytes, validates the
returned URL/ID correlation, and rejects missing outputs or name-based artifact
discovery. This keeps the Task 2 module commit independent while putting CLI
coverage in the task that actually creates `cli.mjs`.

The `prepare` route constructs exactly Task 2's full authority-bearing input from
the named files: frozen candidate/inventory/CI/prepare-run/preparation-authority
receipts, canonical repository root, output outside that root, and the exact tag
source ref. It may not silently default to `main`, the current checkout ref, or a
synthetic CI receipt. The `escrow` route parses the record, artifact, one exact
22-subject attestation set, and all 22 distinct bundle files, then uses the
bounded GitHub/npm readers to capture a fresh `filter=all` publication-state
snapshot in the same invocation before calling `escrowCandidate`. It never accepts
a stale caller-supplied absence proof or one singular bundle as the complete set.

Expose `runReleaseCli(argv, dependencies)` so tests never spawn real external mutations.
Implement command routing with per-command dynamic imports so an invocation loads
only that command's module graph. npm publication is deliberately absent from
this router: the workflow invokes the tested dependency-free `publisher.mjs`
executable directly.

The two reconciliation routes each delegate to only their corresponding Task 3
one-transition function. `dispatch-audit` can use only the actions writer and
writes the direct HTTP 200 receipt to its output; `record-audit-dispatch` can use
only the contents writer and records that exact receipt in the draft marker.
`correlate-audit` records the attempt-scoped receipt, writes canonical success
only for a passing result, and advances the draft marker through
`AUDIT_RETRYABLE` or `AUDIT_VERIFIED`. `publish-release` is a distinct command
that delegates only to Task 3's `publishConsolidatedRelease`; it changes
`draft: true` to `draft: false` after observing `AUDIT_VERIFIED`, then requires an
unchanged `immutable: true` re-read. No command writes a published Release.

- [ ] **Step 2: Wire production observation and strict owner preflight**

Write failing tests proving that `observe` constructs only the named, bounded
read adapters; resolves the scheduled or exact-ref candidate; loads inventory at
that immutable commit; observes Git/GitHub/npm state; and passes the complete
observation through arbitration and the one-transition controller. A missing
adapter, malformed envelope, auth failure, timeout, or identity mismatch is a
blocked/ambiguous result, never absence.

The production observer parses the canonical body marker and partitions Release
assets into the exact 45-member base namespace, attempt-scoped audit namespace,
canonical audit result, and abandonment tombstone. It observes annotated tag peel,
draft/immutable flags, body digest, every asset digest, exact run/job evidence,
and terminal-record consistency. It derives `AUDIT_COMPLETE` only from an
unchanged `AUDIT_VERIFIED` marker on the same published immutable Release; a
published unaudited or mutable managed Release is a conflict.

Replace the legacy static workflow snapshot in `preflight.mjs` with the parsed
final contracts and `controller-schema.json`. Provide separate `capture` and
`verify` subcommands. `capture` invokes only the named read-only `npm trust list
<package> --json` and GitHub REST probes and writes canonical owner evidence;
`verify` never shells out and accepts that explicit evidence file.

The evidence schema binds `phase`, repository/default branch, exact HEAD SHA,
capture and expiry timestamps (maximum 15-minute validity), npm/gh tool versions,
SHA-256 digests of the candidate workflow files and controller schema, all 21
package trust results, the abandonment environment/protection response, and the
remote workflow states, plus the repository immutable-Releases setting and the
permission/capability response used to read or enable it. Reject extra keys,
duplicate/missing packages, future or expired timestamps, a changed HEAD/file
digest, mixed publisher tuples, or tool output that was not captured by the named
adapters. It contains no credentials.

`--phase pre-enable` parses the final candidate workflows from the worktree and
requires the remote legacy `release.yml` and `publish-chart.yml` to remain
`disabled_manually`; it is the PR merge gate. It records the current immutable
setting and proves the owner can read/manage it, but does not require enablement
before the switch commit reaches `main`. `--phase post-enable` runs only after
the replacement workflows are on `main`, repository immutable Releases have
been enabled and re-read as enabled, and the workflow paths have then been
activated. It requires those exact workflow paths to be `active`, immutable
Releases to be enabled, the protected abandonment environment to match the
schema, and all package publishers to have one identical repository, workflow,
and optional environment tuple. Missing, mixed, stale, or redacted evidence
remains `UNPROVABLE`/`FAIL`. Never query or mutate trust settings inside an
npm-publishing job.

- [ ] **Step 3: Expand failure after every transition**

Keep the three-package Verdaccio/proxy/Git fixture as the lower-layer fault suite:
it proves real process lifecycle, proxy faults, Git isolation, bounded tarball
publication, and byte-for-byte registry downloads. It is not a complete release
inventory and must not cross production validators by weakening their canonical
21-package, 22-subject, or 45-asset invariants.

Run the complete transition rehearsal with the canonical fixed-group inventory.
It injects before/after tag, prepare, attest, draft creation, escrow asset
1/middle/final, first/middle/last npm publish, registry convergence,
`reconcile-npm`, each smoke result, and `reconcile-smokes`. It then injects
before/after audit dispatch, dispatch-receipt output, the separate
`AUDIT_DISPATCHED` body CAS, failed attempt attachment, retry dispatch and receipt
CAS, successful attempt attachment, canonical success attachment,
`AUDIT_VERIFIED` marker CAS, final Release publication, and immutable re-read—in
that order. Include runner loss after npm accepts a publish, dispatch-response
loss without run guessing, and Actions artifact expiry with valid escrow fallback.
Every resume preserves the exact 45 base assets and uses attempt-scoped names to
avoid retry collisions. The rehearsal must call the production transition
modules/adapters wherever they define the release boundary; it may not substitute
a parallel release-state simulator or a test-only validation escape hatch.

- [ ] **Step 4: Add local rehearsal scripts**

```json
{
  "release:observe": "node scripts/release/cli.mjs observe",
  "release:rehearse": "node scripts/release/test/support/fault-harness.mjs",
  "test:release-controller": "node --test scripts/release/test/*.test.mjs",
  "test:release-fault-harness": "node --test scripts/release/test/fault-harness.integration.mjs"
}
```

Support:

```text
pnpm release:rehearse -- --all-faults
pnpm release:rehearse -- --inventory fixed-group --inject after-publish:11 --resume
```

`--all-faults` defaults to `--inventory fixed-group`. Reject
`--fixture three-package --all-faults` with an explanation that the small fixture
is limited to the lower-layer fault-harness suite and cannot prove the canonical
45-asset release protocol.

- [ ] **Step 5: Run fault recovery and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  corepack pnpm test:release-controller
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  corepack pnpm test:release-fault-harness
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  corepack pnpm release:rehearse -- --all-faults
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  corepack pnpm release:rehearse -- --inventory fixed-group --inject after-publish:11 --resume
git add scripts/release/controller.mjs scripts/release/cli.mjs \
  scripts/release/observe.mjs scripts/release/preflight.mjs \
  scripts/release/test/controller.test.mjs scripts/release/test/support/fault-harness.mjs \
  scripts/release/test/support/fault-proxy.mjs \
  scripts/release/test/support/release-rehearsal.mjs \
  scripts/release/test/support/release-rehearsal-github.mjs \
  scripts/release/test/fault-harness.integration.mjs \
  scripts/release/test/rehearsal.test.mjs \
  scripts/release/test/observe-production.test.mjs scripts/release/test/preflight.test.mjs \
  docs/superpowers/plans/2026-08-09-release-integrity-controller-pr2.md \
  docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md package.json
git commit -m "test(release): exercise resumable release faults"
```

## Integration Checkpoint: prove the controller before switching ownership

Do not edit active workflows or delete legacy scripts until every checkpoint passes.

- [ ] **Checkpoint 1: Full fixed-group artifact rehearsal**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" corepack pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  corepack pnpm release:rehearse -- --inventory fixed-group --inject after-publish:11 --resume
```

Expected: 21 tarballs, middle failure, successful resume, registry-downloaded
bytes equal the manifest, exact 45-member escrow, independent draft audit with
attempt/canonical success receipts, publication only from `AUDIT_VERIFIED`, an
unchanged immutable re-read, and a third reconciliation that is a no-op.

- [ ] **Checkpoint 2: Repository and gated local verification**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm ci:validate
DAWN_TEST_DOCKER=1 PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm --filter @dawn-ai/sandbox test docker-sandbox.integration
DAWN_TEST_PGVECTOR=1 PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm --filter @dawn-ai/memory-pgvector test
DAWN_TEST_PGSTORAGE=1 PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm --filter @dawn-ai/postgres-storage test
```

Expected: every command passes. There is no baseline-failure waiver.

- [ ] **Checkpoint 3: Preflight capability rehearsal**

Before final workflows exist, test the new capture/verify boundary with bounded
fixtures and, when authenticated owner access is available, perform a non-gating
read-only capture to expose permission or npm-login blockers early. Prove the
evidence schema, redaction, auth-error handling, 21-package set checks, and
pre-enable/post-enable workflow and immutable-Releases state rules. Do not call
this a live merge gate: final
workflow digests do not exist yet and the 15-minute evidence window cannot span
Tasks 9 and 10. The first authoritative pre-enable strict run occurs after the
atomic switch commit, and is recaptured immediately before merge in Task 11.

## Task 9: Write final workflow contracts before the atomic ownership switch

**Files:**
- Modify: `scripts/release/test/workflow-contracts.test.mjs`
- Modify: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Replace shadow allowances with failing final contracts**

Parse the three target workflows and assert:

- `version-pr.yml` has version behavior only, no publish input/OIDC/attestations/Release mutation;
- `release.yml` alone contains npm publish/trusted publishing and retains the exact filename;
- triggers are `push main`, exact-input manual dispatch, and schedule;
- repository-global `queue: max` and no cancellation;
- all actions use full commit SHAs;
- detect/prepare/smoke have no OIDC/write permissions;
- the `release.yml` detect job invokes the exact production entrypoint
  `node scripts/release/cli.mjs observe --event ... --report ... --github-output
  "$GITHUB_OUTPUT"`, consumes its outputs, and has no fallback shadow command;
- tag has only required contents/actions write;
- attest has only contents/actions read plus id-token/attestations write;
- npm has only contents/actions/attestations read plus id-token write;
- the npm job's `environment` key exactly matches
  `controller-schema.json.npmTrustedPublisherEnvironment`, and is absent only
  when that checked-in value is `null`;
- npm sparse checkout invokes `publisher.mjs` directly, excludes
  package dirs/lockfile and `cli.mjs`, and contains no
  install/build/test/pack/lifecycle execution;
- npm sparse checkout invokes dependency-free `artifact-store.mjs resolve`
  before `publisher.mjs`, addresses the normal Actions payload by the record's
  exact artifact ID, and permits draft-Release escrow only for a classified
  retention-expired result;
- tag and escrow precede npm;
- `reconcile-npm` is the only post-npm/pre-smoke contents writer and advances only
  to `NPM_COMPLETE`; all smoke jobs are read-only; `reconcile-smokes` consumes
  their exact receipts and is the only transition to `SMOKES_COMPLETE`;
- `dispatch-audit` has actions write but no contents write, emits the direct run
  receipt, and a distinct `record-audit-dispatch` job has contents write but no
  actions write and CASes only that receipt into `AUDIT_DISPATCHED`;
- when the coordinator self-dispatches at `vX.Y.Z`, every artifact/mutation job is
  gated off by the tag job's `continue=false` output, the coordinator has no poll
  or wait step, and the run can release the global lock before the tagged run;
- tag continuation requires both `github.ref == refs/tags/vX.Y.Z` and
  `github.sha == candidateSha`; a branch ref dispatches and exits even when its
  SHA already equals the candidate;
- preparation, attestation, escrow, npm, smoke, audit, and publication are all
  exact-tag-only, so GitHub attestations record tag-ref provenance;
- Release publication depends on every required smoke result, a directly
  correlated independent audit, an attached successful attempt receipt,
  byte-identical `audit-result.json`, and an `AUDIT_VERIFIED` marker;
- the base escrow contract remains exactly 45 assets while audit attempts and the
  canonical result occupy the separate allowed namespace;
- final publication PATCHes only `draft: false`, re-reads `immutable: true`, and
  no job has a post-publication Release writer;
- abandonment is manual, protected, pre-publish-only, evidence-preserving, and terminal;
- independent audit runs while the Release is draft, uses exact tag, three
  correlation inputs, the dispatch-returned run ID/URLs from the API
  `2026-03-10` HTTP 200 response, and `if: always()` result upload; it never sends
  the removed opt-in field or lists recent runs to guess;
- failed audits retain uniquely named attempt receipts and return to retryable
  draft state without colliding with later attempts;
- annotated tag identity is proven by remote ref lookup plus annotated-object peel
  to the candidate commit; `target_commitish` and lightweight tags are rejected;
- strict post-enable preflight proves repository immutable Releases are enabled
  before any candidate draft can be created;
- no shadow workflow or legacy preflight can remain as a second controller entrypoint;
- Version Packages advances each changed chart's chart patch version and
  `appVersion` together, while an already-synchronized rerun is byte-for-byte a
  no-op;
- no legacy per-package tag/Release/backfill/upload path remains.

- [ ] **Step 2: Run contracts and confirm they fail against the legacy workflows**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/workflow-contracts.test.mjs
```

Expected: failures identify missing `version-pr.yml` and legacy combined privileges/publication.

Do not commit the red-only state separately; continue directly to the atomic switch.

## Task 10: Atomically switch workflow ownership and remove split-brain paths

**Files:**
- Create: `.github/workflows/version-pr.yml`
- Replace: `.github/workflows/release.yml`
- Replace: `.github/workflows/published-artifact-verify.yml`
- Delete: `.github/workflows/release-shadow.yml`
- Delete: `scripts/release-publish.mjs`
- Delete: `scripts/release-publish.test.mjs`
- Delete: `scripts/backfill-release-tags.mjs`
- Delete: `scripts/backfill-release-tags.test.mjs`
- Delete: `scripts/upload-release-assets.mjs`
- Delete: `scripts/upload-release-assets.test.mjs`
- Modify: `package.json`
- Modify: `scripts/sync-chart-appversion.mjs`
- Modify: `scripts/sync-chart-appversion.test.mjs`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`
- Modify: `scripts/release/test/fixtures/workflow-safe-executables.json`
- Modify: `scripts/release/test/fixtures/release-script-hashes.json`
- Modify: `docs/thread-handoff.md`
- Create: `docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Create the version-only workflow**

Use `changesets/action` with `version: pnpm run version`, Version Packages title/commit, and `RELEASE_GITHUB_TOKEN` without a silent standard-token fallback. Grant only `contents: write` and `pull-requests: write`. Omit `publish`, npm registry setup, OIDC, attestations, tags, and Releases. Retain chart synchronization through the existing root `version` script and update its comments.

Change chart synchronization with tests first: when a chart's `appVersion`
advances to the new fixed-group version, increment that chart's own patch
`version` exactly once in the same Version Packages commit. Reject malformed or
non-SemVer chart versions. A rerun at the already-synchronized app version is a
strict no-op and may not increment again.

- [ ] **Step 2: Replace `release.yml` in place**

Implement these ordered jobs and permission boundaries:

```text
detect(read) -> tag(contents/actions write)
  -> prepare(read) -> attest(id-token + attestations write)
  -> escrow(contents write) -> publish-npm(id-token only write capability)
  -> reconcile-npm(contents write + actions read)
  -> metadata / typescript / scaffold / docker / storage / runtime / harness smokes(read)
  -> reconcile-smokes(contents write + actions read)
  -> dispatch-audit(actions write) -> record-audit-dispatch(contents write)
  -> correlate-audit(actions read + contents write)
  -> publish-release(contents write)
```

The tag job continues only when both `github.ref == refs/tags/vX.Y.Z` and
`github.sha == candidateSha`. Every other invocation creates/validates the
annotated tag, dispatches the same workflow at that tag, and exits—even when a
`main` run already has the candidate SHA. It never waits while holding the global
release lock. Every artifact-producing or mutating downstream job repeats the
exact-tag gate.

The npm job sparse-checks out the exact dependency-free resolver/publisher module
allowlist proven in Task 4 with persisted credentials disabled. It invokes
`node scripts/release/artifact-store.mjs resolve` to retrieve and verify the exact
recorded artifact ID or, only after a classified retention-expired response, the
attested draft-Release escrow. It then invokes
`node scripts/release/publisher.mjs` directly against that materialized
directory. It does not include or invoke `cli.mjs` and has no dependency install,
build, test, pack, package directories, lockfile, or `node_modules`.

The detect job invokes `node scripts/release/cli.mjs observe` with the serialized
event, report path, and `$GITHUB_OUTPUT` path, then gates every later job from its
validated outputs. There is no shadow-script, inline reimplementation, or
continue-on-error fallback. The workflow contract executes the router with
injected fixtures and proves that this exact entrypoint reaches Task 8's concrete
observer wiring.

Set the npm job's GitHub `environment:` to the exact checked-in trusted-publisher
environment when the strict preflight proves one; omit the key only when
`npmTrustedPublisherEnvironment` is `null`. The parsed contract compares workflow
YAML with `controller-schema.json`, so environment drift cannot merge.

Within `prepare`, upload the payload artifact first and capture the upload action's
returned artifact ID, URL, and bare digest. Supply the artifact name only from the
validated deterministic preparation result, canonicalize the returned digest,
invoke `record-artifact`, and upload the small release-record handoff separately.
Every later job addresses the payload by that recorded ID; no step expects a name
output from the action or lists artifacts by a guessed name.

`escrow` writes the canonical `ATTACHING` marker before uploading the 23 prepared
assets, adopts the first cryptographically valid durable bundle anchor, replicates
it to all 22 deterministic bundle names, and only then CASes to `ESCROWED` with
the winning signed run/attempt and exact 45-asset base digest. It uses fresh exact
`publicationState` snapshots and Release/tag/body/asset fences at every mutation
boundary. `correlate-audit` runs while the Release is draft,
attaches the attempt-scoped receipt and canonical success, and leaves the marker
at `AUDIT_VERIFIED`. Only the final `publish-release` job may then PATCH
`draft: false`; it supplies no title/body/assets and must re-read the same Release
as `immutable: true`. No later job receives `contents: write` for Release
mutation.

`reconcile-npm` and `reconcile-smokes` are separate exact-tag body-CAS jobs around
the read-only smoke fan-out. The actions-only `dispatch-audit` job passes its exact
HTTP 200 receipt to the contents-only `record-audit-dispatch` job, which records
`AUDIT_DISPATCHED` before the independent workflow's bounded wait may proceed.
Neither permission set can perform the other's effect.

- [ ] **Step 3: Replace the independent verification workflow**

Required exact release inputs are `version`, `commitSha`, and
`manifestSha256`; preserve an explicit manual non-release mode only if its inputs
cannot be confused with release audit mode. A default-branch schedule/manual
coordinator discovers the managed consolidated tag, redispatches at that tag, and
exits before verification unless both its ref is `refs/tags/vX.Y.Z` and its SHA is
the candidate SHA. SHA equality on a branch is not enough. Exact-tag jobs verify
the complete draft Release, exact 45 base assets, allowed audit namespace, npm,
provenance, smokes, and annotated-tag peel. They have no Release writer. An
`if: always()` finalizer emits exactly one result artifact tied to its own run ID
and attempt.

When adding any new third-party action such as artifact download, resolve its current release tag to a full immutable commit SHA and record the version in a comment before committing.

- [ ] **Step 4: Remove legacy owners in the same working-tree state**

Delete the six legacy script/test files and `release-shadow.yml`; remove
`release:publish`, `test:release-publish`, `test:backfill-release-tags`, and
`test:upload-release-assets`. Remove the corresponding local-only `ci:validate`
steps. Replace regex-era legacy workflow assertions in
`scripts/published-artifacts.test.mjs` with the final parsed contracts. Regenerate
and review the exact workflow-entrypoint/safe-executable fixtures, and update the
release-script hash fixture for every deleted, changed, or newly reachable
release executable in the same atomic commit.

- [ ] **Step 5: Add the cutover/recovery runbook**

Document:

- external preflight and trusted-publisher/environment tuple;
- exact candidate/version/SHA/CI receipt;
- candidate tag and draft escrow inspection;
- manual exact-tag recovery;
- protected abandonment with permanent tombstone;
- partial npm resume and conflict behavior;
- required smoke lanes;
- independent draft-audit attempt/canonical receipts, retry naming, and the
  `AUDIT_VERIFIED` publication guard;
- immutable-Releases enablement before workflow activation, final publication's
  unchanged immutable re-read, and the prohibition on post-publication repair;
- first patch release and scheduled no-op audit.

- [ ] **Step 6: Run contracts until green**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/workflow-contracts.test.mjs \
    scripts/release/test/audit.test.mjs \
    scripts/release/test/abandonment.test.mjs \
    scripts/sync-chart-appversion.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node scripts/check-docs.mjs
```

Expected: final topology/permission contracts pass and docs check passes.

- [ ] **Step 7: Commit the atomic switch**

```bash
git add .github/workflows/version-pr.yml .github/workflows/release.yml \
  .github/workflows/published-artifact-verify.yml scripts/release package.json \
  scripts/sync-chart-appversion.mjs scripts/sync-chart-appversion.test.mjs \
  scripts/published-artifacts.test.mjs \
  docs/thread-handoff.md docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md \
  AGENTS.md
git add -u .github/workflows
git add -u scripts
git commit -m "ci(release): switch to the release integrity controller"
```

Before committing, confirm `git status --short` shows all four workflow changes
(new version workflow, two replacements, and the shadow deletion), all six legacy
script/test deletions, and all three regenerated fixture inventories together.

- [ ] **Step 8: Run the authoritative pre-enable strict gate**

At the new atomic-switch commit, perform authenticated `preflight capture
--phase pre-enable` and `preflight verify --phase pre-enable --strict`. Require
the evidence HEAD and workflow/schema digests to equal that exact commit, all 21
npm publisher tuples to match, permission/environment probes to pass, and the two
remote legacy workflow paths to remain `disabled_manually`. Require a successful
read of the current immutable-Releases setting and proof that the owner can
enable it after merge; the pre-enable phase records but does not require the
setting to be true. Save only the credential-free canonical evidence and redacted
report as temporary receipts.
The 15-minute freshness window applies to verification time; recapture this gate
immediately before merge after PR CI completes.

## Task 11: Complete local, PR, and post-merge verification

**Files:**
- Verify only before merge
- Update only the runbook's receipt section with actual run IDs/digests after the live release

- [ ] **Step 1: Run all focused controller and workflow tests**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm check:release-inventory
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:release-controller
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:release-fault-harness
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
```

- [ ] **Step 2: Repeat the full 21-package rehearsal after the workflow switch**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm release:rehearse -- --inventory fixed-group --inject after-publish:11 --resume
```

Expected: identical manifest/package order, successful resume, downloaded byte equality, and clean no-op third run.

- [ ] **Step 3: Run the full repository Definition of Done**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm ci:validate
```

Require the complete command to pass with no waived baseline failure.

- [ ] **Step 4: Run gated local lanes**

```bash
DAWN_TEST_DOCKER=1 PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm --filter @dawn-ai/sandbox test docker-sandbox.integration
DAWN_TEST_PGVECTOR=1 PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm --filter @dawn-ai/memory-pgvector test
DAWN_TEST_PGSTORAGE=1 PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm --filter @dawn-ai/postgres-storage test
```

Require GitHub's `validate`, `edge-workerd`, real `vercel-native`,
`copilotkit-examples-e2e`, sandbox Docker/Kubernetes e2e, pgvector, Postgres
storage, chart validation/apply, and security checks green before merge. The
Vercel CLI dependency and deployment lane remain part of the supported release
surface.

- [ ] **Step 5: Inspect the ownership boundary**

```bash
git diff --check origin/main...HEAD
git status --short --branch
rg -n 'npm publish|release:publish' .github/workflows scripts package.json
rg -n 'backfill-release-tags|upload-release-assets|createGithubReleases: true' \
  .github/workflows scripts package.json
```

Expected: npm publication appears only in the controller path invoked by `.github/workflows/release.yml`; no legacy backfill/upload/per-package Release ownership remains.

- [ ] **Step 6: Merge only before the next Version Packages PR**

After PR CI is green, recapture authenticated owner evidence and re-run strict
`--phase pre-enable` at the unchanged branch HEAD. Merge only while that evidence
is within its 15-minute window and all digests still match. Do not enable either
legacy file before the replacement commit is on `main`, and merge the ownership
switch before merging a Version Packages PR.

At the exact switch SHA, first enable repository immutable Releases and re-read
the setting as enabled while the replacement `release.yml` and unchanged
`publish-chart.yml` remain `disabled_manually`. Only after that setting is proven
enabled may the owner enable those two workflows. Re-read both workflow states as
`active` and confirm the new `version-pr.yml` is active. Immediately capture
fresh owner evidence and run strict `--phase post-enable`; its HEAD and
workflow/schema digests must match the merged switch SHA and its repository
setting evidence must still report immutable Releases enabled. Re-resolve
`refs/heads/main` and abort if it is no longer that SHA. Dispatch `release.yml`
with `ref: main` plus the final workflow's required current-version and
`commitSha=<switchSha>` inputs, retain the run ID returned directly by dispatch,
and require that run's `head_sha` to equal the switch SHA and its correlated
report to be `NO_CANDIDATE`. A moving `main`, guessed run ID, mismatched run SHA,
or candidate draft created before immutable enablement aborts the cutover. The
push-triggered `version-pr.yml` run may create or
update the Version Packages PR using `RELEASE_GITHUB_TOKEN` during these checks,
but that PR must not merge before the post-enable strict and no-candidate receipts.

- [ ] **Step 7: Execute and record the first live patch release**

For the next Version Packages merge:

1. Record exact version, commit SHA, and successful `CI / validate` run.
2. Confirm annotated `vX.Y.Z` points at that SHA.
3. Confirm 21 tarballs, canonical manifest, Actions artifact ID/service digest, GitHub attestations, draft Release, and `release-record.json` agree before npm.
4. Observe serial dependency order and independently download/hash each registry tarball.
5. Confirm exact `latest`, registry signature, and npm provenance workflow/SHA for every package.
6. Keep the consolidated Release draft through all exact-version smoke lanes.
7. Run Published Artifact Verification at the exact tag while the Release remains
   draft, use only the dispatch-returned run ID, attach the uniquely named
   successful attempt receipt, and attach byte-identical `audit-result.json`.
8. Confirm the marker is `AUDIT_VERIFIED`; then publish the single Release by
   changing only `draft` and re-read `immutable: true` with unchanged body,
   assets, and annotated-tag target.
9. Confirm Publish Chart did not skip: the new `dawn-app` and
   `dawn-sandbox-infra` chart versions are visible in GHCR, their `appVersion` is
   `0.8.22`, and the publish run is tied to the Version Packages merge SHA.
10. Run the independent manual exact-tag smoke once more from a clean environment;
    it may emit Actions evidence but must not mutate the immutable Release.
11. Require the exact Version Packages merge SHA to receive a successful production
    Vercel deployment. Verify the public `dawnai.org` site and representative docs,
    including `/docs/api/cli`, in a clean browser; check rendering, navigation,
    console errors, and failed network requests. Do not substitute a preview, an
    older successful deployment, or removal of the Vercel CLI/CI lane.
12. Confirm the next scheduled reconciliation/audit is a successful no-op.

- [ ] **Step 8: Record the live receipt**

Append the actual candidate SHA, CI run, release run/attempt, manifest digest,
Actions artifact ID/digest, Release URL, audit run, smoke conclusions, chart
versions, Publish Chart run, production Vercel deployment ID/commit, and public
site verification results to the runbook. Never include tokens or OIDC material.
