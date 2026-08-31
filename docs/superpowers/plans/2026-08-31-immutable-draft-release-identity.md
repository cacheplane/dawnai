# Immutable Draft Release Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dawn's release controller safely reconcile GitHub drafts whose temporary `tag_name` is not the requested release tag, then bind and verify the exact tag during immutable publication.

**Architecture:** Add one canonical marker-backed draft selector beside `parseReleaseMarker`, and use it only in paths that may observe mutable managed drafts. Split the GitHub writer's draft and published identity assertions so draft mutations rely on Release ID, canonical metadata, and independent annotated-tag verification, while publication explicitly sends and then re-verifies the exact tag. Published-release consumers retain exact `tag_name` matching.

**Tech Stack:** Node.js 24, ESM JavaScript, `node:test`, GitHub REST API adapters, canonical Dawn release markers, pnpm 10.

---

## File Map

- `scripts/release/metadata.mjs`: owns canonical marker parsing, marker-backed draft selection, escrow discovery, and mutable draft validation.
- `scripts/release/adapters/github-write.mjs`: owns GitHub mutation boundaries, distinct draft/published identity assertions, creation race reconciliation, and explicit publication tag binding.
- `scripts/release/observe.mjs`: production observation of marker-backed pre-publication drafts.
- `scripts/release/candidate.mjs`: active managed-candidate discovery from marker-backed drafts.
- `scripts/release/audit.mjs`: audit transitions that operate on a mutable draft.
- `scripts/release/independent-audit.mjs`: independent audit verification of the managed draft before final publication.
- `scripts/release/independent-audit-coordinator.mjs`: selection of the marker-backed draft for exact-tag and default-branch audit runs.
- `scripts/release/artifact-store.mjs`: release-side attestation resolution while the Release remains a draft.
- `scripts/release/abandonment.mjs`: fail-closed discovery and validation of a prepublication candidate draft.
- `scripts/release/abandonment-handoff.mjs`: recovery-context discovery of a marker-backed draft.
- `scripts/release/test/*.test.mjs`: focused regression tests for each affected boundary.
- `scripts/release/test/support/release-rehearsal-github.mjs`: realistic fake GitHub behavior that gives drafts temporary tag identities and binds the requested tag at publication.

### Task 1: Define canonical marker-backed draft selection

**Files:**
- Modify: `scripts/release/metadata.mjs`
- Modify: `scripts/release/test/metadata.test.mjs`

- [ ] **Step 1: Write failing discovery and ambiguity tests**

Add a test fixture whose Release has:

```js
{
  id: 7,
  tag_name: "untagged-opaque",
  target_commitish: "main",
  name: `Dawn v${VERSION}`,
  body: canonicalReleaseBody({ marker, manifest }),
  draft: true,
  prerelease: false,
  immutable: false,
}
```

Assert that escrow resumes this exact `ATTACHING` draft instead of calling
`createDraftRelease`. Add a second marker-bearing draft and assert the operation
fails with the existing duplicate-managed-Release ambiguity before mutation.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test --test-name-pattern='temporary tag|duplicate managed Releases' scripts/release/test/metadata.test.mjs
```

Expected: FAIL because `findManagedRelease` only compares `tag_name`.

- [ ] **Step 3: Add the canonical selector**

Export a small predicate beside `parseReleaseMarker`:

```js
export function isManagedReleaseForTag(release, tag) {
  if (!isRecord(release) || typeof release.tag_name !== "string") return false
  if (release.tag_name === tag) return true
  if (
    release.draft !== true ||
    release.immutable !== false ||
    typeof release.body !== "string"
  ) {
    return false
  }
  try {
    return parseReleaseMarker(release.body).tag === tag
  } catch {
    return false
  }
}
```

Use it in `findManagedRelease`. Remove `tag_name` from
`assertMutableCandidateRelease`; continue requiring the exact title,
`target_commitish`, prerelease state, body, draft state, immutable state, marker,
and independently verified annotated tag.

- [ ] **Step 4: Run the focused metadata tests and verify GREEN**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/metadata.test.mjs
```

Expected: all metadata tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/metadata.mjs scripts/release/test/metadata.test.mjs
git commit -m "fix(release): identify drafts by canonical marker"
```

### Task 2: Separate GitHub draft identity from published tag identity

**Files:**
- Modify: `scripts/release/adapters/github-write.mjs`
- Modify: `scripts/release/test/github-write.test.mjs`

- [ ] **Step 1: Write failing writer tests**

Cover three behaviors:

1. POST creates a draft whose subsequent GET reports a temporary `tag_name`, and
   creation still returns the created Release ID.
2. Update and asset upload accept that same mutable draft while annotated-tag
   verification remains before and after the mutation.
3. Publication PATCH contains both fields and the immutable re-read must expose
   the exact requested tag:

```js
assert.deepEqual(JSON.parse(publishRequest.body), {
  tag_name: TAG,
  draft: false,
})
```

Also assert an immutable re-read with a temporary tag fails.

- [ ] **Step 2: Run the writer tests and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/github-write.test.mjs
```

