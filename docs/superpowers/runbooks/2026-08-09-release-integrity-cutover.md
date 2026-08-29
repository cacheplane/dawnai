# Release-Integrity Controller Cutover Runbook

Use this runbook to activate the release-integrity controller, complete its first
patch release, or recover an interrupted release. It is intentionally
fail-closed: a mismatch is a reason to stop and investigate, not permission to
repair public state in place.

The controller has four workflow owners:

- `.github/workflows/version-pr.yml` owns Changesets versioning and the Version
  Packages pull request only. It cannot publish packages, create tags or
  Releases, or obtain npm OIDC authority.
- `.github/workflows/release.yml` is the only npm publishing owner. A coordinator
  may run from `main`, but preparation and every mutating phase run only from the
  annotated `vX.Y.Z` tag at the exact candidate SHA.
- `.github/workflows/published-artifact-verify.yml` independently audits the
  complete draft Release. It cannot mutate that Release; the release workflow
  correlates and attaches the result.
- `.github/workflows/publish-chart.yml` owns Helm chart publication after the
  fixed-group app version advances. It has no npm or Release authority.

The live release workflow exposes reconciliation only. Workflow abandonment is
unreachable: it has no manual input, job, environment, tag-routing branch, or
executable entrypoint. Historical tombstone readers and the runtime abandonment
implementation remain dormant for compatibility with existing release evidence;
they are not an operator recovery path.

The legacy per-package Release, backfill, upload, and combined Changesets publish
paths must be absent before activation.

## Non-negotiable invariants

- All public packages come from the Changesets fixed group and have one exact
  version and candidate commit.
- Exact `CI / validate` success for the candidate SHA is required before tagging.
- The candidate tag is annotated and peels to the candidate commit. A lightweight
  tag, a tag at another commit, or `target_commitish` alone is insufficient.
- Preparation packs all 21 packages once. The payload contains those 21 tarballs
  and canonical `manifest.json`.
- Attestation covers all 22 subjects: the 21 tarballs and the manifest.
- Before npm mutation, the draft Release contains exactly 45 base assets:
  `release-record.json`, the manifest, 21 tarballs, and 22 verified attestation
  bundles. Audit and smoke receipts occupy separate, bounded namespaces.
- npm publication uses trusted publishing from
  `cacheplane/dawnai/.github/workflows/release.yml`. No long-lived npm token is a
  fallback.
- The consolidated Release stays draft through npm reconciliation, all five
  smoke lanes, and the independent audit. Publication requires the exact
  `AUDIT_VERIFIED` marker.
- Final publication changes only `draft` and then re-reads the same Release as
  `immutable: true`, with unchanged body, assets, and annotated-tag target.
- A published immutable Release is never repaired. Conflicting public bytes or
  metadata are terminal operator incidents.
- An irrecoverable prepublication candidate is preserved exactly as observed.
  Stop, preserve all tags/Releases/evidence, and escalate for a separately
  reviewed recovery design; do not attempt abandonment from the live workflow.

## Required toolchain

