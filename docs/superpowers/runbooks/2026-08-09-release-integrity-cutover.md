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

## v0.8.22 duplicate-draft recovery (one time)

Use this candidate-specific procedure only for the reviewed v0.8.22 recovery.
It preserves the canonical draft at Release `379991871` and quarantines the two
duplicate controller identities without deleting either draft or any asset:

| Role | Release ID | Required temporary `tag_name` |
| --- | ---: | --- |
| Canonical candidate | `379991871` | `untagged-be0ff4bee4ba43b521a9` |
| Duplicate | `379982100` | `untagged-a13939767dd2419ade01` |
| Duplicate | `379986168` | `untagged-20706099efa3c38335a8` |

The exact candidate is version `0.8.22` at commit
`2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`. The recovery command cannot
delete drafts, enable or dispatch Release, or publish npm. GitHub does not
provide an atomic conditional `PATCH` for the Release update endpoint. The
body-only update therefore depends on an explicit operator edit freeze plus a
final compare-before-write fence; do not describe it as compare-and-swap or
atomic.

### Prerequisites and reviewed authority

Keep `.github/workflows/release.yml` in `disabled_manually` throughout this
procedure. Before establishing the freeze, independently require Immutable
Releases to be enabled, no Release workflow run to be nonterminal, annotated
tag `v0.8.22` to peel to the exact candidate commit, no published Release to
use `v0.8.22`, and exact npm version `0.8.22` to remain absent for all 21
packages. Every terminal and nonterminal Release workflow run at the candidate
SHA must have complete attempt/job coverage, and its one `publish-npm` job per
attempt must never have started: only `queued` with no conclusion or `completed`
with conclusion `skipped` is acceptable. Require the canonical and duplicate
numeric IDs, temporary tag names, draft metadata, bodies, and complete
45-base-asset inventories to match the reviewed recovery policy. Stop on a
fourth marker-backed or exact-tag candidate, an unavailable read, or any
mismatch.

Pre-merge production reference (read-only, `2026-09-02`, recorded so the freeze
window is not the first time these are checked; re-verify them live at capture
time rather than trusting this table):

| Fact | Observed |
| --- | --- |
| Annotated tag `v0.8.22` peels to | `2a80deece2ff958fe7fde8fddeb4f99bed70a1c8` |
| Draft Releases identifying the candidate | exactly three; no fourth |
| Release IDs / temporary tag names | exactly the policy values |
| Body SHA-256 of all three drafts | `5fe9fcab17cb6964658da89267beec5cf59cb04846b0209d9773e6b2e2c2e918` (both duplicates `untouched`). Digest the exact body bytes: `gh api … --jq .body \| shasum` appends a newline and yields a different value. |
| Base assets per draft | 45, mutable, not prerelease |
| `.github/workflows/release.yml` | `disabled_manually`, no nonterminal runs |
| Candidate runs | 5, all `completed`; each `publish-npm` job `completed`/`skipped`, one attempt each |
| Published Release at `v0.8.22` | none |
| npm | `latest` = `0.8.21`; `0.8.22` returns `E404` for all 21 packages |

Trailing-newline round trip: the recovery notice ends with exactly one `\n`, and
its byte-exact survival through `PATCH` is not an assumption. `canonicalReleaseBody`
composes controller bodies that also end with exactly one `\n`, and the shipped
`updateDraftReleaseIfCurrent` PATCHes such a body and then re-reads it under exact
body equality. The escrow drafts' stored bodies carry that trailing newline today.

Run only from a newly cloned, isolated checkout of the merged recovery commit.
Do not reuse a worktree or clone that has ever contained `node_modules`; if any
preexisting dependency tree is found in the checkout or its module-resolution
ancestors, fail and create another isolated checkout rather than deleting or
overwriting an unknown tree. Let
`RECOVERY_SHA` be the 40-character lowercase merge SHA, not the pull-request
branch head, a later `main`, or the candidate commit. Fetch `main`, then require
local `HEAD`, `origin/main`, and `RECOVERY_SHA` to be identical. The `capture`
command additionally verifies that this SHA is the merge commit of exactly one
merged pull request targeting `main`, that `CI / validate` succeeded at its
reviewed head, and that the merge commit tree equals the reviewed head tree.
Do not continue if any identity or tree check differs.

Before loading credentials, start one fresh zsh session, create the fresh clone
and a fresh private pnpm store, and establish clean local execution authority.
Replace the placeholder with the reviewed merged recovery commit. The install
is lockfile-frozen, uses the exact `pnpm@10.33.0` declared by the reviewed root
`package.json`, enables content-store integrity verification, and disables all
dependency lifecycle scripts. Initial absence plus the uninterrupted install
and post-install checks prove that the only ignored dependency trees used by
this procedure were materialized from the reviewed lockfile during this
session; they do not claim that a registry is trustworthy beyond the
lockfile's integrity bindings. Never load the GitHub token before this block
finishes.

```zsh
set -euo pipefail
umask 077
unset NODE_OPTIONS NODE_PATH
RECOVERY_PARENT="$(mktemp -d "${TMPDIR%/}/dawn-v0.8.22-recovery.XXXXXXXX")"
RECOVERY_PARENT="${RECOVERY_PARENT:A}"
chmod 0700 "$RECOVERY_PARENT"
RECOVERY_CHECKOUT="$RECOVERY_PARENT/dawn"
PNPM_STORE_DIR="$RECOVERY_PARENT/pnpm-store"
test ! -e "$RECOVERY_CHECKOUT"
test ! -e "$PNPM_STORE_DIR"
git -c core.hooksPath=/dev/null clone https://github.com/cacheplane/dawnai.git "$RECOVERY_CHECKOUT"
cd "$RECOVERY_CHECKOUT"
test "$(pwd -P)" = "$RECOVERY_CHECKOUT"
test -z "$(find . -name node_modules -prune -print -quit)"
MODULE_ANCESTOR="${RECOVERY_CHECKOUT:h}"
while [ "$MODULE_ANCESTOR" != / ]; do
  test ! -e "$MODULE_ANCESTOR/node_modules"
  test ! -L "$MODULE_ANCESTOR/node_modules"
  MODULE_ANCESTOR="${MODULE_ANCESTOR:h}"
done
test ! -e /node_modules
test ! -L /node_modules
git fetch origin main --tags
RECOVERY_SHA='<reviewed-merged-recovery-commit>'
printf '%s\n' "$RECOVERY_SHA" | grep -Eq '^[0-9a-f]{40}$'
test "$(git rev-parse HEAD)" = "$RECOVERY_SHA"
test "$(git rev-parse origin/main)" = "$RECOVERY_SHA"
git diff --quiet --exit-code
git diff --cached --quiet --exit-code
test -z "$(git ls-files --others --exclude-standard)"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git diff --quiet --exit-code "$RECOVERY_SHA" --
test -z "${NODE_OPTIONS-}"
test -z "${NODE_PATH-}"
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
export PATH RECOVERY_SHA RECOVERY_PARENT RECOVERY_CHECKOUT PNPM_STORE_DIR
test "$(node --version)" = 'v24.19.0'
test "$(pnpm --version)" = '10.33.0'
test "$(node -p 'require("./package.json").packageManager')" = 'pnpm@10.33.0'
test ! -e "$PNPM_STORE_DIR"
install -d -m 0700 "$PNPM_STORE_DIR"
pnpm install --frozen-lockfile --ignore-scripts --verify-store-integrity \
  --store-dir "$PNPM_STORE_DIR"
pnpm store status --store-dir "$PNPM_STORE_DIR"
chmod 0700 "$PNPM_STORE_DIR"
test -d node_modules
MODULE_ANCESTOR="${RECOVERY_CHECKOUT:h}"
while [ "$MODULE_ANCESTOR" != / ]; do
  test ! -e "$MODULE_ANCESTOR/node_modules"
  test ! -L "$MODULE_ANCESTOR/node_modules"
  MODULE_ANCESTOR="${MODULE_ANCESTOR:h}"
done
test ! -e /node_modules
test ! -L /node_modules
test -z "$(git status --porcelain=v1 --untracked-files=all)"
# Collapsed mode on purpose: `--untracked-files=all` expands every ignored
# tree into its files, so no line could ever end in `node_modules/`.
git status --ignored --porcelain=v1 | node -e '
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    const lines = input.split("\n").filter(Boolean)
    if (lines.length === 0 || lines.some((line) => !/^!! (?:.+\/)?node_modules\/$/u.test(line))) {
      throw new Error("Post-install ignored paths are not exclusively node_modules trees")
    }
  })
'
git diff --quiet --exit-code
git diff --cached --quiet --exit-code
git diff --quiet --exit-code "$RECOVERY_SHA" --
test -z "$(git ls-files --others --exclude-standard)"
test -z "${NODE_OPTIONS-}"
test -z "${NODE_PATH-}"
```

