# Release Controller Main Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the release-controller branch with current `main`, make terminal abandonment unreachable without weakening normal releases, verify the complete fixed-group train, publish it once, and prove the exact production artifacts and website deployment.

**Architecture:** Preserve `main`'s CopilotKit V2 application code and reviewed dependency graph, then isolate abandonment reachability behind one strict structural classifier and schema-v2 owner evidence. The release workflow becomes reconcile-only while dormant abandonment parsers and authority code remain unchanged. External activation and publication happen only after exact-head local/CI/review evidence, with every state transition driven and observed through authenticated CLIs.

**Tech Stack:** Node.js 24.19.0, pnpm 10.33.0, npm 11.17.0, Node test runner, Vitest, Playwright, YAML 2.9, GitHub Actions/CLI, npm CLI, Helm, Vercel CLI 58.9.0.

---

## Execution invariants

- Work only in `/Users/blove/repos/dawn/.worktrees/release-controller-cli` until
  the pull request merges. Do not touch the unrelated file in the primary
  worktree.
- Re-fetch and pin `origin/main` before implementation. If new `main` changes a
  release workflow, controller source, package/chart version, dependency owner,
  or the website SEO inventory, stop and amend the design before proceeding.
- A plan-review containment check found the legacy Release workflow briefly
  active at `fdb57e6e`; it created unmerged Version Packages PR #512 but did not
  publish. It was returned to `disabled_manually` through the GitHub CLI on
  2026-08-28. Preserve #512 unmerged and revalidate it only after the switch.
- Keep `.github/workflows/release.yml` and
  `.github/workflows/publish-chart.yml` manually disabled until after merge and
  strict pre-enable evidence.
- Do not add dependency overrides, compatibility shims, or a replacement for the
  real `vercel-native` job.
- Preserve exact `vercel: "58.9.0"` in `packages/cli/package.json` and direct
  `@ag-ui/client: "0.0.57"` at every type-facing owner.
- Never delete, move, or reuse a controller `v*` tag. After any npm package is
  accepted, recovery resumes the same exact candidate; unpublish and a new
  version are forbidden.
- Evidence under `.dawn/release-cutover/` is private, write-once, and never
  committed.
- No changeset is expected: the only publishable-package dependency edit is a
  development dependency, while the remaining changes affect private examples,
  tests, workflow ownership, and documentation.

Use this exact toolchain prefix for local gates:

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

## File map

### Create

- `scripts/release/abandonment-reachability.mjs` — strict structural
  classification and aggregate reachability.
- `scripts/release/test/abandonment-reachability.test.mjs` — disabled,
  protected, invalid, and aggregate classifier coverage.

### Reconcile to current `main`

- `examples/chat/web/package.json`
- `examples/research/web/package.json`
- `packages/ag-ui/package.json`
- `examples/chat/web/app/page.tsx`
- `examples/research/web/app/page.tsx`
- `examples/research/web/app/components/AppShell.tsx`
- `examples/research/web/app/components/ToolCallCard.tsx`
- `test/security-dependencies/dependency-resolution.test.ts`
- `test/security-dependencies/copilotkit-v2-runtime.test.ts`
- `test/security-dependencies/mermaid-browser.spec.ts`
- `test/security-dependencies/mermaid-rendering.test.ts`
- `docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md`
- `docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md`
- `pnpm-lock.yaml`

### Implement disabled abandonment

- `scripts/release/preflight-owner-adapters.mjs` — exact bounded GitHub reads for
  main, managed tags, tag peeling, workflow content, and nonterminal runs.
- `scripts/release/preflight-owner.mjs` — schema-v2 canonical evidence capture,
  normalization, and strict verification.
- `scripts/release/test/preflight-owner-adapters.test.mjs`
- `scripts/release/test/preflight-owner.test.mjs`
- `scripts/release/test/preflight-owner-cli.test.mjs`
- `.github/workflows/release.yml` — reconcile-only dispatch surface and jobs.
- `scripts/release/test/workflow-contracts.test.mjs`
- `scripts/release/test/fixtures/workflow-entrypoints.json`
- `scripts/release/test/fixtures/workflow-safe-executables.json`
- `docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md`
- `docs/thread-handoff.md`
- `docs/superpowers/specs/2026-08-09-release-integrity-controller-design.md`
- `docs/superpowers/plans/2026-08-09-release-integrity-controller-pr2.md`

### Preserve unchanged

- `scripts/release/controller-schema.json`, including schema version 1 and
  `abandonmentEnvironment: "release-abandonment"`.
- Owner-preflight report schema version 1 and existing workflow-fixture schema
  versions.
- `scripts/release/cli.mjs` commands `abandon` and `abandonment-context`, all
  abandonment authority/record/parsing modules, and their runtime tests.
- Every CopilotKit `/v2` import, catch-all handler, multi-route provider, and
  browser test.
- `packages/devkit/templates/app-research/**`; it already owns the selected
  `1.68.3`/AG-UI `0.0.57` scaffold.
- The website production-only TypeScript configuration and its focused test.
- `packages/cli/package.json`, Vercel lock importer, native deployment harness,
  and CI job.

### Task 1: Integrate and pin the latest `main`

**Files:**
- Merge: current `origin/main`
- Modify: `docs/superpowers/specs/2026-08-27-release-controller-main-reconciliation-design.md`

- [ ] **Step 1: Prove the worktree and branch are safe**

```bash
git status --short --branch
git branch --show-current
git fetch origin main --tags --prune
git rev-parse HEAD
git rev-parse origin/main
```

Expected: clean worktree except the approved plan/spec edits, branch
`blove/release-controller-cli`, and a full 40-character remote-main SHA.

- [ ] **Step 2: Reassess incoming files before merging**

```bash
git log --oneline HEAD..origin/main
git diff --name-status HEAD...origin/main
git merge-tree "$(git merge-base HEAD origin/main)" HEAD origin/main
```

Expected for the final 2026-08-28 snapshot: Vercel-native
diagnostics/readiness, package test-typecheck coverage, and the changeset-copy
correction in `fdb57e6e`; no controller, workflow, dependency-owner,
chart-version, or website-inventory change. Stop if that expectation changes.

- [ ] **Step 3: Re-prove containment after the fetch**

Require Release and Publish Chart `disabled_manually`, Published Artifact
Verification active, no `v*` tag, no nonterminal Release run, Immutable Releases
false, and Version Packages PR #512 (if still present) open, unmerged, and with
auto-merge disabled. The legacy run `33224111709` is historical evidence only.
If Release has become active again, stop and re-establish the same no-tag,
no-run, no-publication proof before disabling it again through the GitHub CLI.
Never close, force-push, or merge #512 during containment.

