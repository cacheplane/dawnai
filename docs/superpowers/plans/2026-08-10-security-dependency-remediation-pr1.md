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

**Pinned baseline:** `71dfab04e99efe303bd22e36394d68c5862cf502`

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
- Read: `package.json`
- Read: `pnpm-lock.yaml`
- Create: `scripts/security/dependency-evidence.mjs`
- Create: `test/security-dependencies/dependency-evidence.test.ts`
- Create: `test/security-dependencies/fixtures/audit-baseline.json`
- Create: `test/security-dependencies/fixtures/audit-provider-utils-only.json`
- Create: `test/security-dependencies/fixtures/dependabot-baseline.json`
- Create: `test/security-dependencies/vitest.config.ts`
- Create: `test/security-dependencies/tsconfig.json`
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
test "$(git rev-parse origin/main)" = "71dfab04e99efe303bd22e36394d68c5862cf502"
test "$(git merge-base origin/main HEAD)" = "71dfab04e99efe303bd22e36394d68c5862cf502"
test "$(git diff --name-only origin/main...HEAD)" = \
  "docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md"
test -z "$(git status --short)"
```

Expected: every assertion succeeds; the approved plan is the only branch change
above the pinned base. Commit this plan before beginning Task 1. If `origin/main`
moved, stop and rebase/re-review the plan onto the new exact main SHA before
editing; do not refresh a security lock against a stale base.

- [ ] **Step 2: Prove publication is still durably paused**

```bash
set -euo pipefail
test "$(gh api repos/cacheplane/dawnai/actions/workflows/release.yml --jq .state)" = "disabled_manually"
test "$(gh api repos/cacheplane/dawnai/actions/workflows/publish-chart.yml --jq .state)" = "disabled_manually"
gh api --paginate 'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
  | jq -s -e '[.[].workflow_runs[] | select(.status != "completed")] | length == 0'
gh api --paginate 'repos/cacheplane/dawnai/actions/workflows/309127405/runs?per_page=100' \
  | jq -s -e '[.[].workflow_runs[] | select(.status != "completed")] | length == 0'
```

Expected: both workflows are `disabled_manually` and both workflow-wide,
all-page queries return `true`. Any API, pagination, parse, or state ambiguity
blocks the task.

- [ ] **Step 3: Build the bounded evidence reader with TDD**

First add the dedicated repository-root Vitest config described in Task 2 Step
1 and register it in `vitest.workspace.ts`; the missing evidence module is the
first RED. Add focused tests before implementation. The reader exposes three
read-only operations:

- `audit`: executes exact argv for full and production `pnpm audit --json`, with
  one shared wall-clock deadline, stdout/stderr byte caps, no shell, explicit
  exit-code handling, process termination on timeout/overflow, and secret-safe
  errors. It accepts exit `1` only for a parsed audit result with an advisories
  object, no error envelope, record identities present, severity totals equal to
  the record count, and the exact expected package/version/GHSA multiset from a
  contained regular-file fixture supplied with `--expected`. The fixture has
  separate `full` and `production` records and requires an explicit empty
  `muted` array in each mode. Exit `0` is accepted only when both expected sets
  are empty; every other status is an error. A missing `muted` field or any
  non-empty `muted` record fails closed.
- `dependabot`: executes bounded, fixed-argv `gh api` requests for
  `repos/cacheplane/dawnai/dependabot/alerts?state=open&per_page=100&page=N`,
  never follows more than ten pages, stops only on a short page, caps aggregate
  bytes/records/time, and validates exact alert number, state, dependency
  package/manifest/scope, GHSA, dismissal, and timestamps. It rejects duplicate
  records, missing fields, error objects, partial pagination, an unsafe repo, or
  a set different from `--expected-open`.
- `dependabot-fixed`: reads each explicitly supplied alert number by its exact
  REST resource, under the same aggregate bounds, and requires `state=fixed`, a
  null dismissal, unchanged package/manifest/scope/GHSA identity from the
  baseline fixture supplied with `--expected-identities`, and `fixed_at` no
  earlier than `--fixed-since`.

The CLI writes one canonical, redacted JSON receipt to the requested path and
prints only its path/count summary. Tests inject subprocess results and cover
timeout, truncation, nonzero transport, valid finding exit `1`, malformed JSON,
missing/duplicate identities, contradictory totals, page/record limits, partial
pages, and token-like values in errors. It never prints raw stderr or auth
headers.

Run RED before adding the module, then GREEN:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts \
  test/security-dependencies/dependency-evidence.test.ts
```

- [ ] **Step 4: Capture the exact live Dependabot baseline**

Run the reviewed reader with this exact open-number set:

```text
122 123 124 125 160 162 163 164 170 171 172 176 178 179 180 181
191 192 193 194 195 196 197 198 199 200 201
```

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node scripts/security/dependency-evidence.mjs dependabot \
  --repo cacheplane/dawnai \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --expected-open 122,123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201 \
  --output /tmp/dawn-pr1-dependabot-before.json