Expected: FAIL at `assertReleaseIdentity` and because publication omits
`tag_name`.

- [ ] **Step 3: Implement distinct assertions and draft discovery**

Refactor to these responsibilities:

```js
function assertReleaseMetadata(release, args) {
  if (
    positiveId(release.id, "Release ID") !==
      positiveId(args.releaseId ?? release.id, "Release ID") ||
    release.target_commitish !== "main" ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string" ||
    typeof release.name !== "string" ||
    typeof release.body !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.immutable !== "boolean"
  ) {
    throw new Error("GitHub Release identity or metadata is malformed")
  }
}

function assertDraftIdentity(release, args, expected = {}) {
  assertReleaseMetadata(release, args)
  if (release.draft !== true || release.immutable !== false) {
    throw new Error("GitHub Release is not the expected mutable draft")
  }
  // Retain exact title/body compare-and-swap checks.
}

function assertPublishedIdentity(release, args) {
  assertReleaseMetadata(release, args)
  if (release.tag_name !== args.tag || release.draft !== false || release.immutable !== true) {
    throw new Error("GitHub published Release identity is malformed")
  }
}
```

For creation/race discovery, accept an exact tag match or a mutable draft with
the exact requested title and canonical body. Preserve duplicate ambiguity.
Change publication to:

```js
body: { tag_name: args.tag, draft: false }
```

Use `assertDraftIdentity` before publication and
`assertPublishedIdentity` after publication or for an existing published
Release.

- [ ] **Step 4: Run writer tests and verify GREEN**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/github-write.test.mjs
```

Expected: all writer tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/adapters/github-write.mjs scripts/release/test/github-write.test.mjs
git commit -m "fix(release): bind draft tag at publication"
```

### Task 3: Migrate every prepublication reader to marker-backed selection

**Files:**
- Modify: `scripts/release/observe.mjs`
- Modify: `scripts/release/candidate.mjs`
- Modify: `scripts/release/audit.mjs`
- Modify: `scripts/release/independent-audit.mjs`
- Modify: `scripts/release/independent-audit-coordinator.mjs`
- Modify: `scripts/release/artifact-store.mjs`
- Modify: `scripts/release/abandonment.mjs`
- Modify: `scripts/release/abandonment-handoff.mjs`
- Modify: corresponding files under `scripts/release/test/`

- [ ] **Step 1: Add failing temporary-draft tests at each selection boundary**

In each existing fixture, change the managed prepublication Release from
`tag_name: v<version>` to `tag_name: "untagged-opaque"` while retaining its
canonical marker. Assert the same candidate, escrow, audit, or abandonment
result is selected. Add one malformed-marker case and one duplicate-marker case
to prove unrelated temporary drafts are ignored and conflicts fail closed.

Do not change fixtures for paths that explicitly require a published Release;
those must continue to use `tag_name: v<version>`.

- [ ] **Step 2: Run affected tests and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test \
  scripts/release/test/observe-production.test.mjs \
  scripts/release/test/candidate.test.mjs \
  scripts/release/test/audit.test.mjs \
  scripts/release/test/independent-audit.test.mjs \
  scripts/release/test/independent-audit-coordinator.test.mjs \
  scripts/release/test/artifact-store.test.mjs \
  scripts/release/test/abandonment.test.mjs \
  scripts/release/test/abandonment-handoff.test.mjs
```

Expected: failures where exact `tag_name` filters miss the managed draft.

- [ ] **Step 3: Use the shared selector only for mutable managed state**

Import `isManagedReleaseForTag` from `metadata.mjs` and replace exact filters in
prepublication discovery:

```js
const matches = releases.filter((release) => isManagedReleaseForTag(release, tag))
```

Remove `tag_name` equality from validators that have already selected a mutable
draft by its exact canonical marker; retain their title, commit, phase, body,
asset, and annotated-tag checks. Retain explicit
`release.tag_name === tag` checks in final publication, immutable-release
verification, release-integrity audit results, and any other path whose
contract requires a published Release.

- [ ] **Step 4: Run the affected test set and verify GREEN**

Run the command from Step 2.

Expected: all affected tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/observe.mjs scripts/release/candidate.mjs \
  scripts/release/audit.mjs scripts/release/independent-audit.mjs \
  scripts/release/independent-audit-coordinator.mjs \
  scripts/release/artifact-store.mjs scripts/release/abandonment.mjs \
  scripts/release/abandonment-handoff.mjs scripts/release/test
git commit -m "fix(release): observe marker-backed drafts"
```

### Task 4: Make the full release rehearsal reproduce GitHub semantics

**Files:**
- Modify: `scripts/release/test/support/release-rehearsal-github.mjs`
- Modify: `scripts/release/test/support/release-rehearsal.mjs`
- Modify: `scripts/release/test/rehearsal.test.mjs`
- Modify: `scripts/release/test/rehearsal-controller.test.mjs`

