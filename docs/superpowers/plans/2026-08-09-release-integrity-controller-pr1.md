# Release Integrity Controller PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce Dawn's canonical release inventory, pure reconciliation model, read-only observers, historical incident fixtures, fault-harness foundation, and shadow/preflight workflow without changing the active publisher.

**Architecture:** Build a dependency-free release core under `scripts/release/`: inventory and manifest validation feed a pure state classifier and planner, while allowlisted read-only Git/npm/GitHub adapters produce normalized observations. A manual/scheduled shadow workflow renders the plan but cannot mutate Git, GitHub Releases, or npm. The existing `.github/workflows/release.yml` and its legacy publisher remain active and unchanged throughout this PR.

**Tech Stack:** Node.js 24 ESM, `node:test`, Git and GitHub REST read APIs, npm registry HTTP APIs, Verdaccio 6, YAML 2.9, GitHub Actions, pnpm 10.33

**Spec:** `docs/superpowers/specs/2026-08-09-release-integrity-controller-design.md`

---

## File Structure

### Pure release model

- Create `scripts/release/semver.mjs` for dependency-free exact SemVer parsing and ordering.
- Create `scripts/release/inventory.mjs` for fixed-group/workspace discovery and exact-set validation.
- Create `scripts/release/check-inventory.mjs` as the human/CI inventory CLI.
- Create `scripts/release/topology.mjs` for stable dependency-first publication order.
- Create `scripts/release/manifest.mjs` for canonical manifest validation and hashing.
- Create `scripts/release/state.mjs` for normalized state names and conflict classification.
- Create `scripts/release/planner.mjs` for the pure next-transition plan.

### Read-only observation and reporting

- Create `scripts/release/adapters/git.mjs` with an allowlisted read-only Git interface.
- Create `scripts/release/adapters/npm.mjs` with GET-only exact registry/provenance observation.
- Create `scripts/release/adapters/github.mjs` with GET-only Actions/ref/Release/settings observation.
- Create `scripts/release/observe.mjs` to assemble a normalized candidate observation.
- Create `scripts/release/report.mjs` to render stable JSON and Markdown receipts.
- Create `scripts/release/shadow-reconcile.mjs` as the read-only reconciliation CLI.
- Create `scripts/release/preflight.mjs` as the static/live permission and trust-evidence report.

### Tests and fixtures

- Create focused tests in `scripts/release/test/*.test.mjs` matching each module.
- Create frozen incident fixtures in `scripts/release/test/fixtures/incidents/`.
- Create a three-package fixture in `scripts/release/test/fixtures/fault-workspace/`.
- Create Verdaccio, fault-proxy, and temporary-Git support in `scripts/release/test/support/`.
- Create `.github/workflows/release-shadow.yml` and its parsed-YAML contract tests.

### Repository wiring

- Modify `.changeset/config.json` so its fixed group exactly contains all 21 public packages.
- Modify `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`, and `AGENTS.md` to add explicit inventory/controller gates.
- Add root `yaml@2.9.0` only; do not add a workspace package.
- Do not modify `.github/workflows/release.yml`, `scripts/release-publish.mjs`, `scripts/backfill-release-tags.mjs`, `scripts/upload-release-assets.mjs`, or `.github/workflows/published-artifact-verify.yml` in this PR.

## Execution Prerequisite

Use Node 24 and the repository-pinned pnpm. The current worktree has dependencies installed; build again before any test that packs workspace output.

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node -e '
  if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)
  console.log(process.version)
'
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm --version
```

Expected: Node `v24.x` or newer and pnpm `10.33.0`. If this exact Node path is unavailable, substitute another Node 24 path before running any task.

## Task 1: Make the fixed group the canonical release inventory

**Files:**
- Create: `scripts/release/inventory.mjs`
- Create: `scripts/release/check-inventory.mjs`
- Create: `scripts/release/adapters/git.mjs`
- Create: `scripts/release/test/inventory.test.mjs`
- Create: `scripts/release/test/git-adapter.test.mjs`
- Modify: `.changeset/config.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write failing exact-set tests**

