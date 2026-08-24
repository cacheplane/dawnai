# Security Dependency Remediation PR1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Use
> superpowers:test-driven-development for every behavior change and
> superpowers:verification-before-completion before each commit or success
> claim.

**Goal:** Remove every dependency vulnerability that can be fixed through a
compatible owner or lock resolution, prove the patched Hono-family behavior on
Dawn-owned paths, and leave only explicitly evidenced upstream boundaries while
publication stays disabled.

**Architecture:** Upgrade the real direct owners first, then let their declared
compatible ranges select patched transitives. Remove the obsolete global
PostCSS policy, update the unavoidable scoped js-yaml policy, and do not add
CopilotKit, Hono, node-server, UUID, provider-utils, AG-UI, or Vercel overrides.
Anchor security tests to Dawn-owned example, sandbox, and tooling
boundaries instead of freezing upstream package internals. Exercise Mermaid in
an isolated DOM/worker boundary, exercise the Kubernetes SOCKS path, and run the
Windows-only encoded-backslash Hono regression in the existing Windows CI job.
Retain the required Vercel CLI and native deployment lane. Pull request 3, not
this pull request, owns the machine-readable live-alert exception gate.

**Tech Stack:** Node.js 24.19.0, pnpm 10.33.0, Vitest 4, jsdom, Playwright
1.62.1, esbuild 0.28.1, Chromium, Next 16.3, Hono 4.13.3,
`@hono/node-server` 1.19.17/2.1.1, CopilotKit 1.68.3, AG-UI 0.0.57, MCP SDK,
Kubernetes client, required Vercel CLI 58.9.0, GitHub Actions, Dependabot, and
`pnpm audit`.

**Historical evidence baseline:**
`docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json` is an
immutable capture from before the CopilotKit prerequisite. Its source/default
SHAs and finding counts are historical evidence, not current-head assertions.

**Current implementation base:** The branch is rebased onto reviewed main
commit `d2404dc7b138db151ae58f0b36788dfa08e2008e`. The final graph/audit evidence
and reviewed-base receipt were recaptured from clean source snapshot
`e2f894a2db7eccfc92e82d1f7712f8a719907c81` against that exact base.

**Reviewed current-base Dependabot set:** A complete bounded read of
default/main at `d2404dc7b138db151ae58f0b36788dfa08e2008e` from source snapshot
`e2f894a2db7eccfc92e82d1f7712f8a719907c81` observed these exact 59 open alerts
and candidate post-remediation partition:

```text
observed open (59):
122,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,
193,194,195,196,197,198,199,200,201,204,205,206,207,208,209,210,211,
212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,
229,230,231,232,233,234,235,236

candidate fixed after remediation (26):
124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,
194,195,196,197,198,199,200,201,236

candidate retained open boundaries (33):
122,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,
220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235
```

Alert `#236` is the current `@hono/node-server` /
`GHSA-frvp-7c67-39w9` finding and must close on patched `1.19.17`. Alert `#123`
is absent from every GitHub API state (an exact-number read returns 404) and may
appear only in explicitly labeled historical evidence. Alerts `#204`–`#235`
are 32 Vercel-derived findings across path-to-regexp, undici, tar, ajv,
minimatch, smol-toml, and once; the required Vercel CLI/native deployment lane
remains. No alert is suppressed or dismissed. This partition is a reviewed
pre-merge set. Alert `#232` (`tar` / `GHSA-r292-9mhp-454m`) is the only
identity-field change from the previous 59-record capture: its current severity
is `high`, not `medium`. Recapture after every later rebase, then update the
identity fixture, reviewed-base receipt, and explicit reconciliation
disposition if any identity changes.

**Reviewed terminal audit set:** The production audit contains exactly one
upstream-blocked provider-utils record. The full audit contains that record plus
45 exact findings owned by the required Vercel development/native-deployment
boundary: 46 records total. Neither mode has muted records. The terminal
Dependabot sets remain subject to post-merge reconciliation and contain no
suppressions or dismissals. The schema-v2 receipt was captured at
`2026-08-24T19:34:19Z` from source
`e2f894a2db7eccfc92e82d1f7712f8a719907c81`, binds lockfile SHA-256
`f7c08a30d9649a6f795a0b7d33656ecf37e4be92b92717dd666832cc780b8d18`, and
has canonical SHA-256
`3c653e9dc94580768a805170ab606594560206b9a74b7c60d74c698301d18d91`.

---

### Task 0: Complete the CopilotKit V2 prerequisite before recapturing security evidence

**Status:** Implementation, clean prerequisite verification, and preserved-WIP
restoration/reconciliation are complete in the dedicated prerequisite commits.

**Files:**
- Read: `docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md`
- Read: `docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md`

- [x] **Step 1: Upgrade the real CopilotKit owners without compatibility overrides**

Both private examples select `@copilotkit/react-core` and
`@copilotkit/runtime` `^1.68.3`; `packages/ag-ui` selects React Core `^1.68.3`
for development while preserving its optional peer `>=1.66.0`. Direct,
type-facing `@ag-ui/client` remains exactly `0.0.57`.

- [x] **Step 2: Migrate the runtime and providers to V2 multi-route transport**

Both examples use `@copilotkit/runtime/v2`, required `[...path]` route modules,
`createCopilotRuntimeHandler`, `basePath: "/api/copilotkit"`, shared `GET`/`POST`,
and explicit `useSingleEndpoint={false}`. Deterministic loopback tests prove the
exact encoded Dawn AG-UI targets; real-page browser tests prove same-origin
`/info` discovery. Both checks are credential-free and model-free. Live
end-to-end model behavior remains a separate manual smoke that requires provider
credentials.

- [x] **Step 3: Establish the compatible graph and CI boundary**

The prerequisite removes the obsolete UUID override and rejects the planned
node-server override. The selected graph contains Hono `4.13.3`, node-server
`1.19.17` and `2.1.1`, and UUID `11.1.1`/`14.0.1`, all at their patched floors.
Both Next configs set `agentRules: false` so Next 16.3 does not generate
contributor-rule files during `next dev`. An additive browser CI job and both
workflow-audit fixtures are committed without changing the required Vercel CLI
or native deployment lane.

The rest of this plan operates on that architecture. Any pre-prerequisite
command/output below is retained only where it documents the immutable RED or
baseline evidence; it is not an instruction to restore CopilotKit 1.66, the
legacy endpoint, or a forced node-server major.

### Task 1: Pin containment and capture the fail-closed baseline

**Files:**
- Read: `docs/superpowers/specs/2026-08-09-security-backlog-release-recovery-design.md`
- Read: `.github/workflows/release.yml`
- Read: `.github/workflows/publish-chart.yml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `scripts/security/dependency-evidence.mjs`
- Create: `scripts/security/dependency-audit-evidence.mjs`
- Create: `scripts/security/evidence-file-io.mjs`
- Create: `scripts/security/github-evidence.mjs`
- Create: `scripts/security/publication-containment.mjs`
- Create: `scripts/security/dependabot-reconcile.mjs`
- Create: `scripts/security/reconciliation-receipt.mjs`
- Create: `scripts/security/reconciliation-seal.mjs`
- Create: `test/security-dependencies/dependency-evidence.test.ts`
- Create: `test/security-dependencies/github-evidence.test.ts`
- Create: `test/security-dependencies/publication-containment.test.ts`
- Create: `test/security-dependencies/dependabot-reconcile.test.ts`
- Create: `test/security-dependencies/fixtures/audit-baseline.json`
- Create: `test/security-dependencies/fixtures/audit-upstream-boundaries.json`
- Create: `test/security-dependencies/fixtures/dependabot-baseline.json`
- Create: `test/security-dependencies/vitest.config.ts`
- Create: `test/security-dependencies/tsconfig.json`
- Create: `docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json`
- Modify: `vitest.workspace.ts`

- [x] **Step 1: Preserve the completed historical branch/base precondition**

This verification completed before the CopilotKit prerequisite rebase. The
block below is immutable baseline evidence for the original security branch
state; it must not be rerun as an assertion about the current head or current
`origin/main`.

The completed historical verification used a fresh shell with Node 24
explicitly selected:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
git fetch origin main
test "$(git branch --show-current)" = "blove/security-dependency-remediation"
test "$(git rev-parse origin/main)" = "8398c908844cf961f1d64e575c8b9a0000923f41"
test "$(git merge-base origin/main HEAD)" = "8398c908844cf961f1d64e575c8b9a0000923f41"
test "$(git diff --name-only origin/main...HEAD)" = \
  "docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md"
test -z "$(git status --short)"
```

At the historical capture point, every assertion succeeded and the approved
plan was the only branch change above the pinned base. The preserved
`8398c908844cf961f1d64e575c8b9a0000923f41` SHA identifies that evidence; it is
not the current rebase target. Current-head and current-base assertions belong
to the later rebase/reconciliation steps, not this completed precondition.

