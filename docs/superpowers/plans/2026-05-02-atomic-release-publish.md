# Atomic Release Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI release all public packages as one coordinated patch release and avoid exposing partial releases on the `latest` dist-tag.

**Architecture:** Keep Changesets responsible for version planning, but replace direct `changeset publish` with a guarded npm publish script. The script publishes missing package versions under a temporary dist-tag, verifies every intended package version exists, then promotes all packages to `latest` only after the full set is present.

**Tech Stack:** GitHub Actions, Changesets, pnpm, npm CLI, Node.js ESM, `node:test`.

---

### Task 1: Fixed Version Coverage

**Files:**
- Modify: `.changeset/config.json`

- [x] **Step 1: Identify all public packages**

Run: `for f in packages/*/package.json; do node -e "const p=require('./'+process.argv[1]); if(!p.private) console.log(p.name)" "$f"; done`

Expected: all package names that need fixed release behavior.

- [x] **Step 2: Add missing public packages to the fixed Changesets group**

Include `@dawn-ai/config-biome` and `@dawn-ai/config-typescript` in the same fixed group as the runtime packages.

- [x] **Step 3: Dry-run a patch changeset**

Run a temporary `changeset version` outside the worktree and confirm every public package receives the same next patch version.

### Task 2: Guarded npm Publish Script

**Files:**
- Create: `scripts/release-publish.mjs`
- Create: `scripts/release-publish.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`

- [x] **Step 1: Write failing tests**

Test that the release publisher:
- publishes missing versions under a temporary dist-tag;
- does not promote any package to `latest` if any package publish fails;
- on retry, promotes already-staged versions once every package version exists;
- treats already-latest packages as a no-op.

Run: `node --test scripts/release-publish.test.mjs`

Expected: fail because `scripts/release-publish.mjs` does not exist yet.

- [x] **Step 2: Implement release publisher**

Export dependency-injectable helpers for tests and run as a CLI in CI. Use npm registry reads to determine local versions, `pnpm publish --tag <temporary-tag>` for missing versions, and `npm dist-tag add <pkg>@<version> latest` only after all versions are present.

- [x] **Step 3: Wire CI to the guarded publisher**

Change the Changesets action `publish` command from `pnpm exec changeset publish` to `pnpm release:publish`.

- [x] **Step 4: Add package script**

Add `release:publish` and `test:release-publish`, and include the release publish test in `ci:validate`.

### Task 3: Verification and PR

**Files:**
- All modified files

- [x] **Step 1: Run focused tests**

Run: `node --test scripts/release-publish.test.mjs`

Expected: all release-publish tests pass.

- [x] **Step 2: Run full release gate**

Run: `pnpm ci:validate`

Expected: all checks pass.

- [x] **Step 3: Commit, push, and open PR**

Commit on `codex/release-atomic-publish`, push to origin, and open a PR targeting `main`.

- [ ] **Step 4: Merge on green**

After CI is green, merge the PR. If CI fails, inspect the failing check logs, fix, rerun verification, and update the PR.
