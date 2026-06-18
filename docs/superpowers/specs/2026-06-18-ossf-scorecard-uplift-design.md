# OSSF Scorecard Uplift — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Goal:** Raise Dawn's live OpenSSF Scorecard from **4.1/10** to **~8/10**, which in turn lifts the `hvtracker.net` HVTrust Safety and Transparency dimensions (Scorecard feeds both at 0.5 weight, ~21 of 100 HVTrust points).

## Background

[hvtracker.net](https://hvtracker.net) is an AI-agent trust registry that ranks open-source agent frameworks by verifiable supply-chain signals. OSSF Scorecard is the single highest-leverage input to its score. Dawn's repo (`cacheplane/dawnai`) publishes Scorecard results to `api.scorecard.dev` via `ossf/scorecard-action` with `publish_results: true`, so the score is already public and readable.

Scorecard is a weighted average of per-check scores (Critical=10, High=7.5, Medium=5, Low=2.5; checks scoring -1 are excluded). Each check is 0–10.

## Current board (live, 2026-06-18)

| Check | Score | Risk | Root cause | Action |
|---|---|---|---|---|
| Token-Permissions | 0 | High | `ci.yml` has no `permissions:` block → workflow token defaults to write-all | PR 1 |
| Pinned-Dependencies | 0 | Medium | GitHub Actions pinned to tags (`@v6`), not commit SHAs | PR 1 |
| SAST | 0 | Medium | No CodeQL (or other recognized SAST) workflow | PR 1 |
| Vulnerabilities | 0 | High | 25 OSV advisories in dev/docs deps (Next.js ×8, vitest, vite, esbuild, turbo, ws, langsmith, js-yaml, uuid) | PR 2 |
| Branch-Protection | -1 | High | Default `GITHUB_TOKEN` can't read classic branch-protection rules | Follow-up (PAT) |
| Code-Review | 0 | High | 0/23 recent changesets went through an approved PR | Follow-up (process) |
| CII-Best-Practices | 0 | Low | No OpenSSF Best Practices badge | Follow-up (badge) |
| Maintained | 0 | High | Repo created <90 days ago (2026-04-14) | **Auto-resolves ~2026-07-14** |
| Signed-Releases | -1 | High | "no releases found" — GitHub Releases lack signed assets | Deferred |
| Packaging | -1 | Medium | changesets publish not recognized as a packaging workflow | Skip (cosmetic) |

**Already maxed (10):** License, Security-Policy, Dependency-Update-Tool, Dangerous-Workflow, Binary-Artifacts.
**Partial:** CI-Tests 7, Contributors 3.

## Scope

### PR 1 — Pure config (zero runtime risk)

Expected: Token-Permissions 0→10, Pinned-Dependencies 0→~9, SAST 0→10. ≈ +2.0 aggregate.

1. **Token-Permissions.** Add a top-level least-privilege `permissions:` block to every workflow:
   - `ci.yml`: top-level `permissions: contents: read` (it currently declares none).
   - `release.yml`: add top-level `permissions: contents: read`; keep the existing job-level `contents: write` / `pull-requests: write` / `id-token: write`.
   - `scorecard.yml`: already has top-level `contents: read` — no change.
2. **Pinned-Dependencies.** Pin every `uses:` action to a full 40-char commit SHA with a trailing `# vX.Y.Z` comment, across all three workflows:
   - `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `pnpm/action-setup`, `changesets/action`, `github/codeql-action/upload-sarif`, `ossf/scorecard-action`, plus any added in PR 1.
   - Dependabot's existing `github-actions` ecosystem config keeps SHAs updated (it rewrites SHA + comment on new releases).
3. **SAST.** Add `.github/workflows/codeql.yml` using `github/codeql-action` (init/analyze) for the `javascript-typescript` language, triggered on `pull_request`, `push: main`, and a weekly `schedule`. Pin its actions to SHAs. Least-privilege `permissions` (`contents: read`, job-level `security-events: write`).

### PR 2 — Dependency remediation (medium risk)

Expected: Vulnerabilities 0→10. ≈ +0.86 aggregate. The check stays near 0 until **essentially all** advisories clear, so this PR must drive the open count to ~0.

- Bump direct dependencies: `next` (clears ~8 advisories, in the private `@dawn-ai/web` docs app), `vite`, `vitest`, `turbo`.
- Add/extend pnpm `overrides` for transitive advisories that can't be cleared by a direct bump: `ws`, `esbuild`, `js-yaml`, `uuid`, and bump the existing `langsmith` override.
- **Gate:** full CI must pass — `pnpm lint`, `build`, `typecheck`, `test`, and all four harness verification steps (`verify:harness:*`). `pnpm pack:check` must still pass. This is the only PR that can break the build; do not merge on red.
- Re-run `pnpm audit` after changes; target zero (or only un-fixable/disputed) advisories.

### Follow-ups (require Brian's GitHub account — tracked, not coded here)

These are split off because they need account-level actions an agent can't perform:

1. **Branch-Protection (PAT).** Create a fine-grained PAT with **read** access to repository administration, store as the `repo_token` (or `SCORECARD_TOKEN`) secret, and pass it to `ossf/scorecard-action`. Un-excludes Branch-Protection (-1 → ~8, High weight, ≈ +0.85). The repo already has required reviews + status checks + conversation resolution; strengthening with `enforce_admins` and required signatures would push the tier higher.
2. **Code-Review (process).** Route your own commits to `main` through reviewed PRs going forward so approved changesets accumulate. PR 1 and PR 2 themselves should be merged this way to start the count. Climbs 0 → up over time (High weight).
3. **CII-Best-Practices (badge).** Self-certify at [bestpractices.dev](https://bestpractices.dev) (free). 0 → 5+ (Low weight).

### Deferred / out of scope

- **Signed-Releases** (-1): requires reworking the release to create GitHub Releases with signed assets (e.g. attaching the npm provenance `*.intoto.jsonl` / Sigstore artifacts). High effort — own spec later.
- **Packaging** (-1): cosmetic; changesets publish isn't recognized as a packaging workflow.
- **Fuzzing** (0): not meaningful for this library surface.
- **Contributors** (3): organic; not directly actionable.

## Expected trajectory

| Milestone | Approx. aggregate |
|---|---|
| Today | 4.1 |
| After PR 1 (config) | ~6.2 |
| After PR 2 (deps) | ~7.0 |
| After follow-ups (PAT + Code-Review + badge) | ~7.8 |
| ~2026-07-14 (Maintained auto-flips) | ~8.6 |

## Verification

- **PR 1/PR 2:** standard CI green in the PR. Scorecard recomputes on push to `main` and on its weekly schedule; confirm the new per-check scores at `https://api.scorecard.dev/projects/github.com/cacheplane/dawnai` a day or two after merge.
- **Pinned-Dependencies / Token-Permissions:** verifiable immediately from the workflow YAML (SHAs present, top-level `permissions` set).
- **Vulnerabilities:** `pnpm audit` open-count ~0 locally before merge; Scorecard OSV count confirms after.

## Risks & notes

- HVTracker's weighting is explicitly experimental and exists in two forms (runtime `fetch_and_build.py` 25/18/17/20/20 vs spec `specs.py` 25/20/20/20/15); the levers are identical under both. Point estimates here are approximate.
- Dawn is **not yet listed** on hvtracker.net (returns 404). Raising Scorecard only converts to HVTrust points once the project is listed — a separate, prerequisite action.
- Dependency bumps (PR 2) are the main breakage risk; the harness verification gate is the guardrail.