```

Expected: 27 exact records. Do not infer a clean or smaller set from a failed or
partially paginated query.

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
- Read: `test/security-dependencies/vitest.config.ts`
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

Add `test/security-dependencies/tsconfig.json`, extending the repository's Node
configuration with DOM libs, `noEmit`, and explicit path mappings to the chat
example's React, ReactDOM, and React Core types used by the browser entry.
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
  private-example path and is not rewritten to an incompatible major;
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

- [ ] **Step 4: Update the parsed workflow contracts exactly**

Add the new step at index 6 to both readable allowlist fixtures and to the
hard-coded `testing-windows` descriptor test. Add the complete browser-job
descriptor and every executable to both fixtures. Add mutation regressions
proving that changing a path, adding a shell operator, broadening a test command,
removing the frozen install, or substituting a dynamic action fails closed.

- [ ] **Step 5: Observe workflow-contract RED, then make it green**

Add the workflow step before updating fixtures/tests and run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node --test scripts/release/test/workflow-contracts.test.mjs
```

Expected RED: exact workflow descriptor/allowlist mismatch. After updating all
three contract sources, the focused suite is green and the new adversarial
mutation remains rejected.

- [ ] **Step 6: Commit and push the intentionally failing test-only head**

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
- publication workflow disabled/no-run evidence at the reviewed PR head.

The checked-in document must not promise post-merge facts or contain
self-referential SHA placeholders. Merge-SHA CI, audit, and alert reconciliation
go in an immutable canonical PR comment after merge; PR3 may later incorporate
that receipt into checked-in release-gate evidence.

Do not paste secrets, URLs with credentials, tokens, ambient proxy values, or
unbounded raw logs.

- [ ] **Step 2: Record the sole preferred exception**

Record `GHSA-866g-f22w-33x8` only, bound to:

```text
package: @ai-sdk/provider-utils
snapshot: 3.0.28
path: examples/*/web -> @copilotkit/runtime -> @ai-sdk/google-vertex
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

Require both publication workflows disabled, no non-completed runs, no exact
branch-head publication run, and no diff in either publication workflow:

```bash
git diff --exit-code origin/main...HEAD -- \
  .github/workflows/release.yml .github/workflows/publish-chart.yml
```

The CI workflow may change only for the audited Windows regression and isolated
Chromium security job.

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
full/prod audits, focused tests, and all affected validation. Record the exact
reviewed head SHA and require a clean worktree.

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

Immediately before merge, re-read the exact head SHA, required checks, review
threads, workflow disabled states, and absence of active publication runs. Merge
only that reviewed head using the repository's supported strategy. Record the
resulting full merge SHA.

### Task 10: Verify exact merged-main security state

**Files:**
- Verify: merged `main`
- Verify: GitHub Actions and security APIs
- Verify: npm audit/lock graph

- [ ] **Step 1: Monitor post-merge CI and security runs**

Require the recorded merge SHA to be an ancestor of GitHub's current default
branch. If main advanced, prove the intervening diff does not touch
`package.json`, `pnpm-lock.yaml`, workspace manifests, dependency tests, or
security/publication workflows; otherwise the live reconciliation is
uncorrelated and must be repeated on the newer main. Monitor all runs by exact
merge SHA and require CI, CodeQL, and Scorecard to terminal success.
Release and Publish Chart must remain `disabled_manually` with zero exact-SHA
runs and zero non-completed runs.

- [ ] **Step 2: Re-run exact merged-main graph and audit verification**

Create a clean detached verification worktree at the exact recorded merge SHA;
do not move the implementation worktree or assume current `origin/main` still
equals it. Under Node 24, run frozen install, security dependency tests,
full/prod audits, and focused graph receipts. Require the same exact
provider-utils-only GHSA set as the PR head, then remove the detached worktree
after proving no scoped process still uses it.

- [ ] **Step 3: Reconcile the live Dependabot set fail closed**

On the preferred Hono-override path, poll all 26 expected-fixed alert records
until each reports `state=fixed`, a non-null `fixed_at` at or after the merge,
and no dismissal. On the permitted A/B fallback, poll the other 25 records and
require #123 to remain open and undismissed with the recorded identity. Then
query the entire paginated open set and require exact equality:

```text
preferred: {122}
```

Use the reviewed reader for every poll and the terminal receipts:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node scripts/security/dependency-evidence.mjs dependabot-fixed \
  --repo cacheplane/dawnai \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --numbers 123,124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201 \
  --fixed-since "$MERGED_AT" \
  --output /tmp/dawn-pr1-dependabot-fixed.json
node scripts/security/dependency-evidence.mjs dependabot \
  --repo cacheplane/dawnai \
  --expected-identities test/security-dependencies/fixtures/dependabot-baseline.json \
  --expected-open 122 \
  --output /tmp/dawn-pr1-dependabot-open.json
```

The reviewed fallback amendment substitutes fixed numbers
`124,125,160,162,163,164,170,171,172,176,178,179,180,181,191,192,193,194,195,196,197,198,199,200,201`
and exact open numbers `122,123`.

Only the Task 5 A/B failure path may permit `{122,123}`. Any timeout, query or
parse error, new/reopened alert, dismissed alert, or compatible alert left open
is `UNPROVABLE` and keeps publication blocked.

- [ ] **Step 4: Publish the immutable post-merge receipt and release-hold verdict**

Post one canonical, redacted PR comment containing immutable PR, reviewed head,
merge, exact-SHA CI, CodeQL, Scorecard, detached audit, and live-alert receipt
identifiers/digests, including SHA-256 digests of the checked-in Dependabot
identity fixture, the pre-merge baseline receipt, and both terminal post-merge
receipts. Do not modify the already-merged audit document or create a
self-referential evidence commit. Publication remains paused after PR1. Do not
enable Release, generate a version candidate, or publish. PR2 fixes Dawn-owned
scanner findings; PR3 installs the least-privilege alert/exception and release
ownership gates before candidate generation resumes.