- [ ] **Step 4: Commit this approved plan and spec correction**

```bash
git add \
  docs/superpowers/specs/2026-08-27-release-controller-main-reconciliation-design.md \
  docs/superpowers/plans/2026-08-28-release-controller-main-reconciliation.md
git diff --cached --check
git commit -m "docs(release): plan main reconciliation"
```

- [ ] **Step 5: Merge the pinned remote head**

```bash
git merge --no-edit origin/main
```

Resolve only genuine overlap with `apply_patch`; preserve both the incoming
Vercel test fixes and branch website build configuration. Record the exact merge
and remote-main SHAs in the design's dated evidence section if they differ from
the current snapshot.

- [ ] **Step 6: Verify the integrated baseline**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" pnpm install --frozen-lockfile
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" pnpm typecheck
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" pnpm test:release-controller
```

Expected: install/build/typecheck/controller green. The known research scaffold
parity failure remains the only accepted red test before Task 2.

- [ ] **Step 7: Commit the exact integration receipt**

After recording the actual merge and pinned remote-main SHAs with `apply_patch`,
stage and commit that dated evidence so later clean-tree gates remain meaningful:

```bash
git add docs/superpowers/specs/2026-08-27-release-controller-main-reconciliation-design.md
git diff --cached --check
if ! git diff --cached --quiet; then
  git commit -m "docs(release): record latest main integration"
fi
test -z "$(git status --porcelain)"
```

### Task 2: Restore the reviewed CopilotKit graph and scaffold parity

**Files:** the fourteen paths in “Reconcile to current `main`” above.

- [ ] **Step 1: Capture the existing parity failure**

```bash
pnpm --filter @dawn-ai/devkit exec vitest --run \
  --config vitest.config.ts test/templates.test.ts \
  -t 'keeps the complete research web tree in byte-for-byte parity'
```

Expected: FAIL listing only `AppShell.tsx`, `ToolCallCard.tsx`, and `page.tsx`.

- [ ] **Step 2: Change the dependency receipts first**

With `apply_patch`, restore every branch-only range/version assertion in the four
security test files to `^1.68.3`/`1.68.3`, and remove the assertion requiring
`next typegen` from `mermaid-rendering.test.ts`. Preserve the no-override,
AG-UI-generation, and private provider-utils confinement checks.

- [ ] **Step 3: Prove the changed receipts are red against the old graph**

```bash
pnpm exec vitest --run \
  --config test/security-dependencies/vitest.config.ts \
  test/security-dependencies/dependency-resolution.test.ts \
  test/security-dependencies/copilotkit-v2-runtime.test.ts \
  test/security-dependencies/mermaid-rendering.test.ts
```

Expected: FAIL because manifests/lock/runtime still report `1.69.0`.

- [ ] **Step 4: Apply the minimal manifest, comment, and historical-doc changes**

With `apply_patch`:

- restore both example typecheck scripts to `tsc -p . --noEmit`;
- restore both example CopilotKit owners and the `packages/ag-ui` development
  owner to `^1.68.3`;
- keep direct AG-UI exactly `0.0.57` and the optional React Core peer
  `>=1.66.0`;
- restore version-only comments in the five example source locations; and
- reverse only the `1.69.0` refresh in the two historical V2 documents.

Do not alter executable V2 code or the research scaffold.

- [ ] **Step 5: Regenerate only the CopilotKit lock closure**

Use pnpm 10.33.0. Force each direct owner to `1.68.3`, then restore the manifest
ranges to `^1.68.3` if pnpm rewrites them:

```bash
pnpm --dir examples/chat/web update --lockfile-only --save=false --depth 0 \
  @copilotkit/react-core@1.68.3 @copilotkit/runtime@1.68.3
pnpm --dir examples/research/web update --lockfile-only --save=false --depth 0 \
  @copilotkit/react-core@1.68.3 @copilotkit/runtime@1.68.3
pnpm --dir packages/ag-ui update --lockfile-only --save=false --depth 0 \
  @copilotkit/react-core@1.68.3
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

Require the final fourteen files to equal `origin/main` exactly. No Vercel,
Hono, provider-utils, AG-UI, or unrelated importer may change.

```bash
git diff --exit-code origin/main -- \
  examples/chat/web/package.json \
  examples/research/web/package.json \
  packages/ag-ui/package.json \
  examples/chat/web/app/page.tsx \
  examples/research/web/app/page.tsx \
  examples/research/web/app/components/AppShell.tsx \
  examples/research/web/app/components/ToolCallCard.tsx \
  test/security-dependencies/dependency-resolution.test.ts \
  test/security-dependencies/copilotkit-v2-runtime.test.ts \
  test/security-dependencies/mermaid-browser.spec.ts \
  test/security-dependencies/mermaid-rendering.test.ts \
  docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md \
  docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md \
  pnpm-lock.yaml
```

- [ ] **Step 6: Run the focused green gates**

```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm exec playwright test --config test/security-dependencies/playwright.config.ts
pnpm --filter @dawn-ai/devkit test
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/research-web typecheck
pnpm --filter @dawn-ai/web exec vitest --run \
  --config vitest.config.ts app/production-build-config.test.ts
node --test scripts/release/test/workflow-contracts.test.mjs
```

Expected: all green; research example/scaffold parity restored; V2 imports and
the real Vercel job still present.

- [ ] **Step 7: Commit the narrow reconciliation**

```bash
git add \
  examples/chat/web examples/research/web packages/ag-ui/package.json \
  test/security-dependencies \
  docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md \
  docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md \
  pnpm-lock.yaml
git diff --cached --check
git commit -m "chore(examples): align CopilotKit graph with main"
```

### Task 3: Add strict structural abandonment classification

**Files:**
- Create: `scripts/release/abandonment-reachability.mjs`
- Create: `scripts/release/test/abandonment-reachability.test.mjs`

- [ ] **Step 1: Write the classifier tests**

Cover exact reconcile-only bytes, a synthetic exact protected surface, every
partial/mixed surface, malformed YAML, duplicate keys, aliases, placeholder
YAML, an abandonment executable outside the protected job, and aggregate mode.
The intended public surface is:

```js
export function classifyReleaseWorkflowAbandonment(bytes, {
  abandonmentEnvironment,
})

export function aggregateReleaseWorkflowAbandonment(modes)
```

Classification returns only `disabled` or `protected`; remote absence is a
separate evidence status. Aggregation accepts `absent`, `disabled`, and
`protected`, returns protected if any reachable ref is protected, and rejects
invalid/unavailable input.

