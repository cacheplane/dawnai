# Security Dependency Remediation PR1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Use
> superpowers:test-driven-development for every behavior change and
> superpowers:verification-before-completion before each commit or success
> claim.

**Goal:** Remove every currently compatible dependency vulnerability from Dawn,
prove the out-of-range `@hono/node-server` 2.x remediation against the real
CopilotKit/MCP/Windows paths, and leave only the exact upstream-blocked
`@ai-sdk/provider-utils` advisory while publication stays disabled.

**Architecture:** Keep the persistent dependency policy in the private root
manifest. Replace the two vulnerable overrides, add one narrowly selected Hono
adapter override, and refresh only the affected lockfile resolutions. Add a
repo-level security compatibility project that is anchored to the real example,
sandbox, and tooling dependency graphs rather than Dawn's already-safe direct
dependencies. Exercise Mermaid in an isolated DOM/worker boundary, exercise the
Kubernetes SOCKS path, and run the Windows-only encoded-backslash Hono regression
in the existing Windows CI job. Retain a human-readable evidence report; pull
request 3, not this pull request, owns the machine-readable live-alert exception
gate.

**Tech Stack:** Node.js 24.19.0, pnpm 10.33.0, Vitest 4, jsdom, Playwright
1.62.1, esbuild 0.28.1, Chromium, Next 16.3, Hono 4,
`@hono/node-server` 2.1, CopilotKit 1.66, MCP SDK, Kubernetes client, GitHub
Actions, Dependabot, and `pnpm audit`.

**Pinned baseline:** `3887079d400bdf019d3ff90bc89599c1899fa422`

**Preferred terminal security set:** Full and production audits contain only
`GHSA-866g-f22w-33x8`; the live Dependabot open set is exactly alert `#122`.
`@hono/node-server` alert `#123` is not an approved exception. It can remain only
if the explicit A/B failure threshold in Task 5 is met and documented.

---

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
- Create: `test/security-dependencies/fixtures/audit-provider-utils-only.json`
- Create: `test/security-dependencies/fixtures/dependabot-baseline.json`
- Create: `test/security-dependencies/vitest.config.ts`
- Create: `test/security-dependencies/tsconfig.json`
- Create: `docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json`
- Modify: `vitest.workspace.ts`

- [ ] **Step 1: Verify branch, base, tools, and a clean worktree**

Run every verification block in a fresh shell with Node 24 explicitly selected:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
git fetch origin main
test "$(git branch --show-current)" = "blove/security-dependency-remediation"
test "$(git rev-parse origin/main)" = "3887079d400bdf019d3ff90bc89599c1899fa422"
test "$(git merge-base origin/main HEAD)" = "3887079d400bdf019d3ff90bc89599c1899fa422"
test "$(git diff --name-only origin/main...HEAD)" = \
  "docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md"
test -z "$(git status --short)"
```

Expected: every assertion succeeds; the approved plan is the only branch change
above the pinned base. Commit this plan before beginning Task 1. If `origin/main`
moved, stop and rebase/re-review the plan onto the new exact main SHA before
editing; do not refresh a security lock against a stale base.

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
  severity moved between otherwise identical records fails closed.
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
  the supplied audit receipt, embeds its complete normalized full/production
  status, tuple, severity-total, and empty-muted evidence in the canonical
  reconciliation receipt, and also binds the original audit-receipt digest.
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
audit and Dependabot per-record severity drift, workflow ID/path mismatches,
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

- [ ] **Step 4: Capture the exact live security and containment baseline**

Run the reviewed reader with this exact open-number set:

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
  --expected-default-sha 3887079d400bdf019d3ff90bc89599c1899fa422 \
  --current-version 0.8.21 \
  --target-version 0.8.22 \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --expected-open 122,123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201 \
  --output docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json
```

Expected: 27 exact alert records plus the complete containment facts above. The
canonical redacted receipt is reviewed and committed so its content and digest
survive the implementation machine; it is not merely a temporary file. Do not
infer a clean/smaller alert set or unpublished state from a failed or partial
query.

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