### Establish the operator edit freeze and private directory

Require one nonempty `GITHUB_TOKEN` for both the recovery CLI and every `gh` or
direct API call. `GH_TOKEN` must be overwritten with that exact value. Resolve
and record the login without printing the token, then re-run the final equality
before capture, apply, verification, enablement, and dispatch. Any login change
or mismatch stops the procedure.

```zsh
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set for the authenticated operator}"
test -n "$GITHUB_TOKEN"
export GH_TOKEN="$GITHUB_TOKEN"
OPERATOR_LOGIN="$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')"
test -n "$OPERATOR_LOGIN"
test "$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')" = "$OPERATOR_LOGIN"
```

After that same-principal check succeeds, enter `OPERATOR_LOGIN`, the UTC
establishment time, exact scope `[379982100, 379986168]`, the
workflow-disabled observation, and the explicit non-atomic
time-of-check/time-of-use limitation in the operator freeze record. From that
point until the freeze is deliberately released, no human, bot, workflow, or
other process may edit either duplicate Release.

Create both private directories as the authenticated local operator. Every
directory from the repository root through `.dawn` must be owned by that
operator and not group- or world-writable; the final recovery directory must be
exactly mode `0700`. The CLI fails closed before credential or writer
construction if these conditions do not hold.

```bash
umask 077
install -d -m 0700 .dawn
install -d -m 0700 .dawn/release-recovery
chmod go-w .dawn
chmod 0700 .dawn/release-recovery
```

The directory must remain ignored by the reviewed Git policy. Capture and apply
use distinct, unused, regular-file paths below exactly
`.dawn/release-recovery/`. They refuse symlinks, hard links, clobbering,
traversal, absolute paths, alternate `.dawn` directories, and unsafe file
modes. A resumed attempt always uses the next unused matching sequence number;
never replace or reuse a path.

### Capture and inspect fresh evidence

With the edit freeze active and all prerequisites still exact, run:

```zsh
set -euo pipefail
test "$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')" = "$OPERATOR_LOGIN"
: "${ATTEMPT:=01}"
printf '%s\n' "$ATTEMPT" | grep -Eq '^(0[1-9]|[1-9][0-9])$'
typeset -gA CAPTURE_PATHS CAPTURE_STARTED_AT CAPTURE_FINISHED_AT CAPTURE_EXIT_CODES CAPTURE_SHA256S
CAPTURE_PATHS[$ATTEMPT]=".dawn/release-recovery/v0.8.22-capture-$ATTEMPT.json"
test ! -e "${CAPTURE_PATHS[$ATTEMPT]}"
CAPTURE_STARTED_AT[$ATTEMPT]="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if env -u NODE_OPTIONS -u NODE_PATH GITHUB_TOKEN="$GITHUB_TOKEN" \
  node scripts/release/recover-v0.8.22-duplicate-drafts.mjs capture \
  --reviewed-commit "$RECOVERY_SHA" \
  --output "${CAPTURE_PATHS[$ATTEMPT]}"; then
  CAPTURE_EXIT_CODES[$ATTEMPT]=0
else
  CAPTURE_EXIT_CODES[$ATTEMPT]=$?
fi
CAPTURE_FINISHED_AT[$ATTEMPT]="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
```

Capture is read-only and writes one credential-free, canonical evidence file
with mode `0600`. It is valid for at most 15 minutes. Hash it and inspect its
JSON before apply:

```zsh
set -euo pipefail
test "${CAPTURE_EXIT_CODES[$ATTEMPT]}" -eq 0
CAPTURE_SHA256S[$ATTEMPT]="$(shasum -a 256 "${CAPTURE_PATHS[$ATTEMPT]}" | awk '{print $1}')"
printf '%s  %s\n' "${CAPTURE_SHA256S[$ATTEMPT]}" "${CAPTURE_PATHS[$ATTEMPT]}"
env -u NODE_OPTIONS -u NODE_PATH node -e '
  const fs = require("node:fs")
  const path = process.argv[1]
  const value = JSON.parse(fs.readFileSync(path, "utf8"))
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
' "${CAPTURE_PATHS[$ATTEMPT]}"
```

Require the repository/recovery/candidate identities, tag object and peel,
workflow and Immutable Releases states, empty nonterminal-run inventory,
package-level npm absence, all three Release snapshots, body and asset
digests, and the expected notice/asset bytes to be exact. Capture emits evidence
only after it has also enumerated every terminal and nonterminal candidate run,
read every attempt's jobs, and rejected any `publish-npm` job that ever started;
require that acceptance gate during inspection even though raw job records are
not serialized into the credential-free evidence file. Each duplicate must
classify into exactly one of these states:

| State | Exact recognized contents | Next resumable transition |
| --- | --- | --- |
| `untouched` | Original marker body and exactly 45 original base assets | Upload the original-body archive asset. |
| `body-archived` | Original body, 45 base assets, and the exact original-body archive asset | Upload the duplicate recovery receipt asset. |
| `receipt-archived` | Original body, 45 base assets, and both exact recovery evidence assets | Replace only the live body with the exact non-marker notice. |
| `quarantined` | Exact recovery notice, 45 base assets, and both exact recovery evidence assets | No mutation; verify the state. |

The command processes the duplicates only in ascending ID order. It cannot
start Release `379986168` until Release `379982100` is exactly quarantined.
Anything outside these four states is a conflict, not a repair opportunity.

### Apply once and handle partial outcomes

Apply the inspected evidence exactly once with the literal acknowledgement
flag and a distinct unused output path:

```zsh
set -euo pipefail
test "$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')" = "$OPERATOR_LOGIN"
printf '%s\n' "$ATTEMPT" | grep -Eq '^(0[1-9]|[1-9][0-9])$'
typeset -gA APPLY_PATHS APPLY_STARTED_AT APPLY_FINISHED_AT APPLY_EXIT_CODES APPLY_SHA256S
APPLY_PATHS[$ATTEMPT]=".dawn/release-recovery/v0.8.22-apply-$ATTEMPT.json"
test ! -e "${APPLY_PATHS[$ATTEMPT]}"
APPLY_STARTED_AT[$ATTEMPT]="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if env -u NODE_OPTIONS -u NODE_PATH GITHUB_TOKEN="$GITHUB_TOKEN" \
  node scripts/release/recover-v0.8.22-duplicate-drafts.mjs apply \
  --evidence "${CAPTURE_PATHS[$ATTEMPT]}" \
  --acknowledge-non-atomic-release-edit-freeze \
  --output "${APPLY_PATHS[$ATTEMPT]}"; then
  APPLY_EXIT_CODES[$ATTEMPT]=0
else
  APPLY_EXIT_CODES[$ATTEMPT]=$?
fi
APPLY_FINISHED_AT[$ATTEMPT]="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [ "${APPLY_EXIT_CODES[$ATTEMPT]}" -eq 0 ]; then
  APPLY_SHA256S[$ATTEMPT]="$(shasum -a 256 "${APPLY_PATHS[$ATTEMPT]}" | awk '{print $1}')"
  SUCCESS_ATTEMPT="$ATTEMPT"
fi
```

