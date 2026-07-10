# Public Package Pack Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm pack:check` validate every public workspace package and fail when future public packages lack pack expectations.

**Architecture:** Extract the declarative package manifest from the executable pack runner into `scripts/lib/pack-check.mjs`. Test the manifest against public package discovery, then have the existing runner import it without changing pack execution behavior.

**Tech Stack:** Node.js ESM, Vitest, pnpm pack, tar.

---

### Task 1: Guard public package coverage

**Files:**
- Create: `scripts/pack-check.test.mjs`
- Create: `scripts/lib/pack-check.mjs`
- Modify: `scripts/pack-check.mjs`
- Modify: `package.json`

- [ ] Write a test that discovers non-private `packages/*/package.json` files and compares their directories with the pack manifest.
- [ ] Assert that public package directories are unique and every entry expects `README.md` and `package.json`.
- [ ] Run the focused test and confirm it fails because the manifest module or package entries are missing.
- [ ] Extract the existing manifest into the side-effect-free module.
- [ ] Invoke manifest validation from the runner before any package build or pack command.
- [ ] Import the manifest in the runner and confirm existing behavior remains intact.
- [ ] Add a root `test:pack-check` script and make `pack:check` invoke it before the artifact runner.

### Task 2: Cover every public package

**Files:**
- Modify: `scripts/lib/pack-check.mjs`
- Test: `scripts/pack-check.test.mjs`

- [ ] Add artifact and metadata expectations for every uncovered public package.
- [ ] Run the focused test and confirm all public package directories are covered.
- [ ] Run `pnpm pack:check` and confirm every configured tarball passes.

### Task 3: Verify and review

**Files:**
- Verify all changed files.

- [ ] Run `node --test scripts/pack-check.test.mjs`.
- [ ] Run formatting/lint checks for changed files and `git diff --check`.
- [ ] Review the diff for accidental package or release changes.