- [ ] **Step 2: Run the new tests and observe RED**

```bash
node --test scripts/release/test/abandonment-reachability.test.mjs
```

Expected: FAIL because the module/exports do not exist.

- [ ] **Step 3: Implement the smallest fail-closed classifier**

Parse with YAML's unique-key enforcement and aliases disabled. Snapshot parsed
data before inspecting it. Require these exact projections:

```js
const disabledInputs = ["version", "commitSha", "operation"]
const disabledOperationOptions = ["reconcile"]
const protectedInputs = ["version", "commitSha", "operation", "reason"]
const protectedOperationOptions = ["reconcile", "abandon"]
```

Disabled mode has no `reason`, no `abandon` job, no abandon-only tag branch, and
no `abandonment-context`/`cli.mjs abandon` executable anywhere. Protected mode
requires the existing environment, exact identity/state gate, protected
permissions, intent validation, tag branch, and both CLI executable descriptors.
Anything between those exact surfaces throws.

- [ ] **Step 4: Run RED-to-GREEN and regression tests**

```bash
node --test scripts/release/test/abandonment-reachability.test.mjs
node --test scripts/release/test/workflow-contracts.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/release/abandonment-reachability.mjs \
  scripts/release/test/abandonment-reachability.test.mjs
git commit -m "feat(release): classify abandonment workflow reachability"
```

### Task 4: Add bounded ref/run-aware owner reads

**Files:**
- Modify: `scripts/release/preflight-owner-adapters.mjs`
- Modify: `scripts/release/test/preflight-owner-adapters.test.mjs`

- [ ] **Step 1: Write adapter contract tests**

Add tests for exact argv-based reads, complete pagination, response bounds,
duplicate refs/runs, malformed tag peeling, malformed content, authentication
redaction, and malformed successful output. Expose named methods only:

```js
github.getDefaultBranchRef(repository, branch)
github.listManagedCandidateRefs(repository)
github.getAnnotatedTag(repository, tagObjectSha)
github.getWorkflowContent(repository, workflowPath, commitSha)
github.listReleaseRuns(repository, workflowPath, status)
```

- [ ] **Step 2: Run the adapter tests and observe RED**

```bash
node --test scripts/release/test/preflight-owner-adapters.test.mjs
```

- [ ] **Step 3: Implement the exact read surfaces**

Use bounded `gh api --paginate --slurp` where pagination applies and only these
REST resources. Encode the workflow ID as the single path segment
`.github%2Fworkflows%2Frelease.yml`; do not interpolate an unencoded workflow
path into a URL:

```text
GET /repos/{repo}/git/ref/heads/main
GET /repos/{repo}/git/matching-refs/tags/v?per_page=100
GET /repos/{repo}/git/tags/{tagObjectSha}
GET /repos/{repo}/contents/.github/workflows/release.yml?ref={commitSha}
GET /repos/{repo}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?status={status}&per_page=100
```

Query `in_progress`, `pending`, `queued`, `requested`, and `waiting`. Validate
at most 100 pages and 10,000 records for the matching-ref read, and at most 100
pages and 10,000 records for each run status (50,000 run records total before
cross-status deduplication). Reject rather than truncate at either bound.
Validate identity uniqueness, exact file path, a maximum decoded workflow size
of 2 MiB, canonical base64, tag-object type, and commit peel before returning
normalized values. Keep the existing 2 MiB command-output bound and 15-second
per-command timeout; a paginated response that cannot fit those bounds is
`UNPROVABLE`, never partial evidence.

- [ ] **Step 4: Run the adapter suite GREEN**

```bash
node --test scripts/release/test/preflight-owner-adapters.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/release/preflight-owner-adapters.mjs \
  scripts/release/test/preflight-owner-adapters.test.mjs
git commit -m "feat(release): add ref-aware owner evidence reads"
```

### Task 5: Upgrade owner evidence to canonical schema version 2

**Files:**
- Modify: `scripts/release/preflight-owner.mjs`
- Modify: `scripts/release/test/preflight-owner.test.mjs`
- Modify: `scripts/release/test/preflight-owner-cli.test.mjs`

- [ ] **Step 1: Write schema-v2 capture and verification tests**

Add coverage for:

- disabled capture stores `abandonmentEnvironment: null` and never calls the
  environment adapter;
- protected capture preserves the current exact reviewer protection;
- schema version 1 is rejected without migration;
- remote main equals local HEAD and remote workflow bytes equal the local file;
- managed refs are sorted, annotated-tag peeled, and content-bound;
- nonterminal runs are complete, unique, sorted, and initially empty;
- pre-enable requires two disabled/two active workflows;
- post-enable requires all four active;
- disabled/protected/unavailable/inconsistent evidence cannot be confused; and
- structural failure aborts capture before the CLI creates its exclusive output.

- [ ] **Step 2: Run the owner suites and observe RED**

```bash
node --test \
  scripts/release/test/abandonment-reachability.test.mjs \
  scripts/release/test/preflight-owner-adapters.test.mjs \
  scripts/release/test/preflight-owner.test.mjs \
  scripts/release/test/preflight-owner-cli.test.mjs
```

- [ ] **Step 3: Implement the canonical v2 shape**

Keep existing top-level fields and report schema. Extend `github` exactly as:

```js
{
  repository,
  workflows,
  abandonmentMode: "disabled" | "protected",
  remoteDefaultBranch: {
    ref: "refs/heads/main",
    commitSha,
    workflow: { status: "present", path, sha256, mode },
  },
  managedCandidateRefs: [{
    ref,
    object: { type: "tag", sha },
    peeledCommitSha,
    workflow: { status, path, sha256, mode },
  }],
  nonterminalReleaseRuns: [{
    id, runAttempt, status, event, headSha, headBranch,
  }],
  abandonmentEnvironment: null | environmentEvidence,
  immutableReleases,
}
```

Keep fixed file/package/workflow ordering; sort refs lexically and runs by
numeric ID then attempt; reject duplicates and extras.

- [ ] **Step 4: Implement capture in authority-safe order**

Capture must classify local bytes before remote calls, bind remote `main`, fetch
and classify its workflow, enumerate and peel all managed tags, fetch each tag's
workflow or exact absence, collect all five nonterminal statuses, recompute the
aggregate, and only then read the environment when aggregate mode is protected.
Unreadable or structurally invalid evidence aborts without an output file.

- [ ] **Step 5: Implement strict verification checks**

Add `remote-default-branch`, `abandonment-reachability`,
`managed-candidate-refs`, and `nonterminal-release-runs` checks. Initial pre/post
cutover requires aggregate disabled, `managedCandidateRefs: []`, and
`nonterminalReleaseRuns: []`.