Run commands from the repository root with the toolchain used by the final
workflows:

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" node --version
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --version
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" npm --version
```

Expected: Node `v24.19.0`, pnpm `10.33.0`, and npm `11.17.0`. Stop on a version
mismatch rather than changing the release workflow during cutover.

## One-time external configuration

Complete these checks with repository-owner and npm-package-owner access. Never
store a token, npm session, OIDC response, or unredacted command output in the
repository.

### npm trusted publishers

For every package in the 21-package fixed group, `npm trust list <package>
--json` must report one uniform GitHub Actions tuple:

- repository: `cacheplane/dawnai`
- workflow: `.github/workflows/release.yml`
- environment: the exact value in
  `scripts/release/controller-schema.json`

The initial schema uses no npm environment restriction, represented by
`npmTrustedPublisherEnvironment: null`. If live npm configuration names an
environment, update and review the schema and final workflow together before
cutover. Missing or mixed tuples block release. Do not add overrides or an
`NPM_TOKEN` to work around the mismatch.

### GitHub repository configuration

Confirm all of the following:

- `RELEASE_GITHUB_TOKEN` can create or update the Version Packages branch and
  pull request. `version-pr.yml` has no standard-token fallback.
- an owner verifies the repository Immutable Releases setting during the strict
  preflight; release jobs do not receive a separate administrative token, and
  final publication re-reads the resulting immutable Release;
- the repository default Actions token is read-only, with job-local permissions
  granting each release effect;
- repository rules allow the release job to create the annotated `v*` candidate
  tag and manage one consolidated draft Release;
- required exact-SHA CI is workflow `CI`, check `validate`;
- `.github/workflows/release.yml` and `.github/workflows/publish-chart.yml` remain
  `disabled_manually` until the atomic switch is on `main` and Immutable Releases
  is enabled;
- the new `version-pr.yml` becomes active after the switch;
- no `release-abandonment` environment is required or created while the live
  workflow is reconcile-only;
- the Vercel `vercel-preview` environment and its `DAWN_VERCEL_*` secrets remain
  configured, and the pinned Vercel CLI dependency remains installed; and
- `copilotkit-examples-e2e` continues to exercise the v2 example imports.

The real `vercel-native` deployment lane and the CopilotKit example lane are
release gates. Do not remove or skip either one to make the cutover green.

## Pre-enable gate

At the final atomic-switch commit, build and run the full local verification
before collecting live evidence:

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm ci:validate
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm release:rehearse -- --inventory fixed-group --inject after-publish:11 --resume
```

The rehearsal must stop after package 11, resume the same artifact set, prove
downloaded registry bytes equal the manifest, complete the audit, and finish
with a clean third-run no-op.

After every pull-request gate is green, merge the ownership switch while Release
and Publish Chart remain `disabled_manually`. Do not merge a Version Packages
pull request. Synchronize the local checkout to the exact new remote `main` SHA,
require the local release workflow bytes to equal the remote default-branch
bytes, and only then collect fresh authenticated owner evidence in a private,
ignored directory:

```bash
install -d -m 0700 .dawn/release-cutover
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  node scripts/release/preflight.mjs capture \
  --phase pre-enable \
  --repository cacheplane/dawnai \
  --output .dawn/release-cutover/pre-enable.json
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  node scripts/release/preflight.mjs verify \
  --phase pre-enable \
  --evidence .dawn/release-cutover/pre-enable.json \
  --head-sha "$(git rev-parse HEAD)" \
  --format markdown \
  --strict
```

Owner evidence is schema version 2; schema version 1 evidence is rejected rather
than upgraded. Evidence is valid for at most 15 minutes and is bound to the exact
HEAD, local and remote default-branch workflow bytes, the reviewed workflow
policy, controller schema, package inventory, trusted-publisher tuples, complete
managed `v*` ref inventory, nonterminal Release runs, exact workflow states, and
Immutable Releases observation. The capture is write-once; use a new filename
for every recapture.

For this initial cutover, both strict phases require
`github.abandonmentMode: "disabled"`,
`github.managedCandidateRefs: []`,
`github.nonterminalReleaseRuns: []`, and
`github.abandonmentEnvironment: null`. The remote default branch must be
`refs/heads/main` at the evidence HEAD, its release workflow must classify as
disabled, and its bytes must equal the local workflow. An unreadable ref,
workflow, or run query is unprovable and stops the cutover.

The exact pre-enable topology is:

| Workflow | Required state |
| --- | --- |
| `version-pr.yml` | `active` |
| `release.yml` | `disabled_manually` |
| `published-artifact-verify.yml` | `active` |
| `publish-chart.yml` | `disabled_manually` |

Require GitHub's `validate`, `edge-workerd`, `vercel-native`,
`copilotkit-examples-e2e`, sandbox Docker/Kubernetes e2e, pgvector, Postgres
storage, chart validation/apply, and security jobs to be green. The post-merge
strict pre-enable receipt must pass before enabling either mutating workflow.