Expected baseline: full audit has 30 advisories (13 high, 12 moderate, 5 low,
zero critical) and production audit has 27 advisories (10 high, 12 moderate, 5
low, zero critical). The audit includes the two nanoid advisories and one
body-parser advisory that are not yet open in Dependabot.

The after-state fixture is independently minimal: its `full` and `production`
arrays each contain exactly the `@ai-sdk/provider-utils@3.0.28` /
`GHSA-866g-f22w-33x8` record and its `muted` arrays are explicitly empty. Tests
prove a wrong package or version, an extra advisory, a missing mode, or any
muted record cannot satisfy that fixture.

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

### Task 2: Add graph and Hono compatibility regressions first

**Files:**
- Modify: `test/security-dependencies/vitest.config.ts`
- Modify: `test/security-dependencies/tsconfig.json`
- Create: `test/security-dependencies/dependency-resolution.test.ts`
- Create: `test/security-dependencies/hono-node-server.test.ts`
- Read: `vitest.workspace.ts`

- [ ] **Step 1: Confirm the dedicated repo-level Vitest project boundary**

The security-dependencies config is already registered by Task 1. Confirm its explicit
Vitest `root` to the repository root so Vite can transform the two example route
modules without relying on Node to execute TypeScript. Use a Node environment by
default, bounded test/hook timeouts, no ambient credentials, and an include
limited to `test/security-dependencies/**/*.test.ts` and `.tsx`. This is a test
project, not a new workspace package, and the repo-level TypeScript test files
must not be pulled into a publishable package's `rootDir`.

Confirm Task 1's `test/security-dependencies/tsconfig.json` extends the repository's Node
configuration with DOM libs, `noEmit`, and explicit `jsx: "react-jsx"`. Add the
missing explicit path mappings to the chat example's React, ReactDOM, and React
Core types used by the browser entry; do not fall back to root or publishable
package resolution.
Include only this test directory's `.ts`/`.tsx` sources and its Vitest and
Playwright configs. Prove it is independent of every publishable package
`rootDir`:

```bash
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
```

- [ ] **Step 2: Add the lock/manifest receipt test**

Parse `package.json` and `pnpm-lock.yaml` as data and fail closed on malformed or
unexpected lockfile structure. Assert:

- the override **delta** is exactly the PostCSS replacement, js-yaml 4.x
  replacement, and vulnerable node-server addition; the seven unrelated
  baseline overrides remain byte-for-byte equivalent and the final override map
  has exactly ten entries;
- every targeted package's complete lock snapshot set is at or above the
  security floor and contains no known vulnerable snapshot;
- node-server has exactly one resolved 2.1.0 snapshot across the CLI,
  CopilotKit, and MCP roots;
- provider-utils 3.0.28 remains only on the exact Google Vertex/CopilotKit
  private-example path and is not rewritten to an incompatible major. Prove
  the complete four-snapshot reverse-parent set inside that one Vertex subtree,
  while retaining the parallel safe provider-utils 4.x snapshot;
- complete safe side-lines such as js-yaml 5.x, brace-expansion 5.x, and
  body-parser 2.x remain present rather than being discarded by an
  over-specific vulnerable-version filter;
- the expected package names, versions, importers, and parent identities are
  unique and deterministic.

The test must reject missing records, duplicate/ambiguous identities, unexpected
old and new versions together, wrong override selectors, malformed scalars, and
extra vulnerable snapshots.

- [ ] **Step 3: Add app-anchored Hono/node-server compatibility tests**

Use `createRequire()` anchored separately at `examples/chat/web/package.json`
and `examples/research/web/package.json`. Resolve CopilotKit and MCP through the
real anchors, then use Node 24's `findPackageJSON()` and each package's export
map; `@hono/node-server/package.json` is not exported. Require the actual
`require` target and dynamically import the actual `import` target. Importing
the CJS file through `import()` is not ESM coverage. Resolve MCP's Streamable
HTTP module the same way. Never resolve through `packages/cli`, which is already
on 2.x and would produce a false green.