- [ ] **Step 1: Change the fake to expose temporary draft identity**

Make draft creation store an opaque temporary `tag_name` while preserving the
requested tag separately inside the fake's expected publication state. On the
publication PATCH, require `tag_name` and assign it to the Release before
returning `draft: false, immutable: true`.

- [ ] **Step 2: Run the rehearsal and verify RED**

Run the owning test file found by:

```bash
rg -l 'release-rehearsal-github' scripts/release/test
```

Expected: FAIL until all release phases use marker-backed draft discovery and
publication binds the tag.

- [ ] **Step 3: Complete the fake and assertions**

Assert the rehearsal crosses:

```text
ATTACHING -> ESCROWED -> NPM_COMPLETE -> SMOKES_COMPLETE
-> AUDIT_DISPATCHED -> AUDIT_VERIFIED -> immutable publication
```

with a temporary tag throughout the draft phases and the exact tag only after
publication.

- [ ] **Step 4: Run the rehearsal and verify GREEN**

Run the owning test plus `github-write.test.mjs` and `metadata.test.mjs`.

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/test/support/release-rehearsal-github.mjs scripts/release/test
git commit -m "test(release): rehearse temporary draft identity"
```

### Task 5: Validate, review, and merge the permanent fix

**Files:**
- Modify only files needed to fix failures attributable to this change.

- [ ] **Step 1: Run focused and full controller verification**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm lint
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm test:release-controller
```

Expected: lint exits 0 and all release-controller tests pass.

- [ ] **Step 2: Run the repository Definition of Done**

```bash
DAWN_REQUIRE_DOCKER=1 PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm ci:validate
```

Expected: all AGENTS.md gates pass. If a loaded concurrent harness produces a
transport-only failure, repeat only that exact harness in isolation and retain
both outputs as evidence.

- [ ] **Step 3: Push and open the PR**

Push `blove/fix-immutable-draft-identity`, open a PR describing the live
GitHub behavior and safe partial-draft recovery, and require exact-head CI.

- [ ] **Step 4: Request GitHub Copilot review**

Request Copilot on the exact PR head. Resolve technically valid feedback with
`superpowers:receiving-code-review`; do not add an independent human/agent
reviewer because the user waived it.

- [ ] **Step 5: Merge only the exact reviewed head**

Require all substantive checks, the real Vercel lanes, and Copilot review.
Treat the known no-credit reviewer lane as waived. Merge with
`--match-head-commit` and verify the exact head is an ancestor of `origin/main`.

### Task 6: Converge v0.8.22 and complete provenance publication

**Files:**
- No source changes expected.
- Existing recovery inputs: `/tmp/dawn-escrow-diagnose.f0sK9L/`
- Existing draft: GitHub Release ID `379991871`

- [ ] **Step 1: Re-run read-only preconditions**

Verify the annotated tag object still peels to
`2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`, Release `379991871` is a mutable
`ATTACHING` draft with exactly 45 assets, all v0.8.22 npm versions remain absent,
and no publish job has started.

- [ ] **Step 2: Run the fixed escrow CLI**

```bash
GITHUB_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY=cacheplane/dawnai \
GITHUB_REPOSITORY_ID=1210070282 \
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
node scripts/release/cli.mjs escrow \
  --candidate /tmp/dawn-escrow-diagnose.f0sK9L/runtime/candidate.json \
  --record /tmp/dawn-escrow-diagnose.f0sK9L/runtime/release-record.json \
  --artifact-dir /tmp/dawn-escrow-diagnose.f0sK9L/runtime/payload \
  --attestation-set /tmp/dawn-escrow-diagnose.f0sK9L/attestation/attestation-set.json \
  --attestation-bundles-dir /tmp/dawn-escrow-diagnose.f0sK9L/attestation/bundles
```

Expected: exit 0; the existing draft remains Release `379991871`, retains the
exact 45 assets, and advances to `ESCROWED` without replacing assets.

- [ ] **Step 3: Dispatch the exact tagged reconciliation workflow**

Dispatch `.github/workflows/release.yml` at `v0.8.22` with version `0.8.22`,
candidate commit `2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`, and operation `reconcile`.
Observe the exact run rather than retrying generically on failure.

- [ ] **Step 4: Verify each irreversible boundary**

Confirm npm trusted publishing produces provenance for all 21 packages, smoke
receipts cover every required lane, the independent audit succeeds, the GitHub
Release publishes with exact tag `v0.8.22` and `immutable: true`, and no asset or
marker drift occurs.

- [ ] **Step 5: Run full production smoke verification**

Verify package installation, scaffolding, runtime targets, storage, metadata,
CopilotKit v2 examples, the real Vercel deployment, dawnai.org production
content, SEO URLs, and browser smoke. Report exact run/deployment/release IDs.
