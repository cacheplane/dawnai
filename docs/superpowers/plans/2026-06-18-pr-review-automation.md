# PR Review Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two GitHub Actions workflows — a genuine advisory AI code review on every PR, and an unconditional `github-actions[bot]` approval that earns the OSSF Scorecard Code-Review credit while the maintainer remains the merger.

**Architecture:** Two fully independent `pull_request`-triggered workflows (no cross-workflow coupling). `claude-review.yml` runs `anthropics/claude-code-action` in automation mode to post findings as comments. `auto-approve.yml` submits a formal APPROVE review via `GITHUB_TOKEN` so a non-author identity appears in the PR's reviews. Plus one transparency note in `audit-known-issues.md`. No branch-protection change.

**Tech Stack:** GitHub Actions YAML, `anthropics/claude-code-action@v1`, `gh` CLI, `GITHUB_TOKEN`.

**Reference spec:** `docs/superpowers/specs/2026-06-18-pr-review-automation-design.md`

**These are GitHub-only workflows** — they cannot run on a local machine, so there are no unit tests. The local "test" for each is: the YAML parses and (if installed) `actionlint` is clean. Real behavior is verified by a live PR after merge — captured in Task 4 and the spec's Verification section.

**Pinned action SHAs (reuse the repo's existing pins):**

| Action | Tag | SHA |
|---|---|---|
| anthropics/claude-code-action | v1 | `806af32823ef69c8ef357086c573a902af641307` |
| actions/checkout | v6 | `df4cb1c069e1874edd31b4311f1884172cec0e10` |

**Branch:** work happens on `blove/pr-review-automation` (already created off `main`, with the spec commits). Do not switch branches.

---

### Task 1: Genuine AI review workflow

**Files:**
- Create: `.github/workflows/claude-review.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Claude Review

# Genuine, advisory AI code review on every PR. Posts findings as PR
# comments. NOT a required status check — it never blocks a merge.
# Uses `pull_request` (not pull_request_target) so ANTHROPIC_API_KEY is
# never exposed to fork PRs.

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
        with:
          fetch-depth: 1

      - name: Claude review
        uses: anthropics/claude-code-action@806af32823ef69c8ef357086c573a902af641307 # v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          track_progress: true
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review this pull request and post your findings as GitHub PR comments.
            Read the diff with `gh pr diff` and the description with `gh pr view`.
            Focus on:
            - Correctness bugs
            - Security issues (injection, secrets, unsafe input handling)
            - TypeScript type-safety problems
            - Missing or weak test coverage for the change

            Post a concise top-level summary via `gh pr comment`. Post specific
            issues as inline comments. Be brief; skip nitpicks and style unless
            they affect correctness. If the PR looks good, say so briefly.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 15
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/claude-review.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Confirm actions are SHA-pinned and not pull_request_target**

Run: `grep -n 'uses: .*@v' .github/workflows/claude-review.yml; grep -n 'pull_request_target' .github/workflows/claude-review.yml; echo "checked"`
Expected: no `@v` matches and no `pull_request_target` match (only `checked` prints).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/claude-review.yml
git commit -m "ci: add advisory Claude AI review on PRs"
```

---

### Task 2: Auto-approve workflow (Scorecard Code-Review credit)

**Files:**
- Create: `.github/workflows/auto-approve.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Auto Approve

# Records that an intelligent (AI) code review ran on the PR by submitting
# a formal APPROVE review as github-actions[bot] (an identity distinct from
# the PR author). This is what OSSF Scorecard's Code-Review check reads from
# the reviews API. It does NOT count toward branch-protection required
# reviews and has no power to merge — the maintainer still merges. Skips
# fork PRs (read-only token there). See the approval body and
# audit-known-issues.md for the full rationale.
#
# PREREQUISITE: repo/org setting "Allow GitHub Actions to create and approve
# pull requests" must be enabled, or the approve step errors.

on:
  pull_request:
    types: [opened, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  approve:
    # Only same-repo PRs: fork PRs get a read-only token and cannot approve.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: write
    steps:
      - name: Approve pull request
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh pr review "$PR_NUMBER" --approve \
            --body "Automated approval: this PR received an intelligent (AI) code review. See the review comments on this PR."
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/auto-approve.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Confirm least-privilege and fork guard present**

Run: `grep -n 'pull-requests: write' .github/workflows/auto-approve.yml && grep -n 'head.repo.full_name == github.repository' .github/workflows/auto-approve.yml`
Expected: both lines match (job has the write scope and the fork guard).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/auto-approve.yml
git commit -m "ci: auto-approve PRs to record the AI review for Scorecard Code-Review"
```

---

### Task 3: Transparency note in audit-known-issues.md

`audit-known-issues.md` already exists at the repo root (from the Scorecard dep work). Add a section recording where the Code-Review credit comes from, so a future maintainer understands it.

**Files:**
- Modify: `audit-known-issues.md`

- [ ] **Step 1: Append the note**

Add this section to the end of `audit-known-issues.md`:

```markdown
## OSSF Scorecard Code-Review credit

The Code-Review check is credited via automation, not peer review: every PR
receives an intelligent (AI) code review (`.github/workflows/claude-review.yml`),
and `.github/workflows/auto-approve.yml` submits a formal approval as
`github-actions[bot]` — an identity distinct from the PR author — which the
check reads from the reviews API. The maintainer remains the merger on every PR.

Note: OSSF documentation suggests automated/AI reviews may not be intended to
count toward this check; the current implementation does credit them. A future
Scorecard release could change this. Removing `auto-approve.yml` cleanly reverts
the check with no other impact.
```

- [ ] **Step 2: Verify it parses as markdown / file is non-empty**

Run: `tail -n 12 audit-known-issues.md`
Expected: the new "OSSF Scorecard Code-Review credit" section prints.

- [ ] **Step 3: Commit**

```bash
git add audit-known-issues.md
git commit -m "docs: record source of the Scorecard Code-Review credit"
```

---

### Task 4: Verification and prerequisites

- [ ] **Step 1: Lint workflows with actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/claude-review.yml .github/workflows/auto-approve.yml || echo "actionlint not installed — relying on YAML parse"`
Expected: actionlint prints no errors, OR the fallback message. (Do not install actionlint just for this.)

- [ ] **Step 2: Confirm repo-wide that all workflow actions remain SHA-pinned**

Run: `grep -rn 'uses: .*@v' .github/workflows/ ; echo "exit: $?"`
Expected: no matches (grep exit 1) — keeps the Pinned-Dependencies Scorecard check intact.

- [ ] **Step 3: Record the manual prerequisites (do not skip)**

These are account-level and must be done by the maintainer before the workflows function:
1. Enable **"Allow GitHub Actions to create and approve pull requests"** — org `cacheplane` (Settings → Actions → General → Workflow permissions) first if locked, then repo `dawnai`. Without it, the `auto-approve` step errors.
2. Add the **`ANTHROPIC_API_KEY`** repository secret. Without it, `claude-review` fails (no review posted); `auto-approve` is unaffected.

- [ ] **Step 4: Post-merge live verification (after the PR for this work is merged and prerequisites are set)**

1. Open a small test PR.
2. Confirm Claude posts review comment(s) on it.
3. Confirm a bot approval exists:
   Run: `gh api repos/cacheplane/dawnai/pulls/<n>/reviews --jq '.[] | {user: .user.login, state: .state}'`
   Expected: an entry `{"user":"github-actions[bot]","state":"APPROVED"}`.
4. After a few PRs flow through, confirm Scorecard's Code-Review check rises above 0 at `https://api.scorecard.dev/projects/github.com/cacheplane/dawnai`.

---

## Self-review notes

- **Spec coverage:** claude-review.yml (Task 1), auto-approve.yml unconditional approval + fork guard (Task 2), transparency note (Task 3), prerequisites + verification (Task 4). No branch-protection change (correctly absent). Matches the approved spec.
- **Pin consistency:** both new workflows use the SHA table at the top; `claude-review.yml` checkout reuses the repo's existing `actions/checkout` v6 pin.
- **No placeholders:** every workflow file is given in full; the only `<n>` is a live PR number in the post-merge manual step, which is inherently runtime.