- [ ] **Step 2: Prove the operational hold before adding the reviewed reader**

Use exact workflow IDs and paths. The initial precondition queries every
documented non-completed Actions status independently with `per_page=1`; a
result is accepted only when `total_count` is numeric zero and `workflow_runs`
is exactly empty. This avoids an unbounded pre-reader pagination path:

```bash
set -euo pipefail
release_workflow="$(gh api repos/cacheplane/dawnai/actions/workflows/260503756)"
chart_workflow="$(gh api repos/cacheplane/dawnai/actions/workflows/309127405)"
jq -e '.id == 260503756 and .path == ".github/workflows/release.yml" and .state == "disabled_manually"' \
  <<<"$release_workflow" >/dev/null
jq -e '.id == 309127405 and .path == ".github/workflows/publish-chart.yml" and .state == "disabled_manually"' \
  <<<"$chart_workflow" >/dev/null
for workflow_id in 260503756 309127405; do
  for run_status in queued in_progress waiting requested pending; do
    response="$(gh api "repos/cacheplane/dawnai/actions/workflows/$workflow_id/runs?status=$run_status&per_page=1")"
    jq -e '.total_count == 0 and .workflow_runs == []' <<<"$response" >/dev/null
  done
done
```

Expected: the path-resolved workflow objects match the hard-coded IDs, both are
`disabled_manually`, and every non-completed status is empty. Any API, parse, or
state ambiguity blocks the task. This is only the bootstrap guard; Step 4 adds
the complete bounded workflow/public-registry containment proof.

- [ ] **Step 3: Build the bounded evidence reader with TDD**

First add the dedicated repository-root Vitest config described in Task 2 Step
1 and register it in `vitest.workspace.ts`; the missing evidence module is the
first RED. Because this repository-root TypeScript project cannot inherit a
workspace package's private type installation, add the existing workspace-wide
exact `@types/node` version `26.1.2` as a private root dev dependency and update
only the root importer in the lockfile; the isolated `tsc --noEmit` command must
resolve it without a package-relative `typeRoots` workaround. Add focused tests before implementation. Keep the CLI, GitHub
transport, publication correlation, and alert reconciliation in the four
public facades listed above; extract audit, exact-file I/O, receipt-schema, and
seal/writer responsibilities into the dedicated helper modules rather than
leaving thousand-line mixed-responsibility files. The CLI exposes four read-only operations:

- `audit`: executes exact argv for full and production `pnpm audit --json`, with
  one shared wall-clock deadline, stdout/stderr byte caps, no shell, explicit
  exit-code handling, process termination on timeout/overflow, and secret-safe
  errors. It accepts exit `1` only for a parsed audit result with an advisories
  object, no error envelope, record identities present, severity totals equal to
  the record count, and the exact expected
  package/version/GHSA/reported-severity multiset from a contained regular-file
  fixture supplied with `--expected`. The fixture has separate `full` and
  `production` records and requires an explicit empty `muted` array in each
  mode. Exit `0` is accepted only when both expected sets are empty; every other
  status is an error. A missing `muted` field, any non-empty `muted` record, or
  severity moved between otherwise identical records fails closed. Before the
  first audit and after the second, the operation reads the exact checkout
  `HEAD`, proves `pnpm-lock.yaml` is unchanged from that commit, and hashes a
  bounded no-follow read of the lockfile. The canonical schema-v2 receipt binds
  `capturedAt`, `sourceSha`, and `lockfileSha256`; any unprovable source or
  source/lock drift fails before a receipt is written.
- `baseline`: reads the complete live Dependabot open set and publication
  containment state. Dependabot follows only the API's opaque cursor from a
  validated, same-origin, repository-scoped `Link: ...; rel="next"`; the
  unsupported `page=N` parameter is never sent. Missing, duplicate, mixed,
  foreign, credentialed, cyclic, malformed, or more-than-ten-page next links
  fail closed. The terminal page is proved only by absence of `rel="next"`, not
  by a short page. Exact alert identities bind number/state/ecosystem/package/
  manifest/scope/GHSA/reported severity/dismissal/timestamps to
  `--expected-identities` and `--expected-open`. The identity fixture's
  `defaultSha` is provenance for the reviewed base, not a decorative field:
  baseline collection requires it to equal `--expected-default-sha`.
- `reconcile`: validates the exact merged PR/head/base/merge identity, derives
  `merged_at`, and polls the expected fixed/open alert sets under one validated
  wall-clock deadline, interval, request/byte/record budget, and attempt cap.
  Once the target state appears, it captures complete cursor-paginated open
  snapshot A, reads every expected-fixed record by exact number, captures open
  snapshot B, and accepts only byte-identical canonical open snapshots with the
  same stable default-branch head before and after. Every fixed record retains
  the baseline package/manifest/scope/GHSA/reported-severity identity, has a
  null dismissal, and has `fixed_at >= merged_at`. It independently validates
  that the identity fixture's `defaultSha` equals the exact reviewed base SHA,
  requires the supplied audit receipt's source SHA and lockfile digest to equal
  the exact observation checkout, embeds its complete normalized
  full/production status, tuple, severity-total, empty-muted, and provenance
  evidence in the canonical reconciliation receipt, and also binds the
  original audit-receipt digest. The audit must complete after the PR merge, no
  later than reconciliation start, and at most five minutes before that start.
  It collects complete publication containment both before and after the alert
  reads and requires the two normalized snapshots to be byte-identical. It
  selects exactly one successful CI, CodeQL, and Scorecard run for each unique
  required head in `[mergeSha, observationHead]`; this is exactly three run
  records when those heads match and six when they differ.
- `seal-receipt`: accepts only a bounded base64 canonical reconciliation
  receipt plus its exact SHA-256 and immutable repository correlation inputs,
  revalidates the complete receipt schema and digest without network access,
  then writes the exact receipt plus a separate canonical uploader manifest
  containing the current workflow run ID/attempt to a contained output
  directory. The pre-dispatch receipt cannot contain its future uploader run
  identity. The operation never logs the receipt payload. The output root is an
  existing canonical non-symlink directory owned by the current effective user
  with exact mode `0700`; its ancestor chain is not group/world writable except
  for a sticky system temporary ancestor. Portable Node lacks `openat`, so a
  concurrent hostile same-UID process is explicitly outside this local
  writer's threat model. The writer nevertheless binds and revalidates root,
  output-directory, and file inode identities; reserves the exact direct-child
  output atomically with exclusive `mkdir`; uses exact `0600` no-follow,
  exclusive files; and proves the final two-name directory set and bytes.

Both `baseline` and `reconcile` call `publication-containment.mjs`. Its GitHub
reads use fixed-argv `gh api --include` one page at a time so credentials remain
inside `gh`; page and cursor next links share the same strict URL validator and
aggregate deadline/byte/page/record budgets. It requires:

- GitHub default branch and local inventory source identities equal the supplied
  full SHAs;
- workflow IDs `260503756` and `309127405` resolve to the exact Release and
  Publish Chart paths, remain `disabled_manually`, and have count-consistent,
  unique, completely paginated run histories with zero non-completed records;
- all 21 exact inventory package-version documents and all 21 exact npm
  attestation endpoints for `0.8.22` return exact, identity-correlated 404
  absence, while each packument is its own package and `latest` is `0.8.21`;
- completely paginated GitHub tag refs, Releases, and Actions artifacts contain
  no exact `0.8.22` release/tag/candidate identity; and
- the complete cancelled Release incident is bound to exact run/head pairs:
  `31356780088` / `3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb`,
  `31356940801` / `b6adaa982b25adf5fac61733a13ac65320c70bcd`, and
  `31357014583` / `cfa55478cf8e35dc8a00ae7041c0c12479fda2d9`.
  The first run's publish/attestation/later steps are skipped, the second has
  zero jobs, and the third has one cancelled zero-step job. Publish Chart run
  `31356780047` is bound to the first version-commit SHA and exactly the two
  expected successful chart jobs. Bounded job-log reads must prove the exact
  redacted internal no-op facts
  (`dawn-app 0.1.0 already published, skipping` and `dawn-sandbox-infra 0.1.2
  already published, skipping`); the chart jobs and steps themselves concluded
  success, so their conclusions are not mislabeled as skipped. Only normalized
  booleans and log digests enter the receipt. Historical workflow activity is
  not misreported as nonexistent.

List endpoints terminate only on a validated missing next link. Object-list
endpoints additionally require stable `total_count`, exact retrieved count, and
unique record IDs. npm reads use the shared bounded HTTP transport with a
per-response cap and an exact 63-request aggregate ceiling: 21 exact-version
documents, 21 packuments, and 21 attestation endpoints, with each endpoint
class independently required to contain the complete 21-package inventory.
Any network, auth, HTTP, parse, pagination, schema, identity, or count ambiguity
is `UNPROVABLE`.

