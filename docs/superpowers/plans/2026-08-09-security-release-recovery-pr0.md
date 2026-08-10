# Security Release Recovery PR0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Dawn's repository from the merged-but-unpublished `0.8.22` generated version state to the last publicly released `0.8.21` state without changing later feature commits or allowing publication.

**Architecture:** Revert the single-parent generated Version Packages commit `3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb` on top of current main while both publication-capable workflows remain disabled. Prove the 61 generated paths exactly equal that commit's parent, run the complete Node 24 validation lane, merge only after GitHub CI and security checks pass, and re-prove registry/repository containment after merge.

**Tech Stack:** Git, Changesets, pnpm 10.33.0, Node.js 24.19.0, GitHub Actions, npm registry, Dawn release-controller scripts.

---

### Task 1: Pin containment and recovery preconditions

**Files:**
- Read: `.github/workflows/release.yml`
- Read: `packages/sdk/package.json`
- Read: `.changeset/inspector-namespace-groups.md`
- Read: `docs/superpowers/specs/2026-08-09-security-backlog-release-recovery-design.md`

- [ ] **Step 1: Verify the implementation branch and clean worktree**

Run:

```bash
set -euo pipefail
git fetch origin main
test -z "$(git status --short)"
test "$(git branch --show-current)" = "blove/security-backlog-design"
git rev-parse HEAD
git merge-base --is-ancestor origin/main HEAD
```

Expected: clean worktree; branch `blove/security-backlog-design`; HEAD contains only the approved spec/plan commits above current `origin/main`; ancestry succeeds.

- [ ] **Step 2: Prove the desired recovery assertions are initially false**

Run:

```bash
set -euo pipefail
if test "$(node -p "require('./packages/sdk/package.json').version")" = "0.8.21"; then
  echo "recovery baseline unexpectedly already has package version 0.8.21" >&2
  exit 1
fi
if test -f .changeset/inspector-namespace-groups.md; then
  echo "recovery baseline unexpectedly already has the consumed changeset" >&2
  exit 1
fi
```

Expected: both assertions fail before the revert because the repository is at `0.8.22` and the changeset was consumed. This is the recovery baseline, not a product-test failure.

- [ ] **Step 3: Verify npm and chart publication are durably paused**

Run:

```bash
set -euo pipefail
test "$(gh api repos/cacheplane/dawnai/actions/workflows/release.yml --jq .state)" = "disabled_manually"
test "$(gh api repos/cacheplane/dawnai/actions/workflows/publish-chart.yml --jq .state)" = "disabled_manually"
gh api --paginate 'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
  | jq -s -e '[.[].workflow_runs[] | select(.status != "completed")] | length == 0'
gh api --paginate 'repos/cacheplane/dawnai/actions/workflows/309127405/runs?per_page=100' \
  | jq -s -e '[.[].workflow_runs[] | select(.status != "completed")] | length == 0'
```

Expected: all four assertions succeed. The API is used directly because `gh
run list` omits disabled workflows unless explicitly broadened.

- [ ] **Step 4: Verify no public `0.8.22` state exists**

Use the production inventory and bounded HTTP transport to read an
identity-correlated `200` packument for every package. Prove the target version
is missing from each packument's `versions` map and that `latest` remains the
last public version. Do not infer absence from an exact-version `404`: the live
npm registry does not reliably include the structured `E404` body required for
that classification, so such a response is intentionally ambiguous.

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
node --input-type=module <<'NODE'
import { createHttpGet } from "./scripts/release/adapters/http.mjs"
import { assertValidReleaseInventory, readReleaseInventory } from "./scripts/release/inventory.mjs"

