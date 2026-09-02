# Consolidation Workflow Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow duplicate-draft consolidation inspection to validate GitHub's canonical numeric-repository workflow pagination links without weakening any other pagination or release-safety boundary.

**Architecture:** Add one workflow-specific canonicalization rule shared by the transport Link-graph validator and the workflow-run enumerator. It accepts only the existing owner/name path or the fixed Dawn repository-ID path, returns the owner/name page URL for both, and leaves generic GitHub pagination behavior unchanged.

**Tech Stack:** Node.js 24, ESM, built-in `node:test`, pnpm, Biome, GitHub CLI

---

## File structure

- Modify `scripts/release/duplicate-draft-consolidation-adapters.mjs` — bind
  the fixed repository ID, canonicalize the two exact workflow page
  representations, and apply that canonical form at both Link-validation
  layers.
- Modify `scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs`
  — prove the live numeric Link graph succeeds and that foreign IDs and
  unrelated endpoints remain rejected.
- Create this plan only; no release workflow, dependency, controller hash, or
  Vercel lane changes are in scope.

### Task 1: Lock the numeric workflow Link behavior with regressions

**Files:**
- Test: `scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs:1099-1190`

- [ ] **Step 1: Add fixed numeric workflow test URLs**

Near the existing GitHub test constants, add the public repository identity
and exact numeric workflow base:

```js
const REPOSITORY_ID = "1210070282"
const NUMERIC_WORKFLOW_BASE =
  `${API_ORIGIN}/repositories/${REPOSITORY_ID}/actions/workflows/` +
  ".github%2Fworkflows%2Frelease.yml/runs"
```

- [ ] **Step 2: Write the failing live-shape regression**

Add a two-page test beside
`workflow-run pagination accepts compatible next-last and prev-first aliases`.
Return numeric repository URLs in all four Link relations but keep the recorded
outbound requests on the existing owner/name URLs:

```js
test("workflow-run pagination canonicalizes GitHub numeric repository links", async () => {
  const namedFirst =
    `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=1`
  const namedSecond =
    `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`
  const numericFirst = `${NUMERIC_WORKFLOW_BASE}?per_page=100&page=1`
  const numericSecond = `${NUMERIC_WORKFLOW_BASE}?per_page=100&page=2`
  const page = Array.from({ length: 100 }, (_unused, index) => workflowRun(index + 1))
  const recording = recordingFetch([
    jsonResponse({ total_count: 101, workflow_runs: page }, 200, {
      Link: `<${numericSecond}>; rel="next", <${numericSecond}>; rel="last"`,
    }),
    jsonResponse({ total_count: 101, workflow_runs: [workflowRun(101)] }, 200, {
      Link: `<${numericFirst}>; rel="prev", <${numericFirst}>; rel="first"`,
    }),
  ])
  const adapters = await createAdapters({
    fetchImpl: recording.fetchImpl,
    run: commandRunner([]),
  })

  const result = await adapters.github.listNonterminalWorkflowRuns(workflowQuery())

  assert.equal(result.runs.length, 101)
  assert.deepEqual(
    recording.calls.map(({ url }) => url),
    [namedFirst, namedSecond],
  )
})
```

- [ ] **Step 3: Run the regression and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test \
  --test-name-pattern='workflow-run pagination canonicalizes GitHub numeric repository links' \
  scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
```

Expected: FAIL because the transport validator replaces the mixed-path Link
graph with `malformed` before the workflow reader can accept it.

- [ ] **Step 4: Add fail-closed negative coverage**

Extend the exact trusted-workflow-Link rejection table with a numeric URL whose
repository ID is not `1210070282`.

Add a separate transport-sensitive generic Release regression whose response
has an otherwise-valid numeric workflow URL as `rel="last"` with no `next`:

```js
const adapters = await createAdapters({
  fetchImpl: async () =>
    jsonResponse([], 200, {
      Link: `<${NUMERIC_WORKFLOW_BASE}?per_page=100&page=2>; rel="last"`,
    }),
  run: commandRunner([]),
})
assert.deepEqual(await adapters.github.listReleases(), {
  status: "ERROR",
  operation: "releases",
  httpStatus: 200,
  code: "MALFORMED_LINK_HEADER",
})
```

The `last`-only graph is deliberate: the generic reader has no next page to
reject downstream. The assertion therefore proves the transport layer did not
activate workflow canonicalization for an unrelated Release request. These
tests must not add a new escape hatch or compatibility option.

- [ ] **Step 5: Run the focused adapter file and confirm only the new positive case is red**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test \
  scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
```

Expected: the numeric positive regression fails; the foreign-ID and generic
`last`-only regressions pass, as do all existing owner/name and rejection cases.

### Task 2: Canonicalize the fixed workflow identity at both validation layers

**Files:**
- Modify: `scripts/release/duplicate-draft-consolidation-adapters.mjs:24-45`
- Modify: `scripts/release/duplicate-draft-consolidation-adapters.mjs:2281-2333`
- Modify: `scripts/release/duplicate-draft-consolidation-adapters.mjs:2466-2514`
- Test: `scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs`

- [ ] **Step 1: Bind the repository ID and exact path union**

Add `const REPOSITORY_ID = "1210070282"` beside `REPOSITORY`. In the workflow
page validator, derive the owner/name path from `workflowRunsUrl(1)` and build
only this numeric alternative:

```js
const numericPath =
  `/repositories/${REPOSITORY_ID}/actions/workflows/` +
  `${encodeURIComponent(RELEASE_WORKFLOW)}/runs`
```

Reject every pathname outside that two-member set. Keep the exact HTTPS API
origin, empty credentials and fragment, two-query-entry, single
`per_page=100`, and positive-decimal `page` checks.