## Activation order

At the exact switch SHA on `main`:

1. Re-resolve `refs/heads/main` and require it to equal the reviewed switch SHA.
2. Enable repository Immutable Releases using the owner-approved GitHub settings
   operation.
3. Re-read `GET /repos/cacheplane/dawnai/immutable-releases` with API version
   `2026-03-10` and require `enabled: true`.
4. While that setting is enabled, activate `release.yml` and
   `publish-chart.yml`; require all four controller workflows to report
   `active`.
5. Capture new `post-enable` owner evidence and verify it strictly against the
   unchanged switch SHA.
6. Run one `release.yml` reconciliation from `main` with the current fixed-group
   version, the switch SHA, and `operation=reconcile`. Require its directly
   correlated observation to be `NO_CANDIDATE` and require that it creates no tag,
   draft Release, package version, or chart.

Use the same capture commands as above with `--phase post-enable`, a new evidence
filename, and the exact switch SHA. The ref and nonterminal-run inventories must
remain empty, and the aggregate abandonment mode must remain disabled. If `main`
moves, evidence expires, a workflow state differs, or a candidate draft exists
before Immutable Releases was enabled, stop the cutover.

## First live patch release

The first controller-owned release is a patch release. For this cutover the
expected fixed-group version is `0.8.22`; if the release train has advanced,
reassess and explicitly approve the new version rather than substituting it
silently.

### 1. Version Packages

Confirm the Version Packages pull request was produced by `version-pr.yml` and
contains version/changelog changes only. It must advance all fixed-group packages
together. Each Helm chart whose `appVersion` advances must also increment its own
chart patch version exactly once; rerunning versioning after synchronization must
be byte-for-byte a no-op.

Before merge, record:

- pull request number and merge SHA;
- exact package version;
- both chart versions and `appVersion` values; and
- successful exact-commit `CI / validate` run and attempt.

### 2. Candidate tag and preparation

After the Version Packages merge, the `main` coordinator must create or validate
`vX.Y.Z`, dispatch `release.yml` at that tag, and exit without waiting. Only the
tagged run continues.

Verify both parts of annotated-tag identity:

```bash
git fetch --tags origin
git cat-file -t "v${VERSION}"
git rev-parse "v${VERSION}^{commit}"
```

Expected: object type `tag` and the exact Version Packages merge SHA. Do not
continue if the ref is lightweight or peels elsewhere.

Before any npm package appears, record and compare:

- candidate version, SHA, tag, CI run, release run, and attempt;
- deterministic Actions payload artifact name, numeric ID, URL, and service
  digest;
- canonical manifest digest and dependency-first package order;
- 21 tarball names, sizes, SHA-256/SHA-512 digests, and npm integrity values;
- the 22-subject GitHub attestation set, source ref `refs/tags/vX.Y.Z`, workflow,
  run, attempt, and bundle digests; and
- the draft Release ID, marker, `release-record.json`, and exact 45-member base
  asset set.

Draft Releases are not reliably discoverable through a published-only
"release by tag" lookup. Enumerate Releases with pagination, select exactly one
matching `tag_name`, and then re-read it by numeric Release ID. Duplicate matches,
an unexpected asset, or any digest drift is a hard conflict.

### 3. npm publication and reconciliation

The sparse publisher installs nothing and publishes the already-attested
manifest tarballs serially in dependency order. For each package:

1. Observe exact `name@version` metadata.
2. On exact E404, publish that manifest tarball through npm trusted publishing.
3. If present, download it and require exact digest equality.
4. Require `latest`, registry signature, npm provenance, tagged workflow ref, and
   candidate SHA to converge before advancing.

Independently download and hash every public tarball from a clean environment.
Record package-by-package conclusions; do not rely only on the publisher log.