Workflow topology is exact:

| Workflow | Pre-enable | Post-enable |
|---|---|---|
| `version-pr.yml` | `active` | `active` |
| `release.yml` | `disabled_manually` | `active` |
| `published-artifact-verify.yml` | `active` | `active` |
| `publish-chart.yml` | `disabled_manually` | `active` |

- [ ] **Step 6: Run the owner suites GREEN**

```bash
node --test \
  scripts/release/test/abandonment-reachability.test.mjs \
  scripts/release/test/preflight-owner-adapters.test.mjs \
  scripts/release/test/preflight-owner.test.mjs \
  scripts/release/test/preflight-owner-cli.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add scripts/release/preflight-owner.mjs \
  scripts/release/test/preflight-owner.test.mjs \
  scripts/release/test/preflight-owner-cli.test.mjs
git commit -m "feat(release): verify ref-aware owner evidence v2"
```

### Task 6: Switch the release workflow atomically to reconcile-only

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release/test/workflow-contracts.test.mjs`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`
- Modify: `scripts/release/test/fixtures/workflow-safe-executables.json`
- Modify: four live-contract documents listed in the file map.

- [ ] **Step 1: Write the reconcile-only workflow assertions**

Require inputs exactly `commitSha`, `operation`, `version`; options exactly
`["reconcile"]`; no `reason`; no `abandon` job/environment; no abandon-only tag
branch; and no abandonment executable. Require the production classifier to
classify actual `release.yml` as disabled. Remove `abandon` from the expected
final job list.

- [ ] **Step 2: Run the focused contract tests and observe RED**

```bash
node --test \
  --test-name-pattern='release.yml|tag is|abandonment unreachable|workflow entrypoints|workflow audit' \
  scripts/release/test/workflow-contracts.test.mjs
```

- [ ] **Step 3: Apply the minimal workflow change**

With `apply_patch`:

- make the operation description reconcile-only and leave one option;
- remove `reason` and the manual-intent validation step;
- remove `OPERATION` and the abandonment branch from tag routing; and
- remove the complete `abandon` job.

Do not change reconcile gates, the global queue, tag writer, npm publication,
smoke fan-out, independent audit, or Release publication.

- [ ] **Step 4: Manually transcribe the two exact fixtures**

Keep fixture schema versions unchanged. In `workflow-entrypoints.json`, remove
`reason`, the validation step, and the abandon job; set operation options to one.
In `workflow-safe-executables.json`, remove validation and four abandonment
entries, shift the affected tag indexes, and copy the final reconcile-only route
body exactly. Expected Release inventory: 18 jobs and 120 executable entries.

Do not change `release-script-hashes.json`; retained `cli.mjs` bytes remain
reachable through reconciliation.

- [ ] **Step 5: Update the live operating contract**

- Runbook: owner evidence v2, exact four-workflow topology, post-merge
  pre-enable capture, and stop/preserve/escalate instead of runnable abandonment.
- Thread handoff: workflow abandonment unreachable; retained code is dormant or
  historical only.
- Original controller design/PR2 plan: partial-supersession banners linking the
  two approved 2026-08-25/27 specs; do not rewrite history.

- [ ] **Step 6: Run workflow, dormant-runtime, and docs regression gates**

```bash
node --test scripts/release/test/workflow-contracts.test.mjs
node --test \
  scripts/release/test/abandonment-authority.test.mjs \
  scripts/release/test/abandonment-handoff.test.mjs \
  scripts/release/test/abandonment.test.mjs \
  scripts/release/test/candidate.test.mjs \
  scripts/release/test/controller.test.mjs \
  scripts/release/test/evidence.test.mjs \
  scripts/release/test/observe-production.test.mjs \
  scripts/release/test/planner.test.mjs \
  scripts/release/test/terminal-records.test.mjs
node scripts/check-docs.mjs
```

Also require this search to return no reachable workflow/fixture match:

```bash
rg -n 'abandonment-context|cli\.mjs abandon|inputs\.reason|release-abandonment' \
  .github/workflows/release.yml \
  scripts/release/test/fixtures/workflow-entrypoints.json \
  scripts/release/test/fixtures/workflow-safe-executables.json
```

- [ ] **Step 7: Commit the atomic switch**

```bash
git add .github/workflows/release.yml \
  scripts/release/test/workflow-contracts.test.mjs \
  scripts/release/test/fixtures/workflow-entrypoints.json \
  scripts/release/test/fixtures/workflow-safe-executables.json \
  docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md \
  docs/thread-handoff.md \
  docs/superpowers/specs/2026-08-09-release-integrity-controller-design.md \
  docs/superpowers/plans/2026-08-09-release-integrity-controller-pr2.md
git diff --cached --check
git commit -m "ci(release): make abandonment workflow unreachable"
```

### Task 7: Run complete local verification and fixed-group recovery rehearsal

**Files:** none expected; generated evidence stays ignored.

- [ ] **Step 1: Prove exact tools and a clean source tree**

```bash
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
test "$(npm --version)" = "11.17.0"
git status --short
pnpm install --frozen-lockfile
```

- [ ] **Step 2: Run the full Definition of Done**

```bash
DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: every gate in root `ci:validate` passes with no required Docker skip.

- [ ] **Step 3: Run the complete dependency-security lanes**

```bash
install -d -m 0700 .dawn/release-cutover
node scripts/security/dependency-evidence.mjs audit \
  --expected test/security-dependencies/fixtures/audit-upstream-boundaries.json \
  --output ".dawn/release-cutover/dependency-security-$(date -u +%Y%m%dT%H%M%SZ).json"
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm exec playwright install chromium
pnpm exec playwright test --config test/security-dependencies/playwright.config.ts
```

Expected: only the reviewed upstream boundaries remain; no browser skip.

- [ ] **Step 4: Run fault and full fixed-group rehearsal**

```bash
pnpm test:release-fault-harness
pnpm release:rehearse -- \
  --inventory fixed-group \
  --inject after-publish:11 \
  --resume
