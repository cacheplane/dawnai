# Controller Draft Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the four draft-reading release jobs `contents: write` so the controller can observe its own escrow, and pin the write set in the contract tests.

**Architecture:** Two YAML permission edits and one contract-test file. No script changes. Spec: `docs/superpowers/specs/2026-09-04-controller-draft-visibility-design.md`.

**Tech Stack:** GitHub Actions YAML, `node:test` (`scripts/release/test/workflow-contracts.test.mjs`), Node 24, biome.

---

### Task 1: Pin the write set in the contract tests (red first)

**Files:** Modify `scripts/release/test/workflow-contracts.test.mjs`.

- [ ] Add a test `"only the enumerated jobs hold contents: write"` that parses both workflows (use the file's `readRequiredWorkflow`) and asserts the exact sets: release.yml → `["correlate-audit","detect","dispatch-audit","escrow","publish-release","reconcile-npm","reconcile-smokes","record-audit-dispatch","tag"]`; published-artifact-verify.yml → `["coordinate","verify-draft"]`. Sort before comparing.
- [ ] Add a helper `assertContentsWriteOnly(job)`: `job.permissions.contents === "write"`, every other permission value is `"read"`, and `permissions["id-token"] !== "write"`. Use it for `detect` (replacing `assertNoWriteOrOidc(detect)` at ~L865), `dispatch-audit` (replacing the `notEqual(...contents, "write")` at ~L1207 with `assertContentsWriteOnly` and keeping `actions === "write"` — NOTE: dispatch-audit legitimately holds `actions: write`, so for that job the helper must allow `actions: write` explicitly: give the helper an `allowedWrites` parameter defaulting to `[]`), `coordinate` (~L1310; it holds `actions: write`), and `verify-draft` (~L1732 currently `deepEqual(job.permissions, { contents: "read" })` → `{ contents: "write" }` plus whatever it already has).
- [ ] Run `node --test scripts/release/test/workflow-contracts.test.mjs` → the new enumeration test and the four updated assertions FAIL against the current YAML.

### Task 2: Grant the permission

**Files:** Modify `.github/workflows/release.yml` (`detect`, `dispatch-audit`) and `.github/workflows/published-artifact-verify.yml` (`coordinate`, `verify-draft`): `contents: read` → `contents: write` in each job's `permissions` block only. Add a one-line YAML comment above each: `# contents: write — the only scope that exposes draft Releases to GITHUB_TOKEN (spec 2026-09-04-controller-draft-visibility).`

- [ ] Run the contract test file → all pass. Run `pnpm test:release-controller` → exit 0. Run `node scripts/check-docs.mjs`.
- [ ] Commit `feat(release): let the draft-reading release jobs see draft Releases`.

### Task 3: PR

- [ ] Push; open a PR with the spec's Problem and Accepted trade-off sections; `gh pr merge --auto --merge`.
