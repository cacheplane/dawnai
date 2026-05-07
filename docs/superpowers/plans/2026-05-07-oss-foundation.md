# OSS Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public open-source community health files and update GitHub repository metadata without adding DCO or CLA enforcement.

**Architecture:** Keep the OSS foundation as repository-level documentation and GitHub configuration. Preserve `CONTRIBUTORS.md` as the internal engineering guide and add `CONTRIBUTING.md` as the public entrypoint.

**Tech Stack:** Markdown, GitHub issue forms, GitHub Actions, Dependabot, OSSF Scorecard, `gh`.

---

### Task 1: Community Documentation

**Files:**
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `SECURITY.md`
- Create: `SUPPORT.md`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add root license metadata**

Add MIT license text to `LICENSE` and add `"license": "MIT"` to the root `package.json`.

- [ ] **Step 2: Add public contribution guidance**

Create `CONTRIBUTING.md` with setup, verification, PR, issue, changeset, security, and licensing expectations. Do not require `Signed-off-by` trailers and do not mention active CLA enforcement.

- [ ] **Step 3: Add conduct, support, and security docs**

Create `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md` with concise public-facing guidance.

- [ ] **Step 4: Update README links**

Point the README contributing section at `CONTRIBUTING.md` and keep `CONTRIBUTORS.md` linked as the monorepo engineering guide.

### Task 2: GitHub Project Configuration

**Files:**
- Create: `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/scorecard.yml`

- [ ] **Step 1: Add issue and PR templates**

Create focused GitHub issue forms for bug reports and feature requests plus a PR checklist.

- [ ] **Step 2: Add Dependabot configuration**

Configure weekly updates for npm workspace dependencies and GitHub Actions.

- [ ] **Step 3: Add OSSF Scorecard**

Add a weekly and manual Scorecard workflow using `ossf/scorecard-action@v2.4.3`.

### Task 3: Repo Settings And Verification

**Files:**
- No file changes.

- [ ] **Step 1: Validate local files**

Run `node scripts/check-docs.mjs` and syntax-check YAML files.

- [ ] **Step 2: Update GitHub settings with gh**

Use `gh repo edit` and `gh api` to set repo description, homepage, topics, delete-branch-on-merge, auto-merge, and supported security settings.

- [ ] **Step 3: Verify GitHub state**

Use `gh repo view`, `gh api repos/cacheplane/dawnai/community/profile`, and `gh api repos/cacheplane/dawnai` to report recognized files and setting status.