Start `scripts/release/test/inventory.test.mjs` with fixture-level cases and one live-repository case:

```js
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { readReleaseInventory, validateReleaseInventory } from "../inventory.mjs"

describe("validateReleaseInventory", () => {
  it("reports missing, extra, duplicate, private, and unknown members", () => {
    const result = validateReleaseInventory({
      fixedGroups: [["@dawn/base", "@dawn/missing", "@dawn/base", "@dawn/private"]],
      workspacePackages: [
        { name: "@dawn/base", private: false, version: "0.1.0" },
        { name: "@dawn/extra", private: false, version: "0.1.0" },
        { name: "@dawn/private", private: true, version: "0.1.0" },
      ],
    })

    assert.deepEqual(result.missing, ["@dawn/extra"])
    assert.deepEqual(result.extra, ["@dawn/missing", "@dawn/private"])
    assert.deepEqual(result.duplicates, ["@dawn/base"])
    assert.deepEqual(result.privateMembers, ["@dawn/private"])
  })

  it("matches Dawn's public workspace packages exactly", async () => {
    const inventory = await readReleaseInventory({ root: process.cwd(), ref: "HEAD" })
    assert.deepEqual(validateReleaseInventory(inventory), {
      duplicates: [],
      extra: [],
      missing: [],
      privateMembers: [],
      unknownMembers: [],
      versionMismatches: [],
    })
  })
})
```

- [ ] **Step 2: Run the test and confirm the intended failures**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/inventory.test.mjs
```

Expected: first fail because `inventory.mjs` does not exist. After the minimal module exists, the live case must fail specifically because `@dawn-ai/sandbox` is absent from the fixed group.

- [ ] **Step 3: Implement inventory discovery and validation**

First add the already-used YAML parser as an explicit root dependency:

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm add -D -w yaml@2.9.0
```

Create the initial allowlisted Git reader with only the methods inventory needs:

```js
export function createGitReader({ root, run = runCommand })
// initial methods: showFile({ref, path}), listTree({ref}), firstParent(ref)
```

Add `git-adapter.test.mjs` assertions that the adapter uses argument arrays, rejects
invalid refs/paths, and exposes no mutation or generic command method.

Expose this public shape from `inventory.mjs`:

```js
export async function readReleaseInventory({ root, ref = "HEAD", git = createGitReader({ root }) })
export function readFixedGroup(changesetConfig)
export function validateReleaseInventory({ fixedGroups, workspacePackages })
export function assertValidReleaseInventory(inventory)
```

Requirements:

- read workspace patterns from `pnpm-workspace.yaml`, including `packages/*` and any future public member location;
- read manifests at the requested Git ref rather than silently using the working tree;
- require exactly one fixed group;
- compare the fixed group with every non-private workspace package;
- require one uniform release version;
- return stable alphabetized error categories;
- never import `scripts/release-publish.mjs` or its directory-only scanner.

- [ ] **Step 4: Add `@dawn-ai/sandbox` and the inventory CLI**

Insert `@dawn-ai/sandbox` between `@dawn-ai/postgres-storage` and `@dawn-ai/sdk` in `.changeset/config.json`.

`check-inventory.mjs` must accept `--ref <ref>` and `--json`, print the canonical package list/version on success, print categorized differences on failure, and set a nonzero exit code without a stack trace for expected validation errors.