The CLI writes one canonical, redacted JSON receipt to the requested path and
prints only its path/count summary. Tests inject subprocess results and cover
timeout, truncation, nonzero transport, valid finding exit `1`, malformed JSON,
missing/duplicate identities, contradictory totals, page/record limits, partial
pages, cursor addition/removal/reordering/cycles, foreign or credentialed links,
audit and Dependabot per-record severity drift, legacy audit receipts, dirty or
drifting audit source/lock state, audit provenance mismatch, pre-merge/stale/
future audit capture times, workflow ID/path mismatches,
retrieved/total-count disagreement, one-of-21 npm or attestation presence,
candidate tag/Release/artifact presence, historical run/head/job mismatch,
truncated or non-no-op chart logs, default-head drift, terminal open-set drift,
reconciliation success-at-boundary and timeout, and token-like values in errors.
It never prints raw stderr, job logs, or auth headers.

Run RED before adding the module, then GREEN:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts \
  test/security-dependencies/dependency-evidence.test.ts \
  test/security-dependencies/github-evidence.test.ts \
  test/security-dependencies/publication-containment.test.ts \
  test/security-dependencies/dependabot-reconcile.test.ts
```

- [x] **Step 4: Preserve the completed historical security and containment baseline**

This capture completed before the prerequisite rebase. Its old default SHA,
27-alert set, and command are immutable historical evidence only; do not rerun
the block as a current-head assertion. The completed reader used this exact
open-number set:

```text
122 123 124 125 160 162 163 164 170 171 172 176 178 179 180 181
191 192 193 194 195 196 197 198 199 200 201
```

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node scripts/security/dependency-evidence.mjs baseline \
  --repo cacheplane/dawnai \
  --inventory-ref HEAD \
  --source-sha "$(git rev-parse HEAD)" \
  --expected-default-sha 8398c908844cf961f1d64e575c8b9a0000923f41 \
  --current-version 0.8.21 \
  --target-version 0.8.22 \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --expected-open 122,123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201 \
  --output docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json
```

The result contained 27 exact historical alert records plus the complete
containment facts above. In this receipt, alert `#123` is part of the old
snapshot; it is not visible in the current GitHub API. The canonical redacted
receipt remains committed at the August 10 path so its content and digest
survive the implementation machine. Do not rewrite it, infer current state from
it, or infer a clean/smaller alert set or unpublished state from a failed or
partial current query.

- [ ] **Step 5: Capture exact full and production audit baselines**

Run the reviewed reader. The baseline expectation is stored as the exact
package/GHSA multiset asserted in `dependency-evidence.test.ts`, not only broad
severity counts:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node scripts/security/dependency-evidence.mjs audit \
  --expected test/security-dependencies/fixtures/audit-baseline.json \
  --output /tmp/dawn-pr1-audit-before.json
```

The generated audit receipt uses schema v2 and records the exact source SHA,
bounded `pnpm-lock.yaml` SHA-256, and production-audit completion time in
addition to the verified modes below.

Expected baseline: full audit has 30 advisories (13 high, 12 moderate, 5 low,
zero critical) and production audit has 27 advisories (10 high, 12 moderate, 5
low, zero critical). The audit includes the two nanoid advisories and one
body-parser advisory that are not yet open in Dependabot.

The originally drafted provider-utils-only after-state fixture is superseded by
the required Vercel development boundary now present on main. After compatible
remediation is complete, recapture a reviewed fixture whose `production` mode
contains only provider-utils if it remains and whose `full` mode additionally
contains the exact final Vercel-owned findings, if any. Both `muted` arrays
remain explicitly empty. Do not freeze those final records or counts during the
prerequisite.

- [ ] **Step 6: Record the initial dependency graph**

Run `pnpm why -r` and `pnpm list -r --depth 20` for:

```text
hono @hono/node-server ip-address js-yaml mermaid dompurify postcss nanoid
fast-uri brace-expansion body-parser @ai-sdk/provider-utils
```

Expected vulnerable snapshots include Hono 4.12.28, node-server 1.19.14,
ip-address 10.2.0, js-yaml 3.15.0/4.2.0, Mermaid 11.16.0, DOMPurify 3.4.11,
PostCSS 8.5.10, nanoid 3.3.15, fast-uri 3.1.3, brace-expansion 2.1.1, and
body-parser 1.20.5. Preserve the command outputs outside the worktree for the
final evidence report.

### Task 2: Keep lean graph and Dawn-owned runtime regressions

**Files:**
- Modify: `test/security-dependencies/vitest.config.ts`
- Modify: `test/security-dependencies/tsconfig.json`
- Modify: `test/security-dependencies/dependency-resolution.test.ts`
- Create: `test/security-dependencies/copilotkit-v2-runtime.test.ts`
- Delete: `test/security-dependencies/hono-node-server.test.ts`
- Read: `vitest.workspace.ts`

- [x] **Step 1: Confirm the dedicated repo-level Vitest project boundary**

The security-dependencies config has an explicit repository root, bounded
timeouts, no ambient credentials, and a narrow include. Its TypeScript config
uses explicit example React mappings and remains outside every publishable
package `rootDir`.

- [x] **Step 2: Replace the exact graph snapshot with public invariants**

Parse `package.json` and `pnpm-lock.yaml` as fail-closed data. Require direct
CopilotKit `1.68.3` owners, direct AG-UI `0.0.57`, Hono `>=4.12.34`, node-server
1.x `>=1.19.15`, node-server 2.x `>=2.0.10`, UUID `>=11.1.1`, and no override
selector for these public owners. Provider-utils path checks accept an empty
affected set; if an affected 3.x identity remains, every complete importer path
must stay below private CopilotKit Google Vertex. The locator/path parser rejects
malformed, dangling, orphaned, and cyclic graph evidence without freezing
unrelated reverse-edge totals.

- [x] **Step 3: Test Dawn's real V2 server boundary instead of upstream internals**

The model-free loopback test loads both required catch-all route modules,
verifies `GET /api/copilotkit/info`, rejects malformed run input, and sends a
schema-valid run through each real `HttpAgent`. It requires the exact encoded
`/agui/%2Fchat%23agent` and `/agui/%2Fresearch%23agent` targets plus ordered SSE
forwarding and deterministic cleanup.

- [x] **Step 4: Delete the superseded upstream-internal adapter suite**

`hono-node-server.test.ts` is intentionally removed. Do not restore its exact
export-map archaeology, forced-major assumptions, or legacy single-route JSON
response. The lean graph receipt, Dawn CLI Hono roundtrip, Windows disclosure
regression, and V2 loopback cover the boundaries Dawn owns.

After restoring the remaining security WIP, run:

```bash
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts \
  test/security-dependencies/dependency-resolution.test.ts \
  test/security-dependencies/copilotkit-v2-runtime.test.ts
```

### Task 3: Add hostile Mermaid/DOMPurify and SOCKS-path regressions

**Files:**
- Create: `test/security-dependencies/mermaid-rendering.test.ts`
- Create: `test/security-dependencies/mermaid-render-worker.mjs`
- Create: `test/security-dependencies/mermaid-browser-entry.tsx`
- Create: `test/security-dependencies/mermaid-browser.spec.ts`
- Create: `test/security-dependencies/playwright.config.ts`
- Create: `packages/sandbox/test/kube-socks-proxy.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml` only to add private test-tool importers at this stage

- [ ] **Step 1: Add explicit private DOM/browser test dependencies**

Declare exact root dev dependencies `jsdom@30.0.1`,
`@playwright/test@1.62.1`, and `esbuild@0.28.1`. Do not import undeclared
transitive test tools. Keep React and Streamdown anchored to the example apps.
Update only the root importer, then realize it before observing RED:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm add --save-dev --workspace-root --lockfile-only \
  jsdom@30.0.1 @playwright/test@1.62.1 esbuild@0.28.1
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Inspect the intermediate lock diff and reject unrelated resolution changes.
Extend the private root `typecheck` script to run the existing Turbo typecheck
and then `tsc -p test/security-dependencies/tsconfig.json --noEmit`, so the
repository Definition of Done owns these repo-root TypeScript sources.

- [ ] **Step 2: Add isolated hostile Mermaid rendering coverage**

Resolve the exact chain, independently for both examples:

```text
example package.json -> @copilotkit/react-core -> streamdown -> mermaid -> dompurify
```

Validate every parent manifest declaration and lock identity; do not anchor at
`@copilotkit/runtime` or rely on pnpm's shared fallback. Create a worker helper
that imports Mermaid's actual ESM export, installs a fresh jsdom realm, preserves
and restores all global property descriptors (including Node 24's getter-only
`navigator`), supplies the required CSS/DOM/SVG globals plus deterministic
`getBBox()`/`getComputedTextLength()` controls, renders a benign diagram first,
then runs exactly one hostile case. It returns only bounded JSON and always
terminates the worker/realm.

The per-worker order is load-bearing: create jsdom, snapshot/install
globals/descriptors/polyfills, **then** dynamically import the resolved Mermaid
ESM entry, then benign-render, then run one hostile case, then restore/terminate.
Never top-level-import Mermaid before `window` exists; DOMPurify binds its
default instance during module evaluation and an early import would create a
false unsupported/failing renderer.

Cover all five Mermaid 11.16.1 advisories with the upstream hostile inputs:

- invalid XY axis `x-axis 1 --> 1` completes within a strict deadline;
- `architecture-beta` cannot write
  `mermaidPrototypePollutionMarker` to `Object.prototype`;
- frontmatter `themeCSS` containing `& + *` cannot escape the SVG namespace;
- untrusted config cannot prototype-pollute Mermaid's internal/global objects;
- radar `ticks 1000000000` completes or rejects within a strict deadline.

Run all five hostile cases in separate worker processes with memory limits and
an external deadline, including both prototype-pollution cases. Terminate and
fail a non-settling worker; never execute a hostile input or import Mermaid in
Vitest's main realm. Assert the worker's prototype is clean before and after the
case. Verify no worker, timer, or DOM realm survives cleanup.

Also assert the Mermaid-resolved DOMPurify is 3.4.13 and that hostile
HTML/SVG/event-handler/URL input rendered with the actual strict integration
settings contains no executable element, event attribute, `javascript:` URL,
or escaping CSS. The patched CSS may contain the safely nested selector
`#diagram #diagram+*`; reject the vulnerable top-level `#diagram+*` selector
rather than every sibling combinator. Do not claim the two DOMPurify advisories
are default Streamdown exploits; the version receipt is the remediation proof
and the rendering case is the integration control.