Partial publication is resumable, not atomic. A rerun skips a package only when
its public bytes and all evidence match, then starts at the first missing package.
If a runner dies after npm accepted a publish, the next run observes and verifies
that exact version before continuing. Never rebuild, repack, unpublish, or replace
an accepted version.

Stop as a hard conflict when:

- an existing exact version has different bytes or identity;
- `latest` has moved to a newer version after this candidate is partially public;
- the escrow, manifest, tag, provenance, or release record differs; or
- npm or GitHub observation remains ambiguous after bounded retry.

A newer `latest` observed before this candidate makes any public mutation is a
superseded no-op. It is not permission to move `latest` backward.

### 4. Five required smoke lanes

The consolidated Release remains draft while all five exact-version lanes run:

- `metadata`: fixed-group npm metadata, tarball digests, signatures, provenance,
  manifest correlation, and `latest`;
- `published-harness`: clean exact installs plus framework, runtime, smoke,
  TypeScript, AG-UI, and Docker PID-recovery probes;
- `runtime-targets`: representative Node execution and an edge bundle/import
  without Node built-ins;
- `scaffold`: exact `create-dawn-ai-app` installation, generated app dependency
  identity, typecheck, build, and runtime test; and
- `storage`: exact published storage packages against disposable Postgres 16 and
  pgvector databases, with verified cleanup.

Each lane always emits one canonical attempt receipt tied to version, commit SHA,
manifest digest, workflow run, and attempt. `reconcile-smokes` accepts exactly one
successful receipt per lane and advances the draft marker to `SMOKES_COMPLETE`.
Do not manually synthesize, rename, or copy a receipt from another attempt.

### 5. Independent draft audit

The release workflow dispatches `published-artifact-verify.yml` at the exact tag
with exactly `version`, `commitSha`, and `manifestSha256`. Preserve the direct HTTP
200 dispatch receipt containing the returned workflow run ID and URLs; never find
an audit by listing recent runs.

The audit independently rechecks the annotated tag, draft marker, 45 base assets,
npm state and provenance, all five smoke receipts, and aggregate correlation. It
always emits one result artifact for its own run and attempt.

- Every attempt is attached as
  `audit-attempt-<workflowRunId>-<runAttempt>.json`.
- A failed attempt moves the draft to `AUDIT_RETRYABLE`. Dispatch a new audit at
  the same exact tag and retain both attempt receipts.
- Only a successful attempt may create canonical `audit-result.json`.
- The canonical result must be byte-identical to the successful attempt receipt
  and must advance the marker to `AUDIT_VERIFIED`.
- A same-name/different-byte receipt is a conflict, never an overwrite.

After `AUDIT_VERIFIED`, the final job publishes the Release by changing only
`draft: false`. Re-read the published Release by ID and require
`immutable: true`, unchanged body and assets, and the same annotated-tag peel.
No workflow may perform post-publication repair.

### 6. Charts and production

Confirm Publish Chart did not skip a stale chart version. For the expected
`0.8.22` release, `dawn-app` advances from chart `0.1.0` to `0.1.1` and
`dawn-sandbox-infra` advances from `0.1.2` to `0.1.3`, both with
`appVersion: "0.8.22"`. Verify those exact OCI chart versions are visible in GHCR
and tie the publish run to the Version Packages merge SHA.

Require a successful production Vercel deployment whose source commit is the
exact release SHA. Record its deployment ID, production URL, commit SHA, and
ready timestamp. Do not substitute an older production deployment or a preview.
The separate real `vercel-native` CI lane must also be green with a closed cleanup
receipt.

In a clean browser, verify `https://dawnai.org`, representative navigation, and
`https://dawnai.org/docs/api/cli`. Check rendering, browser console errors, and
failed network requests. Record the result without cookies, tokens, or request
headers.

Run one more independent exact-tag verification after publication. It may emit
Actions evidence, but it must not mutate the immutable Release.

## Manual exact-tag recovery

