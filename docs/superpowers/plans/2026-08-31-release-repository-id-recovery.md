# Release Repository-ID Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explicitly bind the trusted GitHub repository ID into the release workflow, then safely complete the immutable v0.8.22 provenance release with the existing controller CLI.

**Architecture:** Keep the GitHub reader's strict repository-ID pagination validation unchanged. Add one workflow-level environment binding sourced from the GitHub Actions context, prove the binding with a workflow-contract test, and use the merged controller plus immutable artifacts from failed run `33418085547` for the one-time escrow recovery.

**Tech Stack:** GitHub Actions YAML, Node.js 24, `node:test`, Dawn's release controller CLI, GitHub CLI, npm trusted publishing and GitHub artifact attestations.

---

### Task 1: Pin the repository identity at the workflow boundary

**Files:**
- Modify: `scripts/release/test/workflow-contracts.test.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release/test/fixtures/release-workflow-disabled.yml`
- Modify: `scripts/release/test/fixtures/release-workflow-protected.yml`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`
- Modify: `scripts/release/abandonment-workflow-policy.json`

- [ ] **Step 1: Write the failing workflow-contract assertion**

In `release.yml has exact triggers and one repository-global non-cancelling queue`, add:

```js
assert.deepEqual(workflow.env, {
  GITHUB_REPOSITORY_ID: workflowExpression("github.repository_id"),
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  node --test --test-name-pattern='repository-global non-cancelling queue' \
  scripts/release/test/workflow-contracts.test.mjs
```

Expected: FAIL because `workflow.env` is currently absent.

- [ ] **Step 3: Add the minimal workflow binding**

Add this top-level block to `.github/workflows/release.yml`:

```yaml
env:
  GITHUB_REPOSITORY_ID: ${{ github.repository_id }}
```

Do not modify the GitHub adapter, accept arbitrary repository-ID URLs, or add a fallback value.

Apply the identical workflow change to both reviewed abandonment fixtures,
refresh their exact canonical policy digests, and add the resulting top-level
`env` descriptor to the audited workflow-entrypoint fixture.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the Step 2 command again.

Expected: PASS.

- [ ] **Step 5: Run focused release verification**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  node --test scripts/release/test/workflow-contracts.test.mjs
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  pnpm test:release-controller
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  pnpm lint
```

Expected: all pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add .github/workflows/release.yml \
  scripts/release/test/workflow-contracts.test.mjs \
  scripts/release/test/fixtures/release-workflow-disabled.yml \
  scripts/release/test/fixtures/release-workflow-protected.yml \
  scripts/release/abandonment-workflow-policy.json \
  scripts/release/test/fixtures/workflow-entrypoints.json
git commit -m "fix(release): bind repository id explicitly"
```

### Task 2: Validate and merge the permanent fix

**Files:**
- Verify: repository-wide gates only

- [ ] **Step 1: Run the local Definition of Done**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: all required gates pass. If a disposable-port collision occurs, diagnose it and rerun only after proving it environmental.

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin blove/fix-release-repository-id-boundary
gh pr create --base main --head blove/fix-release-repository-id-boundary \
  --title "fix(release): bind repository id explicitly" \
  --body-file <prepared-pr-body>
```

- [ ] **Step 3: Request and process GitHub Copilot review**

Request Copilot review through GitHub, inspect every comment, and apply feedback only after technical verification. The independent external reviewer remains waived per user instruction.

- [ ] **Step 4: Require exact-head CI**

Record the PR head SHA. Require all substantive checks for that exact SHA, including validation, release-controller coverage, dependency security, real Vercel, CopilotKit v2, sandbox, storage, charts, and CodeQL. Treat only the previously waived no-credit reviewer lane as non-blocking.

- [ ] **Step 5: Merge with exact-head protection**

Re-read the PR head immediately before merge and merge only if it equals the reviewed and validated SHA.

### Task 3: Reconfirm the v0.8.22 recovery preconditions

**Files:**
- Read: `/tmp/dawn-escrow-diagnose.f0sK9L/runtime/candidate.json`
- Read: `/tmp/dawn-escrow-diagnose.f0sK9L/runtime/release-record.json`
- Read: `/tmp/dawn-escrow-diagnose.f0sK9L/runtime/payload/*`
- Read: `/tmp/dawn-escrow-diagnose.f0sK9L/attestation/attestation-set.json`
- Read: `/tmp/dawn-escrow-diagnose.f0sK9L/attestation/bundles/*`

- [ ] **Step 1: Re-download immutable artifacts by exact run and artifact name if needed**

Use `gh run download 33418085547` for the exact runtime and attestation artifacts. Reject duplicate or unexpected files.

- [ ] **Step 2: Reconfirm external absence and identity**

Verify all of the following with read-only commands:

- `v0.8.22` still peels to `2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`;
- no GitHub Release exists at tag `v0.8.22`;
- every manifest package version `0.8.22` is absent from npm;
- run `33418085547` is the attestation-set run and contains the expected artifacts;
- no `publish-npm` job has started for any candidate run.

- [ ] **Step 3: Repeat the guarded real-adapter diagnostic**

Invoke `runReleaseCli(["escrow", ...])` with real GitHub/npm readers and the real attestation verifier, but replace all five writer methods with a function that throws `DIAGNOSTIC_MUTATION_BOUNDARY_REACHED` before mutation. Supply repository ID `1210070282`.

Expected: all checks and all 22 provenance subjects pass, ending only at the guarded writer boundary.

### Task 4: Escrow the immutable candidate with the existing CLI

**Files:**
- Runtime input: immutable artifacts listed in Task 3
- Production mutation: draft GitHub Release `v0.8.22`

- [ ] **Step 1: Run the escrow transition once**

From the merged controller checkout, run:

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

Expected: `ESCROWED` result for one draft Release. Never print the token.

- [ ] **Step 2: Verify escrow independently**

Read the `v0.8.22` Release by exact tag and confirm:

- it is draft and mutable;
- its target/tag identity matches the candidate;
- its managed marker phase is `ESCROWED`;
- the base asset set is exact and every digest matches the release record, payload, attestation set, and bundles.

Stop if any field or digest is ambiguous.

### Task 5: Resume provenance publication and verify production

**Files:**
- Production workflow: `.github/workflows/release.yml` at tag `v0.8.22`

- [ ] **Step 1: Dispatch exact tagged reconciliation**

Dispatch `.github/workflows/release.yml` at ref `v0.8.22` with exact inputs:

```text
version=0.8.22
commitSha=2a80deece2ff958fe7fde8fddeb4f99bed70a1c8
operation=reconcile
```

- [ ] **Step 2: Observe the workflow through completion**

Require the exact tagged run to complete npm trusted publication, reconciliation, all five published-artifact smoke lanes, independent audit, and final GitHub Release publication. Do not retry blindly after any failure; diagnose the first failed transition.

- [ ] **Step 3: Verify published packages and provenance**

For every package in the sealed manifest, confirm exact version `0.8.22`, integrity/tarball digest, npm provenance, and expected latest-tag behavior.

- [ ] **Step 4: Verify the final GitHub Release**

Confirm the final Release is published, immutable where supported, points to the exact candidate tag/SHA, has the final controller marker, and exposes the exact audited asset set.

- [ ] **Step 5: Run full production smoke verification**

Verify the production Vercel deployment remains tied to the approved candidate content, run the repository's production SEO/link verification, and run the browser smoke against `https://dawnai.org`.

- [ ] **Step 6: Record final evidence**

Report the merged fix PR and SHA, exact release run ID, npm version/provenance results, smoke/audit conclusions, GitHub Release URL, Vercel deployment evidence, and production browser result.