```

Require 21 packages, 45 base assets, five smoke assets, immutable Release true,
registry verification, injected failure after package 11, escrow-based resume,
independent audit completion, and a clean third-run no-op.

- [ ] **Step 5: Verify preservation boundaries and cleanliness**

```bash
git diff --check
git status --short
git diff origin/main...HEAD -- packages/cli/package.json .github/workflows/ci.yml
```

Expected: clean tree; exact Vercel owner and native lane retained.

### Task 8: Push the final head, run every CI lane, and obtain fresh Copilot review

**Files:** none unless review feedback is accepted through a new tested commit.

- [ ] **Step 1: Push and bind PR 493 to the exact head**

```bash
git push origin blove/release-controller-cli
final_head_sha="$(git rev-parse HEAD)"
test "$(gh pr view 493 -R cacheplane/dawnai --json headRefOid --jq .headRefOid)" = "$final_head_sha"
```

- [ ] **Step 2: Require the full PR check matrix**

```bash
gh pr checks 493 -R cacheplane/dawnai --watch --interval 15
gh pr checks 493 -R cacheplane/dawnai --json name,state,bucket,workflow
```

Require successful `changesets`, `validate`, `testing-windows`,
`dependency-security-browser`, all Docker/Kubernetes/Postgres/pgvector lanes,
`edge-workerd`, `copilotkit-examples-e2e`, `vercel-native`, `inspector-e2e`, all
chart lanes, CodeQL, and Vercel preview. The native Vercel job must run, not skip.

- [ ] **Step 3: Request a fresh Copilot review through the CLI**

```bash
gh api --method POST \
  repos/cacheplane/dawnai/pulls/493/requested_reviewers \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
gh api --paginate --slurp repos/cacheplane/dawnai/pulls/493/reviews | \
  jq --arg sha "$final_head_sha" \
    '[.[][] | select(.user.login == "copilot-pull-request-reviewer[bot]" and .commit_id == $sha)] | last'
```

Require a review object for the exact final SHA. Inspect review comments and
GraphQL review threads for the same login; require no unresolved actionable
finding. A stale review on an earlier commit is not a receipt.

- [ ] **Step 4: Apply feedback only after technical verification**

For each finding, reproduce it, accept only valid changes, add a regression test
first, implement minimally, and rerun Tasks 7–8. Any new commit invalidates all
previous head-bound checks and review.

- [ ] **Step 5: Freeze the merge candidate**

Record the exact PR head, current `origin/main`, mergeability, all checks, and
review receipt under the private cutover directory. Stop if `main` moves before
merge; fetch, merge, and repeat the relevant plan tasks.

### Task 9: Merge safely and activate the controller

**Files:** no source changes. Use a clean detached cutover worktree at the exact
merge SHA.

- [ ] **Step 1: Verify pre-merge live state through the CLI**

Require Release and Publish Chart `disabled_manually`, Published Artifact
Verification active, Version Packages absent from deployed `main`, Immutable
Releases disabled, zero `v*` tags, and zero nonterminal Release runs. Here
"Version Packages absent" means the standalone workflow file/registry entry;
the contained legacy-created PR #512 may remain open but must be unmerged,
without auto-merge, and unchanged by the operator.

- [ ] **Step 2: Merge only the reviewed PR head**

```bash
gh pr merge 493 -R cacheplane/dawnai --merge --match-head-commit "$final_head_sha"
switch_sha="$(gh pr view 493 -R cacheplane/dawnai --json mergeCommit --jq .mergeCommit.oid)"
git fetch origin main --tags --prune
test "$(git rev-parse origin/main)" = "$switch_sha"
```

Version Packages may now create or update its pull request; do not merge it.

- [ ] **Step 3: Create an exact detached cutover checkout**

```bash
git worktree add --detach \
  /Users/blove/repos/dawn/.worktrees/release-cutover-0.8.22 \
  "$switch_sha"
cd /Users/blove/repos/dawn/.worktrees/release-cutover-0.8.22
test "$(git rev-parse HEAD)" = "$switch_sha"
pnpm install --frozen-lockfile
```

Run all following commands from that worktree root. Require Version Packages and
Published Artifact Verification active while Release and Publish Chart remain
manually disabled. The frozen install is mandatory because owner preflight
imports the repository-pinned `yaml` package; never resolve it through another
worktree's dependency tree.

- [ ] **Step 4: Capture strict pre-enable evidence**

```bash
install -d -m 0700 .dawn/release-cutover
cutover_pre_file=".dawn/release-cutover/pre-enable-$(date -u +%Y%m%dT%H%M%SZ).json"
node scripts/release/preflight.mjs capture \
  --phase pre-enable \
  --repository cacheplane/dawnai \
  --output "$cutover_pre_file"
node scripts/release/preflight.mjs verify \
  --phase pre-enable \
  --evidence "$cutover_pre_file" \
  --head-sha "$switch_sha" \
  --format markdown \
  --strict
```

Require disabled aggregate mode, exact two-disabled/two-active topology, no
environment read, zero managed refs, and zero nonterminal Release runs.

- [ ] **Step 5: Enable and re-read Immutable Releases**

```bash
gh api --method PUT \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/cacheplane/dawnai/immutable-releases \
  --include
gh api \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/cacheplane/dawnai/immutable-releases \
  --jq '.enabled'
```

Require PUT HTTP 204 and GET `true`. Before enabling either mutator, define the
pre-publication rollback in the same cutover shell:

```bash
disable_mutators_before_publication() {
  local rollback_failed=0
  gh workflow disable release.yml -R cacheplane/dawnai || rollback_failed=1
  gh workflow disable publish-chart.yml -R cacheplane/dawnai || rollback_failed=1
  test "$(gh api \
    repos/cacheplane/dawnai/actions/workflows/release.yml \
    --jq .state)" = "disabled_manually" || rollback_failed=1
  test "$(gh api \
    repos/cacheplane/dawnai/actions/workflows/publish-chart.yml \
    --jq .state)" = "disabled_manually" || rollback_failed=1
  return "$rollback_failed"
}
```

Immutable Releases is deliberately not rolled back. From the first workflow
enable through the last pre-dispatch gate, any failure invokes this function and
stops. Once the dispatch POST is sent, do not disable immediately: use Step 7's
exact run-job and registry evidence first. Do not cancel a run or delete any
ref, draft, or evidence it created. If npm acceptance cannot be ruled out,
preserve the exact candidate and switch to the post-publication recovery rule
instead of disabling it blindly. A malformed or missing direct dispatch receipt
does not authorize listing recent runs to guess an ID and does not prove that no
run started; preserve evidence and stop with the workflow state unchanged.

Only after the helper exists, enable both mutators as one guarded operation:

```bash
if ! {
  gh workflow enable release.yml -R cacheplane/dawnai &&
  gh workflow enable publish-chart.yml -R cacheplane/dawnai &&
  test "$(gh api \
    repos/cacheplane/dawnai/actions/workflows/release.yml \
    --jq .state)" = "active" &&
  test "$(gh api \
    repos/cacheplane/dawnai/actions/workflows/publish-chart.yml \
    --jq .state)" = "active"
}; then
  disable_mutators_before_publication
  exit 1