The acknowledgement accepts no value, alias, reordered form, environment
fallback, or configuration substitute. `apply` reauthorizes every mutation
against fresh production reads, uploads only absent byte-identical recovery
assets, performs at most one body-only `PATCH` per duplicate, never retries an
ambiguous write, and emits the local write-once final authorization receipt
only after both duplicates and the final normal-controller observation pass.

On any nonzero exit, preserve every remaining file, GitHub asset, and the
operator freeze. Record the exit, UTC time, and the exact known or ambiguous
state. Exit code `3` specifically means output cleanup is
uncertain: do not delete, rename, reuse, or infer the contents of that apply
path. Do not rerun `apply` blindly after a timeout, transport error, retryable
HTTP response, malformed response, or otherwise ambiguous outcome.

Instead, use read-only `capture` at the next unused path, such as
`v0.8.22-capture-02.json`, while the freeze remains active. If it proves one of
the four exact states, inspect and hash it, record that state, and deliberately
resume only the missing transition with the matching unused
`v0.8.22-apply-02.json` path and the exact acknowledgement. A resumed final
authorization receipt may report a freshly verified
`preexisting-quarantined` duplicate with `priorFenceObservations: null`; never
invent an earlier invocation's pre/post fence observations. If fresh capture
cannot classify the live state exactly, keep the workflow disabled and the
edit freeze active, preserve all evidence, and escalate for review.

For a deliberate second attempt, set the next number and paste the capture,
inspection, and apply blocks above unchanged. This is the copy/paste-safe resume
selector; it derives new paths and ledger values without reading or overwriting
attempt `01`:

```zsh
ATTEMPT='02'
printf '%s\n' "$ATTEMPT" | grep -Eq '^(0[1-9]|[1-9][0-9])$'
test ! -e ".dawn/release-recovery/v0.8.22-capture-$ATTEMPT.json"
test ! -e ".dawn/release-recovery/v0.8.22-apply-$ATTEMPT.json"
# Paste the three unchanged capture/inspect/apply blocks; a successful apply
# assigns SUCCESS_ATTEMPT="$ATTEMPT" for independent verification.
```

Maintain this append-only attempt ledger in the operator freeze record. Add a
row immediately after every capture/apply pair, including failed or ambiguous
attempts. Preserve every numbered file; a missing digest must say why it could
not be safely read rather than being left implicit.

| Attempt | Capture path / SHA-256 / UTC / exit | Apply path / SHA-256 / UTC / exit | Exact states after read-only observation | Output cleanup | Per-duplicate outcome |
| ---: | --- | --- | --- | --- | --- |
| `01` | pending | pending | pending for `379982100`; pending for `379986168` | pending (`clean` or `uncertain`) | pending (`performed`, `preexisting-quarantined`, or no final receipt) |

For a `performed` duplicate, record its outcome and both exact fence objects:
`preWriteFence` and `postWriteFence` each contain only `observedAt`,
`projectionSha256`, and `tagObjectSha`. For a
`preexisting-quarantined` duplicate, record only `verifiedAt`,
`projectionSha256`, and `priorFenceObservations: null`. Do not assign an
outcome to a fence or invent a fence for a preexisting quarantine.

### Independent verification and freeze release

After successful apply, independently enumerate Releases with pagination and
read all three objects and their assets by numeric ID; do not rely on a
published-only tag lookup or solely on the recovery command's success line.
Download both evidence assets on each duplicate through the authenticated
numeric asset endpoint, not a response URL. Run this in the same zsh session;
it creates one unused mode-`0700` verification directory and keeps every API
response and download private. It prints no headers, token, or signed URL.

```zsh
set -euo pipefail
test "$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')" = "$OPERATOR_LOGIN"
: "${SUCCESS_ATTEMPT:?set SUCCESS_ATTEMPT to the successful two-digit ledger attempt}"
printf '%s\n' "$SUCCESS_ATTEMPT" | grep -Eq '^(0[1-9]|[1-9][0-9])$'
test "${CAPTURE_EXIT_CODES[$SUCCESS_ATTEMPT]}" -eq 0
test "${APPLY_EXIT_CODES[$SUCCESS_ATTEMPT]}" -eq 0
CAPTURE_PATH="${CAPTURE_PATHS[$SUCCESS_ATTEMPT]}"
APPLY_PATH="${APPLY_PATHS[$SUCCESS_ATTEMPT]}"
VERIFY_DIR=".dawn/release-recovery/v0.8.22-verify-$SUCCESS_ATTEMPT"
SUCCESS_LEDGER_ATTEMPT="$SUCCESS_ATTEMPT"
test "$CAPTURE_PATH" = ".dawn/release-recovery/v0.8.22-capture-$SUCCESS_ATTEMPT.json"
test "$APPLY_PATH" = ".dawn/release-recovery/v0.8.22-apply-$SUCCESS_ATTEMPT.json"
test -n "${CAPTURE_STARTED_AT[$SUCCESS_LEDGER_ATTEMPT]}"
test -n "${CAPTURE_FINISHED_AT[$SUCCESS_LEDGER_ATTEMPT]}"
test -n "${APPLY_STARTED_AT[$SUCCESS_LEDGER_ATTEMPT]}"
test -n "${APPLY_FINISHED_AT[$SUCCESS_LEDGER_ATTEMPT]}"
test "$(shasum -a 256 "$CAPTURE_PATH" | awk '{print $1}')" = "${CAPTURE_SHA256S[$SUCCESS_LEDGER_ATTEMPT]}"
test "$(shasum -a 256 "$APPLY_PATH" | awk '{print $1}')" = "${APPLY_SHA256S[$SUCCESS_LEDGER_ATTEMPT]}"
test ! -e "$VERIFY_DIR"
install -d -m 0700 "$VERIFY_DIR"
chmod 0700 "$VERIFY_DIR"

GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  'repos/cacheplane/dawnai/releases?per_page=100' \
  > "$VERIFY_DIR/releases-pages.json"
GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
  > "$VERIFY_DIR/release-run-pages.json"

for release_id in 379991871 379982100 379986168; do
  GH_TOKEN="$GITHUB_TOKEN" gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/cacheplane/dawnai/releases/$release_id" \
    > "$VERIFY_DIR/release-$release_id.json"
  GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/cacheplane/dawnai/releases/$release_id/assets?per_page=100" \
    > "$VERIFY_DIR/release-$release_id-assets-pages.json"
done

VERIFY_DIR="$VERIFY_DIR" env -u NODE_OPTIONS -u NODE_PATH node --input-type=module \
  > "$VERIFY_DIR/candidate-run-ids.txt" <<'NODE'
import { readFileSync } from "node:fs"
const pages = JSON.parse(readFileSync(`${process.env.VERIFY_DIR}/release-run-pages.json`, "utf8"))
if (!Array.isArray(pages)) throw new Error("Release run pagination is malformed")
const runs = pages.flatMap((page) => {
  if (!page || !Array.isArray(page.workflow_runs)) throw new Error("Release run page is malformed")
  return page.workflow_runs
})
const ids = new Set()
for (const run of runs) {
  if (!Number.isSafeInteger(run.id) || ids.has(run.id)) throw new Error("Release run ID is invalid")
  ids.add(run.id)
  if (run.status !== "completed") throw new Error("A Release workflow run is nonterminal")
  if (run.head_sha === "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8") {
    process.stdout.write(`${run.id}\n`)
  }
}
NODE

while IFS= read -r run_id; do
  printf '%s\n' "$run_id" | grep -Eq '^[1-9][0-9]*$'
  GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/cacheplane/dawnai/actions/runs/$run_id/jobs?filter=all&per_page=100" \
    > "$VERIFY_DIR/run-$run_id-jobs-pages.json"
done < "$VERIFY_DIR/candidate-run-ids.txt"

VERIFY_DIR="$VERIFY_DIR" env -u NODE_OPTIONS -u NODE_PATH node --input-type=module \
  > "$VERIFY_DIR/evidence-asset-ids.tsv" <<'NODE'
import { readFileSync } from "node:fs"
for (const releaseId of [379982100, 379986168]) {
  const file = `${process.env.VERIFY_DIR}/release-${releaseId}-assets-pages.json`
  const pages = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("Release asset pagination is malformed")
  }
  const prefix = `dawn-v0.8.22-duplicate-${releaseId}-`
  const assets = pages.flat().filter((asset) =>
    typeof asset?.name === "string" && asset.name.startsWith(prefix),
  )
  if (assets.length !== 2 || assets.some((asset) => !Number.isSafeInteger(asset.id))) {
    throw new Error("Recovery evidence asset identity is not exact")
  }
  for (const asset of assets) process.stdout.write(`${releaseId}\t${asset.id}\n`)
}
NODE

while IFS=$'\t' read -r release_id asset_id; do
  printf '%s\n' "$release_id" | grep -Eq '^(379982100|379986168)$'
  printf '%s\n' "$asset_id" | grep -Eq '^[1-9][0-9]*$'
  GH_TOKEN="$GITHUB_TOKEN" gh api \
    -H 'Accept: application/octet-stream' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/cacheplane/dawnai/releases/assets/$asset_id" \
    > "$VERIFY_DIR/release-$release_id-asset-$asset_id.bin"
done < "$VERIFY_DIR/evidence-asset-ids.tsv"

find "$VERIFY_DIR" -type f -exec chmod 0600 {} +
```