- [ ] **Step 5: Run the focused checks**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/inventory.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node scripts/release/check-inventory.mjs --ref HEAD
```

Expected: both pass and report exactly 21 public packages.

- [ ] **Step 6: Wire the gate into local and hosted CI**

Add these scripts:

```json
{
  "check:release-inventory": "node scripts/release/check-inventory.mjs",
  "test:release-controller": "node --test scripts/release/test/*.test.mjs"
}
```

Add `pnpm check:release-inventory` and `pnpm test:release-controller` to `ci:validate`. Add matching `Release Inventory` and `Release Controller Tests` steps to `.github/workflows/ci.yml` after source tests. Update `AGENTS.md`'s Definition of Done and local `ci:validate` description so they describe the new gates accurately.

- [ ] **Step 7: Commit**

```bash
git add .changeset/config.json package.json .github/workflows/ci.yml AGENTS.md \
  pnpm-lock.yaml scripts/release/inventory.mjs scripts/release/check-inventory.mjs \
  scripts/release/adapters/git.mjs scripts/release/test/inventory.test.mjs \
  scripts/release/test/git-adapter.test.mjs
git commit -m "fix(release): align the fixed release inventory"
```

## Task 2: Add SemVer, dependency order, and the immutable manifest model

**Files:**
- Create: `scripts/release/semver.mjs`
- Create: `scripts/release/topology.mjs`
- Create: `scripts/release/manifest.mjs`
- Create: `scripts/release/test/semver.test.mjs`
- Create: `scripts/release/test/topology.test.mjs`
- Create: `scripts/release/test/manifest.test.mjs`

- [ ] **Step 1: Write failing SemVer and topology tests**

Cover exact stable/prerelease syntax, prerelease precedence, build metadata, cycles, stable alphabetical ties, dependency-first ordering, and `create-dawn-ai-app` final placement.

```js
assert.equal(compareSemver("0.8.21", "0.8.22"), -1)
assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.10"), -1)
assert.deepEqual(
  orderReleasePackages(packages, { gateOrder: ["create-dawn-ai-app"] }).map((item) => item.name),
  ["@dawn/base", "@dawn/middle", "create-dawn-ai-app"],
)
```

- [ ] **Step 2: Run and confirm missing-module failures**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/semver.test.mjs \
  scripts/release/test/topology.test.mjs
```

- [ ] **Step 3: Implement only the tested interfaces**

```js
export function parseSemver(value)
export function compareSemver(left, right)
export function isExactSemver(value)

export function internalDependencies(packageJson, inventoryNames)
export function orderReleasePackages(packages, { gateOrder = ["create-dawn-ai-app"] } = {})
```

Do not add the `semver` npm dependency. Reject cycles and internal dependency names missing from the canonical inventory.

- [ ] **Step 4: Write the failing manifest tests**

Use a complete valid three-package manifest, then one table row per invariant: schema version, 40-character SHA, exact version, exact package set, duplicate, path traversal, basename, public access, positive size, lowercase SHA-256/SHA-512, matching npm integrity, and dependency order.

The production interface is:

```js
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1
export function parseReleaseManifest(raw, context)
export function validateReleaseManifest(value, context)
export function canonicalManifestBytes(manifest)
export function manifestSha256(manifest)
```

Canonical bytes use recursively stable object-key ordering and preserve package-array order, followed by one newline.

- [ ] **Step 5: Run red, implement, and run green**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/manifest.test.mjs
```

Expected before implementation: missing exports. Expected after implementation: all manifest tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/semver.mjs scripts/release/topology.mjs scripts/release/manifest.mjs \
  scripts/release/test/semver.test.mjs scripts/release/test/topology.test.mjs \
  scripts/release/test/manifest.test.mjs
git commit -m "feat(release): add manifest and package ordering model"
```

## Task 3: Implement the pure release state classifier and planner

**Files:**
- Create: `scripts/release/state.mjs`
- Create: `scripts/release/planner.mjs`
- Create: `scripts/release/test/planner.test.mjs`

- [ ] **Step 1: Write the exhaustive failing planner table**

Define every state from the spec, including terminal no-op, supersession, tagged/escrowed/partial progress, independent audit, and abandonment:

```js
export const ReleaseState = Object.freeze({
  NO_CANDIDATE: "NO_CANDIDATE",
  SUPERSEDED_NOOP: "SUPERSEDED_NOOP",
  CANDIDATE_VALIDATED: "CANDIDATE_VALIDATED",
  CANDIDATE_TAGGED: "CANDIDATE_TAGGED",
  ARTIFACTS_PREPARED: "ARTIFACTS_PREPARED",
  ARTIFACTS_ATTESTED: "ARTIFACTS_ATTESTED",
  CANDIDATE_ESCROWED: "CANDIDATE_ESCROWED",
  NPM_PARTIAL: "NPM_PARTIAL",
  NPM_COMPLETE: "NPM_COMPLETE",
  RELEASE_DRAFT_COMPLETE: "RELEASE_DRAFT_COMPLETE",
  SMOKES_COMPLETE: "SMOKES_COMPLETE",
  RELEASE_PUBLISHED: "RELEASE_PUBLISHED",
  AUDIT_DISPATCHED: "AUDIT_DISPATCHED",
  AUDIT_COMPLETE: "AUDIT_COMPLETE",
  ABANDONED_PREPUBLICATION: "ABANDONED_PREPUBLICATION",
})
```

For every row, call `planRelease()` twice with the same frozen input and assert deep equality and no input mutation.

- [ ] **Step 2: Cover arbitration and conflicts before implementation**

Add tests for:

- skipped `0.8.20` when `latest=0.8.21`;
- an older tagged release blocking a newer candidate;
- an older audited or abandoned candidate unblocking the newer one;
- newer `latest` never moving backward;
- exact npm bytes/provenance/tag/asset conflicts;
- ambiguous registry/GitHub responses blocking rather than becoming absence;
- abandonment rejected after the publish job begins.

- [ ] **Step 3: Run red, then implement the minimal classifier and planner**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node --test scripts/release/test/planner.test.mjs
```

Expose:

```js
export function classifyObservedRelease(candidate, observation)
export function findReleaseConflicts(candidate, observation)
export function planRelease({ candidate, observation, mode = "shadow" })
```

The plan result must be JSON-safe and contain only:

```js
{
  state,
  disposition: "noop" | "would-transition" | "blocked" | "audit-only",
  nextTransition,
  reasons: [],
  conflicts: [],
  proposedMutations: [],
}
```

Shadow mode may describe mutations but must have no effect callbacks or mutable clients.

- [ ] **Step 4: Commit**

```bash
git add scripts/release/state.mjs scripts/release/planner.mjs \
  scripts/release/test/planner.test.mjs
git commit -m "feat(release): add the release state planner"
```

## Task 4: Add fail-closed read-only Git, npm, and GitHub adapters

**Files:**
- Modify: `scripts/release/adapters/git.mjs`
- Create: `scripts/release/adapters/npm.mjs`
- Create: `scripts/release/adapters/github.mjs`
- Modify: `scripts/release/test/git-adapter.test.mjs`
- Create: `scripts/release/test/npm-adapter.test.mjs`
- Create: `scripts/release/test/github-adapter.test.mjs`

- [ ] **Step 1: Write allowlist tests before client code**

Inject recording `run` and `fetch` functions. Assert Git exposes only `showFile`, `listTree`, `firstParent`, `isAncestor`, `listFirstParentHistory`, and `resolveTag`; GitHub exposes only GET-based named methods; npm uses only GET/HEAD. There must be no generic `runGit(args)` or `request(method, path)` escape hatch.

- [ ] **Step 2: Write registry response-classification tests**

Table-drive exact package/version E404, package-level E404, 401, 403, 408/timeout, 429, malformed JSON, and 5xx. Only the exact-version E404 result is `ABSENT`; every other failure is typed as `AMBIGUOUS` or `ERROR` with status/code retained.

- [ ] **Step 3: Extend the Git reader and implement the npm reader**

```js
export function createGitReader({ root, run = runCommand })
export function createNpmReader({ registryUrl = "https://registry.npmjs.org", fetchImpl = fetch })
export function classifyRegistryResponse({ operation, response, body })
```

`observePackageVersion({name, version})` returns normalized exact metadata: presence, tarball URL, shasum/integrity, signatures, dist-tags, and npm attestation/provenance evidence.

- [ ] **Step 4: Implement the GitHub reader**

```js
export function createGitHubReader({ owner, repo, token, fetchImpl = fetch })
```

Named methods cover exact-SHA CI checks, refs, Releases/assets, Actions artifacts/runs, attestations, workflow/default-permission settings, environments, and branch protection. Normalize absence separately from authorization and server failure. Never log the token.

- [ ] **Step 5: Run focused tests**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/git-adapter.test.mjs \
  scripts/release/test/npm-adapter.test.mjs \
  scripts/release/test/github-adapter.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/release/adapters scripts/release/test/*-adapter.test.mjs
git commit -m "feat(release): add read-only release observers"
```