fi
```

- [ ] **Step 6: Capture strict post-enable evidence**

Require unchanged remote main and all four workflows active, then capture and
verify a new write-once `post-enable` file. Make failure disable both mutators:

```bash
cutover_post_file=".dawn/release-cutover/post-enable-$(date -u +%Y%m%dT%H%M%SZ).json"
if ! {
  test "$(gh api repos/cacheplane/dawnai/git/ref/heads/main \
    --jq .object.sha)" = "$switch_sha" &&
  node scripts/release/preflight.mjs capture \
    --phase post-enable \
    --repository cacheplane/dawnai \
    --output "$cutover_post_file" &&
  node scripts/release/preflight.mjs verify \
    --phase post-enable \
    --evidence "$cutover_post_file" \
    --head-sha "$switch_sha" \
    --format markdown \
    --strict
}; then
  disable_mutators_before_publication
  exit 1
fi
```

Stop on a moving SHA, expired evidence, any ref/run, or unexpected candidate
state; the guarded failure path leaves Release and Publish Chart disabled.

- [ ] **Step 7: Dispatch the mandatory no-candidate reconciliation**

Derive the current inventory at `switch_sha` (expected `0.8.21`) and build the
exact request without interpolating JSON in the shell:

```bash
umask 077
set -o noclobber
dispatch_attempt="$(date -u +%Y%m%dT%H%M%SZ)-$$"
dispatch_dir=".dawn/release-cutover/no-candidate-$switch_sha-$dispatch_attempt"
inventory_file="$dispatch_dir/inventory.json"
npm_baseline_file="$dispatch_dir/npm-before.json"
dispatch_request_file="$dispatch_dir/request.json"
dispatch_http_file="$dispatch_dir/dispatch-http.txt"
dispatch_receipt_file="$dispatch_dir/dispatch-receipt.json"
capture_registry_snapshot() {
  node --input-type=module - "$inventory_file" "$1" <<'NODE'
import { execFileSync } from "node:child_process"
import fs from "node:fs"
const [inventoryFile, outputFile] = process.argv.slice(2)
const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8"))
const packages = [...inventory.packages].sort()
const snapshot = packages.map((name) => {
  const value = JSON.parse(execFileSync(
    "npm", ["view", name, "versions", "dist-tags", "--json"],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  ))
  if (!Array.isArray(value.versions) || value["dist-tags"] === null ||
      typeof value["dist-tags"] !== "object" || Array.isArray(value["dist-tags"])) {
    throw new Error(`registry response for ${name} is malformed`)
  }
  return {
    name,
    versions: [...value.versions].sort(),
    distTags: Object.fromEntries(Object.entries(value["dist-tags"]).sort()),
  }
})
fs.writeFileSync(outputFile, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 })
NODE
}
if ! {
  mkdir -m 0700 "$dispatch_dir" &&
  node scripts/release/check-inventory.mjs --ref "$switch_sha" --json \
    > "$inventory_file" &&
  current_version="$(node -e \
    'const x=require(process.argv[1]);if(x.packages.length!==21)process.exit(1);process.stdout.write(x.version)' \
    "./$inventory_file")" &&
  test "$current_version" = "0.8.21" &&
  capture_registry_snapshot "$npm_baseline_file" &&
  node -e \
    'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({ref:"main",inputs:{version:process.argv[2],commitSha:process.argv[3],operation:"reconcile"}})+"\n",{flag:"wx",mode:0o600})' \
    "$dispatch_request_file" "$current_version" "$switch_sha"
}; then
  disable_mutators_before_publication
  exit 1
fi

# The request boundary starts here. A failed/ambiguous POST no longer proves
# that publication is absent, so it must not call the pre-publication rollback.
if ! gh api --method POST --include \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/cacheplane/dawnai/actions/workflows/.github%2Fworkflows%2Frelease.yml/dispatches \
  --input "$dispatch_request_file" > "$dispatch_http_file"; then
  exit 1
fi
if ! node --input-type=module - "$dispatch_http_file" "$dispatch_receipt_file" <<'NODE'
import fs from "node:fs"
const [httpFile, receiptFile] = process.argv.slice(2)
const raw = fs.readFileSync(httpFile, "utf8").replaceAll("\r\n", "\n")
const separator = raw.indexOf("\n\n")
if (separator < 0 || !/^HTTP\/\S+ 200(?: |$)/u.test(raw.slice(0, raw.indexOf("\n")))) {
  throw new Error("workflow dispatch did not return HTTP 200")
}
const receipt = JSON.parse(raw.slice(separator + 2))
const fields = Object.keys(receipt).sort()
if (JSON.stringify(fields) !== JSON.stringify(["html_url", "run_url", "workflow_run_id"])) {
  throw new Error("workflow dispatch receipt fields are invalid")
}
const id = receipt.workflow_run_id
if (!Number.isSafeInteger(id) || id < 1 ||
    receipt.run_url !== `https://api.github.com/repos/cacheplane/dawnai/actions/runs/${id}` ||
    receipt.html_url !== `https://github.com/cacheplane/dawnai/actions/runs/${id}`) {
  throw new Error("workflow dispatch receipt identity is invalid")
}
fs.writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 })
NODE
then
  # The POST completed without a trustworthy direct run ID. Preserve all
  # evidence, do not guess from recent runs, and leave workflow state unchanged.
  exit 1
fi
release_run_id="$(node -p \
  'require(process.argv[1]).workflow_run_id' "./$dispatch_receipt_file")"
no_candidate_failure=0
test "$(gh api "repos/cacheplane/dawnai/actions/runs/$release_run_id" \
  --jq .head_sha)" = "$switch_sha" || no_candidate_failure=1
test "$(gh api "repos/cacheplane/dawnai/actions/runs/$release_run_id" \
  --jq .event)" = "workflow_dispatch" || no_candidate_failure=1
```

Watch only the directly returned run, then download its exact attempt artifact:

```bash
gh run watch "$release_run_id" -R cacheplane/dawnai --exit-status || \
  no_candidate_failure=1
release_run_attempt=""
if [[ "$no_candidate_failure" -eq 0 ]]; then
  release_run_attempt="$(gh api \
    "repos/cacheplane/dawnai/actions/runs/$release_run_id" --jq .run_attempt)" || \
    no_candidate_failure=1
fi
observation_dir="$dispatch_dir/observation-$release_run_id-$release_run_attempt"
if [[ "$no_candidate_failure" -eq 0 ]]; then
  mkdir -m 0700 "$observation_dir" || no_candidate_failure=1