Run this fail-closed verifier over the preserved files. It reuses the recovery
module's canonical evidence parser; independently validates canonical final
authorization and duplicate recovery receipt JSON; checks list/numeric-ID
correlation, body/tag/draft state, exact 45/47 asset counts and digests; hashes
the downloaded evidence assets; and rechecks every candidate run attempt's
`publish-npm` job. Each duplicate's stored receipt names the reviewed commit
that performed its quarantine, which may predate `RECOVERY_SHA` when the
recovery surface was fixed between attempts; the verifier rebuilds the expected
receipt and notice around that commit with every other field pinned to the
evidence, exactly as `classifyDuplicateDraft` does, and the shell then
requires that commit to be a merge commit that is an ancestor of
`RECOVERY_SHA`. Its output is a credential-free mode-`0600` verification
receipt.

```zsh
set -euo pipefail
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be nonempty for credential-leak verification}"
VERIFY_DIR="$VERIFY_DIR" CAPTURE_PATH="$CAPTURE_PATH" APPLY_PATH="$APPLY_PATH" \
  GITHUB_TOKEN="$GITHUB_TOKEN" \
  env -u NODE_OPTIONS -u NODE_PATH node --input-type=module \
  > "$VERIFY_DIR/independent-verification.json" <<'NODE'
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import {
  canonicalDuplicateDraftEvidence,
  canonicalRecoveryNotice,
  canonicalRecoveryReceipt,
  parseDuplicateDraftEvidence,
} from "./scripts/release/duplicate-draft-recovery.mjs"
import { parseReleaseMarker } from "./scripts/release/metadata.mjs"

const verifyDir = process.env.VERIFY_DIR
const evidenceBytes = readFileSync(process.env.CAPTURE_PATH)
const receiptBytes = readFileSync(process.env.APPLY_PATH)
const githubToken = process.env.GITHUB_TOKEN
if (typeof githubToken !== "string" || githubToken.length === 0) {
  throw new Error("GitHub token is unavailable for credential-leak verification")
}
const githubTokenBytes = Buffer.from(githubToken, "utf8")
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, "utf8")
const exactKeys = (value, keys, label) => {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} is invalid`)
  const actual = Object.keys(value).sort().join(",")
  if (actual !== [...keys].sort().join(",")) throw new Error(`${label} fields are not exact`)
}
const parseJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const arrayPages = (path) => {
  const pages = parseJson(path)
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${path} pagination is malformed`)
  }
  return pages.flat()
}
const objectPages = (path, field) => {
  const pages = parseJson(path)
  if (!Array.isArray(pages) || pages.some((page) => !page || !Array.isArray(page[field]))) {
    throw new Error(`${path} pagination is malformed`)
  }
  return pages.flatMap((page) => page[field])
}
const requirePrivate = (path) => {
  const stat = statSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new Error(`${path} is not one private regular file`)
  }
}
const same = (left, right) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
const shaPattern = /^[0-9a-f]{64}$/u
const timestamp = (value) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false
  const canonical = new Date(Date.parse(value)).toISOString()
  return value === canonical || (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"))
}

requirePrivate(process.env.CAPTURE_PATH)
requirePrivate(process.env.APPLY_PATH)
const evidence = parseDuplicateDraftEvidence(evidenceBytes)
if (!canonicalDuplicateDraftEvidence(evidence).equals(evidenceBytes)) {
  throw new Error("Capture evidence is not canonical")
}
const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes))
if (!canonicalBytes(receipt).equals(receiptBytes)) throw new Error("Final authorization receipt is not canonical")
exactKeys(receipt, ["schemaVersion", "atomic", "concurrencyAcknowledgement", "freezeScope", "evidenceCapturedAt", "appliedAt", "candidate", "duplicates", "finalAuthorization"], "final authorization receipt")
if (receipt.schemaVersion !== 1 || receipt.atomic !== false || receipt.evidenceCapturedAt !== evidence.capturedAt || !timestamp(receipt.appliedAt) || Date.parse(receipt.appliedAt) < Date.parse(receipt.evidenceCapturedAt)) {
  throw new Error("Final authorization receipt identity is not exact")
}
if (receiptBytes.includes(githubTokenBytes)) throw new Error("Final authorization receipt contains the configured credential")
const expectedScope = [379982100, 379986168]
exactKeys(receipt.concurrencyAcknowledgement, ["acknowledged", "atomic", "mode", "releaseIds"], "acknowledgement")
exactKeys(receipt.freezeScope, ["mode", "releaseIds"], "freeze scope")
if (receipt.concurrencyAcknowledgement.acknowledged !== true || receipt.concurrencyAcknowledgement.atomic !== false || receipt.concurrencyAcknowledgement.mode !== "operator-freeze-compare-before-write-v1" || !same(receipt.concurrencyAcknowledgement.releaseIds, expectedScope) || receipt.freezeScope.mode !== "operator-freeze-compare-before-write-v1" || !same(receipt.freezeScope.releaseIds, expectedScope)) {
  throw new Error("Final authorization freeze acknowledgement is not exact")
}
if (!same(receipt.candidate, { version: "0.8.22", commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8", releaseId: 379991871 })) {
  throw new Error("Final authorization candidate is not exact")
}
if (!Array.isArray(receipt.duplicates) || receipt.duplicates.length !== 2) throw new Error("Duplicate outcomes are not exact")
for (const [index, result] of receipt.duplicates.entries()) {
  if (result.releaseId !== expectedScope[index]) throw new Error("Duplicate outcome order is not exact")
  if (result.outcome === "performed") {
    exactKeys(result, ["releaseId", "outcome", "preWriteFence", "postWriteFence"], "performed outcome")
    for (const fence of [result.preWriteFence, result.postWriteFence]) {
      exactKeys(fence, ["observedAt", "projectionSha256", "tagObjectSha"], "write fence")
      if (!timestamp(fence.observedAt) || !shaPattern.test(fence.projectionSha256) || fence.tagObjectSha !== evidence.candidate.tagObjectSha) throw new Error("Write fence is not exact")
    }
    if (Date.parse(result.preWriteFence.observedAt) < Date.parse(receipt.evidenceCapturedAt) || Date.parse(result.preWriteFence.observedAt) > Date.parse(result.postWriteFence.observedAt) || Date.parse(result.postWriteFence.observedAt) > Date.parse(receipt.appliedAt)) throw new Error("Write fence times are not exact")
  } else {
    exactKeys(result, ["releaseId", "outcome", "priorFenceObservations", "verifiedAt", "projectionSha256"], "preexisting outcome")
    if (result.outcome !== "preexisting-quarantined" || result.priorFenceObservations !== null || !timestamp(result.verifiedAt) || Date.parse(result.verifiedAt) < Date.parse(receipt.evidenceCapturedAt) || Date.parse(result.verifiedAt) > Date.parse(receipt.appliedAt) || !shaPattern.test(result.projectionSha256)) throw new Error("Preexisting quarantine outcome is not exact")
  }
}
const expectedObserver = { state: "CANDIDATE_ESCROWED", disposition: "would-transition", nextTransition: "publish-npm-packages", conflicts: [], diagnostics: [], releaseId: 379991871 }
if (!same(receipt.finalAuthorization, expectedObserver)) throw new Error("Final observer result is not exact")

const listed = arrayPages(`${verifyDir}/releases-pages.json`)
const listedIds = new Set()
for (const release of listed) {
  if (!Number.isSafeInteger(release?.id) || listedIds.has(release.id)) throw new Error("Complete Release pagination has an invalid or duplicate ID")
  listedIds.add(release.id)
}
const expectedIds = [379991871, ...expectedScope]
for (const releaseId of expectedIds) {
  if (listed.filter((release) => release?.id === releaseId).length !== 1) throw new Error(`Release ${releaseId} list identity is not unique`)
}
const controllerVisible = listed.filter((release) => {
  if (release?.tag_name === "v0.8.22") return true
  if (typeof release?.body !== "string" || !release.body.includes("DAWN_RELEASE_CONTROLLER_MARKER")) return false
  try {
    const marker = parseReleaseMarker(release.body)
    return marker.version === "0.8.22" || marker.commitSha === "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8" || marker.tag === "v0.8.22"
  } catch {
    throw new Error(`Release ${release?.id ?? "unknown"} has a malformed candidate marker`)
  }
})
if (controllerVisible.length !== 1 || controllerVisible[0].id !== 379991871) {
  throw new Error("Complete Release inventory does not have exactly one canonical controller-visible candidate")
}
if (!same(parseReleaseMarker(controllerVisible[0].body), evidence.releases.canonical.marker)) {
  throw new Error("The remaining controller-visible candidate marker is not canonical")
}
const findings = []
for (const [index, releaseId] of expectedIds.entries()) {
  const release = parseJson(`${verifyDir}/release-${releaseId}.json`)
  const assets = arrayPages(`${verifyDir}/release-${releaseId}-assets-pages.json`)
  const expected = index === 0 ? evidence.releases.canonical : evidence.releases.duplicates[index - 1]
  const listedRelease = listed.find((item) => item.id === releaseId)
  for (const field of ["id", "tag_name", "name", "body", "target_commitish", "draft", "prerelease", "immutable"]) {
    if (listedRelease[field] !== release[field]) throw new Error(`Release ${releaseId} list/numeric ${field} differs`)
  }
  if (release.id !== releaseId || release.tag_name !== expected.tagName || release.name !== "Dawn v0.8.22" || release.draft !== true || release.prerelease !== false || release.immutable !== false || release.target_commitish !== "main") throw new Error(`Release ${releaseId} mutable draft metadata is not exact`)
  if (index === 0) {
    if (release.body !== expected.body || assets.length !== 45) throw new Error("Canonical Release body or asset count changed")
  }
  let recoveryCommit = null
  let expectedReceipt = null
  if (index > 0) {
    // The stored receipt records the commit that PERFORMED the quarantine,
    // which may be an earlier reviewed recovery commit than RECOVERY_SHA.
    // Mirror `classifyDuplicateDraft`: rebuild the expected receipt and notice
    // around that commit with every other field still pinned to the evidence.
    const receiptAsset = assets.find((asset) => asset.name === expected.receiptAssetName)
    if (!receiptAsset || !Number.isSafeInteger(receiptAsset.id)) throw new Error(`Duplicate Release ${releaseId} recovery receipt asset is absent`)
    const storedPath = `${verifyDir}/release-${releaseId}-asset-${receiptAsset.id}.bin`
    requirePrivate(storedPath)
    let stored
    try {
      stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(storedPath)))
    } catch {
      throw new Error(`Duplicate Release ${releaseId} stored receipt is not JSON`)
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || typeof stored.recoveryCommit !== "string" || !/^[0-9a-f]{40}$/u.test(stored.recoveryCommit)) {
      throw new Error(`Duplicate Release ${releaseId} stored receipt names no recovery commit`)
    }
    recoveryCommit = stored.recoveryCommit
    const { schemaVersion, ...pinned } = JSON.parse(expected.receiptBytes)
    if (schemaVersion !== 1) throw new Error("Evidence recovery receipt schema is not exact")
    expectedReceipt = canonicalRecoveryReceipt({ ...pinned, recoveryCommit })
    const expectedNotice = canonicalRecoveryNotice({
      repository: pinned.repository,
      version: pinned.version,
      canonicalReleaseId: pinned.canonicalReleaseId,
      duplicateReleaseId: releaseId,
      originalBodySha256: expected.originalBodySha256,
      archiveAssetName: expected.archiveAssetName,
      receiptAssetName: expected.receiptAssetName,
      receiptSha256: sha256(expectedReceipt),
    }).toString("utf8")
    if (recoveryCommit === pinned.recoveryCommit && (expectedNotice !== expected.noticeBytes || !expectedReceipt.equals(Buffer.from(expected.receiptBytes, "utf8")))) {
      throw new Error("Rebuilt recovery expectations diverge from the evidence")
    }
    if (release.body !== expectedNotice || release.body.includes("DAWN_RELEASE_CONTROLLER_MARKER") || assets.length !== 47) {
      throw new Error(`Duplicate Release ${releaseId} is not quarantined`)
    }
  }
  const ids = new Set()
  const names = new Set()
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.id) || ids.has(asset.id) || typeof asset.name !== "string" || names.has(asset.name) || !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) throw new Error(`Release ${releaseId} asset inventory is malformed`)
    ids.add(asset.id)
    names.add(asset.name)
  }
  const original = index === 0 ? expected.assets : expected.assets.slice(0, 45)
  for (const asset of original) {
    const live = assets.find((item) => item.id === asset.id)
    if (!live || live.name !== asset.name || live.digest !== `sha256:${asset.sha256}`) throw new Error(`Release ${releaseId} original asset changed`)
  }
  const recoveryAssets = []
  if (index > 0) {
    for (const item of [
      { name: expected.archiveAssetName, sha256: expected.originalBodySha256, bytes: Buffer.from(evidence.releases.canonical.body, "utf8") },
      { name: expected.receiptAssetName, sha256: sha256(expectedReceipt), bytes: expectedReceipt },
    ]) {
      const live = assets.find((asset) => asset.name === item.name)
      if (!live || live.digest !== `sha256:${item.sha256}`) throw new Error(`Release ${releaseId} recovery asset metadata changed`)
      const downloaded = readFileSync(`${verifyDir}/release-${releaseId}-asset-${live.id}.bin`)
      requirePrivate(`${verifyDir}/release-${releaseId}-asset-${live.id}.bin`)
      if (downloaded.length !== live.size || sha256(downloaded) !== item.sha256 || !downloaded.equals(item.bytes)) throw new Error(`Release ${releaseId} recovery asset bytes changed`)
      if (downloaded.includes(githubTokenBytes)) throw new Error(`Release ${releaseId} recovery asset contains the configured credential`)
      if (item.name === expected.receiptAssetName) {
        const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(downloaded))
        if (!canonicalBytes(json).equals(downloaded)) throw new Error(`Release ${releaseId} duplicate recovery receipt asset is not canonical`)
      }
      recoveryAssets.push({ id: live.id, name: live.name, size: live.size, sha256: item.sha256 })
    }
  }
  findings.push({ releaseId, tagName: release.tag_name, name: release.name, targetCommitish: release.target_commitish, draft: release.draft, prerelease: release.prerelease, immutable: release.immutable, bodySha256: sha256(Buffer.from(release.body, "utf8")), assetCount: assets.length, recoveryCommit, recoveryAssets })
}

const runs = objectPages(`${verifyDir}/release-run-pages.json`, "workflow_runs")
const runIds = new Set()
for (const run of runs) {
  if (!Number.isSafeInteger(run.id) || runIds.has(run.id) || run.status !== "completed") throw new Error("Release workflow run inventory is not terminal and unique")
  runIds.add(run.id)
  if (run.head_sha !== "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8") continue
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("Candidate run attempt is invalid")
  const jobs = objectPages(`${verifyDir}/run-${run.id}-jobs-pages.json`, "jobs")
  for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
    const publishers = jobs.filter((job) => job.run_id === run.id && job.run_attempt === attempt && job.name === "publish-npm")
    if (publishers.length !== 1) throw new Error("Candidate publish-npm job coverage is not exact")
    const job = publishers[0]
    const neverStarted = (job.status === "queued" && job.conclusion === null && job.started_at === null) || (job.status === "completed" && job.conclusion === "skipped")
    if (!neverStarted) throw new Error("A candidate publish-npm job started")
  }
}

const report = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  evidenceSha256: sha256(evidenceBytes),
  finalAuthorizationReceiptSha256: sha256(receiptBytes),
  candidatePublishJobsStarted: false,
  releases: findings,
  finalAuthorization: receipt.finalAuthorization,
}
process.stdout.write(canonicalBytes(report))
NODE
chmod 0600 "$VERIFY_DIR/independent-verification.json"
env -u NODE_OPTIONS -u NODE_PATH node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  const commits = report.releases.filter((release) => release.recoveryAssets.length > 0).map((release) => release.recoveryCommit)
  if (commits.length !== 2 || commits.some((commit) => !/^[0-9a-f]{40}$/u.test(commit))) throw new Error("Recovery commits are not exact")
  process.stdout.write(`${commits.join("\n")}\n`)
' "$VERIFY_DIR/independent-verification.json" | while IFS= read -r recovery_commit; do
  printf '%s\n' "$recovery_commit" | grep -Eq '^[0-9a-f]{40}$'
  git merge-base --is-ancestor "$recovery_commit" "$RECOVERY_SHA"
  test "$(git rev-list --parents --max-count=1 "$recovery_commit" | wc -w | tr -d ' ')" -eq 3
done
shasum -a 256 "$CAPTURE_PATH" "$APPLY_PATH" "$VERIFY_DIR/independent-verification.json"
```

Require all of the following before releasing the edit freeze:

- canonical Release `379991871` still has its exact original body, temporary
  tag, title `Dawn v0.8.22`, `target_commitish: main`, draft/prerelease/
  immutable flags, and original 45-member asset namespace;
- both duplicate Releases retain their exact opaque temporary tags and all 45
  original assets, exact title `Dawn v0.8.22`, target and draft flags, have the
  exact non-marker recovery notice, and have no `v0.8.22` tag name;
- the complete paginated Release inventory contains exactly one Release with
  either the exact v0.8.22 controller marker identity or exact tag `v0.8.22`,
  and it is canonical Release `379991871`; there is no fourth marker-backed or
  exact-tag candidate;
- each original-body archive downloads byte-for-byte to the canonical original
  body, and each duplicate recovery receipt asset is canonical with the
  recorded Release ID, asset ID, size, and SHA-256, and names as its recovery
  commit a merge commit that is an ancestor of `RECOVERY_SHA`;
- the local final authorization receipt is canonical, credential-free,
  `atomic: false`, and scope-exact; each duplicate is honestly either
  `performed`, with this invocation's exact `preWriteFence` and
  `postWriteFence` (`observedAt`, `projectionSha256`, and `tagObjectSha`), or
  `preexisting-quarantined`, with a fresh `verifiedAt`, projection SHA-256, and
  `priorFenceObservations: null`; and
- its normal-controller observer is exactly `state: CANDIDATE_ESCROWED`,
  `disposition: would-transition`, `nextTransition: publish-npm-packages`,
  `releaseId: 379991871`, `conflicts: []`, and `diagnostics: []`.

Hash the final authorization receipt and enter the direct-read results in the
live receipt. Only after every successful verification above may the operator
freeze record receive its successful outcome and UTC release time and the edit
freeze be released.

If apply failed or was ambiguous, release the edit freeze only after a fresh
read-only capture proves and records one exact recognized state. A partial state
may be preserved for a later reviewed resume, but Release must remain disabled.
If the state remains ambiguous, do not release the freeze. Under no failure
condition may an operator restore a marker body, delete a draft or asset,
enable Release, dispatch the workflow, or publish npm manually.

### Resume the exact-tag release

Only after both duplicates are independently verified as quarantined, the final
observer is exact, and the edit freeze is released may an owner enable
`.github/workflows/release.yml`. Its schedule is `17 7 * * *`; its
`dawn-release-controller` concurrency group queues and never cancels. Activate
only from `00:00` through `05:59` UTC, away from the 07:17 scheduled edge, and
still prove no queued or in-progress controller exists immediately before and
after enablement and again immediately before dispatch. Activation, all
post-enable reads, dispatch, and durable receipt validation are one trapped
operation below. Once enablement succeeds, every local error, normal exit, or
`INT`, `TERM`, or `HUP` before a fully validated durable HTTP-200 receipt first
attempts to disable Release and read back exact `disabled_manually`. A failed
disable or failed read-back is a hard escalation: preserve every artifact and
do not dispatch or retry.

```zsh
run_v0822_activation_dispatch() (
  set -euo pipefail
  umask 077
  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be nonempty}"
  case "$GITHUB_TOKEN" in
    *$'\r'*|*$'\n'*) print -u2 'GITHUB_TOKEN contains a forbidden newline'; return 1 ;;
  esac
  test "$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')" = "$OPERATOR_LOGIN"
  UTC_HHMM="$(date -u '+%H%M')"
  case "$UTC_HHMM" in
    0[0-5][0-9][0-9]) ;;
    *) print -u2 'Release activation is outside the approved 00:00-05:59 UTC window'; return 1 ;;
  esac

  ACTIVATION_DIR='.dawn/release-recovery/v0.8.22-activation-01'
  test ! -e "$ACTIVATION_DIR"
  install -d -m 0700 "$ACTIVATION_DIR"
  chmod 0700 "$ACTIVATION_DIR"
  ENABLE_MAY_BE_ACTIVE=false
  DISPATCH_DURABLE=false

  assert_workflow_state() {
    WORKFLOW_PATH="$1" EXPECTED_STATE="$2" env -u NODE_OPTIONS -u NODE_PATH node -e '
      const fs = require("node:fs")
      const workflow = JSON.parse(fs.readFileSync(process.env.WORKFLOW_PATH, "utf8"))
      if (workflow.id !== 260503756 || workflow.path !== ".github/workflows/release.yml" || workflow.state !== process.env.EXPECTED_STATE) throw new Error("Release workflow state is not exact")
    '
  }

  assert_terminal_release_runs() {
    RUNS_PATH="$1" env -u NODE_OPTIONS -u NODE_PATH node -e '
      const fs = require("node:fs")
      const pages = JSON.parse(fs.readFileSync(process.env.RUNS_PATH, "utf8"))
      if (!Array.isArray(pages)) throw new Error("Release run pagination is malformed")
      const runs = pages.flatMap((page) => {
        if (!page || !Array.isArray(page.workflow_runs)) throw new Error("Release run page is malformed")
        return page.workflow_runs
      })
      const ids = new Set()
      for (const run of runs) {
        if (!Number.isSafeInteger(run.id) || ids.has(run.id) || run.status !== "completed") throw new Error("Release run inventory is nonterminal or duplicated")
        ids.add(run.id)
      }
    '
  }

  assert_same_release_run_ids() {
    BASELINE_RUNS="$1" CURRENT_RUNS="$2" env -u NODE_OPTIONS -u NODE_PATH node -e '
      const fs = require("node:fs")
      const ids = (path) => new Set(JSON.parse(fs.readFileSync(path, "utf8")).flatMap((page) => page.workflow_runs).map((run) => run.id))
      const baseline = ids(process.env.BASELINE_RUNS)
      const current = ids(process.env.CURRENT_RUNS)
      if (baseline.size !== current.size || [...current].some((id) => !baseline.has(id))) throw new Error("Release run inventory changed after enablement")
    '
  }

  disable_release_after_abort() {
    local disable_exit read_exit chmod_exit validate_exit
    set +e
    GH_TOKEN="$GITHUB_TOKEN" gh api --silent --method PUT \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      'repos/cacheplane/dawnai/actions/workflows/260503756/disable'
    disable_exit=$?
    GH_TOKEN="$GITHUB_TOKEN" gh api \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      'repos/cacheplane/dawnai/actions/workflows/260503756' \
      > "$ACTIVATION_DIR/workflow-after-abort-disable.json"
    read_exit=$?
    chmod 0600 "$ACTIVATION_DIR/workflow-after-abort-disable.json" 2>/dev/null
    chmod_exit=$?
    assert_workflow_state "$ACTIVATION_DIR/workflow-after-abort-disable.json" disabled_manually
    validate_exit=$?
    set -e
    if [ "$disable_exit" -ne 0 ] || [ "$read_exit" -ne 0 ] || [ "$chmod_exit" -ne 0 ] || [ "$validate_exit" -ne 0 ]; then
      print -u2 'HARD ESCALATION: Release may still be active; preserve activation evidence and obtain an independent workflow-state read'
      return 1
    fi
    print -u2 'Release disabled and independently read back as disabled_manually after aborted dispatch'
  }

  fail_safe_exit() {
    local original_exit_code=$?
    trap - EXIT INT TERM HUP
    if [ "$ENABLE_MAY_BE_ACTIVE" = true ] && [ "$DISPATCH_DURABLE" != true ]; then
      if ! disable_release_after_abort; then
        original_exit_code=125
      elif [ "$original_exit_code" -eq 0 ]; then
        original_exit_code=1
      fi
    fi
    exit "$original_exit_code"
  }
  trap 'fail_safe_exit' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  PRE_RUNS="$ACTIVATION_DIR/pre-enable-runs.json"
  POST_RUNS="$ACTIVATION_DIR/post-enable-runs.json"
  PRE_DISPATCH_RUNS="$ACTIVATION_DIR/pre-dispatch-runs.json"
  GH_TOKEN="$GITHUB_TOKEN" gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'repos/cacheplane/dawnai/actions/workflows/260503756' \
    > "$ACTIVATION_DIR/workflow-before-enable.json"
  chmod 0600 "$ACTIVATION_DIR/workflow-before-enable.json"
  assert_workflow_state "$ACTIVATION_DIR/workflow-before-enable.json" disabled_manually
  GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
    > "$PRE_RUNS"
  chmod 0600 "$PRE_RUNS"
  assert_terminal_release_runs "$PRE_RUNS"

  ENABLED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  ENABLE_MAY_BE_ACTIVE=true
  GH_TOKEN="$GITHUB_TOKEN" gh api --silent --method PUT \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'repos/cacheplane/dawnai/actions/workflows/260503756/enable'
  GH_TOKEN="$GITHUB_TOKEN" gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'repos/cacheplane/dawnai/actions/workflows/260503756' \
    > "$ACTIVATION_DIR/workflow-after-enable.json"
  chmod 0600 "$ACTIVATION_DIR/workflow-after-enable.json"
  assert_workflow_state "$ACTIVATION_DIR/workflow-after-enable.json" active
  GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
    > "$POST_RUNS"
  chmod 0600 "$POST_RUNS"
  assert_terminal_release_runs "$POST_RUNS"
  assert_same_release_run_ids "$PRE_RUNS" "$POST_RUNS"
  printf '%s\n' "$ENABLED_AT" > "$ACTIVATION_DIR/enabled-at.txt"
  chmod 0600 "$ACTIVATION_DIR/enabled-at.txt"

  DISPATCH_BODY="$ACTIVATION_DIR/v0.8.22-dispatch-body.json"
  DISPATCH_RECEIPT="$ACTIVATION_DIR/v0.8.22-dispatch-receipt.json"
  DISPATCH_STATUS="$ACTIVATION_DIR/v0.8.22-dispatch-http-status.txt"
  DISPATCH_HASHES="$ACTIVATION_DIR/v0.8.22-dispatch-sha256.txt"
  env -u NODE_OPTIONS -u NODE_PATH node -e '
    const body = { ref: "v0.8.22", inputs: { version: "0.8.22", commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8", operation: "reconcile" } }
    process.stdout.write(JSON.stringify(body))
  ' > "$DISPATCH_BODY"
  chmod 0600 "$DISPATCH_BODY"

  test "$(GH_TOKEN="$GITHUB_TOKEN" gh api user -H 'X-GitHub-Api-Version: 2022-11-28' --jq '.login')" = "$OPERATOR_LOGIN"
  UTC_HHMM="$(date -u '+%H%M')"
  case "$UTC_HHMM" in
    0[0-5][0-9][0-9]) ;;
    *) print -u2 'Release dispatch is outside the approved 00:00-05:59 UTC window'; return 1 ;;
  esac
  GH_TOKEN="$GITHUB_TOKEN" gh api --paginate --slurp \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
    > "$PRE_DISPATCH_RUNS"
  chmod 0600 "$PRE_DISPATCH_RUNS"
  assert_terminal_release_runs "$PRE_DISPATCH_RUNS"
  assert_same_release_run_ids "$PRE_RUNS" "$PRE_DISPATCH_RUNS"

  set +e
  HTTP_STATUS="$(curl --silent --show-error \
    --output "$DISPATCH_RECEIPT" \
    --write-out '%{http_code}' \
    --request POST \
    --header @- \
    'https://api.github.com/repos/cacheplane/dawnai/actions/workflows/260503756/dispatches' \
    --data-binary "@$DISPATCH_BODY" <<HEADERS
Accept: application/vnd.github+json
Authorization: Bearer $GITHUB_TOKEN
X-GitHub-Api-Version: 2026-03-10
HEADERS
  )"
  CURL_EXIT_CODE=$?
  set -e
  printf '%s\n' "$HTTP_STATUS" > "$DISPATCH_STATUS"
  chmod 0600 "$DISPATCH_STATUS"
  test "$CURL_EXIT_CODE" -eq 0
  test "$HTTP_STATUS" = 200
  test -f "$DISPATCH_RECEIPT"
  chmod 0600 "$DISPATCH_RECEIPT"
  shasum -a 256 "$DISPATCH_BODY" "$DISPATCH_RECEIPT" "$DISPATCH_STATUS" > "$DISPATCH_HASHES"
  chmod 0600 "$DISPATCH_HASHES"

  DISPATCH_BODY="$DISPATCH_BODY" DISPATCH_RECEIPT="$DISPATCH_RECEIPT" \
    DISPATCH_STATUS="$DISPATCH_STATUS" DISPATCH_HASHES="$DISPATCH_HASHES" \
    GITHUB_TOKEN="$GITHUB_TOKEN" env -u NODE_OPTIONS -u NODE_PATH node -e '
      const { createHash } = require("node:crypto")
      const { closeSync, fsyncSync, openSync, readFileSync, statSync } = require("node:fs")
      const { basename } = require("node:path")
      const paths = [process.env.DISPATCH_BODY, process.env.DISPATCH_RECEIPT, process.env.DISPATCH_STATUS, process.env.DISPATCH_HASHES]
      const token = process.env.GITHUB_TOKEN
      if (typeof token !== "string" || token.length === 0) throw new Error("Dispatch token is unavailable for leak verification")
      const tokenBytes = Buffer.from(token, "utf8")
      const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
      for (const path of paths) {
        const stat = statSync(path)
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error(`${path} is not one mode-0600 regular file`)
        if (readFileSync(path).includes(tokenBytes)) throw new Error(`${path} contains the GitHub token`)
      }
      const expectedBody = { ref: "v0.8.22", inputs: { version: "0.8.22", commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8", operation: "reconcile" } }
      if (JSON.stringify(JSON.parse(readFileSync(process.env.DISPATCH_BODY, "utf8"))) !== JSON.stringify(expectedBody)) throw new Error("Workflow dispatch body is not exact")
      if (readFileSync(process.env.DISPATCH_STATUS, "utf8") !== "200\n") throw new Error("Workflow dispatch status is not exact")
      const receipt = JSON.parse(readFileSync(process.env.DISPATCH_RECEIPT, "utf8"))
      const keys = Object.keys(receipt).sort().join(",")
      if (keys !== ["workflow_run_id", "run_url", "html_url"].sort().join(",") || !Number.isSafeInteger(receipt.workflow_run_id) || receipt.workflow_run_id < 1) throw new Error("Workflow dispatch receipt is malformed")
      const id = receipt.workflow_run_id
      if (receipt.run_url !== `https://api.github.com/repos/cacheplane/dawnai/actions/runs/${id}` || receipt.html_url !== `https://github.com/cacheplane/dawnai/actions/runs/${id}`) throw new Error("Workflow dispatch receipt URLs are not exact")
      const hashes = new Map(readFileSync(process.env.DISPATCH_HASHES, "utf8").trim().split("\n").map((line) => {
        const match = /^([0-9a-f]{64})  (.+)$/u.exec(line)
        if (!match) throw new Error("Dispatch hash record is malformed")
        return [basename(match[2]), match[1]]
      }))
      for (const path of paths.slice(0, 3)) {
        if (hashes.get(basename(path)) !== sha256(readFileSync(path))) throw new Error(`${path} hash is not exact`)
      }
      for (const path of paths) {
        const fd = openSync(path, "r")
        try { fsyncSync(fd) } finally { closeSync(fd) }
      }
    '
  sync
  DISPATCH_DURABLE=true
  trap - EXIT INT TERM HUP
  shasum -a 256 "$DISPATCH_BODY" "$DISPATCH_RECEIPT" "$DISPATCH_STATUS" "$DISPATCH_HASHES"
)