## Task 5: Capture the incidents and build the shadow report CLI

**Files:**
- Create: `scripts/release/observe.mjs`
- Create: `scripts/release/report.mjs`
- Create: `scripts/release/shadow-reconcile.mjs`
- Create: `scripts/release/test/fixtures/incidents/0.8.20-skipped.json`
- Create: `scripts/release/test/fixtures/incidents/0.8.21-publish-metadata-failure.json`
- Create: `scripts/release/test/fixtures/incidents/main-2026-08-09.json`
- Create: `scripts/release/test/incidents.test.mjs`
- Create: `scripts/release/test/shadow-reconcile.test.mjs`

- [ ] **Step 1: Freeze factual incident fixtures**

Use these immutable identities:

```text
0.8.20 candidate: 5bb97cf3434e7c4afa95646982d510d79387ba5b
0.8.21 candidate: 341678ea7932832ec860bdd915371669440bef7c
0.8.21 release run: 31292769511, attempt 1
post-incident main: d159eb6d49fc8accd9f53139634b10930a4fd093
```

The fixtures are normalized observations, not copied raw API payloads. Expected dispositions:

- `0.8.20`: `SUPERSEDED_NOOP`, audit-only, no publication proposal;
- `0.8.21` attempt-1 snapshot: npm complete, downstream evidence incomplete;
- post-incident main: `NO_CANDIDATE` because the fixed-group version did not change in that commit.

- [ ] **Step 2: Write failing fixture and report tests**

Assert each fixture's planner output, stable JSON ordering, Markdown headings, candidate identity, last proven transition, next safe transition, conflicts, and manual recovery inputs. Snapshot strings must not contain tokens or authorization headers.

- [ ] **Step 3: Implement observation composition and reports**

```js
export async function discoverShadowCandidate({ ref, git, inventory })
export async function observeCandidate({ candidate, inventory, git, npm, github })
export function createReconciliationReport({ candidate, observation, plan, run })
export function renderReportJson(report)
export function renderReportMarkdown(report)
```

- [ ] **Step 4: Implement and test the CLI**

Accepted forms:

```text
node scripts/release/shadow-reconcile.mjs --observation <fixture> --format json
node scripts/release/shadow-reconcile.mjs --version <exact> --commit-sha <40-sha> --format markdown
node scripts/release/shadow-reconcile.mjs --repository cacheplane/dawnai --format markdown
```

`--version` and `--commit-sha` must be paired. Fixture mode performs no network calls. Live mode reads `GITHUB_TOKEN` only for GitHub GET requests.

- [ ] **Step 5: Run all three acceptance fixtures**

```bash
for fixture in \
  0.8.20-skipped \
  0.8.21-publish-metadata-failure \
  main-2026-08-09; do
  PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
    node scripts/release/shadow-reconcile.mjs \
      --observation "scripts/release/test/fixtures/incidents/${fixture}.json" \
      --format json
done
```

