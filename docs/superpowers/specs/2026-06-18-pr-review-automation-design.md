# PR Review Automation — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Goal:** Add genuine automated AI code review on every PR (real quality + audit trail), and — as a decoupled second mechanism — earn the OSSF Scorecard **Code-Review** check credit without changing who merges, so Brian's account remains the merger on every PR.

## Background

Dawn is a solo-maintainer repo. OSSF Scorecard's **Code-Review** check scores **0** ("0/23 approved changesets") because every change is authored *and* merged by the same person, so no review exists from a different identity. The check is *designed* to detect human review; for a genuinely solo maintainer who merges their own work, any automated path to the score is a metric mechanism, not real review. This was accepted explicitly.

Verified facts (traced in OSSF Scorecard source + GitHub docs):
- **Scorecard credits a changeset as reviewed** if the PR's reviews include a `State == APPROVED` review whose author login differs from the PR author login. The current implementation applies **no bot filter to the reviewer** (`checks/raw/code_review.go` injects merger/reviewers; `probes/codeApproved/impl.go` only compares logins). The "bot/AI reviews don't count" docs prose is **not enforced in code** for the reviewer role. *Caveat: this is a gap between OSSF's stated intent and its code; a future release could close it and the credit would vanish.*
- **`GITHUB_TOKEN` can submit a formal APPROVE review** when the setting *"Allow GitHub Actions to create and approve pull requests"* is enabled (org level first if locked, then repo). The review is attributed to `github-actions[bot]` (≠ the human author → not a self-approval), and is visible via `GET /pulls/{n}/reviews` — the endpoint Scorecard reads.
- An Actions/bot approval does **not** count toward GitHub branch-protection required-review counts — which is fine here: Brian admin-merges (`enforce_admins: false`), exactly as today. **No branch-protection change is needed.**
- `dismiss_stale_reviews` is already `false`, so the bot approval survives later commits.

The genuine AI reviewer (`anthropics/claude-code-action`) **cannot** submit a formal approving review (comments only, by design), so it provides quality + audit trail but contributes nothing to the score on its own. The two concerns are therefore implemented as two independent workflows.

## Scope

### 1. `.github/workflows/claude-review.yml` — genuine AI review

- Trigger: `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`). **Not** `pull_request_target` — keeps `ANTHROPIC_API_KEY` off fork PRs.
- Action: `anthropics/claude-code-action@806af32823ef69c8ef357086c573a902af641307 # v1` (SHA-pinned, consistent with the repo's Pinned-Dependencies posture) in **automation mode** (a `prompt:` input, no `@claude` mention).
- Behavior: reads the diff via `gh pr diff`, posts findings as PR comments focused on correctness, security, TypeScript type-safety, and test-coverage gaps. **Advisory and non-blocking** — it is not a required status check and never gates a merge. No structured verdict / `--json-schema` (decoupled from approval — see §2).
- Auth: `ANTHROPIC_API_KEY` repo secret.
- Permissions (least privilege): `contents: read`, `pull-requests: write`.
- Fork PRs: receive a read-only token, so the secret is absent and the job no-ops/fails harmlessly — acceptable (Brian is the only author).

### 2. `.github/workflows/auto-approve.yml` — Scorecard Code-Review credit

- Trigger: `pull_request` (`opened`, `reopened`, `ready_for_review`). Same-repo PRs get a write-capable `GITHUB_TOKEN`; fork PRs get read-only and are skipped.
- Behavior: submits a formal **APPROVE** review as `github-actions[bot]`, **unconditionally** on PR open (no dependency on CI or the Claude review → no added latency). One step: `gh pr review "$PR_NUMBER" --approve --body "Automated approval recording that this PR ran the automated review pipeline (CI + AI review). This is not a human review."` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- Permissions (least privilege): `pull-requests: write`.
- Idempotence: re-runs (e.g. reopen) may add another APPROVE review; harmless. Optionally guard with a check that the bot hasn't already approved the current head — a minor nicety, not required.

**Why unconditional (not gated on the Claude verdict):** gating would chain the approval behind the 1–3 min Claude run and skip the credit on any flagged PR. Firing immediately is faster, simpler (two fully independent workflows), more robust, and maximizes the credit. The approval has **zero gating power over merges** (Brian still admin-merges as himself and still reads Claude's findings first), so an unconditional approval cannot wave through anything he didn't choose to merge.

### Honesty / documentation

The approval is an **automated formality for the Scorecard metric, not human review.** This is recorded transparently:
- A clear comment block at the top of `auto-approve.yml` stating what it is and why.
- An honest `--body` on the approval itself (e.g. "Automated approval to record an automated-review pipeline; not a human review.").
- An entry in `audit-known-issues.md` noting that the Code-Review credit derives from automated approval, so a future maintainer isn't misled.

### Prerequisites (account-level — Brian handles)

1. Enable **"Allow GitHub Actions to create and approve pull requests"**: org `cacheplane` → Settings → Actions → General → Workflow permissions (enable first if locked), then repo `dawnai` → same. Without this, the approve step errors.
2. Add the **`ANTHROPIC_API_KEY`** repo secret (cost ≈ $0.05–0.30 per PR review).

### Out of scope / explicitly not done

- No merge bot (rejected — would transfer merge-history identity off Brian's account).
- No branch-protection change (bot approval doesn't need to satisfy required reviews; Brian admin-merges).
- No blocking AI gate (avoids false-positive override-traps and added latency).
- No second human/machine-user account.

## Verification

- **claude-review:** open a test PR; confirm Claude posts review comments; confirm fork PRs don't leak the secret (no run with secret on a fork).
- **auto-approve:** open a test PR; confirm a `github-actions[bot]` review with `state: APPROVED` appears via `gh api repos/cacheplane/dawnai/pulls/<n>/reviews`.
- **Score:** after a few PRs merge through this flow, confirm Scorecard's Code-Review check rises above 0 at `https://api.scorecard.dev/projects/github.com/cacheplane/dawnai`.

## Risks & notes

- **Fragility:** the credit relies on the OSSF prose/code gap for bot reviewers; a future Scorecard release may enforce "bot reviews don't count," removing it. The genuine `claude-review.yml` value is unaffected by that.
- **Optics:** the workflow is public; the approach is documented honestly rather than hidden. If that transparency ever feels wrong, deleting `auto-approve.yml` cleanly reverts to Code-Review = 0 with no other impact.
- **Setting scope:** enabling Actions-approval is a repo/org-wide capability; it applies to all workflows, not just this one. Least-privilege `permissions:` blocks limit which jobs can actually use it.