pnpm exposes the app-facing CopilotKit package through a symlink. After finding
its package manifest from each app anchor, canonicalize that manifest with
`realpathSync()` before creating the nested `createRequire()` or locating
node-server/MCP; repeat that canonicalization for MCP. A nested lookup from the
logical symlink path is an expected false RED, while resolving from the root or
CLI is an expected false green. The export-map resolver accepts the current 1.x
string `require`/`import` branches and the target 2.x nested `default` branches,
rejecting arrays, types-only branches, and unknown shapes. MCP is loaded through
the exact `@modelcontextprotocol/sdk/server/streamableHttp.js` subpath, not its
currently unusable package root.

Cover:

- exact safe version identity at every anchor;
- both ESM and CJS `serve` and `getRequestListener` exports;
- a real Hono HTTP GET and POST/body roundtrip using the app-anchored adapter;
- a real import and construction of MCP's Streamable HTTP server transport;
- both example Next route handlers, invoked with an empty JSON request, returning
  exact status `400` and
  `{"error":"invalid_request","message":"Missing method field"}`;
- deterministic cleanup of servers, ports, timers, and temporary directories.

Set `COPILOTKIT_TELEMETRY_DISABLED=true` before any dynamic import of either
route, avoid static route imports, and restore the prior environment in
`finally`.

- [ ] **Step 4: Run the intended RED**

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts \
  test/security-dependencies/dependency-resolution.test.ts \
  test/security-dependencies/hono-node-server.test.ts
```

Expected RED: the receipt and app anchors report the exact vulnerable versions,
including node-server 1.19.14. API/route controls may already pass and should be
recorded separately from the intended version failures.

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

### Task 4: Add native browser/Windows gates and capture the test-only RED head

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
sentinel header. Always close the server and remove the temporary root. Before
the override, the native Windows control must demonstrate the vulnerable 1.x
adapter serves the secret while bypassing the sentinel.

- [ ] **Step 2: Add one exact safe Windows CI step**

Append after the existing Windows subprocess test:

```yaml
- name: Dependency security regressions
  run: pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/hono-node-server.test.ts test/security-dependencies/hono-serve-static-windows.test.ts
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
closed.

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

- [ ] **Step 7: Commit and push the intentionally failing test-only head**

Run all unaffected controls, prove every new failure is one of the recorded
vulnerable-version/security assertions, and commit:

```text
test(security): cover vulnerable dependency paths
```

Push the branch and open a **draft** PR. Pin the exact test-only head SHA. Let CI
run on that SHA and retain links/results showing:

- native Windows serves `static/admin%5Csecret.txt` with node-server 1.19.14
  while the middleware sentinel is bypassed;
- the app-anchored resolver reports node-server 1.19.14;
- the browser/worker receipts report Mermaid 11.16.0/DOMPurify 3.4.11; and
- the remaining graph receipts report the exact old versions.

The draft is expected to be red and must not be mergeable/ready. A generic test
crash, missing browser primitive, missing dependency, timeout outside the bounded
hostile cases, or unrelated CI failure is not acceptable RED evidence. Do not
apply the dependency fix until the exact Windows run has demonstrated the
native advisory path.

### Task 5: Apply the minimal dependency policy and targeted lock refresh

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Replace the two vulnerable root overrides**

Set:

```json
"postcss": "8.5.23",
"js-yaml@>=4 <4.3.1": "4.3.1"
```

Remove the old PostCSS 8.5.10 and js-yaml 4.2.0 policies. Add a short adjacent
JSON-compatible policy explanation only if the manifest's existing style has a
supported place for it; otherwise document the reason/removal condition in the
audit report rather than inventing an out-of-schema field.

- [ ] **Step 2: Apply the narrow Hono adapter override**

Set:

```json
"@hono/node-server@<2.0.10": "2.1.0"
```

The selector exists because the CopilotKit 1.66.4 and MCP 1.29 declarations
still intersect on vulnerable 1.x. It avoids overriding already-safe future
2.0.10+ versions while making all currently vulnerable ranges resolve to the
same already-used 2.1.0 adapter. Do not choose 2.0.5 through 2.0.9; they have a
separate WebSocket advisory.

- [ ] **Step 3: Refresh only the affected lock resolutions**

Do not use named `pnpm update`: on pnpm 10.33 it rewrites the CLI's direct Hono
range, and `--depth Infinity --no-save` still leaves the vulnerable transitives
unchanged. Instead, temporarily add these exact forcing entries beside the three
persistent policies:

```json
"hono@>=4 <4.12.34": "4.13.1",
"ip-address@>=10 <10.3.1": "10.5.0",
"js-yaml@>=3 <3.15.1": "3.15.1",
"mermaid@>=11 <11.16.1": "11.16.1",
"dompurify@>=3 <3.4.13": "3.4.13",
"nanoid@>=3 <3.3.17": "3.3.18",
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

Remove all nine temporary entries with `apply_patch`, leaving exactly the three
persistent security-policy changes and the seven untouched baseline overrides,
then run `pnpm install --lockfile-only --no-frozen-lockfile` again. The admitted
parent ranges retain the safe lock selections without permanent forcing. Prove
the final root manifest has no temporary selector and that no workspace package
manifest changed.

Review `pnpm-lock.yaml` before installing. Expected resolution set at planning
time:

```text
hono 4.13.1
@hono/node-server 2.1.0 only
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

A newer same-range resolution is acceptable only after updating the exact
receipt test and confirming it is not newly vulnerable. Reject unrelated parent
package upgrades, unrelated importer churn, or a second node-server snapshot.

- [ ] **Step 4: Realize and freeze the new graph**

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

- [ ] **Step 5: Make all new focused tests green**

Run the security dependency project, sandbox proxy test, workflow contracts,
existing CLI Hono tests, and both example route/build controls. Require no skip
except the explicit Windows-only test on non-Windows.

- [ ] **Step 6: Enforce the no-third-outcome Hono decision**

Preferred result: 2.1.0 is green and lands.

Only if 2.1.0 fails, repeat a clean A/B with 2.0.10. `UPSTREAM_BLOCKED` is
allowed only when baseline 1.19.14 passes the corresponding non-security control
and both safe versions reproducibly introduce one of:

- frozen install, peer, or Node 24 engine failure attributable to node-server;
- ESM/CJS, `serve`, or `getRequestListener` incompatibility;
- MCP transport import/runtime failure;
- changed Copilot Next route behavior;
- CLI Hono target/real HTTP regression;
- chat/research build or route-smoke regression; or
- continued Windows secret disclosure.

Semver mismatch alone, an unrelated audit finding, missing Docker/API keys,
Node below 20, or a flaky lane does not qualify. If the threshold is met, remove
the override and stop implementation for a reviewed plan amendment. The
amendment must define this complete alternate outcome before the branch can
continue:

- final override delta contains only the PostCSS/js-yaml replacements; all seven
  unrelated overrides remain unchanged and no Hono override remains;
- the graph receipt requires exactly node-server 1.19.14 at both example/MCP
  anchors plus the CLI's independent 2.1.0, with all compatibility controls
  green;
- the disclosure test is retained as an opt-in evidence probe gated by
  `DAWN_PROBE_VULNERABLE_HONO=1`, not as a passing assertion of vulnerable
  behavior; the audited Windows CI step runs the non-disclosure test only on the
  preferred override path and otherwise runs the API/route compatibility
  controls;
- full/prod audit expectations become the exact multiset
  `{GHSA-866g-f22w-33x8, GHSA-frvp-7c67-39w9}`;
- the audit report records both owned/expiring exceptions, exact sanitized A/B
  logs, and a newly filed or existing upstream CopilotKit issue URL requesting a
  safe node-server range;
- the PR title/body state that #123 remains open; post-merge expected open set is
  `{122,123}` and only the other 25 baseline alerts may be required fixed; and
- independent spec/security reviewers approve the amendment before another
  implementation commit.

Otherwise, node-server 2.1.0 must land, the Windows test must pass, the audit
must contain only provider-utils, and alert #123 must close.

### Task 6: Record the exact remediation and sole upstream exception

**Files:**
- Create: `docs/superpowers/audits/2026-08-10-dependency-remediation.md`

- [ ] **Step 1: Write a human-readable security receipt**

Record:

- pinned base, exact test-only RED SHA, and exact dependency-fix commit SHA (not
  the audit document's own future commit or merge SHA);
- the complete pre-remediation 27-alert set and 30-advisory audit set;
- each package, GHSA/CVE, old version, resolved version, graph root, and test
  surface;
- why each root override exists and its removal trigger;
- exact focused/full/gated commands and results;
- the post-remediation full/prod audit set;
- live Dependabot baseline and pre-merge state;
- the checked-in canonical baseline receipt path and SHA-256 digest;
- publication workflows disabled, zero non-completed runs, and zero
  exact-reviewed-head publication runs, with every historical incident run
  preserved and explicitly classified.

The checked-in document must not promise post-merge facts or contain
self-referential SHA placeholders. Merge-SHA CI, audit, and alert reconciliation
live in a content-addressed Actions artifact after merge; the PR comment only
indexes that artifact. PR3 may later incorporate the receipt into checked-in
release-gate evidence.

Do not paste secrets, URLs with credentials, tokens, ambient proxy values, or
unbounded raw logs.

- [ ] **Step 2: Record the sole preferred exception**

Record `GHSA-866g-f22w-33x8` only, bound to:

```text
package: @ai-sdk/provider-utils
snapshot: 3.0.28
path: examples/*/web -> @copilotkit/runtime -> @ai-sdk/google-vertex
reported severity: low
reachability: unused Vertex response-handler branch in private examples
disposition: UPSTREAM_BLOCKED
owner: @blove
review expiry: 2026-09-10
recheck triggers: patched compatible 3.x, CopilotKit/Google Vertex dependency
  migration, a new reachable import, severity/reachability change, or any Dawn
  Vertex example/use
```

Do not force provider-utils 4.x. Pull request 3 will translate the reviewed
evidence into the machine-readable, exact-set, expiring live-alert exception
gate.

- [ ] **Step 3: Explain why no changeset exists**

State explicitly that persistent manifest changes are private root policy/test
dependencies, lockfile resolutions stay within existing published dependency
ranges, and all Dawn package changes are tests only. If implementation changes a
publishable package's normal dependency or `src/`, stop and add a patch changeset
for that package instead of retaining this conclusion.

### Task 7: Run focused and integration verification under Node 24

**Files:**
- Test: all files changed above
- Test: `packages/cli/test/hono-target.test.ts`
- Test: `packages/cli/test/hono-node-roundtrip.test.ts`
- Test: `scripts/release/test/fault-harness.integration.mjs`

- [ ] **Step 1: Verify exact resolution and audit sets**

Run all `pnpm why`/`pnpm list` receipts again. Then capture full and production
audits with explicit status and schema checks. Preferred exact GHSA set for both
is:

```json
["GHSA-866g-f22w-33x8"]
```

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node scripts/security/dependency-evidence.mjs audit \
  --expected test/security-dependencies/fixtures/audit-provider-utils-only.json \
  --output /tmp/dawn-pr1-audit-after.json
```

Reject a missing expected advisory, any extra advisory, malformed JSON, audit
network/error envelope, non-unique record, contradictory severity counts, or an
unexpected exit status. This task does not dismiss or suppress the advisory.

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
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/chat-web build
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

- [ ] **Step 1: Run the complete local lane serially**

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: every Definition-of-Done and local-only release-script lane passes,
including all three long harness families. Preserve a bounded result summary,
not an unbounded raw log in Git.

- [ ] **Step 2: Re-prove publication containment and change scope**

Require the reviewed reader to reproduce the full Task 1 containment proof at
the exact reviewed branch head while the default branch remains the reviewed
base. This repeats all 21 npm version/attestation reads plus complete workflow,
tag, Release, and Actions-artifact pagination; it is not only a workflow-state
check:

```bash
set -euo pipefail
REVIEWED_HEAD_SHA="$(git rev-parse HEAD)"
REVIEWED_BASE_SHA="$(git rev-parse origin/main)"
node scripts/security/dependency-evidence.mjs baseline \
  --repo cacheplane/dawnai \
  --inventory-ref HEAD \
  --source-sha "$REVIEWED_HEAD_SHA" \
  --expected-default-sha "$REVIEWED_BASE_SHA" \
  --current-version 0.8.21 \
  --target-version 0.8.22 \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --expected-open 122,123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201 \
  --output /tmp/dawn-pr1-reviewed-head-baseline.json
git diff --exit-code origin/main...HEAD -- \
  .github/workflows/release.yml .github/workflows/publish-chart.yml
```

The CI workflow may change only for the audited Windows regression and isolated
Chromium security job. The new receipt-uploader workflow must remain the exact
read-only, manual, allowlisted descriptor from Task 4.

- [ ] **Step 3: Commit in reviewable units**

The approved plan is committed before Task 1. Recommended implementation
commits are:

1. `test(security): cover vulnerable dependency paths`
2. `fix(security): update compatible dependencies`
3. `docs(security): record dependency remediation`

Each commit must pass `git show --check`; no commit or PR text may reference an
assistant implementation tool.

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
full/prod audits, focused tests, and all affected validation. Recapture the
complete live alert baseline against the new base; update and review the
identity fixture's `defaultSha`, the checked-in baseline receipt, and their
digests before accepting the rebased branch. Record the exact reviewed head SHA
and reviewed base SHA, announce an operational main freeze for the merge
window, and require a clean worktree. Auto-merge remains off.

- [ ] **Step 2: Push the fix/evidence commits and finalize the draft PR**

Push the dependency-fix and evidence commits to the existing draft PR from Task
4. Update it with a concise security-focused title and body. Include:

- exact dependency/override changes;
- Hono 2.1 compatibility and native Windows evidence;
- exact post-change audit set;
- why provider-utils remains upstream-blocked;
- why there is no changeset;
- local verification summary;
- explicit statement that publication workflows remain disabled.

Keep it draft until local verification and both independent reviews are green.
Then mark that exact head ready; do not open a second PR and do not discard the
linked test-only RED runs.

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
`test/security-dependencies/fixtures/audit-provider-utils-only.json`. Require
the exact provider-utils-only package/version/GHSA/reported-severity tuple and
empty muted sets. Write one canonical audit receipt to
`/tmp/dawn-pr1-postmerge-audit.json` and compute its SHA-256. Remove the detached
worktree only after proving no scoped process uses it.

- [ ] **Step 3: Produce one stable, bracketed reconciliation receipt**

Run `reconcile` from the detached observation-head checkout. On the preferred
path, expected fixed alerts are
`123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201`
and the exact open set is `{122}`. The reviewed fallback amendment substitutes
the other 25 fixed alerts and exact open set `{122,123}`.

The operation validates the exact PR number, reviewed base/head, merge commit
and parents, observation head, and `merged_at`; verifies CI/CodeQL/Scorecard run
IDs, attempts, heads, and success conclusions; reruns complete publication
containment before and after alert reads; and binds the audit receipt plus every
input fixture by SHA-256. It requires the Dependabot identity fixture's
`defaultSha` to equal the exact reviewed base SHA; it is not compared with the
later post-merge observation head. The audit receipt is not merely referenced: after
schema and fixture validation, its complete normalized full/production status,
package/version/GHSA/reported-severity tuples, severity totals, and explicit
empty muted sets are embedded in the canonical reconciliation receipt. It polls
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
audit { digest, evidence }, dependabot { fixed, open }, publication
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
deadline. Input hashes cover the exact bounded file bytes actually validated.
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
  --expected-fixed 123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201 \
  --expected-open 122 \
  --baseline-receipt docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json \
  --audit-expectation test/security-dependencies/fixtures/audit-provider-utils-only.json \
  --audit-receipt /tmp/dawn-pr1-postmerge-audit.json \
  --wait-timeout-ms 900000 \
  --poll-interval-ms 15000 \
  --max-attempts 61 \
  --output /tmp/dawn-pr1-reconciliation.json
```

Only the Task 5 reviewed A/B failure path may use `{122,123}`. Any timeout,
query/parse/schema error, head drift, mismatched bracketing snapshot, new or
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
contains the validated audit evidence preimage as well as its digest; the
temporary standalone audit file is not the only surviving copy. Recompute the
checked-in baseline digest against the human audit first. Do not modify the
merged audit document or create a self-referential evidence commit.

Publication remains paused after PR1. Do not enable Release, generate a version
candidate, or publish. PR2 fixes Dawn-owned scanner findings; PR3 installs the
dedicated read-only alert credential plus least-privilege exception/release
ownership gates before candidate generation resumes.