- [ ] **Step 3: Add real Chromium coverage for the actual example UI path**

Set `playwright.config.ts` to an exact `testDir` containing this browser test
and `testMatch: "mermaid-browser.spec.ts"`; it must not discover the adjacent
Vitest `*.test.ts` files. Add a focused config regression that imports the
configuration and asserts that exact discovery boundary.

Use esbuild with an in-memory entry whose `resolveDir` is
`examples/chat/web` and a fresh temporary `outdir`. Bundle the exported
`CopilotChatAssistantMessage.MarkdownRenderer` from
`@copilotkit/react-core/v2`, which renders the real Streamdown component used by
the examples. Fail if resolution does not follow the validated React Core ->
Streamdown chain. Emit JavaScript and CSS to disk, configure file loaders for
`.woff`, `.woff2`, and `.ttf`, and serve every emitted JavaScript, CSS, and font
asset from a contained path handler on one random loopback port. Link the
emitted CSS from the harness HTML; missing or escaped assets, page errors, and
console errors fail the case.

In Playwright Chromium, create a fresh browser context per hostile case. Prove a
benign Mermaid diagram renders first, then cover architecture/config prototype
pollution, strict HTML/SVG sanitization, and the CSS sibling-sentinel control.
For the CSS case, insert the sentinel as the immediate next sibling of the
generated `svg[id]` in the same parent and assert its computed style is
unchanged; a sentinel merely beside the outer renderer is not valid evidence
for the vulnerable `#id + *` selector. Bound navigation/rendering, capture no
secrets, and close contexts, browser, server, and temporary bundle in `finally`.
Repeat the benign and strict-sanitization controls with the research example as
the resolver root so both private UI graphs are covered.

- [ ] **Step 4: Add the Kubernetes SOCKS proxy path smoke**

In `packages/sandbox/test/kube-socks-proxy.test.ts`, construct the real
`@kubernetes/client-node` configuration with `skipTLSVerify: true`, a loopback
SOCKS proxy URL, and a loopback Kubernetes HTTP target. Resolve and validate the
exact client-node -> socks-proxy-agent -> socks -> ip-address chain rather than
directly importing a phantom-hoisted package. Use a minimal bounded SOCKS5 test server to
observe the requested address/port and proxy the request. Assert the request
traverses the SOCKS agent, reaches the intended target exactly once, returns the
expected body, and uses the patched `ip-address` path. Cover mandatory IPv4 and
a fixed sentinel hostname that the test SOCKS server maps to loopback. Use the
exact proxy URL `socks5h://127.0.0.1:<random-port>` so hostname resolution occurs
inside the controlled proxy rather than through ambient DNS; use the same
proxy-side path for the literal IPv4 control. Do not make success depend on host
IPv6 support.

Use random loopback ports, absolute deadlines, byte limits, exact-once cleanup,
and `finally` blocks. Save, unset, and restore uppercase and lowercase HTTP,
HTTPS, ALL, and NO proxy environment variables. Never contact the network
outside loopback.

- [ ] **Step 5: Run the intended RED without risking the main process**

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts \
  test/security-dependencies/mermaid-rendering.test.ts
pnpm exec playwright test --config test/security-dependencies/playwright.config.ts
pnpm --filter @dawn-ai/sandbox exec vitest --run --config vitest.config.ts \
  test/kube-socks-proxy.test.ts