Use manual recovery only for an incomplete, nonconflicting candidate. Supply the
exact known version and SHA; never infer either from a newer `main`:

```bash
gh workflow run release.yml \
  --repo cacheplane/dawnai \
  --ref "v${VERSION}" \
  -f version="${VERSION}" \
  -f commitSha="${CANDIDATE_SHA}" \
  -f operation=reconcile
```

The run must report `refs/tags/vX.Y.Z` and the candidate SHA before any
artifact-producing or mutating job starts. The controller observes durable state
and resumes one safe transition. It reuses the recorded Actions artifact or, only
when retention expiry is classified exactly, the complete attested 45-asset
draft escrow. Authentication failure, timeout, malformed response, or missing
evidence does not authorize escrow fallback.

Typical recovery actions are:

| Observed state | Safe action |
| --- | --- |
| Annotated tag only | Prepare, attest, and escrow at the exact tag. |
| Matching partial base escrow; npm untouched | Upload only missing members, then re-read all 45. |
| Matching partial npm publication | Verify published members and resume at the first exact E404. |
| npm complete; metadata incomplete | Reconcile the draft marker and evidence. |
| Smoke failure | Rerun exact-version lanes and retain attempt receipts. |
| Audit failure | Dispatch a new exact-tag audit and attach a new attempt receipt. |
| Published immutable Release | Observe only; no repair or mutation is allowed. |

## Irrecoverable prepublication candidate

The live workflow does not provide terminal abandonment. If reconciliation
cannot safely resume an exact prepublication candidate, stop without mutation:

1. Preserve the annotated tag, draft Release, Actions artifacts, run identities,
   logs, and every canonical receipt exactly as observed.
2. Do not delete or reuse the candidate version, synthesize a tombstone, create
   an environment, or invoke the dormant CLI abandonment commands directly.
3. Escalate with the preserved evidence for a separately reviewed recovery or
   reactivation design.

Restoring protected abandonment requires its own reviewed workflow change,
independent reviewer configuration, and ref-aware owner evidence. It is not part
of this cutover.

## Scheduled no-op proof

After the first Release is published and independently reverified, observe the
next scheduled reconciliation/audit. It must:

- classify the published Release as complete only from the same
  `AUDIT_VERIFIED` body, canonical audit result, immutable flag, 45 base assets,
  smoke set, and annotated tag;
- report a successful no-op;
- create no tag, draft, package version, chart, Release asset, or marker update;
  and
- leave `latest`, the published Release, and the production deployment unchanged.

An incomplete older tagged candidate is not a no-op: it wins arbitration and
must be recovered before newer work proceeds. If recovery is irrecoverable,
stop, preserve the candidate, and escalate; the live workflow cannot abandon it.

## Live receipt

Append only credential-free facts after the live release. Do not mark the
cutover complete while any field is missing.

| Receipt | Value |
| --- | --- |
| Atomic switch SHA | pending |
| Pre-enable evidence digest/time | pending |
| Post-enable evidence digest/time | pending |
| Immutable Releases enabled re-read | pending |
| No-candidate activation run/attempt | pending |
| Version Packages PR and merge SHA | pending |
| Candidate version and annotated tag object | pending |
| Exact `CI / validate` run/attempt | pending |
| Release run/attempt | pending |
| Manifest SHA-256 | pending |
| Actions payload artifact ID/service digest | pending |
| Draft/published Release ID and URL | pending |
| 45-base-asset digest | pending |
| npm package conclusions | pending |
| Five smoke run/attempt conclusions | pending |
| Independent audit run/attempt and canonical digest | pending |
| Immutable publication re-read | pending |
| OCI chart versions and Publish Chart run | pending |
| Production Vercel deployment ID/commit | pending |
| Public site/browser verification | pending |
| Scheduled no-op run/attempt | pending |

Retain the live receipt with the release records, but never include credentials,
OIDC material, npm session state, browser cookies, or secret-bearing logs.