- [ ] **Step 2: Return one canonical workflow page URL**

After successful validation, return the existing owner/name representation
instead of `url.href`:

```js
return workflowRunsUrl(url.searchParams.get("page"), url.searchParams.get("per_page"))
```

This also fixes query ordering to the enumerator's constructed form. Do not
convert `page` through `Number`; retain the validated decimal string.

- [ ] **Step 3: Add a non-throwing canonicalization wrapper for the transport layer**

Keep `exactWorkflowPageUrl`'s current throwing contract for the workflow
reader. Add a private wrapper for the transport graph:

```js
function canonicalWorkflowPageUrl(value) {
  try {
    return exactWorkflowPageUrl(value)
  } catch {
    return null
  }
}
```

Determine whether the current request is the fixed owner/name workflow page by
requiring its pathname to equal the owner/name path and its full URL to equal
its canonical workflow page URL. A numeric request URL must not activate the
alias rule.

- [ ] **Step 4: Canonicalize every workflow Link relation before graph checks**

In `validPaginationLinkGraph`, preserve the current generic branch exactly.
Only for the fixed owner/name workflow request:

1. require every relation target to pass `canonicalWorkflowPageUrl`;
2. use the returned owner/name URL as the key passed to
   `addTargetRelation`; and
3. run `hasCompatibleSharedLinkTargets` over those canonical keys.

This must canonicalize `next`, `last`, `prev`, and `first`, so equivalent
numeric and owner/name representations cannot evade or falsely fail shared
target checks. The inner `workflowNextUrl` will apply the same canonicalizer
and its existing exact comparison to `workflowRunsUrl(page + 1)` will remain
unchanged.

- [ ] **Step 5: Run the new regression and verify GREEN**

Run the exact command from Task 1 Step 3. Expected: PASS, with recorded requests
remaining the owner/name first and second pages.

- [ ] **Step 6: Run the full adapter test file**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test \
  scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
```

Expected: all adapter tests pass, including existing owner/name pagination,
malformed graphs, cumulative byte limits, and deadline limits.

- [ ] **Step 7: Commit the tested implementation**

```bash
git add scripts/release/duplicate-draft-consolidation-adapters.mjs \
  scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
git commit -m "fix(release): accept canonical workflow pagination links"
```

### Task 3: Verify the complete release boundary and merge the focused PR

**Files:**
- Verify: `scripts/release/duplicate-draft-consolidation-adapters.mjs`
- Verify: `scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs`
- Verify: `docs/superpowers/specs/2026-09-02-consolidation-workflow-pagination-design.md`
- Verify: `docs/superpowers/plans/2026-09-02-consolidation-workflow-pagination.md`

- [ ] **Step 1: Run the complete consolidation suite**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test \
  scripts/release/test/duplicate-draft-consolidation*.test.mjs
```

Expected: every consolidation test passes.

- [ ] **Step 2: Run scoped static checks**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec biome check \
  --config-path packages/config-biome/biome.json \
  scripts/release/duplicate-draft-consolidation-adapters.mjs \
  scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node scripts/check-docs.mjs
git diff --check origin/main...HEAD
```

Expected: all checks pass and the branch diff contains only the approved spec,
plan, adapter, and adapter test.

- [ ] **Step 3: Run the repository Definition of Done**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: every required local gate passes, including the full build, release
controller, packaging, TypeScript tooling, and harness lanes.

- [ ] **Step 4: Commit the reviewed plan and any verification-only updates**

Commit only remaining intentional tracked changes. Do not amend the tested
implementation after review begins.

- [ ] **Step 5: Push a focused PR and request GitHub Copilot**

Push `blove/fix-consolidation-workflow-pagination`, open a PR against `main`,
and request `copilot-pull-request-reviewer[bot]` on the exact head through the
GitHub CLI. Require Copilot to finish with no unresolved Critical or Important
finding. Re-run affected tests after any review change.

- [ ] **Step 6: Require exact-head CI and merge**

Require all mandatory checks plus the real `vercel-native` lane on the exact
reviewed head. Treat infrastructure-only retries separately and preserve their
evidence. Merge only when the PR is mergeable and required checks are green.

### Task 4: Resume the live read-only consolidation inspection

**Files:**
- Live private output: `.dawn/release/duplicate-draft-consolidation.proposed.json`

- [ ] **Step 1: Return the dedicated worktree to exact merged `main`**

Fetch `origin`, switch this worktree to symbolic `main`, fast-forward only, and
confirm local HEAD, `origin/main`, and GitHub's default-branch SHA are
identical. Require a clean status, the expected `cacheplane/dawnai` origin, the
release workflow still `disabled_manually`, and zero nonterminal release runs.

- [ ] **Step 2: Run the exact production inspection**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  pnpm release:consolidate-drafts inspect \
  --version 0.8.22 \
  --commit-sha 2a80deece2ff958fe7fde8fddeb4f99bed70a1c8 \
  --survivor 379991871 \
  --duplicates 379982100,379986168 \
  --output .dawn/release/duplicate-draft-consolidation.proposed.json
```

Expected: inspection confirms zero nonterminal Release runs, performs no
writer call, and writes one canonical private proposal.

- [ ] **Step 3: Independently validate the proposal before any perform decision**

Confirm the proposal is a regular no-follow file with mode `0600`, parses as
the canonical proposed envelope, and contains the exact repository, version,
candidate commit, survivor ID, ordered duplicate IDs, and printed record
SHA-256. Confirm no journal exists and no GitHub Release or npm state changed.
Stop at this read-only checkpoint and report the evidence before authorizing a
separate live deletion.
