# Security Backlog and Release Recovery Design

Status: approved design, ready for implementation planning

Date: 2026-08-09

## Summary

Dawn will keep publication disabled, restore the repository from its merged but
unpublished `0.8.22` version state to the last published `0.8.21` state, and
remediate the security backlog in bounded pull requests before regenerating a
new `0.8.22` candidate.

The release gate is risk-based and auditable. Dawn does not require every
scanner row to disappear regardless of reachability, but it does require every
finding to have a deterministic disposition. No accepted critical or high risk
may remain in a shipped surface. Compatible security patches must land, and an
upstream-only exception must name an owner, evidence, expiry, and removal
condition.

This design does not create a new workspace package. It builds on the existing
release-integrity controller under `scripts/release/` and the previously
approved
[Release Integrity Controller Design](./2026-08-09-release-integrity-controller-design.md).

## Incident state and containment

Version Packages pull request
[#433](https://github.com/cacheplane/dawnai/pull/433) was merged as
`3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb` while its required `validate`
check was absent. The generated pull request had been updated by
`github-actions[bot]`; GitHub marked its workflow runs `action_required` with
zero jobs. Branch protection normally blocked the pull request, but it did not
enforce protection for administrators, so the merge bypassed the missing check.

That merge advanced every fixed-group package manifest and the Helm chart
application versions to `0.8.22`, generated changelog entries, and removed the
consumed changesets. It did not publish npm packages by itself.

The following release runs were cancelled before their publish step:

- `31356780088`, started by the Version Packages merge;
- `31356940801`, started by pull request #438;
- `31357014583`, started by pull request #439.

The Release workflow, workflow id `260503756`, is now `disabled_manually`.
Registry and GitHub checks after cancellation proved:

- sampled fixed-group packages still have npm `latest=0.8.21`;
- exact `0.8.22` is absent for SDK, core, CLI, sandbox, and Inspector;
- no `0.8.22` Git tag or GitHub Release exists;
- no release attestation or asset was created.

Publication remains disabled until the resume criteria in this document are
satisfied. Cancelled release runs must not be rerun.

## Goals

- Restore repository version state to the last version actually published.
- Preserve `0.8.22` as the eventual remediated release instead of creating a
  changelog section for a version that never existed publicly.
- Clear every compatible dependency advisory with the smallest safe parent or
  lockfile movement.
- Fix genuine code risks and harden scanner false-positive sinks where the
  hardening is small and independently testable.
- Record explicit, expiring dispositions for findings that cannot be fixed
  compatibly or do not reach a shipped surface.
- Complete the release-integrity ownership cutover before publication resumes.
- Make publication require an exact candidate, an exact green CI run, an
  explicit protected approval, and correlated post-publication evidence.
- Keep dependency, code, release-control, and generated-version changes
  reviewable as separate concerns.

## Non-goals

- Publishing the current merged `0.8.22` repository state.
- Skipping to `0.8.23` merely to avoid reverting generated version files.
- Forcing an incompatible transitive major solely to make an alert counter zero.
- Dismissing an alert without evidence, ownership, an expiry, and a removal
  condition.
- Treating Scorecard policy findings as equivalent to demonstrated remote
  vulnerabilities.
- Adding a new Dawn workspace package for security or release orchestration.
- Solving every medium and low supply-chain hygiene finding before the next
  release when it is outside the release gate defined below.

## Release gate

A release candidate may be generated only when all of the following are true:

1. No credible critical or high risk remains in published packages, generated
   production artifacts, or supported runtime paths.
2. Every GitHub Dependabot, CodeQL, Scorecard, and secret-scanning finding has a
   disposition of `FIXED`, `MITIGATED`, `UNREACHABLE`, `UPSTREAM_BLOCKED`, or
   `POLICY_FOLLOWUP`.
3. Every compatible security patch is present in the lockfile and accepted by
   its parent ranges.
4. `UNREACHABLE` and `UPSTREAM_BLOCKED` findings include evidence, an owner, an
   expiry date, and the dependency or code change that will cause re-evaluation.
5. Secret scanning has no open finding.
6. Full CI, CodeQL, and the required gated runtime lanes pass on the final main
   commit.
7. The release-integrity cutover prevents a generated Version Packages pull
   request from publishing, bypassing CI, or silently using the default
   `GITHUB_TOKEN` when the intended credential is unavailable.
8. Release preflight proves exact set equality between live open security alerts
   and the repository's unexpired exception manifest. A missing, extra,
   duplicate, expired, reopened, or identity-drifted alert blocks the candidate.

Scanner severity is an input to prioritization, not a substitute for technical
reachability. A reported critical false positive is not accepted as critical
risk, but it still requires either a narrow hardening change that removes the
ambiguous dataflow or an evidence-backed, time-bounded disposition.

## Workstream topology

The work is split at boundaries where failure and verification evidence differ.
The order is mandatory.

### Pull request 0: recover version state

Create a clean branch from the then-current `main` and revert only
`3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb`. It is a single-parent squash
commit, so the revert leaves later pull requests #438 and #439 intact while
restoring:

- fixed-group package versions to `0.8.21`;
- chart application versions to `0.8.21`;
- the consumed changeset files;
- pre-generation changelogs.

The pull request contains no security edits and no release-workflow edits. The
Release workflow stays disabled out of band before, during, and after the merge.

Acceptance evidence:

- the revert diff is the exact inverse of #433 after accounting for later files;
- the release inventory is the exact 21-package set at uniform `0.8.21`;
- every restored changeset parses and targets the intended package set;
- npm and GitHub still have no `0.8.22` state;
- full CI passes before merge and on the resulting main commit.

### Pull request 1: compatible dependency remediation

Apply compatible patch updates in one dependency-focused pull request, grouped
by verification surface rather than by alert number.

#### Published and example runtime paths

- Hono `4.12.28` to at least `4.12.34`.
- `ip-address` `10.2.0` to at least `10.3.1`.
- `js-yaml` 4.x to at least `4.3.1` and 3.x to at least `3.15.1`.
- Mermaid `11.16.0` to at least `11.16.1`.
- DOMPurify `3.4.11` to at least `3.4.13`.

Hono is present in CLI target validation and example dependency trees. The
affected helper surfaces are not currently imported, but all parent ranges admit
the patched version. `ip-address` and js-yaml reach the published sandbox through
the Kubernetes client; their inputs are operator-controlled configuration rather
than a Dawn SSRF allowlist, but compatible patches exist. Mermaid and DOMPurify
are reachable in the private chat and research example UIs through agent-authored
Markdown and therefore receive browser rendering coverage.

#### Build and test paths

- Remove or raise the PostCSS override from `8.5.10` to at least `8.5.23`.
- `fast-uri` `3.1.3` to at least `3.1.5`.
- `brace-expansion` `2.1.1` to at least `2.1.4`.
- Any coupled patched nanoid or body-parser resolution reported by the final
  production and full audits.

The PostCSS override currently downgrades Next `16.3.0` from its safe declared
dependency and must not remain. The other packages are reachable only through
Verdaccio, AJV, Testcontainers, or repository-controlled build inputs, but their
parent ranges admit safe versions.

Prefer lockfile refreshes within existing semver ranges. Add a persistent
override only when the normal resolver cannot select the safe version or when an
existing vulnerable override must be replaced. Every override records why it is
needed and the condition for removal.

#### Compatibility exceptions

`@hono/node-server@1.19.14` is installed through CopilotKit even though Dawn's
own CLI already uses a safe 2.x release. The vulnerable Windows `serveStatic`
path is not used by the Next-based examples. Pull request 1 owns a focused
compatibility branch with two explicit outcomes:

- If a `2.0.5` or newer override passes installation, Next/Copilot routes, Hono
  adapter coverage, Windows-path regression coverage, and application smokes,
  the override lands in pull request 1 and the alert must close.
- If the override violates CopilotKit's declared contract or fails those tests,
  it does not land. The pull request records the failure evidence and upstream
  issue. Pull request 3 then carries an owned, expiring `UPSTREAM_BLOCKED`
  exception whose recheck trigger is a CopilotKit range update.

There is no third outcome and the alert cannot be silently deferred.

`@ai-sdk/provider-utils@3.0.28` has no patched compatible 3.x release and is
reachable only through an unused Google Vertex branch in CopilotKit. Do not
override it to the incompatible 4.x line. Record an `UPSTREAM_BLOCKED`
disposition tied to the CopilotKit or Google Vertex upgrade, with an owner and an
expiry.

Acceptance evidence includes full and production audits, both example web
builds, hostile Mermaid rendering, CLI Hono-target tests, sandbox unit and
Kubernetes/SOCKS lanes, Inspector/docs builds, Verdaccio fault tests, and the
Testcontainers-backed storage lanes.

### Pull request 2: code-risk and scanner hardening

Use test-driven fixes for the four Dawn-owned CodeQL groups.

#### Bounded regular-expression evaluation

`@dawn-ai/evals`' `regex()` scorer and `@dawn-ai/testing`'s matching helpers
execute a developer-supplied JavaScript regular expression against model-derived
text on the main thread. A nested quantified pattern demonstrably grows
exponentially.

Preserve the synchronous API. At matcher/scorer construction or invocation,
reject structurally unsafe patterns and cap the inspected input length. Apply the
same policy and error contract to evals and testing without creating a new
workspace package. Regression tests must prove a known catastrophic pattern is
rejected before execution, oversized text is bounded, ordinary flags and
matching semantics remain intact, and stateful `g`/`y` expressions behave
deterministically across repeated calls.

The implementation plan must evaluate a small maintained regex-safety dependency
against a local validator. It may add a normal package dependency, but must not
invent a new Dawn package or claim static validation proves all JavaScript regexes
safe.

#### Fault-proxy request construction

CodeQL alert #49 reports request forgery in release fault-test support. Direct
probes show that the proxy binds to loopback, validates an exact loopback
upstream, rejects alternate origins, and did not forward absolute-form or
scheme-relative hostile requests. The finding is not remotely reachable
production SSRF.

Even so, remove the ambiguous dataflow: construct outbound requests from the
validated upstream object, forward only normalized pathname and query data, and
do not forward the inbound `Host` header. Tests cover absolute-form URLs,
scheme-relative URLs, alternate loopback ports, metadata IPs, redirects, invalid
upstreams, and ordinary query forwarding.

#### Blog route identity

CodeQL alerts #27 and #28 trace repository-controlled blog metadata into Next
links. React escapes attributes and the `/blog/` prefix prevents a script scheme,
so there is no external stored-XSS write path. Add a canonical lowercase slug
grammar at content ingestion and encode the single route segment at both link
sinks. Test protocol-like strings, network-path references, quotes, backslashes,
dot segments, control characters, and valid round trips.

#### Test sentinel cleanup

Remove the test-only identity replacement reported by alert #26 and assert that
the sentinel exists before the real replacement occurs. This is correctness
hygiene, not a release blocker.

Acceptance evidence includes focused adversarial tests, full CodeQL analysis,
the release fault harness repeated under Node 24, both docs/blog builds, the eval
and testing suites, and the full Definition of Done.

Consumer-visible dependency or behavior changes in pull requests 1 and 2 carry
patch changesets for the affected published packages. Lockfile-only movements in
private build/test paths do not manufacture package changesets.

### Pull request 3: release ownership and publication gate

Complete the ownership switch described in the Release Integrity Controller
Design before re-enabling publication.

- Version Packages maintenance and npm publication are separate workflows.
- The version workflow has no npm OIDC or attestation authority.
- Generated Version Packages pull requests are always draft until explicitly
  promoted.
- Checkout does not persist the default `GITHUB_TOKEN` for version-branch pushes.
- Version-branch authentication uses a least-privileged GitHub App or PAT and
  fails closed when it is unavailable; there is no fallback that produces an
  approval-gated bot push.
- Publication is protected by a GitHub Environment with required review.
- Publication consumes an exact version, commit, manifest, and green CI identity.
- Validation executes without write or OIDC permissions; privileged jobs receive
  only the permissions needed for their single transition.
- Admin bypass is removed with an enforcing ruleset or an equivalent no-bypass
  publication control.
- Release workflow ownership remains at `.github/workflows/release.yml` so npm
  trusted-publisher identities do not drift silently.

Pull request 3 also owns the machine-readable security gate:

- `scripts/release/security-exceptions.json` contains only live exceptions, not
  historical fixed findings.
- `scripts/release/security-exceptions.schema.json` defines the exact format.
- Release preflight reads live Dependabot, code-scanning, and secret-scanning
  state through bounded, read-only GitHub adapters and requires exact set
  equality with the manifest.
- Those adapters authenticate with a dedicated GitHub App installation token
  whose repository permissions are limited to reading Dependabot alerts, code
  scanning alerts, and secret scanning alerts. The default `GITHUB_TOKEN` is not
  treated as sufficient, and the alert-reader token has no contents, Actions,
  pull-request, package, or administration write permission.
- Network, authentication, pagination, parse, schema, or permission failure is
  `UNPROVABLE` and blocks candidate generation.

Each exception contains exactly these planning-level fields:

```text
source: dependabot | code-scanning
alertNumber: positive integer
stableId: GHSA id or scanner rule id
reportedSeverity: critical | high | medium | low
calibratedRisk: medium | low
disposition: UNREACHABLE | UPSTREAM_BLOCKED | POLICY_FOLLOWUP
identity:
  dependabot: exact ecosystem + package + manifest path
  code-scanning-located: exact tool + rule + repository path
  code-scanning-locationless: exact tool + rule + explicit NONE location
aggregateAdvisories: sorted unique GHSA ids, required only for aggregate rules
aggregateSha256: SHA-256 of canonical aggregateAdvisories JSON
scope: bounded package path or code surface
owner: repository identity
expiresOn: YYYY-MM-DD
recheckTrigger: non-empty dependency, path, or policy condition
evidence: repository-relative audit section or test reference
```

Secret-scanning findings cannot be excepted. `FIXED` and `MITIGATED` findings
must disappear from the live open set and therefore do not appear in this file.
Locationless Scorecard alerts use the explicit locationless identity; a missing
path is never normalized to an empty located path. For an aggregate rule such as
Scorecard's vulnerability summary, the adapter extracts only syntactically valid
GHSA ids, rejects an empty/malformed/duplicate set, sorts the unique ids, and
compares both the explicit set and its canonical JSON SHA-256. A new, removed, or
changed advisory therefore changes the identity even when the outer alert number
and rule stay constant.

An exception is invalid when its live source, number, stable id, severity,
package/location identity, aggregate advisory set or digest, or open state
differs; when it is duplicated; when its calibrated risk is high; when its
owner/evidence/trigger is missing; or when `expiresOn` is not later than the
injected evaluation date. Tests cover every missing/extra/duplicate/expired and
metadata-drift boundary, located and locationless alerts, aggregate set
addition/removal/reordering/malformed ids, deterministic ordering, hostile
accessor/JSON shapes, pagination, and fail-closed adapter errors.

The reader returns a canonical, redacted security observation containing the
candidate SHA, observation time, workflow run id and attempt, exact live alert
identities, exception-manifest digest, and verdict. Raw alert descriptions,
tokens, request headers, and API error payloads are never logged or placed in a
release artifact. A missing or under-permissioned GitHub App credential fails
closed.

The version workflow is inert when pull request 3 merges. Its job requires the
repository variable `DAWN_VERSIONING_ENABLED` to equal `true`; a missing value is
false. The variable remains absent through post-merge settings verification and
final main verification. The first version candidate is then created by a manual
dispatch that requires `expectedMainSha` and fails unless it equals the frozen
main head. Normal push maintenance is enabled only after that first controlled
dispatch proves the credential and draft-PR path.

The Release workflow remains disabled until this pull request is merged, its
repository settings are independently verified, the generated Version Packages
pull request is merged, and exact candidate-commit CI and preflight are green.

### Follow-up security hygiene

The following findings are important but do not block the remediated release
once the release gate is satisfied:

- deterministic generated Docker installs with no unlocked npm fallback;
- manifest-list digest pinning for generated Node images and the aimock image;
- job-scoped chart publishing permissions;
- a lockfile-backed aimock image install;
- recognized property-based tests for security-sensitive normalization paths;
- Scorecard timing artifacts and policy-only rows after their underlying runs
  settle.

These may be one bounded supply-chain pull request or separate follow-ups when
their verification surfaces differ materially.

## Data and evidence flow

Security triage produces a versioned human audit keyed by stable alert id and
advisory id. Pull request 3 distills only the still-open approved exceptions into
`scripts/release/security-exceptions.json`. Each audit row records:

```text
source
alert/advisory id
reported severity
affected package or code sink
dependency/root path
reachability classification
chosen disposition
fix or mitigation commit
verification evidence
owner
expiry/recheck trigger
```

The live GitHub alert set and exception manifest are joint inputs to release
preflight, not an automated permission to dismiss GitHub alerts. GitHub remains
the live source; the checked-in manifest explains only current exceptions. Exact
set equality prevents a stale manifest from hiding a new or reopened alert and
prevents a closed finding from lingering indefinitely as accepted debt.

The release sequence is:

```text
release disabled
  -> exact version-state recovery
  -> dependency remediation
  -> code/scanner hardening
  -> release ownership cutover (versioning still inert; publishing disabled)
  -> verify repository settings
  -> final main freeze and full verification
  -> enable versioning variable and manually create draft Version Packages PR
  -> exact PR-head CI and read-only generated-diff review
  -> merge Version Packages PR while publishing remains disabled
  -> exact candidate-main-SHA CI, CodeQL, preflight, and shadow
  -> enable Release workflow and manually dispatch exact version + candidate SHA
  -> protected publication approval
  -> fresh exact-set security check with read-only alert credential
  -> publish exact artifacts from the candidate SHA
  -> independent registry/provenance/release verification
  -> post-publication smoke tests
  -> unfreeze main
```

## Failure handling

- A failed recovery diff stops all later work; do not compensate with manual
  manifest or changelog edits.
- A dependency that requires an incompatible major leaves its own focused work
  item; it is never smuggled into a lockfile refresh.
- An audit network or parse error is `UNPROVABLE`, not a clean result.
- A scanner false positive without retained evidence remains unresolved.
- Any main push while publication is paused must leave the workflow disabled.
- Any attempt to re-enable Release before the ownership gate is verified is an
  operational blocker.
- If registry state ever shows any exact `0.8.22` package before the approved
  candidate, stop recovery and invoke the release controller's partial-publication
  reconciliation. Never overwrite or unpublish.
- After approved publication begins, a partial failure is observed and resumed
  from exact public state; the workflow is not blindly rerun.

## Final verification and resumption

Before generating the candidate:

1. Pin the final main SHA and freeze unrelated merges.
2. Run the repository Definition of Done under Node 24.
3. Run all affected Docker, Kubernetes, Postgres, pgvector, edge, browser, and
   release fault lanes.
4. Confirm Dependabot and CodeQL have reconciled fixed alerts.
5. Review every remaining exception against its evidence and expiry.
6. Confirm secret scanning is empty.
7. Confirm Release remains disabled and no queued or in-progress release run
   exists.
8. Confirm `DAWN_VERSIONING_ENABLED` is absent or false and the version workflow
   made no branch update when pull request 3 merged.

For the regenerated Version Packages pull request:

1. Require draft state and an exact base SHA equal to the verified main SHA.
2. Require a generated-only diff, uniform `0.8.22` manifests, exact changeset
   consumption, and correct chart application versions.
3. Require every CI job and CodeQL to pass on the exact head SHA.
4. Run read-only release preflight and shadow reconciliation against the exact
   proposed version and generated source identity; this is not yet the final
   candidate commit.
5. Merge the Version Packages pull request while the Release workflow remains
   disabled, record the resulting full main SHA, and keep main frozen.
6. Require the complete push CI matrix and CodeQL to pass on that exact resulting
   main SHA. PR-head CI alone is insufficient because merge strategy produces a
   different candidate commit.
7. Run release preflight and shadow reconciliation again against exact
   `{version, candidateMainSha}` and the live security-alert set.

Only after those checks pass may an operator enable `.github/workflows/release.yml`
and manually dispatch it with exact `version=0.8.22` and the full candidate main
SHA. The job re-observes the candidate and waits at the protected publication
environment; enabling the workflow is not itself publication approval.

The protected publish job does not reuse the earlier preflight result. After
approval and after validating its immutable artifact escrow, its final
non-mutating step obtains a fresh read-only GitHub App token, re-reads all three
live alert sources, and repeats exact-set validation against the exception file
from the candidate SHA. The controller refuses its first npm mutation when that
observation is older than five minutes, identifies another SHA/run, or is
anything other than `PASS`. No build, test, network retry loop, or other
unbounded work may occur between this check and the first registry mutation.
Once the first package is published, the release controller's partial-publication
reconciliation rules take precedence; a later failure never causes unpublish or
replacement.

Publication resumes only after the protected environment approval. Completion
requires exact `0.8.22` registry presence for the full inventory, aligned
`latest` tags, tarball digests, dependency specs, npm signatures and provenance,
the expected Git tag and GitHub Release assets, GitHub attestations, inline
TypeScript-tooling and Docker-sandbox smokes, and independent Published Artifact
Verification. The independent verification enables all applicable public,
TypeScript, Docker, memory, and pgvector lanes.

Main is unfrozen only after all evidence correlates to the same version and
commit.

## Alternatives rejected

### Skip to `0.8.23`

Keeping the generated `0.8.22` files and adding security changesets would produce
`0.8.23`. That avoids revert churn but leaves a changelog and repository version
for an artifact that never existed publicly. The exact inverse revert is
available and later commits do not depend on the generated version state, so the
historical ambiguity is unnecessary.

### Publish the current `0.8.22`

The merged Version Packages commit bypassed its required validation run, and
main moved after the candidate was generated. Publishing it would undermine the
exact-identity policy the release controller was built to enforce.

### One consolidated security pull request

Combining version recovery, dependency resolution, runtime code changes, and
privileged workflow ownership would make failures hard to localize and review.
The proposed pull requests consolidate related fixes while preserving distinct
verification and rollback boundaries.

## Definition of done

This workstream is complete when:

- repository and public version history agree;
- compatible dependency advisories are fixed;
- remaining exceptions are explicit, expiring, and owned;
- Dawn-owned code findings are fixed or hardened with adversarial tests;
- the release workflow cannot publish through a generated-PR CI bypass;
- a newly generated `0.8.22` candidate passes exact-head verification;
- the full fixed-group release publishes from immutable artifacts;
- inline and independent post-publication verification pass;
- Release is re-enabled only under the protected, least-privilege ownership
  model.
