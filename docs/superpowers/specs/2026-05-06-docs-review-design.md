# Dawn Docs Review — Design Spec

**Date:** 2026-05-06
**Status:** Approved (brainstorm complete; ready for plan)

## Goal

Find and fix gaps, misalignments, and errors across user-facing Dawn docs. Verify code examples on load-bearing pages actually run against the current packages. Produce an audit report and four targeted fix PRs.

## Scope

**In scope:**

- Root `README.md`
- Website docs: `apps/web/content/docs/*.mdx` (8 pages)
- Templates that ship with scaffolded apps: `apps/web/content/templates/AGENTS.md`, `apps/web/content/templates/CLAUDE.md`
- All package READMEs under `packages/*/README.md` (11 packages)

**Out of scope (explicit):**

- Internal historical docs in `docs/superpowers/specs/` and `docs/superpowers/plans/` — point-in-time artifacts, not maintained
- `docs/next-iterations-roadmap.md` and `docs/thread-handoff.md` — internal tracking
- Adding net-new docs pages (e.g., a new "middleware" page). Gaps requiring a brand-new page are recorded but deferred to a follow-up issue list
- Website navigation, sidebar, layout, or styling changes — content only
- Code changes to packages — this is a docs-only review

**Escape hatch:** if a broken-example finding requires a one-line code change to make a documented API match the docs (and the docs are right), the implementer can include that in the website-docs PR with explicit callout in the PR description. Anything larger is deferred.

## Architecture

The work runs in two phases producing five PRs total:

1. **Audit phase** — read-only. Six subagents dispatched in parallel, each with bounded surface ownership. They produce a single audit report at `docs/superpowers/audits/2026-05-06-docs-audit.md` with structured findings. The report ships as **PR 0** and merges to `main` before fix work begins, so each fix implementer can read its slice of the audit straight from `main`.

2. **Fix phase** — write-only. Four independent PRs (A, B, C, D), one implementer subagent per PR. PRs branched from `main`, merged independently on green CI.

Both phases run in the worktree at `.worktrees/docs-review`.

## Audit Phase

### Subagent decomposition

| # | Subagent | Files | Verification |
|---|----------|-------|---|
| 1 | Root README auditor | `README.md` | Cross-reference every CLI command, code snippet, and file path against current source |
| 2 | Website load-bearing pages auditor | `getting-started.mdx`, `routes.mdx`, `tools.mdx`, `deployment.mdx` | Structural review **and** code-example verification (extract snippets → temp fixture → `pnpm exec tsc --noEmit`; for getting-started, scaffold via packed tarballs and run `dawn check`/`dawn verify`) |
| 3 | Website supporting pages auditor | `state.mdx`, `cli.mdx`, `dev-server.mdx`, `testing.mdx` | Structural only |
| 4 | Templates auditor | `AGENTS.md`, `CLAUDE.md` | Verify every directive matches actual current behavior. These ship with scaffolded apps |
| 5 | Public package READMEs auditor | `packages/{sdk,cli,create-dawn-ai-app}/README.md` | Compare current stubs against hybrid-policy expectations |
| 6 | Internal package READMEs auditor | `packages/{config-biome,config-typescript,core,devkit,langchain,langgraph,vite-plugin}/README.md` | Verify stub-with-pointer format consistency |

Subagents 1, 4, 5, 6 are independent and dispatched in parallel. Subagents 2 and 3 are dispatched after 1, 4, 5, 6 begin (they share build-tooling state but don't conflict on files).

### Findings format

Each subagent appends to the audit report under its section using a fixed schema:

```markdown
### F-NNN: <one-line summary>
- **Surface:** <surface>
- **File:** <path:line if applicable>
- **Type:** gap | misalignment | error | broken-example
- **Severity:** critical | important | minor
- **Description:** <what's wrong>
- **Suggested fix:** <concrete change, or "needs design">
```

Severity meanings:

- **critical:** users hit a wall (broken example, wrong instruction that prevents a working app)
- **important:** users get confused or take the wrong path, but recoverable
- **minor:** style, wording, dead links to non-blocking content

### Findings cut

Before dispatching fix PRs, the controller presents the audit summary to the user. Critical and important findings are in scope. Minor findings get deferred to a follow-up issue list. This is the gate that keeps fix PRs reviewable.

### PR 0 — audit report

After the findings cut, the agreed-upon audit report is opened as a PR against `main` and merged on green CI. This makes the report durable and gives each fix implementer a stable reference path on `main`.

## Fix Phase

### PRs

| PR | Surface | Verification |
|----|---------|---|
| A | `README.md` | All code/CLI refs grep-verified against source |
| B | `apps/web/content/docs/*.mdx` + `templates/*.md` | `pnpm --filter web build` clean; load-bearing examples scaffolded & run |
| C | `packages/{sdk,cli,create-dawn-ai-app}/README.md` (hybrid-policy: real overview + install + key APIs + link to website) | `npm pack --dry-run` clean; readable when rendered |
| D | The other 7 package READMEs (stub-with-pointer per hybrid policy) | Visual inspection; pointer format consistent |

### Implementer flow per PR

1. Read its slice of the audit (only findings for its surface)
2. Implement the fixes on a branch from `main`
3. Run the relevant verification
4. Push branch + open PR
5. Spec-compliance review (against audit findings) → quality review → fix loops until both pass
6. Wait for CI green, then merge

PRs land independently. Default order is **B → A → C → D** (B is largest, A may reference website URLs, C/D are quick cleanup). Any PR can ship first if others get blocked.

### Worktree lifecycle

- Created at `.worktrees/docs-review` from `main` at the start of the audit phase
- Each fix PR is branched from `main` directly, not from the worktree branch — keeps PRs independent
- Worktree cleaned up via superpowers:finishing-a-development-branch after the last fix PR merges

## Success Criteria

- Audit report at `docs/superpowers/audits/2026-05-06-docs-audit.md` merged to `main` (PR 0) with all critical and important findings categorized
- Four fix PRs (A, B, C, D) merged to `main`, all CI green
- Code examples in `getting-started.mdx`, `routes.mdx`, `tools.mdx`, `deployment.mdx` verified to run against current packages
- Hybrid READMEs policy applied: 3 fleshed out, 7 as stub-with-pointer
- Minor-severity findings captured in a follow-up issue list (or GitHub issues)