```

Expected RED: version receipts and at least the architecture/worker security
cases expose Mermaid 11.16.0; the SOCKS version receipt exposes ip-address
10.2.0. Bounded worker termination is an acceptable intentional RED; a hung or
leaked test process is not.

### Task 4: Add native browser/Windows gates and preserve bounded RED evidence

**Files:**
- Create: `test/security-dependencies/hono-serve-static-windows.test.ts`
- Create: `.github/workflows/dependency-security-receipt.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`
- Modify: `scripts/release/test/fixtures/workflow-safe-executables.json`
- Modify: `scripts/release/test/workflow-contracts.test.mjs`

- [ ] **Step 1: Add the Windows-only encoded-backslash regression**

Skip only when `process.platform !== "win32"`. Resolve `serve` and `serveStatic`
through the CopilotKit example anchor. Create
`static/admin/secret.txt`, register a sentinel authorization middleware on
`/static/admin/*`, then register `serveStatic` on `/static/*`. Request the exact
path `/static/admin%5Csecret.txt` over real loopback HTTP.

Fixed expectation: response `404`, no secret bytes, and no authorization
sentinel header. Always close the server and remove the temporary root. Preserve
any bounded pre-prerequisite observation of `1.19.14` serving the secret as RED
evidence, but do not downgrade the selected compatible `1.19.17` or add an
override merely to recreate it.

- [ ] **Step 2: Add one exact safe Windows CI step**

Append after the existing Windows subprocess test:

```yaml
- name: Dependency security regressions
  run: pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts
```

Do not alter the existing Windows steps, permissions, runner, or timeout unless
an observed bounded runtime requires a reviewed timeout adjustment.

- [ ] **Step 3: Add an isolated Chromium security job**

Add `dependency-security-browser` to `ci.yml` with `contents: read`,
`ubuntu-latest`, and a 15-minute timeout. Use the repository's existing pinned
checkout, pnpm, and Node setup actions; install with the frozen lockfile; run
`pnpm exec playwright install --with-deps chromium`; then run exactly:

```bash
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm exec playwright test --config test/security-dependencies/playwright.config.ts
```

Do not put the browser download in every `validate` run or allow the job to skip
when Chromium setup fails.

- [ ] **Step 4: Add the write-once post-merge receipt uploader**

Create `dependency-security-receipt.yml` with only `workflow_dispatch`, an exact
seven-input contract (`expectedMainSha`, `expectedPrNumber`,
`expectedReviewedBaseSha`, `expectedReviewedHeadSha`, `expectedMergeSha`,
`receiptBase64`, and `receiptSha256`), job-level `contents: read`, no secrets, no
environment, no write or OIDC permission, and a 10-minute timeout. This workflow does **not**
read Dependabot: the default `GITHUB_TOKEN` is not treated as sufficient for
that endpoint before PR3 installs the dedicated read-only GitHub App.

The owner-side reviewed reader produces the bounded redacted receipt. Dispatch
inputs are safe because the receipt contains no raw descriptions, tokens,
headers, or error bodies. Canonical receipt bytes are capped at 32 KiB so their
single-line base64 encoding stays below GitHub's aggregate dispatch-input limit.
Use the repository's pinned checkout, Node 24 setup, and upload actions. Keep
`seal-receipt` and its imports Node-built-in-only so this uploader needs no
package install. Its `run-name` includes the exact receipt SHA-256. The job must:

1. validate all SHAs and the PR number before checkout;
2. check out the exact `expectedMainSha` with persisted credentials disabled;
3. require `github.sha` and the live default-branch ref to equal that SHA; the
   job token is read-only, checkout does not persist it, and only this exact API
   step receives it explicitly as `GH_TOKEN`;
4. run `seal-receipt` to decode and revalidate the canonical receipt, its
   digest, and repo/PR/reviewed-head/base/merge/observation-head identities,
   then write a separate uploader manifest containing the current run
   ID/attempt without echoing the payload; and
5. upload the receipt and uploader manifest with the repository's pinned
   `actions/upload-artifact` full SHA, 90-day retention, and artifact name
   `dependency-security-receipt-<expectedMainSha>-<receiptSha256>`.

The action-provided artifact ID, URL, and service digest plus the independently
computed receipt SHA-256 form the durable index. Artifacts are write-once for a
run; the later PR comment is only an index and is never described as the
evidence store. Tests reject extra/missing inputs, pull-request or scheduled
triggers, any write/id-token permission, secret access, an unpinned action,
credential persistence, dependency installation, a dynamic command, head drift,
wrong receipt digest, unsafe base64, oversized input, extra archive files, and
invalid runtime run/attempt values.

- [ ] **Step 5: Update the parsed workflow contracts exactly**

Add the new step at index 6 to both readable allowlist fixtures and to the
hard-coded `testing-windows` descriptor test. Add the complete browser-job
descriptor, the complete receipt-uploader workflow descriptor, and every
executable to both fixtures. Add mutation regressions proving that changing a
path, adding a shell operator, broadening a test command, removing the frozen
install, expanding permissions/triggers, or substituting a dynamic action fails
closed. Preserve the already-audited `copilotkit-examples-e2e` descriptors and
the required native Vercel job/executables byte-for-byte.

- [ ] **Step 6: Observe workflow-contract RED, then make it green**

Add the workflow step before updating fixtures/tests and run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node --test scripts/release/test/workflow-contracts.test.mjs
```

Expected RED: exact workflow descriptor/allowlist mismatch. After updating all
three contract sources, the focused suite is green and the new adversarial
mutation remains rejected.

- [ ] **Step 7: Commit the behavior regressions against the patched graph**

Run all controls and require the selected compatible graph to pass. Preserve
bounded pre-prerequisite RED receipts outside the worktree; do not create a
mergeable commit that deliberately restores vulnerable versions. Commit:

```text
test(security): cover vulnerable dependency paths
```

The reviewed test commit must be green for Hono/node-server because the V2
prerequisite already selected their patched ranges. Mermaid, DOMPurify, SOCKS,
and other still-unreconciled WIP may retain their own specific RED assertions
until Task 5; a generic crash, missing primitive, timeout, or unrelated failure
is never acceptable evidence.

### Task 5: Apply the minimal dependency policy and targeted lock refresh

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `test/security-dependencies/dependency-resolution.test.ts`

- [x] **Step 1: Remove the obsolete PostCSS policy and update js-yaml**

Keep this scoped policy:

```json
"js-yaml@>=4 <4.3.1": "4.3.1"
```

Remove the old global PostCSS 8.5.10 policy rather than replacing it. Next
16.3.0 declares exact PostCSS 8.5.23, while Tailwind and Vite admit that safe
line, so their real owner ranges hold the patched resolution without forcing.
Keep the scoped js-yaml policy because `@vercel/python-analysis` 0.13.1 pins
4.1.1 exactly (and 0.14.0 still does); document that owner-pin removal as the
policy's removal trigger in the audit report.

- [x] **Step 2: Preserve the no-Hono/no-UUID override boundary**

Do not add any CopilotKit, Hono, node-server, UUID, provider-utils, AG-UI, or
Vercel selector. The prerequisite already removed:

```json
"uuid@<11.1.1": "11.1.1"
```

The proposed `@hono/node-server@<2.0.10` major-forcing override is rejected.
CopilotKit `1.68.3` and the refreshed compatible graph select patched 1.x and
2.x lines without it.

- [x] **Step 3: Refresh only the affected lock resolutions**

Do not use named `pnpm update`: on pnpm 10.33 it rewrites the CLI's direct Hono
range, and `--depth Infinity --no-save` still leaves the vulnerable transitives
unchanged. Hono/node-server/UUID are already safe and must not be forced again.
For only the still-unreconciled compatible findings, temporarily add these exact
lock-refresh selectors:

```json
"postcss@>=8 <8.5.23": "8.5.23",
"ip-address@>=10 <10.3.1": "10.5.0",
"js-yaml@>=3 <3.15.1": "3.15.1",
"mermaid@>=11 <11.16.1": "11.16.1",
"dompurify@>=3 <3.4.13": "3.4.13",
"nanoid@>=3 <3.3.18": "3.3.18",
"fast-uri@>=3 <3.1.5": "3.1.5",
"brace-expansion@>=2 <2.1.4": "2.1.4",
"body-parser@>=1 <1.20.6": "1.20.6"
```

Realize the lock under those constraints:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm install --lockfile-only --no-frozen-lockfile
```

Remove all nine temporary entries with `apply_patch`, leaving exactly the one
scoped js-yaml security policy plus the six untouched unrelated overrides:
seven total. Then run `pnpm install --lockfile-only --no-frozen-lockfile` again.
The admitted parent ranges retain the safe lock selections without permanent
forcing. Prove the final root manifest has no temporary selector and that no
workspace package manifest changed.

Review `pnpm-lock.yaml` before installing. Expected resolution set at planning
time:

```text
hono 4.13.3 (floor 4.12.34)
@hono/node-server 1.19.17 and 2.1.1 (floors 1.19.15 and 2.0.10)
uuid 11.1.1 and 14.0.1 (floor 11.1.1)
ip-address 10.5.0
js-yaml 3.15.1, 4.3.1, and the unrelated safe 5.x line
mermaid 11.16.1
dompurify 3.4.13
postcss 8.5.23
nanoid 3.3.18
fast-uri 3.1.5
brace-expansion 2.1.4
body-parser 1.20.6
```

A newer same-range resolution is acceptable only after updating the floor-based
receipt and confirming it is not newly vulnerable. Reject unrelated parent
package upgrades or importer churn; do not collapse the valid 1.x and 2.x
node-server lines into one forced major.

- [x] **Step 4: Realize and freeze the new graph**

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm install --frozen-lockfile
git diff --check
git diff -- package.json pnpm-lock.yaml
```

Expected: frozen install succeeds, only intended manifest/importer/snapshot
changes appear, and there is no workspace package version or dependency-range
change.

- [x] **Step 5: Make all new focused tests green**

Run the security dependency project, sandbox proxy test, workflow contracts,
existing CLI Hono tests, and both example route/build controls. Require no skip
except the explicit Windows-only test on non-Windows.

- [x] **Step 6: Enforce the compatible Hono floors without a forced major**

Require Hono `>=4.12.34`, node-server 1.x `>=1.19.15`, and node-server 2.x
`>=2.0.10`, with the current `4.13.3`/`1.19.17`/`2.1.1` graph passing the lean
receipt, CLI HTTP roundtrip, V2 runtime loopback, example builds, and native
Windows non-disclosure test. Current alert `#236`
(`@hono/node-server`, `GHSA-frvp-7c67-39w9`) must close on `1.19.17`. Alert
`#123` is absent from every current API state and belongs only to the explicitly
historical August 10 evidence.

If a future compatible owner refresh changes these identities, update the
floor-based receipt and rerun Dawn-owned behavior. Do not reintroduce the old
upstream export-map suite, pin an exact safe version, or force all consumers onto
one major. A reproducible Dawn-owned regression requires a reviewed direct-owner
reassessment before implementation continues.

### Task 6: Prepare remediation and upstream-boundary evidence

**Files:**
- Create: `docs/superpowers/audits/2026-08-10-dependency-remediation.md`
- Modify: `test/security-dependencies/fixtures/audit-upstream-boundaries.json`
- Read without modification:
  `docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json`
- Plan for creation in Task 8:
  `docs/superpowers/audits/2026-08-20-dependency-remediation-reviewed-base.json`

- [x] **Step 1: Prepare the human-readable security receipt schema and draft**

Record already-proven decisions and evidence:

- historical evidence base, exact bounded pre-remediation RED receipt/source
  identities, and exact dependency-fix commit SHA (not the audit document's own
  future commit or merge SHA);
- the complete pre-remediation 27-alert set and 30-advisory audit set;
- selected compatible floors and remediation decisions, their graph roots, and
  the Dawn-owned test surfaces that justify them;
- why each root override exists and its removal trigger;
- why no CopilotKit/Hono/node-server/UUID/provider-utils/AG-UI/Vercel override
  exists; and
- why the Vercel CLI/native-deployment lane remains required.

Create explicit draft sections, labeled pending rather than stated as final
facts, for:

- Task 7's exact production/full audit tuples and conditional provider-utils and
  Vercel retained-boundary or resolution outcome, plus the schema-v2 audit
  receipt's capture time, exact source SHA, lockfile SHA-256, and digest;
- Task 8's final Dependabot identities, explicit fixed/open disposition, and
  confirmation of no suppressions or dismissals;
- Task 8's August 20 reviewed-base receipt path and SHA-256 digest;
- exact final focused/full/gated command results; and
- exact-reviewed-head publication containment evidence, while preserving every
  historical incident run and its classification.

The checked-in document must not promise post-merge facts or contain
self-referential SHA placeholders. Merge-SHA CI, audit, and alert reconciliation
live in a content-addressed Actions artifact after merge; the PR comment only
indexes that artifact. PR3 may later incorporate the receipt into checked-in
release-gate evidence.

Never update the August 10 receipt to represent a new base. Its path and digest
may be recorded now as immutable history. The August 20 reviewed-base receipt
and digest remain explicitly pending until Task 8 recaptures them against the
exact reviewed base; every later rebase refreshes that current receipt, the
identity fixture, their digests, the schema-v2 final audit receipt/provenance,
and the explicit fixed/open disposition.

Do not paste secrets, URLs with credentials, tokens, ambient proxy values, or
unbounded raw logs.

- [x] **Step 2: Conditionally record the provider exception and Vercel development boundary**

The prerequisite observed `GHSA-866g-f22w-33x8` on provider-utils `3.0.28`.
Prepare the following conditional record schema, but leave its outcome pending
until Task 7 recaptures the final production audit. Record that advisory only if
it remains, bound to the exact affected 3.x snapshot and dependency path in that
final recapture:

```text
package: @ai-sdk/provider-utils
snapshot: exact affected 3.x snapshot from the final recapture
path: exact affected dependency path from the final recapture
reported severity: exact severity from the final recapture
reachability: reviewed final reachability through the exact affected path
disposition: UPSTREAM_BLOCKED only if the final evidence supports it
owner: @blove
review expiry: 2026-09-10
recheck triggers: patched compatible 3.x, CopilotKit/Google Vertex dependency
  migration, a new reachable import, severity/reachability change, or any Dawn
  Vertex example/use
```

If the advisory remains, do not force provider-utils 4.x. Pull request 3 will
translate the reviewed evidence into the machine-readable, exact-set, expiring
live-alert exception gate. Revalidate its reachability and disposition against
the final path rather than copying the prerequisite rationale. Task 7 updates
the final fixture and human audit with that observed identity. If the advisory
is absent, record the resolved version/path and resolution reason, and omit the
exception instead of carrying a stale upstream-blocked record.

Separately record the required `vercel@58.9.0` CLI path and native-deployment CI
lane. Vercel findings belong only to the full development audit, are not muted,
and are not a reason to remove the dependency or the credentialed real-deploy
test. Leave their exact package/version/GHSA tuples pending until Task 7's
recapture; do not invent counts or force transitive versions.

Prepare `audit-upstream-boundaries.json` with distinct `production` and `full`
schemas and explicit empty `muted` arrays. Task 7 fills and verifies the exact
records: production contains provider-utils only if it remains, while full adds
the exact reviewed Vercel-owned tuples only if final recapture reports them.

- [x] **Step 3: Record the no-release changeset decision**

State explicitly that persistent manifest changes are private root policy/test
dependencies, private-example dependencies, or `packages/ag-ui`'s development
owner. The only public `packages/ag-ui/src` change is a JSDoc example that
shows the supported V2 import/provider configuration; runtime behavior, types,
API shape, runtime dependencies, and the optional peer floor are unchanged.
Record that reviewed no-release decision with an empty
`.changeset/copilotkit-v2-guidance.md`. Lockfile resolutions stay within
existing published dependency ranges. If implementation later changes a
publishable package's runtime behavior, types, API, or normal dependency, stop
and replace this decision with a patch changeset.

### Task 7: Run focused and integration verification under Node 24

**Files:**
- Test: all files changed above
- Modify: `docs/superpowers/audits/2026-08-10-dependency-remediation.md`
- Modify: `test/security-dependencies/fixtures/audit-upstream-boundaries.json`
- Test: `packages/cli/test/hono-target.test.ts`
- Test: `packages/cli/test/hono-node-roundtrip.test.ts`
- Test: `scripts/release/test/fault-harness.integration.mjs`

- [ ] **Step 1: Verify exact resolution and audit sets**

Run all `pnpm why`/`pnpm list` receipts again. Then capture full and production
audits with explicit status and schema checks. From the complete recapture,
update `audit-upstream-boundaries.json` with the exact final production/full
records and explicit empty `muted` arrays, then rerun the reviewed reader against
that fixture. Production contains provider-utils only if it remains; full adds
the exact Vercel development-boundary records only if final recapture reports
them. No final count is inferred from the pre-prerequisite graph.

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node scripts/security/dependency-evidence.mjs audit \
  --expected test/security-dependencies/fixtures/audit-upstream-boundaries.json \
  --output /tmp/dawn-pr1-audit-after.json
```

The canonical result is an audit receipt with schema v2. Record its
`capturedAt`, `sourceSha`, `lockfileSha256`, and SHA-256 alongside the exact
finding counts; a matching count from a different source or lockfile is not
acceptable evidence.

Reject a missing expected advisory, any extra advisory, malformed JSON, audit
network/error envelope, non-unique record, contradictory severity counts, or an
unexpected exit status. This task does not dismiss or suppress the advisory.

After the exact fixture passes, update the human audit draft with the final
production/full tuples and either the retained provider-utils/Vercel boundaries
or each finding's resolved version/path and resolution reason. Replace only the
Task 7 audit placeholders; keep final Dependabot disposition and the August 20
reviewed-base receipt/digest explicitly pending for Task 8.

- [ ] **Step 2: Run the focused security matrix**

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts
pnpm exec playwright test --config test/security-dependencies/playwright.config.ts
pnpm --filter @dawn-ai/sandbox exec vitest --run --config vitest.config.ts \
  test/kube-socks-proxy.test.ts
node --test scripts/release/test/workflow-contracts.test.mjs
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/hono-target.test.ts
DAWN_REQUIRE_DOCKER=1 pnpm --filter @dawn-ai/cli exec vitest --run \
  --config vitest.config.ts test/hono-node-roundtrip.test.ts
pnpm --filter @dawn-ai/ag-ui build
pnpm --filter @dawn-example/chat-web test:e2e
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/chat-web build
pnpm --filter @dawn-example/research-web test:e2e
pnpm --filter @dawn-example/research-web typecheck
pnpm --filter @dawn-example/research-web build
pnpm --filter @dawn-ai/web build
pnpm turbo run build --filter=@dawn-ai/inspector...
pnpm test:release-fault-harness
```

Set `DAWN_REQUIRE_DOCKER=1` for the CLI roundtrip and repository validation when
the lane owns a working Docker daemon. A skip in required infrastructure is not
a pass.

- [ ] **Step 3: Run sandbox, storage, and pgvector integration lanes**

Run with their documented environment gates:

```bash
DAWN_TEST_DOCKER=1 pnpm --filter @dawn-ai/sandbox test
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/postgres-storage test
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/testing exec vitest run \
  test/memory-example-dogfood.test.ts
```

Also run the repository's real Kubernetes sandbox and full-arc smoke through CI;
do not attempt to substitute unit mocks for those jobs.

- [ ] **Step 4: Run scoped static hygiene**

Use scoped Biome on every changed JSON/TS/MJS file, the docs checker, JSON/YAML
parsers, `git diff --check`, and the workflow auditor. Never run a bare
workspace-wide `biome check --write`.

### Task 8: Run the full Definition of Done and independent reviews

**Files:**
- Test: repository Definition of Done
- Modify: `docs/superpowers/audits/2026-08-10-dependency-remediation.md`
- Review and commit:
  `test/security-dependencies/fixtures/audit-upstream-boundaries.json`
- Modify: `test/security-dependencies/fixtures/dependabot-baseline.json`
- Create or update:
  `docs/superpowers/audits/2026-08-20-dependency-remediation-reviewed-base.json`
- Read without modification:
  `docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json`

- [x] **Step 1: Re-prove publication containment and change scope**

Require the reviewed reader to reproduce the full Task 1 containment proof at
the exact reviewed branch head while the default branch remains the reviewed
base. This repeats all 21 npm version/attestation reads plus complete workflow,
tag, Release, and Actions-artifact pagination; it is not only a workflow-state
check.

The completed recapture read every current Dependabot identity with bounded
pagination and rewrote `dependabot-baseline.json` so its `defaultSha` is the
exact reviewed base and its sorted `open` array is the complete reviewed set.
It confirmed 59 records and found one identity-field change: alert `#232`
changed severity from `medium` to `high`. No dismissal or suppression was
accepted. The shell derived the all-open baseline CSV from the reviewed fixture
only after fail-closed provenance, state, ordering, and uniqueness checks:

```bash
set -euo pipefail
REVIEWED_HEAD_SHA="$(git rev-parse HEAD)"
REVIEWED_BASE_SHA="$(git rev-parse origin/main)"
DEPENDABOT_IDENTITIES="test/security-dependencies/fixtures/dependabot-baseline.json"
EXPECTED_OPEN_CSV="$(
  jq -er --arg reviewed_base "$REVIEWED_BASE_SHA" '
    .open as $open
    | [$open[].number] as $numbers
    | if .schemaVersion != 1
      or .repository != "cacheplane/dawnai"
      or .defaultSha != $reviewed_base
      or ($open | type) != "array"
      or ($open | length) == 0
      or any($open[]; .state != "open" or .dismissal != null)
      or $numbers != ($numbers | sort | unique)
      then error("invalid reviewed Dependabot identity fixture")
      else $numbers | map(tostring) | join(",")
      end
  ' "$DEPENDABOT_IDENTITIES"
)"
test -n "$EXPECTED_OPEN_CSV"
node scripts/security/dependency-evidence.mjs baseline \
  --repo cacheplane/dawnai \
  --inventory-ref HEAD \
  --source-sha "$REVIEWED_HEAD_SHA" \
  --expected-default-sha "$REVIEWED_BASE_SHA" \
  --current-version 0.8.21 \
  --target-version 0.8.22 \
  --expected-identities "$DEPENDABOT_IDENTITIES" \
  --expected-open "$EXPECTED_OPEN_CSV" \
  --output docs/superpowers/audits/2026-08-20-dependency-remediation-reviewed-base.json
git diff --exit-code origin/main...HEAD -- \
  .github/workflows/release.yml .github/workflows/publish-chart.yml
```

The canonical reviewed-base receipt and digest were reviewed, and the human
audit records the exact recaptured Dependabot identities, explicit fixed/open
disposition, confirmation of no suppressions or dismissals, August 20 receipt
path/digest, and provider-utils/Vercel outcome. The immutable August 10 receipt
and its historical claims remain unchanged.

Beyond the already-committed, audited `copilotkit-examples-e2e` job, the CI
workflow may change only for the audited Windows regression and isolated
Chromium security job. The new receipt-uploader workflow must remain the exact
read-only, manual, allowlisted descriptor from Task 4. Preserve the required
native Vercel job and all of its executables unchanged.

- [ ] **Step 2: Run the complete local lane on the finalized evidence state**

Run this once after Step 1 completes every final fixture, receipt, and human
audit mutation. It validates the exact state that Step 3 commits and reviews:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: every Definition-of-Done and local-only release-script lane passes,
including all three long harness families. Preserve a bounded result summary,
not an unbounded raw log in Git. Do not run a second redundant full validation
before Step 3 unless the evidence state changes again.

- [ ] **Step 3: Commit and review the finalized evidence in reviewable units**

The approved plan is committed before Task 1. Recommended implementation
commits are:

1. `test(security): cover vulnerable dependency paths`
2. `fix(security): update compatible dependencies`
3. `docs(security): record dependency remediation`

The documentation commit includes the finalized human audit, exact audit and
Dependabot fixtures, and checked-in August 20 reviewed-base receipt. Review all
paths and recompute the recorded digests before committing. Each commit must
pass `git show --check`; no commit or PR text may reference an assistant
implementation tool.

- [ ] **Step 4: Request independent spec and code-quality reviews**

Dispatch separate reviewers. Spec review must compare the implementation to the
approved design and this plan. Quality/security review must inspect fail-closed
audit parsing, lockfile scope, worker/server cleanup, hostile inputs, Windows
behavior, workflow allowlists, changeset classification, and secret safety.

Fix every Critical or Important finding with a new RED/GREEN cycle, rerun the
affected matrix, and request a fresh review. Do not merge with unresolved
Critical/Important findings.

### Task 9: Finalize the draft pull request and merge only on the exact green head

**Files:**
- Review: complete branch diff against `origin/main`

- [ ] **Step 1: Rebase/pin before publication of the branch**

Fetch main. If it moved, rebase and repeat frozen install, resolution receipt,
schema-v2 full/prod audit receipt with its exact source/lock provenance, focused
tests, and all affected validation. Recapture the
complete live alert baseline against the new base; update and review the
identity fixture's `defaultSha`, the checked-in August 20 reviewed-base receipt,
the explicit fixed/open disposition, and their digests before accepting the
rebased branch. Never rewrite the immutable August 10 historical receipt.
Record the exact reviewed head SHA and reviewed base SHA, announce an
operational main freeze for the merge window, and require a clean worktree.
Auto-merge remains off.

- [ ] **Step 2: Push the fix/evidence commits and finalize the draft PR**

Push the dependency-fix and evidence commits to the existing draft PR from Task
4. Update it with a concise security-focused title and body. Include:

- exact dependency/override changes;
- compatible Hono/node-server floors, absence of a forced-major override, and
  native Windows evidence;
- exact post-change production and full audit sets;
- either the exact observed provider-utils upstream boundary if it remains, or
  its resolved version/path and resolution reason;
- why the Vercel CLI/native deployment lane remains required and either why any
  exact full-audit Vercel findings remain upstream development boundaries, or
  their resolved versions/paths and resolution reasons if none remain;
- why the checked-in changeset is an intentional empty no-release
  acknowledgement;
- local verification summary;
- explicit statement that publication workflows remain disabled.

Keep it draft until local verification and both independent reviews are green.
Then mark that exact head ready; do not open a second PR and do not discard the
bounded pre-remediation RED receipts.

- [ ] **Step 3: Monitor the exact PR head**

Require all substantive CI jobs, the new Chromium job, Windows, Inspector,
Docker, Postgres, pgvector, Kubernetes, full-arc smokes, and CodeQL to finish
successfully on the same head. Scorecard has no pull-request trigger and is
required only on the post-merge SHA. Require the PR to be mergeable, approved,
and free of unresolved
Critical/Important review threads. A third-party check that cannot start due
external account credit is not green, but may be separately classified as
non-required only after proving it produced no finding; no technical failure is
waived.

- [ ] **Step 4: Merge on green and pin the merge SHA**

Immediately before merge, fetch and require the remote default head to equal the
recorded reviewed base. Re-read required checks and review threads, then rerun
the complete `baseline` operation from Task 8 to prove the 21-package public
absence and publication hold at the exact reviewed head/base. Read the PR once
and require it is open, ready, approved, has `auto_merge == null`, targets
`main`, and has exact `.head.sha == REVIEWED_HEAD_SHA` and
`.base.sha == REVIEWED_BASE_SHA`.

Merge with the repository's merge-commit strategy and the CLI's atomic head
precondition:

```bash
set -euo pipefail
git fetch origin main
test "$(git rev-parse origin/main)" = "$REVIEWED_BASE_SHA"
gh pr merge "$PR_NUMBER" --repo cacheplane/dawnai --merge \
  --match-head-commit "$REVIEWED_HEAD_SHA"
```

GitHub exposes no atomic expected-base argument, so the operational main freeze,
immediate exact-base read, and post-merge parent proof are all mandatory. Fetch
again and accept the merge SHA only if the exact PR object is merged with the
same reviewed head/base and its merge commit has first parent
`REVIEWED_BASE_SHA`, second parent `REVIEWED_HEAD_SHA`, and is the exact remote
default head. Any head/base movement or parent mismatch invalidates the reviewed
evidence, keeps publication paused, and requires fresh correlation; it is never
papered over as the reviewed merge.

### Task 10: Verify exact merged-main security state

**Files:**
- Verify: merged `main`
- Verify: GitHub Actions and security APIs
- Verify: npm audit/lock graph
- Verify: `.github/workflows/dependency-security-receipt.yml`
- Verify:
  `docs/superpowers/audits/2026-08-20-dependency-remediation-reviewed-base.json`

- [ ] **Step 1: Select and pin the exact observation head**

Monitor CI, CodeQL, and Scorecard for the exact merge SHA to terminal success.
Then read GitHub's default head into `OBSERVATION_HEAD_SHA`. Prefer exact equality
with `MERGE_SHA`. If main advanced, require `MERGE_SHA` is an ancestor, prove the
intervening diff does not touch `package.json`, `pnpm-lock.yaml`, any workspace
manifest, dependency/security tests, or security/publication workflows, and
require CI, CodeQL, and Scorecard for the newer observation head to be terminal
success too. Otherwise stop as uncorrelated.

Record merge and observation heads separately. Never label a default-branch
Dependabot observation as merge-SHA state when the heads differ. Release and
Publish Chart must still resolve by exact ID/path to `disabled_manually` with
zero non-completed runs. If the default head changes during any later step,
discard the incomplete receipt and restart Tasks 10.1–10.3 at the new head.

- [ ] **Step 2: Re-run exact observation-head graph and audit verification**

Create a clean detached verification worktree at `OBSERVATION_HEAD_SHA`; do not
move the implementation worktree. Under Node 24, run frozen install, the full
security dependency project, browser and focused graph receipts, then capture
full/prod audits with
`test/security-dependencies/fixtures/audit-upstream-boundaries.json`. Require
the exact distinct production/full package/version/GHSA/reported-severity
tuples and empty muted sets. Write one canonical audit receipt to
`/tmp/dawn-pr1-postmerge-audit.json` and compute its SHA-256. Keep the detached
worktree through Step 3 and remove it only after reconciliation, after proving
no scoped process uses it. The audit operation must
prove that the detached checkout remains at `OBSERVATION_HEAD_SHA`, that its
lockfile is clean and hashes to the receipt's `lockfileSha256`, and that neither
identity drifts across the two audit modes. Run reconciliation immediately
afterward so the receipt is no more than five minutes old when observation
starts.

- [ ] **Step 3: Produce one stable, bracketed reconciliation receipt**

Run `reconcile` from the detached observation-head checkout. On the preferred
path, begin from the independently reviewed 59-record current-base observation
and the candidate partition recorded at the top of this plan. The candidate
fixed set is
`124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201,236`;
the candidate retained-open set is
`122,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235`.
Current Hono/node-server alert `#236` must close on the compatible patched
`1.19.17` graph; `#123` is historical and is not an API-visible reconciliation
identity. The `#204`–`#235` candidate boundaries come from the required Vercel
development/native-deployment path. No alert may be suppressed or dismissed.

Task 8's mandatory final recapture controls execution. If it changes any
identity or disposition—including resolution of provider-utils or a Vercel
finding—stop and update the reviewed identity fixture, August 20 reviewed-base
receipt, human audit, candidate text, and both explicit shell variables below
before running reconciliation. Do not infer fixed/open disposition from the
fixture; the partition remains an explicit reviewed security decision.

The operation validates the exact PR number, reviewed base/head, merge commit
and parents, observation head, and `merged_at`; verifies CI/CodeQL/Scorecard run
IDs, attempts, heads, and success conclusions; reruns complete publication
containment before and after alert reads; and binds the audit receipt plus every
input fixture by SHA-256. It requires the Dependabot identity fixture's
`defaultSha` to equal the exact reviewed base SHA; it is not compared with the
later post-merge observation head. The audit receipt is not merely referenced:
after schema and fixture validation, its source SHA must equal the observation
head, its lockfile SHA-256 must equal a fresh bounded hash of that checkout, and
its capture time must fall from merge time through reconciliation start within
a five-minute freshness window. Its complete normalized full/production
status, package/version/GHSA/reported-severity tuples, severity totals,
explicit empty muted sets, and provenance fields are embedded in the canonical
reconciliation receipt. It polls
under one 15-minute deadline, fixed 15-second interval, at most 61 attempts, ten
pages, and explicit aggregate byte/record caps. At terminal state it requires
open snapshot A == open snapshot B around one fresh exact-number read of every
fixed alert and requires the live default head to equal
`OBSERVATION_HEAD_SHA` before A and after B.

The canonical receipt has this exact top-level shape (all fields required; no
nullable fields):

```text
schemaVersion, kind, repository, observationHead,
observation { startedAt, completedAt },
pr { number, reviewedBaseSha, reviewedHeadSha, mergeSha,
     mergeParentShas, mergedAt },
verificationRuns[],
digests { inputs { auditExpectationFixtureSha256, auditReceiptSha256,
                   baselineReceiptSha256, dependabotIdentitiesFixtureSha256 },
          outputs { fixedAlertsSha256, openSnapshotASha256,
                    openSnapshotBSha256, publicationBeforeSha256,
                    publicationAfterSha256 } },
audit { digest,
        evidence { schemaVersion, kind, capturedAt, sourceSha,
                   lockfileSha256, full, production } },
dependabot { fixed, open }, publication
```

Each verification-run record has exact keys `workflowPath`, `runId`,
`runAttempt`, `headSha`, `headBranch`, `event`, `status`, and `conclusion`. The allowed paths are
`.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, and
`.github/workflows/scorecard.yml`; status/conclusion are exactly
`completed`/`success`, event is exactly `push`, and `headBranch` is exactly
`main`. For each path/head, complete
pagination may contain other workflow events, but exactly one distinct `push`
run ID must exist; a rerun is that same run ID's latest positive attempt. The
retained set is the Cartesian product of the three paths and the unique
merge/observation heads, with unique positive run IDs and stable head/path
ordering. Merge parents are exactly `[reviewedBaseSha,
reviewedHeadSha]`; `mergedAt <= startedAt <= completedAt`; completion is
captured after the closing publication/head proof and before the shared
deadline. Audit capture obeys
`mergedAt <= audit.capturedAt <= startedAt` and
`startedAt - audit.capturedAt <= 5 minutes`. Input hashes cover the exact
bounded file bytes actually validated.
Audit digest fields agree with the normalized audit bytes. Open A/B digests
agree with each other and the retained open set; the fixed digest matches the
retained fixed set; publication before/after digests agree with each other and
the retained publication snapshot. Publication default/source SHAs equal the
observation head. Raw alert descriptions, headers, job logs, credentials, and
error bodies are excluded. The receipt never embeds its own digest or future
uploader/artifact identities.

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
EXPECTED_FIXED_CSV="124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201,236"
EXPECTED_OPEN_CSV="122,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235"
node scripts/security/dependency-evidence.mjs reconcile \
  --repo cacheplane/dawnai \
  --pr "$PR_NUMBER" \
  --reviewed-base-sha "$REVIEWED_BASE_SHA" \
  --reviewed-head-sha "$REVIEWED_HEAD_SHA" \
  --merge-sha "$MERGE_SHA" \
  --observation-head-sha "$OBSERVATION_HEAD_SHA" \
  --inventory-ref HEAD \
  --current-version 0.8.21 \
  --target-version 0.8.22 \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --expected-fixed "$EXPECTED_FIXED_CSV" \
  --expected-open "$EXPECTED_OPEN_CSV" \
  --baseline-receipt docs/superpowers/audits/2026-08-20-dependency-remediation-reviewed-base.json \
  --audit-expectation test/security-dependencies/fixtures/audit-upstream-boundaries.json \
  --audit-receipt /tmp/dawn-pr1-postmerge-audit.json \
  --wait-timeout-ms 900000 \
  --poll-interval-ms 15000 \
  --max-attempts 61 \
  --output /tmp/dawn-pr1-reconciliation.json
```

Any timeout, query/parse/schema error, audit source/lock mismatch, stale or
misordered audit capture, head drift, mismatched bracketing snapshot, new or
reopened alert, dismissal, compatible alert left open, or containment failure
is `UNPROVABLE` and keeps publication blocked.

- [ ] **Step 4: Seal the receipt in an exact-head Actions artifact**

Compute the canonical receipt SHA-256, encode the bounded redacted bytes as one
base64 `workflow_dispatch` input, and dispatch
`dependency-security-receipt.yml` with `--ref main` plus exact observation-head,
PR, reviewed-base, reviewed-head, and merge inputs. `--ref` is deliberately the branch name;
the workflow itself rejects unless `github.sha` and live `main` both equal the
supplied observation head. Its `run-name` includes the receipt digest.

Select exactly one uploader run by full workflow path, dispatch event, exact
run-name digest, observation head, and creation time after dispatch; ambiguity
blocks. Require terminal success, then read its artifact list and require one
artifact with the exact content-addressed name. Record and verify artifact ID,
URL, retention, service digest, workflow run ID/attempt, uploader-manifest
digest, and receipt SHA. Download it through the bounded reader, reject unsafe
ZIP paths/types/extras, and require its receipt bytes and uploader manifest
exactly match the local validated values. Re-read default `main` and require it
still equals `OBSERVATION_HEAD_SHA`; otherwise restart correlation.

- [ ] **Step 5: Publish the release-hold index**

Post one canonical, redacted PR comment that indexes—but is not itself—the
write-once Actions artifact. Include immutable PR/reviewed base/head/merge/
observation identities, exact-head CI/CodeQL/Scorecard run IDs and attempts,
artifact ID/URL/service digest, receipt/uploader/audit/baseline/fixture digests,
and the final alert/containment verdict. The artifact's reconciliation receipt
contains the validated schema-v2 audit evidence preimage—including its source,
lockfile digest, and capture time—as well as its digest; the temporary
standalone audit file is not the only surviving copy. Recompute the
checked-in August 20 reviewed-base receipt digest against the human audit first;
index the immutable August 10 historical digest separately. Do not modify the
merged audit document or create a self-referential evidence commit.

Publication remains paused after PR1. Do not enable Release, generate a version
candidate, or publish. PR2 fixes Dawn-owned scanner findings; PR3 installs the
dedicated read-only alert credential plus least-privilege exception/release
ownership gates before candidate generation resumes.