const TARGET_VERSION = "0.8.22"
const EXPECTED_LATEST = "0.8.21"
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const inventory = assertValidReleaseInventory(
  await readReleaseInventory({
    root: process.cwd(),
    ref: process.env.RELEASE_INVENTORY_REF ?? "HEAD",
  }),
)
if (inventory.packages.length !== 21) throw new Error("unexpected release inventory size")
const http = createHttpGet()
const results = await Promise.all(
  inventory.packages.map(async (name) => ({
    name,
    response: await http.getJson({
      url: `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    }),
  })),
)
for (const { name, response } of results) {
  if (response.status !== "OK" || response.httpStatus !== 200) {
    throw new Error(`packument is not proven readable for ${name}: ${response.status}/${response.code}`)
  }
  const packument = response.body
  if (
    !isRecord(packument) ||
    packument.name !== name ||
    !isRecord(packument.versions) ||
    !isRecord(packument["dist-tags"])
  ) {
    throw new Error(`packument identity/schema is not proven for ${name}`)
  }
  if (Object.hasOwn(packument.versions, TARGET_VERSION)) {
    throw new Error(`${name}@${TARGET_VERSION} already exists`)
  }
  if (packument["dist-tags"].latest !== EXPECTED_LATEST) {
    throw new Error(`latest is not ${EXPECTED_LATEST} for ${name}`)
  }
}
console.log(
  `Proven absent from identity-correlated packuments: ${TARGET_VERSION} for ${results.length} packages; latest is ${EXPECTED_LATEST}`,
)
NODE

gh api --paginate 'repos/cacheplane/dawnai/git/matching-refs/tags?per_page=100' \
  | jq -s -e '[.[][] | select(.ref | test("0\\.8\\.22"))] | length == 0'
gh api --paginate 'repos/cacheplane/dawnai/releases?per_page=100' \
  | jq -s -e '[.[][] | select(.tag_name | test("0\\.8\\.22"))] | length == 0'
```

Expected: all 21 identity-correlated packuments prove that `0.8.22` is not in
their version maps and `latest=0.8.21`; both `jq -e` assertions return `true`.
Any transport, HTTP, parse, schema, identity, or query failure stops execution.

### Task 2: Apply and prove the exact generated-state revert

**Files:**
- Restore: `.changeset/*.md` deleted by `3f4e3f9f`
- Modify: `charts/dawn-app/Chart.yaml`
- Modify: `charts/dawn-sandbox-infra/Chart.yaml`
- Modify: `examples/*/server/{CHANGELOG.md,package.json}`
- Modify: `packages/*/{CHANGELOG.md,package.json}` selected by `3f4e3f9f`

- [ ] **Step 1: Prove later commits do not overlap the generated paths**

Run:

```bash
set -euo pipefail
generated_paths=$(git diff-tree --no-commit-id --name-only -r 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb | sort)
test "$(printf '%s\n' "$generated_paths" | wc -l | tr -d ' ')" = "61"
later_main_paths=$(git diff --name-only 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb..origin/main | sort)
overlap=$(comm -12 <(printf '%s\n' "$generated_paths") <(printf '%s\n' "$later_main_paths"))
if test -n "$overlap"; then
  printf 'later main commits overlap generated recovery paths:\n%s\n' "$overlap" >&2
  exit 1
fi
```

Expected: no output. Stop if any path overlaps; do not hand-edit around a conflict.

- [ ] **Step 2: Apply the revert without committing**

Run:

```bash
set -euo pipefail
git revert --no-commit 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb
```

Expected: command succeeds without conflicts and stages exactly the generated inverse.

- [ ] **Step 3: Prove exact path and byte equality with the pre-generation parent**

Run:

```bash
set -euo pipefail
generated_paths=$(git diff-tree --no-commit-id --name-only -r 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb | sort)
test "$(printf '%s\n' "$generated_paths" | wc -l | tr -d ' ')" = "61"
git diff --cached --name-only | sort | diff -u <(printf '%s\n' "$generated_paths") -
while IFS= read -r generated_path; do
  git diff --quiet 95768c3f8f9042ee156da50c043901062591a9d5 -- "$generated_path" || {
    printf 'recovered path differs from version parent: %s\n' "$generated_path" >&2
    exit 1
  }
done < <(printf '%s\n' "$generated_paths")
```

Expected: no diff and no error output. All 61 generated paths exactly match the Version Packages commit's parent.

- [ ] **Step 4: Prove the desired recovery assertions are now true**

Run:

```bash
set -euo pipefail
test "$(node -p "require('./packages/sdk/package.json').version")" = "0.8.21"
test "$(node -p "require('./packages/core/package.json').version")" = "0.8.21"
test -f .changeset/inspector-namespace-groups.md
rg -n '^appVersion: "0\.8\.21"$' charts/dawn-app/Chart.yaml charts/dawn-sandbox-infra/Chart.yaml
```

Expected: all assertions succeed; each chart reports `appVersion: 0.8.21`.

- [ ] **Step 5: Inspect the staged recovery diff**

Run:

```bash
set -euo pipefail
git diff --cached --check
git diff --cached --stat
git diff --cached --summary
```

Expected: no whitespace errors; only generated version/changelog/chart/changeset files appear.

- [ ] **Step 6: Commit the exact recovery before ref-based verification**

Run:

```bash
set -euo pipefail
git commit -m "fix(release): restore unpublished version state"
```

Expected: one commit containing exactly the staged generated-state inverse.
This commit must exist before release-inventory and controller verification
because those readers intentionally inspect `HEAD`, not the index or worktree.

- [ ] **Step 7: Verify commit scope and clean worktree**

Run:

```bash
set -euo pipefail
git show --check --stat --oneline HEAD
test -z "$(git status --short)"
```

Expected: `git show --check` succeeds; worktree clean.

### Task 3: Verify the recovered repository under Node 24

**Files:**
- Test: `scripts/release/test/*.test.mjs`
- Test: `scripts/test-sync-chart-appversion.mjs`
- Test: repository Definition of Done

- [ ] **Step 1: Select the repository's Node 24 runtime**

Run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
```

Expected: Node `v24.19.0`; pnpm `10.33.0`.

- [ ] **Step 2: Verify release inventory and restored changesets**

Run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
pnpm check:release-inventory
pnpm exec changeset status
```

Expected: exact 21-package release inventory at uniform `0.8.21`; Changesets reports the restored pending patch releases without schema errors.

- [ ] **Step 3: Run focused release and chart regressions**

Run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
pnpm test:release-controller
pnpm test:sync-chart-appversion
node scripts/check-docs.mjs
```

Expected: all tests and docs checks pass.

- [ ] **Step 4: Run the complete local Definition of Done**

Run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
test "$(pnpm --version)" = "10.33.0"
pnpm ci:validate
```

Expected: exit 0 through lint, build-cache, build, typecheck, source tests, release inventory/controller tests, release-script tests, docs, pack checks, TypeScript tooling pack, and all harness lanes.

- [ ] **Step 5: Re-prove containment after the long validation**

Repeat Task 1 Steps 3–4.

Expected: both publication workflows remain disabled, no publication run is active, npm latest remains `0.8.21`, and exact `0.8.22` remains absent.

### Task 4: Independently review the verified PR0 commit

**Files:**
- Read: exact branch diff and committed recovery paths
- Preserve: `docs/superpowers/specs/2026-08-09-security-backlog-release-recovery-design.md`
- Preserve: `docs/superpowers/plans/2026-08-09-security-release-recovery-pr0.md`

- [ ] **Step 1: Dispatch two read-only reviews**

Use one reviewer for exact-revert/spec compliance and one reviewer for release-safety/containment. Both receive the exact base/head SHAs, spec path, and explicit instruction not to edit files or mutate GitHub.

Expected: no Critical or Important issue. Resolve any finding with a focused change and rerun all affected verification before continuing.

### Task 5: Publish the branch and open the recovery PR

**Files:**
- Read: complete branch diff against `origin/main`

- [ ] **Step 1: Fetch and prove the branch is current**

Run:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
git fetch origin main
test "$(git rev-list --count HEAD..origin/main)" = "0"
git diff --check origin/main...HEAD
```

Expected: branch is not behind main; diff check succeeds. If main moved, do not
continue mechanically: update the branch, re-prove that later main commits do
not overlap the generated paths, re-prove exact parent equality on the updated
committed tree, and repeat Tasks 3–4 for the new HEAD.

- [ ] **Step 2: Push the branch**

Run:

```bash
set -euo pipefail
git push -u origin blove/security-backlog-design
```

Expected: push succeeds.

- [ ] **Step 3: Open a ready pull request**

Title:

```text
fix(release): restore unpublished version state
```

The body records containment, the exact reverted commit, proof that later commits do not overlap, local Node 24 verification, and the fact that no package/tag/Release at `0.8.22` exists. Do not include references to coding agents.

Expected: ready PR targeting `main`.

### Task 6: Monitor, merge on green, and verify main

**Files:**
- Read: PR checks, review threads, code-scanning alerts, main workflow runs

- [ ] **Step 1: Monitor every technical check**

Use `gh pr checks`, Actions run inspection, CodeQL alerts for the PR, and review-thread inspection until all required and technical checks are terminal.

Expected: `validate`, changesets, CodeQL, Windows, Docker, Kubernetes, Postgres, pgvector, edge, charts, and preview checks pass; no unresolved Critical/Important review finding.

- [ ] **Step 2: Merge only after green evidence**

Immediately before merging, capture the reviewed PR head SHA, fetch main, and
prove the PR's recorded base still matches it, the branch is not behind,
generated paths still have no later-main overlap, both publication workflows are
still disabled, and neither has a non-completed run:

```bash
set -euo pipefail
git fetch origin main
reviewed_head=$(gh pr view <PR_NUMBER> --json headRefOid --jq .headRefOid)
test "$reviewed_head" = "$(git rev-parse HEAD)"
test "$(gh pr view <PR_NUMBER> --json baseRefOid --jq .baseRefOid)" = "$(git rev-parse origin/main)"
test "$(git rev-list --count HEAD..origin/main)" = "0"
generated_paths=$(git diff-tree --no-commit-id --name-only -r 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb | sort)
test "$(printf '%s\n' "$generated_paths" | wc -l | tr -d ' ')" = "61"
later_main_paths=$(git diff --name-only 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb..origin/main | sort)
overlap=$(comm -12 <(printf '%s\n' "$generated_paths") <(printf '%s\n' "$later_main_paths"))
if test -n "$overlap"; then
  printf 'later main commits overlap generated recovery paths:\n%s\n' "$overlap" >&2
  exit 1
fi
test "$(gh api repos/cacheplane/dawnai/actions/workflows/release.yml --jq .state)" = "disabled_manually"
test "$(gh api repos/cacheplane/dawnai/actions/workflows/publish-chart.yml --jq .state)" = "disabled_manually"
gh api --paginate 'repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100' \
  | jq -s -e '[.[].workflow_runs[] | select(.status != "completed")] | length == 0'
gh api --paginate 'repos/cacheplane/dawnai/actions/workflows/309127405/runs?per_page=100' \
  | jq -s -e '[.[].workflow_runs[] | select(.status != "completed")] | length == 0'
gh pr merge <PR_NUMBER> --squash --match-head-commit "$reviewed_head"
```

Expected: every assertion succeeds, the overlap is empty, and the PR state
becomes `MERGED`. If main moved, do not merge: rebase, repeat the exact-revert
proof and all affected checks, push, and wait for the new PR head to become
green. A non-required external review service that cannot run for
billing/credential reasons is recorded separately and is not misreported as a
technical pass.

- [ ] **Step 3: Verify exact post-merge repository state**

Run from a clean fetch of `origin/main`:

```bash
set -euo pipefail
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
test "$(node --version)" = "v24.19.0"
git fetch origin main
git show --check --stat --oneline origin/main
node --input-type=module <<'NODE'
import { assertValidReleaseInventory, readReleaseInventory } from "./scripts/release/inventory.mjs"
const result = assertValidReleaseInventory(
  await readReleaseInventory({ root: process.cwd(), ref: "origin/main" }),
)
if (result.packages.length !== 21 || result.version !== "0.8.21") {
  throw new Error(`unexpected recovered inventory: ${result.packages.length}/${result.version}`)
}
console.log(`Recovered inventory: ${result.packages.length} packages at ${result.version}`)
NODE

generated_paths=$(git diff-tree --no-commit-id --name-only -r 3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb | sort)
test "$(printf '%s\n' "$generated_paths" | wc -l | tr -d ' ')" = "61"
while IFS= read -r generated_path; do
  git diff --quiet 95768c3f8f9042ee156da50c043901062591a9d5 origin/main -- "$generated_path" || {
    printf 'post-merge recovered path differs from version parent: %s\n' "$generated_path" >&2
    exit 1
  }
done < <(printf '%s\n' "$generated_paths")
restored_changesets=$(printf '%s\n' "$generated_paths" | rg '^\.changeset/')
test "$(printf '%s\n' "$restored_changesets" | wc -l | tr -d ' ')" = "11"
while IFS= read -r generated_path; do
  git cat-file -e "origin/main:$generated_path"
done < <(printf '%s\n' "$restored_changesets")
```

Expected: the exact 21-package inventory reports `0.8.21`; all 61 recovered
paths match the original version parent byte-for-byte; every restored changeset
exists on merged main.

- [ ] **Step 4: Verify no publication path restarted**

Repeat Task 1 Step 3, then repeat Task 1 Step 4 with
`RELEASE_INVENTORY_REF=origin/main` so the inventory is read from the exact
merged ref rather than the local branch.

Expected: Release and Publish Chart remain `disabled_manually`; neither has an
active run; npm and GitHub remain at `0.8.21` with exact `0.8.22` absent.

- [ ] **Step 5: Monitor post-merge CI**

Monitor the push-triggered CI, CodeQL, and Scorecard runs for the exact merge SHA through completion.

Expected: all technical post-merge checks pass. Record exact run ids and conclusions before declaring PR0 complete.