fi
if [[ "$no_candidate_failure" -eq 0 ]]; then
  gh run download "$release_run_id" -R cacheplane/dawnai \
    --name "production-observation-$release_run_id-$release_run_attempt" \
    --dir "$observation_dir" || no_candidate_failure=1
fi
if [[ "$no_candidate_failure" -eq 0 ]]; then
  node -e '
const r=require(process.argv[1]),p=r.before?.plan,t=r.transition
if(r.candidate!==null || r.before?.observation?.status!=="no-candidate" ||
   p?.state!=="NO_CANDIDATE" || p.disposition!=="noop" ||
   p.nextTransition!==null || p.conflicts?.length!==0 ||
   p.proposedMutations?.length!==0 || r.diagnostics?.length!==0 ||
   t?.name!==null || t.status!=="not-required" || r.after!==null) process.exit(1)
' "./$observation_dir/production-observation.json" || no_candidate_failure=1
fi

if [[ "$no_candidate_failure" -ne 0 ]]; then
  failure_jobs_file="$dispatch_dir/failure-jobs.json"
  npm_after_file="$dispatch_dir/npm-after-failure.json"
  publication_absence_proven=0
  if gh api -H 'X-GitHub-Api-Version: 2026-03-10' \
      "repos/cacheplane/dawnai/actions/runs/$release_run_id/jobs?filter=all&per_page=100" \
      > "$failure_jobs_file" &&
    capture_registry_snapshot "$npm_after_file" &&
    cmp -s "$npm_baseline_file" "$npm_after_file" &&
    node -e '
const x=require(process.argv[1])
const jobs=x.jobs?.filter((job)=>job.name==="publish-npm")
if(!Number.isSafeInteger(x.total_count) || x.total_count>100 ||
   x.jobs?.length!==x.total_count || jobs?.length!==1 ||
   jobs[0].status!=="completed" || jobs[0].conclusion!=="skipped") process.exit(1)
' "./$failure_jobs_file"; then
    publication_absence_proven=1
  fi

  if [[ "$publication_absence_proven" -eq 1 ]]; then
    disable_mutators_before_publication
  else
    gh run view "$release_run_id" -R cacheplane/dawnai
    # Do not disable: package acceptance is not disproven. Preserve this exact
    # run/candidate and enter the post-publication recovery procedure.
  fi
  exit 1
fi
```

The failure branch disables mutators only when the exact run proves its
`publish-npm` job was skipped and a fresh all-package versions/dist-tags snapshot
is byte-equal to the pre-dispatch snapshot. Missing, running, cancelled, failed,
or successful publication-job evidence cannot prove absence; in those cases
leave the workflows unchanged and recover the exact candidate. Never guess a
recent run or delete an unexpected durable object.

Finally recapture and strictly verify a second write-once `post-enable` evidence
file, re-read `main == switch_sha`, and require the same empty managed-ref and
nonterminal-run sets. Snapshot GitHub Releases, npm `latest`, and both chart
versions before/after this run and require no tag, draft, package, chart, or
deployment mutation. Only after every assertion passes is the cutover complete;
clear the rollback and registry-snapshot helpers, disable `noclobber`, and leave
both mutators active.

### Task 10: Merge Version Packages and observe the exact fixed-group release

**Files:** generated Version Packages PR only.

- [ ] **Step 1: Validate exactly one Version Packages PR**

Derive the PR number and head from one bounded CLI snapshot; never type or reuse
them from the pre-switch evidence:

```bash
version_pr_snapshot_file=".dawn/release-cutover/version-pr-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
(
  set -o noclobber
  gh pr list -R cacheplane/dawnai --state open --base main \
    --head changeset-release/main --limit 2 \
    --json number,title,baseRefOid,headRefOid,isDraft,state,url \
    > "$version_pr_snapshot_file"
)
if ! node -e '
const x=require(process.argv[1]),p=x[0]
if(x.length!==1 || p.title!=="Version Packages" || p.state!=="OPEN" ||
   p.isDraft!==false || p.baseRefOid!==process.argv[2] ||
   !Number.isSafeInteger(p.number) || !/^[0-9a-f]{40}$/.test(p.headRefOid)) process.exit(1)
' "./$version_pr_snapshot_file" "$switch_sha"; then
  exit 1
fi
version_pr_number="$(node -p 'require(process.argv[1])[0].number' \
  "./$version_pr_snapshot_file")" || exit 1
version_head_sha="$(node -p 'require(process.argv[1])[0].headRefOid' \
  "./$version_pr_snapshot_file")" || exit 1
test "$(gh pr view "$version_pr_number" -R cacheplane/dawnai \
  --json autoMergeRequest --jq '.autoMergeRequest == null')" = "true" || exit 1
```

Require that one PR (the updated #512 or its single replacement) to contain 21
fixed-group packages targeting `0.8.22`, `dawn-app` chart `0.1.1`, and
`dawn-sandbox-infra` chart `0.1.3`, both with `appVersion: 0.8.22`. Do not trust
#512's pre-switch approval or checks; require the standalone Version Packages
workflow to have regenerated or content-validated its exact post-switch head.

- [ ] **Step 2: Prove versioning is idempotent in a disposable checkout**

Create and install an exact detached Version Packages checkout; do not reuse the
cutover checkout:

```bash
git fetch origin "pull/$version_pr_number/head"
git worktree add --detach \
  /Users/blove/repos/dawn/.worktrees/version-packages-0.8.22 \
  "$version_head_sha"
cd /Users/blove/repos/dawn/.worktrees/version-packages-0.8.22
test "$(git rev-parse HEAD)" = "$version_head_sha"
pnpm install --frozen-lockfile
pnpm run version
git diff --exit-code
test -z "$(git status --porcelain)"
```

Require the full CI/CodeQL matrix for that exact head.

- [ ] **Step 3: Merge only the validated version head**

Immediately before merge, re-fetch `main` and re-read both PR OIDs. The base
guard is as important as `--match-head-commit` because the latter protects only
the head:

```bash
if ! {
  git fetch origin main --tags --prune &&
  test "$(git rev-parse origin/main)" = "$switch_sha" &&
  test "$(gh pr view "$version_pr_number" -R cacheplane/dawnai \
    --json baseRefOid --jq .baseRefOid)" = "$switch_sha" &&
  test "$(gh pr view "$version_pr_number" -R cacheplane/dawnai \
    --json headRefOid --jq .headRefOid)" = "$version_head_sha"
}; then
  exit 1