- [ ] **Step 6: Commit**

```bash
git add scripts/release/observe.mjs scripts/release/report.mjs \
  scripts/release/shadow-reconcile.mjs scripts/release/test/fixtures/incidents \
  scripts/release/test/incidents.test.mjs scripts/release/test/shadow-reconcile.test.mjs
git commit -m "test(release): capture historical release incidents"
```

## Task 6: Establish the Verdaccio and temporary-Git fault harness

**Files:**
- Create: `scripts/release/test/support/verdaccio.mjs`
- Create: `scripts/release/test/support/fault-proxy.mjs`
- Create: `scripts/release/test/support/git-fixture.mjs`
- Create: `scripts/release/test/support/fault-harness.mjs`
- Create: `scripts/release/test/fixtures/fault-workspace/**`
- Create: `scripts/release/test/fault-harness.integration.mjs`
- Modify: `package.json`

- [ ] **Step 1: Build the three-package fixture**

Create `base -> middle -> gate` using `workspace:*`, one fixed group, and one version. The gate is unscoped and listed last. Keep sources to a package manifest plus one `index.js` each.

- [ ] **Step 2: Write the first failing integration tests**

Cover:

- registry startup/cleanup on a random loopback port;
- publish in derived topological order;
- download exact registry tarballs and compare SHA-256 with the source tarballs;
- exact-version E404;
- main advancing in a temporary working repository while an old tag remains exact.

Reuse Verdaccio configuration concepts from `test/harness/local-registry.ts`, but keep the Node-test harness independent of Vitest/TypeScript helpers.

- [ ] **Step 3: Implement registry and Git fixtures**

Every test uses a fresh temp storage directory and bare remote. Always close servers and remove temp directories in `finally`/test cleanup. Do not use the real npm registry or repository remote.

- [ ] **Step 4: Add the fault proxy**

Expose deterministic controls for delayed visibility, timeout, 401/403, exact 404, 429, malformed JSON, and 5xx. Add one test per classification and assert the planner blocks on ambiguity.

- [ ] **Step 5: Add the slow script and run it**

```json
{
  "test:release-fault-harness": "node --test scripts/release/test/fault-harness.integration.mjs"
}
```

The `.integration.mjs` suffix keeps this slow test outside the fast
`scripts/release/test/*.test.mjs` glob. Run it explicitly:

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  corepack pnpm test:release-fault-harness
```

- [ ] **Step 6: Commit**

```bash
git add scripts/release/test/support scripts/release/test/fixtures/fault-workspace \
  scripts/release/test/fault-harness.integration.mjs package.json
git commit -m "test(release): establish the registry fault harness"
```

## Task 7: Add the preflight report and read-only shadow workflow

**Files:**
- Create: `scripts/release/preflight.mjs`
- Create: `scripts/release/test/preflight.test.mjs`
- Create: `.github/workflows/release-shadow.yml`
- Create: `scripts/release/test/workflow-contracts.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing preflight tests**

The report must distinguish `PASS`, `FAIL`, `WARN`, and `UNPROVABLE`. It may prove current npm provenance for an existing version, static workflow permissions, required `validate` CI, workflow activation, visible environments, and repository default permissions. It must label current npm trusted-publisher configuration and future write/OIDC capability as `UNPROVABLE` unless authenticated owner evidence exists.

Expose:

```js
export async function collectReleasePreflight({ inventory, workflowSource, npm, github })
export function renderPreflightReport(report, { format })
```

- [ ] **Step 2: Implement the CLI and scripts**

```text
node scripts/release/preflight.mjs \
  --repository cacheplane/dawnai \
  --workflow .github/workflows/release.yml \
  [--version 0.8.21] [--format json|markdown] [--strict]
```

Add:

```json
{
  "release:shadow": "node scripts/release/shadow-reconcile.mjs",
  "release:preflight": "node scripts/release/preflight.mjs"
}
```