run_v0822_activation_dispatch
```

The repository's pinned GitHub writer requires this 2026 API direct HTTP-200
receipt. Do not use `gh workflow run`, because it does not durably bind the
returned run. The Authorization header above is read by `curl` from standard
input and never appears in its argument vector or a dispatch artifact. Any
transport failure, non-200 status, malformed receipt, chmod/hash/fsync failure,
identity drift, time-window failure, or new run is ambiguous after enablement;
the armed trap disables and verifies before returning failure. Never retry or
list recent runs to infer a dispatch.

Record the direct dispatch receipt and run identity. Do not cancel, generically
rerun, list recent runs to infer a dispatch, or substitute `main`. Require
serial trusted publication of all 21 packages,
package-level npm integrity and provenance, all five smoke lanes, the
independent audit, and immutable publication of Release `379991871`. Stop at
the first failed transition and preserve its evidence. Only after v0.8.22 is
terminal may Version Packages PR #525 advance the fixed group to the
README-bearing v0.8.23 release; after that release is terminal, remove the
one-time recovery surface in its separately reviewed cleanup pull request.

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
cutover complete while any field is missing. The recovery-specific rows are
also the operator freeze record: preserve exact observations and use `none`
only when a field was independently proved inapplicable. Do not backfill prior
fence observations for a `preexisting-quarantined` outcome.

| Receipt | Value |
| --- | --- |
| Recovery PR number / reviewed head SHA / merge SHA | pending |
| Fresh checkout path / reviewed `packageManager` / pnpm version / lockfile-frozen no-lifecycle install / fresh store integrity result | pending |
| Operator freeze record: authenticated operator | pending |
| Operator freeze record: established UTC | pending |
| Operator freeze record: released UTC | pending |
| Operator freeze record: scope Release IDs | pending (`379982100`, `379986168`) |
| Operator freeze record: workflow-disabled observation and non-atomic limitation | pending |
| Append-only recovery attempt ledger: numbered capture/apply paths, SHA-256, UTC, exits, states, cleanup, outcomes | pending |
| Release `379982100` performed `preWriteFence`: `observedAt` / `projectionSha256` / `tagObjectSha` | pending or inapplicable |
| Release `379982100` performed `postWriteFence`: `observedAt` / `projectionSha256` / `tagObjectSha` | pending or inapplicable |
| Release `379982100` preexisting verification: `verifiedAt` / `projectionSha256` / `priorFenceObservations: null` | pending or inapplicable |
| Release `379986168` performed `preWriteFence`: `observedAt` / `projectionSha256` / `tagObjectSha` | pending or inapplicable |
| Release `379986168` performed `postWriteFence`: `observedAt` / `projectionSha256` / `tagObjectSha` | pending or inapplicable |
| Release `379986168` preexisting verification: `verifiedAt` / `projectionSha256` / `priorFenceObservations: null` | pending or inapplicable |
| Operator freeze record: exact per-attempt partial or ambiguous state | pending |
| Release `379982100` original-body archive asset ID/SHA-256 | pending |
| Release `379982100` duplicate recovery receipt asset ID/SHA-256 | pending |
| Release `379986168` original-body archive asset ID/SHA-256 | pending |
| Release `379986168` duplicate recovery receipt asset ID/SHA-256 | pending |
| Post-quarantine body SHA-256 for both duplicates | pending |
| Evidence `capturedAt` used by the successful apply (must equal `receipt.evidenceCapturedAt`) | pending |
| Final authorization receipt path / SHA-256 | pending |
| Final authorization receipt per-duplicate `performed` or `preexisting-quarantined` outcomes | pending |
| Final observer `CANDIDATE_ESCROWED` / `would-transition` / `publish-npm-packages` / Release `379991871` / `conflicts: []` / `diagnostics: []` | pending |
| Release activation UTC / pre-enable, post-enable, and immediately-pre-dispatch run snapshot SHA-256 / exact no-new-run proofs | pending |
| Direct v0.8.22 dispatch HTTP 200 receipt SHA-256 / durable hash record / `workflow_run_id` / `run_url` / `html_url` | pending |
| v0.8.22 Release run/attempt | pending |
| v0.8.22 npm integrity/provenance conclusions | pending |
| v0.8.22 immutable Release ID and re-read | pending (`379991871`) |
| v0.8.23 Version Packages PR / Release run/attempt | pending |
| Recovery cleanup PR / merge SHA | pending |
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