fi
if ! gh pr merge "$version_pr_number" -R cacheplane/dawnai \
  --merge --match-head-commit "$version_head_sha"; then
  exit 1
fi
release_sha="$(gh pr view "$version_pr_number" -R cacheplane/dawnai \
  --json mergeCommit --jq .mergeCommit.oid)" || exit 1
if ! {
  git fetch origin main --tags --prune &&
  test "$(git rev-parse origin/main)" = "$release_sha" &&
  test "$(git rev-list --parents -n 1 "$release_sha")" = \
    "$release_sha $switch_sha $version_head_sha"
}; then
  exit 1
fi
```

If the base moves before merge, do not merge. If the resulting first and second
parents are not exactly `switch_sha` and `version_head_sha`, stop immediately;
before package acceptance disable both mutators and after package acceptance
preserve and recover only the exact resulting candidate.

- [ ] **Step 4: Correlate all release workflows by exact SHA**

Use `gh run list --commit "$release_sha"` for CI, Release, Publish Chart,
Version Packages, security, and production deployment observations. Use only
the controller's direct receipts for cross-workflow authorization.

- [ ] **Step 5: Require every release smoke job and receipt**

Require `smoke-metadata`, `smoke-published-harness`, `smoke-runtime-targets`,
`smoke-scaffold`, and `smoke-storage` success—not skipped—and their uniquely
named Actions artifacts and Release assets.

If the run fails after npm accepts any package, dispatch only the same exact
`v0.8.22` candidate with version `0.8.22`, `commitSha: release_sha`, and reconcile.
There is no abandonment or reason input.

### Task 11: Verify immutable artifacts, charts, npm, Vercel, and production

**Files:** no source changes; evidence remains private.

- [ ] **Step 1: Create and install the exact release checkout**

Do not perform any source-derived production check from the earlier switch or
version-head worktree:

```bash
git fetch origin main --tags --prune
git cat-file -e "$release_sha^{commit}"
test "$(git rev-list --parents -n 1 "$release_sha")" = \
  "$release_sha $switch_sha $version_head_sha"
git worktree add --detach \
  /Users/blove/repos/dawn/.worktrees/release-0.8.22 \
  "$release_sha"
cd /Users/blove/repos/dawn/.worktrees/release-0.8.22
test "$(git rev-parse HEAD)" = "$release_sha"
pnpm install --frozen-lockfile
pnpm build
```

Run every remaining Task 11 command from this worktree. If remote `main` later
moves, that is not a release-verification failure: retain this detached checkout
as the source-of-truth for `release_sha` and continue exact-candidate recovery
and verification. Task 11 Step 2 separately proves the annotated `v0.8.22` tag
peels to the same commit.

- [ ] **Step 2: Verify the tag and all npm packages**

Fetch tags and require `v0.8.22` to be an annotated tag peeling to
`release_sha`. For every name in the sealed manifest, use `npm view`/`npm pack`
to require version, `latest`, provenance workflow/SHA, integrity, and downloaded
tarball hash equal the manifest.

- [ ] **Step 3: Verify charts**

```bash
helm show chart oci://ghcr.io/cacheplane/charts/dawn-app --version 0.1.1
helm show chart oci://ghcr.io/cacheplane/charts/dawn-sandbox-infra --version 0.1.3
```

Require both `appVersion: 0.8.22` and exact expected chart versions.

- [ ] **Step 4: Verify immutable Release inventory and audit**

Require 45 base assets, five smoke assets, canonical `audit-result.json`, audit
attempt history, exact marker/body/tag/commit, and immutable true. Download and
hash `manifest.json`; compare it with `release-record.json`.

Dispatch Published Artifact Verification at exact `v0.8.22` via `gh api` with
version, commit SHA, and manifest SHA-256. Retain its returned run ID; require
`verify-published` success, draft verification skipped, and its exact audit
artifact. Snapshot the Release before/after and require no mutation.

- [ ] **Step 5: Bind the production deployment to the release SHA**

Query GitHub deployments for `environment=Production&sha=<release_sha>` and
require one relevant successful deployment. Use the repository-pinned CLI:

```bash
test "$(pnpm --filter @dawn-ai/cli exec vercel --version | tr -d '\r')" = \
  "Vercel CLI 58.9.0"
pnpm --filter @dawn-ai/cli exec vercel inspect \
  "$deployment_url" --json --scope "$vercel_org_id" --non-interactive
```

Pass the operator credential through the environment, never argv. Require exact
Git commit metadata, production target, `READY`, and `https://dawnai.org`
resolving to that deployment.

- [ ] **Step 6: Run the source-derived website audit locally and in production**

Build and start `apps/web` from `release_sha` on `127.0.0.1:3018`, then run:

```bash
install -d -m 0700 .dawn/release-cutover
pnpm --dir apps/web build
pnpm --dir apps/web exec next start --hostname 127.0.0.1 --port 3018 \
  > .dawn/release-cutover/next-release-0.8.22.log 2>&1 &
web_pid=$!
cleanup_web() {
  if kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid"
  fi
  wait "$web_pid" 2>/dev/null || true
}
trap cleanup_web EXIT INT TERM
for attempt in {1..60}; do
  if curl --fail --silent --show-error --output /dev/null \
    http://127.0.0.1:3018/; then
    break
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then
    wait "$web_pid"
    exit 1
  fi
  sleep 1
done
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3018/
pnpm --dir apps/web seo:audit-built -- \
  --base-url http://127.0.0.1:3018 --as-of 2026-08-28
pnpm --dir apps/web seo:audit-built -- \
  --base-url https://dawnai.org --as-of 2026-08-28
cleanup_web
trap - EXIT INT TERM
```

Require both audits to agree: 83 ordered canonical sitemap URLs, 83 successful
HTML pages, 75 docs, three posts, three tags, 331 JSON-LD entities, 11 robots
groups, both LLM files with 75 docs, three 1200×630 blog OG images, two expected
OG 404s, and zero failures. Re-derive these numbers if source inventory changes;
never weaken the assertion silently.

- [ ] **Step 7: Perform representative clean-browser smoke**

Verify `/`, `/docs/getting-started`, `/docs/api/sdk`,
`/docs/recipes/add-a-tool`, and `/blog/eve-validates-the-shape` for rendering,
navigation, console errors, canonical/meta/JSON-LD equality, and image loading.

- [ ] **Step 8: Record final receipts and conclude**

Record exact PR/version merge SHAs, tag object, Release and workflow run IDs,
package/chart versions, manifest/audit digests, Vercel deployment ID/URL/SHA,
and both SEO audit summaries. Confirm the source worktree is clean and no
required follow-up remains before reporting production verified.