`--strict` is implemented now but is not enabled in the PR 1 shadow workflow; PR 2 will use it for cutover.

- [ ] **Step 3: Write failing parsed-workflow contracts with the root YAML dependency**

Use the `yaml@2.9.0` dependency added in Task 1.

Contracts must assert:

- `release-shadow.yml` has only `workflow_dispatch` and `schedule` triggers;
- its permissions are only `contents: read` and `actions: read`;
- it contains no OIDC, publish, tag, Release-write, or non-GET controller path;
- third-party actions are pinned to full SHAs;
- the legacy `release.yml` remains the only npm publisher in PR 1;
- final-topology constraints are not applied until PR 2.

- [ ] **Step 4: Implement the workflow**

Use pinned checkout, pnpm setup, and setup-node; fetch depth 0; Node 24.17.0;
and optional paired manual inputs `version`/`commitSha`. Install only the root
tooling with `pnpm install --filter . --frozen-lockfile --ignore-scripts` so the
declared YAML parser is available without building packages. Run inventory,
shadow reconciliation, and preflight; append Markdown to `$GITHUB_STEP_SUMMARY`.
Do not upload an artifact or mutate external release state.

- [ ] **Step 5: Run workflow and preflight tests**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/preflight.test.mjs \
  scripts/release/test/workflow-contracts.test.mjs
```

- [ ] **Step 6: Verify legacy ownership is unchanged**

```bash
git diff --exit-code origin/main -- \
  .github/workflows/release.yml \
  scripts/release-publish.mjs \
  scripts/backfill-release-tags.mjs \
  scripts/upload-release-assets.mjs \
  .github/workflows/published-artifact-verify.yml
```

Expected: no diff.

- [ ] **Step 7: Commit**

```bash
git add scripts/release/preflight.mjs scripts/release/test/preflight.test.mjs \
  scripts/release/test/workflow-contracts.test.mjs .github/workflows/release-shadow.yml \
  package.json pnpm-lock.yaml
git commit -m "ci(release): add the read-only shadow reconciler"
```

## Task 8: Complete PR 1 verification and shadow acceptance

**Files:**
- Verify only; no expected source changes

- [ ] **Step 1: Rebuild before any dist-backed verification**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm build
```

- [ ] **Step 2: Run the release gates**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm check:release-inventory
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:release-controller
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:release-fault-harness
```

Expected: all pass, including exact registry byte comparisons and historical incident dispositions.

- [ ] **Step 3: Run live read-only reports**

```bash
GITHUB_TOKEN="${GH_TOKEN:-$(gh auth token)}" \
  PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node scripts/release/shadow-reconcile.mjs \
    --repository cacheplane/dawnai --version 0.8.21 \
    --commit-sha 341678ea7932832ec860bdd915371669440bef7c --format markdown

GITHUB_TOKEN="${GH_TOKEN:-$(gh auth token)}" \
  PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" \
  node scripts/release/preflight.mjs \
    --repository cacheplane/dawnai --workflow .github/workflows/release.yml \
    --version 0.8.21 --format markdown
```

Expected: read-only reports with no secret values. `UNPROVABLE` is acceptable only for external npm publisher settings/future write capability explicitly identified in the spec.

- [ ] **Step 4: Run the repository Definition of Done**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm ci:validate
```

Expected: all gates pass. If the known `packages/testing/test/subprocess.test.ts` disposal test fails with a successful health response, report it separately; do not relabel the controller as fully green or modify it in this PR.

- [ ] **Step 5: Inspect the final PR 1 branch**

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
git diff --exit-code origin/main -- \
  .github/workflows/release.yml \
  scripts/release-publish.mjs \
  scripts/backfill-release-tags.mjs \
  scripts/upload-release-assets.mjs \
  .github/workflows/published-artifact-verify.yml
```

Expected: clean worktree, only approved commits, and no active-publisher diff.
