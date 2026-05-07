# Dawn Docs Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit and fix gaps, misalignments, and errors across user-facing Dawn docs (root README, website docs, templates, package READMEs); verify code examples on load-bearing pages run against current packages.

**Architecture:** Two phases, five PRs total. Phase 1 produces a single audit report via six parallel subagents (PR 0). Phase 2 produces four independent fix PRs (A: root README, B: website docs + templates, C: public package READMEs fleshed out, D: internal package READMEs as stub-with-pointer). Fix PRs branch from `main` after PR 0 merges so they each have the audit available.

**Tech Stack:** Markdown / MDX, Biome lint, pnpm workspace, Next.js (website build), TypeScript (code-example verification).

**Worktree:** all controller-side work runs in `.worktrees/docs-review` on branch `feature/docs-review`. Fix PRs use temporary branches from `main`.

---

## Phase 1 — Audit

### Task 1: Initialize audit report skeleton

**Files:**
- Create: `docs/superpowers/audits/2026-05-06-docs-audit.md`

- [ ] **Step 1: Create the audit report skeleton**

Write the file at `docs/superpowers/audits/2026-05-06-docs-audit.md` with this exact content:

```markdown
# Dawn Docs Audit — 2026-05-06

**Status:** in progress
**Spec:** `docs/superpowers/specs/2026-05-06-docs-review-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-docs-review.md`

## Findings format

Each finding uses this schema:

\`\`\`markdown
### F-NNN: <one-line summary>
- **Surface:** <surface>
- **File:** <path:line if applicable>
- **Type:** gap | misalignment | error | broken-example
- **Severity:** critical | important | minor
- **Description:** <what's wrong>
- **Suggested fix:** <concrete change, or "needs design">
\`\`\`

Findings are numbered globally across all sections (F-001, F-002, ...). Each subagent claims a contiguous range and announces it in its closing summary so the next subagent picks up from F-(N+1).

## 1. Root README (`README.md`)

_(pending — Task 2)_

## 2. Website load-bearing pages (`getting-started.mdx`, `routes.mdx`, `tools.mdx`, `deployment.mdx`)

_(pending — Task 3)_

## 3. Website supporting pages (`state.mdx`, `cli.mdx`, `dev-server.mdx`, `testing.mdx`)

_(pending — Task 4)_

## 4. Templates (`AGENTS.md`, `CLAUDE.md`)

_(pending — Task 5)_

## 5. Public package READMEs (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`)

_(pending — Task 6)_

## 6. Internal package READMEs (config-biome, config-typescript, core, devkit, langchain, langgraph, vite-plugin)

_(pending — Task 7)_

## Summary

_(pending — populated at the findings cut after Tasks 2–7)_
```

- [ ] **Step 2: Verify the file was created**

Run: `wc -l docs/superpowers/audits/2026-05-06-docs-audit.md`
Expected: at least 30 lines.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs: scaffold docs audit report"
```

---

### Task 2: Audit Root README

**Files:**
- Read: `README.md`
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (section 1)

- [ ] **Step 1: Dispatch root README auditor subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are auditing the root README of the Dawn project. This is read-only research — do NOT edit any code or website docs. Your only output is appending findings to the audit report file.

Read these files first:
- README.md (the file under audit)
- packages/cli/src/commands/*.ts (every CLI command and its options)
- packages/sdk/src/index.ts (SDK exports)
- packages/create-dawn-ai-app/src/bin.ts (scaffold CLI)
- package.json (workspace scripts and metadata)

For each claim in README.md, verify it matches the current code:
- Every CLI command shown (e.g., `dawn check`, `dawn verify`, `dawn build`) must exist in packages/cli/src/commands
- Every code snippet must reference current SDK exports
- Every URL or file path must resolve (use Read or Glob to confirm)
- Every install command must use the right package names
- Every claim about "what Dawn does" must align with current capabilities (deployment via LangGraph platform, retry config, middleware, etc — these are recent features)

Append findings to docs/superpowers/audits/2026-05-06-docs-audit.md under section "## 1. Root README". Use the F-NNN format (start at F-001). Severities: critical = users hit a wall; important = users confused; minor = style/wording. Number findings sequentially.

End with a summary line: "Root README findings: F-001 through F-NNN (X critical, Y important, Z minor)."

If you find no issues, write "_(no findings)_" under the section and report so in your summary.

Report back with: the F-NNN range you used, the count by severity, and any judgment calls you made.
```

- [ ] **Step 2: Verify subagent appended findings**

Run: `grep -E "^### F-" docs/superpowers/audits/2026-05-06-docs-audit.md | head -20`
Expected: at least the F-NNN range the subagent reported, OR the section contains `_(no findings)_`.

Read the section: confirm the format matches the schema (Surface, File, Type, Severity, Description, Suggested fix).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): root README findings"
```

---

### Task 3: Audit Website Load-Bearing Pages (with code verification)

**Files:**
- Read: `apps/web/content/docs/getting-started.mdx`, `routes.mdx`, `tools.mdx`, `deployment.mdx`
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (section 2)

- [ ] **Step 1: Dispatch load-bearing-pages auditor subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are auditing the load-bearing website docs pages for Dawn. This is read-only research — do NOT edit any code or doc content. Your only output is appending findings to the audit report file.

Files under audit:
- apps/web/content/docs/getting-started.mdx
- apps/web/content/docs/routes.mdx
- apps/web/content/docs/tools.mdx
- apps/web/content/docs/deployment.mdx

For each page, do a structural review:
- Every code block: extract and verify it typechecks against the current SDK. For TS/MDX snippets, write the snippet to a temp file under /tmp/dawn-doc-verify/<slug>.ts that imports from "@dawn-ai/sdk", "@dawn-ai/core", "@dawn-ai/langchain" as needed. Then run `cd /Users/blove/repos/dawn && pnpm exec tsc --noEmit --target esnext --moduleResolution bundler --module esnext /tmp/dawn-doc-verify/<slug>.ts 2>&1` and capture failures.
- Every CLI command shown (`dawn dev`, `dawn check`, `dawn verify`, `dawn build`, `dawn routes`, `dawn typegen`) must exist in packages/cli/src/commands and accept the documented flags.
- Every cross-link (`[link](/docs/foo)`) must resolve to an existing page in apps/web/content/docs/.
- Every claim about routes, tools, agents, deployment must align with the current code.
- For getting-started specifically: the documented scaffold flow must work. You don't need to actually scaffold (that's expensive), but each step must reference real commands and produce real files.

Recent feature work that must be reflected:
- `agent()` descriptor with optional `retry: { maxAttempts, baseDelay }` (added 2026-05-05)
- `defineMiddleware`, `reject(status, body?)`, `allow(context?)` from @dawn-ai/sdk
- `MiddlewareRequest` with parsed headers and params
- Tool `run` second arg now includes `middleware?` field for context (added 2026-05-06)
- `dawn build` produces `langgraph.json` with `dependencies: ["."]` and `env` as path
- `dawn verify` includes a `deps` check (4 checks, not 3)

Append findings to docs/superpowers/audits/2026-05-06-docs-audit.md under section "## 2. Website load-bearing pages". Use F-NNN format starting from where Task 2 left off (read the report first to find the highest existing F-number, then start at F-(N+1)).

End with a summary line: "Load-bearing pages findings: F-NNN through F-MMM (X critical, Y important, Z minor)."

Clean up your /tmp/dawn-doc-verify/ files when done.

Report back with: the F-NNN range used, count by severity, list of pages with the most issues.
```

- [ ] **Step 2: Verify subagent appended findings and cleaned up tempfiles**

Run: `grep -c "^### F-" docs/superpowers/audits/2026-05-06-docs-audit.md`
Expected: increased by however many findings the subagent reported.

Run: `ls /tmp/dawn-doc-verify/ 2>&1`
Expected: directory not present, or empty.

If tempfiles remain, run: `rm -rf /tmp/dawn-doc-verify`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): website load-bearing pages findings"
```

---

### Task 4: Audit Website Supporting Pages

**Files:**
- Read: `apps/web/content/docs/state.mdx`, `cli.mdx`, `dev-server.mdx`, `testing.mdx`
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (section 3)

- [ ] **Step 1: Dispatch supporting-pages auditor subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are auditing the supporting website docs pages for Dawn. This is read-only research — structural review only, no code-example verification (those pages are lower-stakes).

Files under audit:
- apps/web/content/docs/state.mdx
- apps/web/content/docs/cli.mdx
- apps/web/content/docs/dev-server.mdx
- apps/web/content/docs/testing.mdx

For each page:
- Read it end-to-end.
- Cross-check every CLI command, file path, and code reference against the current source (packages/cli/src/commands, packages/sdk/src, packages/core/src).
- Cross-check internal links — every [text](/docs/foo) must resolve to a real page in apps/web/content/docs/.
- Look for content that became stale due to recent feature work:
  - state.mdx: confirm Zod-based state defs and reducers match current `state.ts` semantics
  - cli.mdx: every command flag must be real
  - dev-server.mdx: ports, endpoints, /healthz behavior must match packages/cli/src/lib/dev/runtime-server.ts
  - testing.mdx: testing helpers and DAWN_TEST_RUNNER guidance must match packages/cli/src/testing/index.ts
- Note gaps where significant features have no mention (e.g., middleware page doesn't exist — but creating it is OUT OF SCOPE; record as a finding with "Suggested fix: defer to follow-up issue").

Append findings to docs/superpowers/audits/2026-05-06-docs-audit.md under section "## 3. Website supporting pages". Use F-NNN starting from where Task 3 left off.

End with a summary: "Supporting pages findings: F-NNN through F-MMM (X critical, Y important, Z minor)."

Report back with: the F-NNN range, count by severity, and which pages drifted most.
```

- [ ] **Step 2: Verify subagent appended findings**

Read section 3 of the audit report; confirm format compliance.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): website supporting pages findings"
```

---

### Task 5: Audit Templates

**Files:**
- Read: `apps/web/content/templates/AGENTS.md`, `apps/web/content/templates/CLAUDE.md`
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (section 4)

- [ ] **Step 1: Dispatch templates auditor subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are auditing AI-agent prompt templates that ship with scaffolded Dawn apps. These are high-stakes — they tell future Claude/Codex sessions how to work in a Dawn app.

Files under audit:
- apps/web/content/templates/AGENTS.md
- apps/web/content/templates/CLAUDE.md

For each file:
- Read it end-to-end.
- Verify every directive matches actual current behavior. Examples:
  - Claims about how routes are structured (file conventions, default exports)
  - Claims about how tools are authored (default export signature: `(input, context) => ...`)
  - Claims about state, config, middleware
  - Claims about CLI commands and what they do
- Cross-reference packages/sdk/src, packages/core/src, packages/cli/src/commands.
- Pay special attention to anything that conflicts with recent feature work:
  - Tool signature now includes `middleware?` in context
  - Agent descriptor has optional retry config
  - Middleware exists as `src/middleware.ts` with defineMiddleware/reject/allow
  - `dawn build` writes langgraph.json (paths-as-deps, env-as-file)
- Check that the two templates are consistent with each other where they cover the same topic. Inconsistency itself is a finding.

Append findings to docs/superpowers/audits/2026-05-06-docs-audit.md under section "## 4. Templates". Use F-NNN starting from where Task 4 left off.

End with a summary: "Templates findings: F-NNN through F-MMM (X critical, Y important, Z minor)."

Report back with: the F-NNN range, count by severity, biggest divergence between current code and what the templates claim.
```

- [ ] **Step 2: Verify subagent appended findings**

Read section 4 of the audit report; confirm format compliance.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): templates findings"
```

---

### Task 6: Audit Public Package READMEs

**Files:**
- Read: `packages/sdk/README.md`, `packages/cli/README.md`, `packages/create-dawn-ai-app/README.md`
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (section 5)

- [ ] **Step 1: Dispatch public-package-READMEs auditor subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are auditing the README files for Dawn's three publicly-discoverable npm packages: @dawn-ai/sdk, @dawn-ai/cli, create-dawn-ai-app.

Files under audit:
- packages/sdk/README.md
- packages/cli/README.md
- packages/create-dawn-ai-app/README.md

These currently are ~10-line stubs. The hybrid policy says public packages need a real README: overview, installation, key APIs, and a link to https://dawn-ai.org/docs/<page>.

For each file, audit against the hybrid-policy expectations:
- Has a clear one-paragraph overview of what the package does
- Has install instructions (e.g., `npm install @dawn-ai/sdk`) that match the actual package name in package.json
- Has the most important APIs/commands shown briefly with a code example or two
- Links to the relevant website page for full docs
- README will render reasonably on npmjs.com

Each gap relative to that target is a finding (Type: gap, Severity: important by default).

Cross-reference packages/sdk/src/index.ts, packages/cli/src/index.ts, packages/create-dawn-ai-app/src/bin.ts to know what to feature.

Append findings to docs/superpowers/audits/2026-05-06-docs-audit.md under section "## 5. Public package READMEs". Use F-NNN starting from where Task 5 left off.

End with a summary: "Public READMEs findings: F-NNN through F-MMM (X critical, Y important, Z minor)."

Report back with: the F-NNN range, count, and which package needs the most work.
```

- [ ] **Step 2: Verify subagent appended findings**

Read section 5 of the audit report; confirm format compliance.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): public package READMEs findings"
```

---

### Task 7: Audit Internal Package READMEs

**Files:**
- Read: `packages/{config-biome,config-typescript,core,devkit,langchain,langgraph,vite-plugin}/README.md`
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (section 6)

- [ ] **Step 1: Dispatch internal-package-READMEs auditor subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are auditing the README files for Dawn's seven internal packages. These should be stub-with-pointer per the hybrid policy: a 5-10 line file that names the package, says what it is in one sentence, and points to the website for full docs.

Files under audit:
- packages/config-biome/README.md
- packages/config-typescript/README.md
- packages/core/README.md
- packages/devkit/README.md
- packages/langchain/README.md
- packages/langgraph/README.md
- packages/vite-plugin/README.md

For each file, check:
- Format consistency: do they all follow the same template? (If not, that's a finding.)
- Each lists the right package name (matches package.json `name`)
- Each has a one-line description that matches the package's actual purpose
- Each points to https://dawn-ai.org or a more specific URL where appropriate
- No stale claims (e.g., a claim about an API surface that has since been removed)

Each inconsistency or gap is a finding (Type: gap or misalignment, Severity: minor unless content is materially wrong).

Append findings to docs/superpowers/audits/2026-05-06-docs-audit.md under section "## 6. Internal package READMEs". Use F-NNN starting from where Task 6 left off.

End with a summary: "Internal READMEs findings: F-NNN through F-MMM (X critical, Y important, Z minor)."

Report back with: the F-NNN range, count by severity, whether the seven READMEs are consistent or all-different.
```

- [ ] **Step 2: Verify subagent appended findings**

Read section 6 of the audit report; confirm format compliance.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): internal package READMEs findings"
```

---

### Task 8: Findings cut and audit summary

**Files:**
- Modify: `docs/superpowers/audits/2026-05-06-docs-audit.md` (status header, Summary section)

- [ ] **Step 1: Read the full audit report and tally findings by severity**

Run: `grep -E "^- \\*\\*Severity:\\*\\*" docs/superpowers/audits/2026-05-06-docs-audit.md | sort | uniq -c`

Capture the totals. Confirm against the per-section subagent summaries.

- [ ] **Step 2: Present the summary to the user**

Reply to the user with a structured summary, e.g.:

```
Audit complete. Findings:

| Section | Critical | Important | Minor | Total |
|---------|---------:|----------:|------:|------:|
| Root README             | <n> | <n> | <n> | <n> |
| Website load-bearing    | <n> | <n> | <n> | <n> |
| Website supporting      | <n> | <n> | <n> | <n> |
| Templates               | <n> | <n> | <n> | <n> |
| Public READMEs          | <n> | <n> | <n> | <n> |
| Internal READMEs        | <n> | <n> | <n> | <n> |
| **Total**               | **<n>** | **<n>** | **<n>** | **<n>** |

Per the spec, critical and important findings are in scope for the fix PRs. Minor findings get deferred to a follow-up issue list.

Top critical findings: <bullet list of 3–5 with F-NNN references>

Anything you'd like to recategorize before I open PR 0?
```

Wait for user confirmation before proceeding.

- [ ] **Step 3: Update the audit report status and Summary section**

Update the `**Status:**` line at the top of the report from `in progress` to `complete`.

Replace the `## Summary` section with a populated version, e.g.:

```markdown
## Summary

| Section | Critical | Important | Minor | Total |
|---------|---------:|----------:|------:|------:|
| Root README             | <n> | <n> | <n> | <n> |
| ... etc ... |
| **Total**               | **<n>** | **<n>** | **<n>** | **<n>** |

**In scope for fix PRs:** all critical + important findings (N total).
**Deferred:** minor findings will be filed as a follow-up GitHub issue.

**Recategorization decisions:** <list any user-driven changes from Step 2, or "none">.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-docs-audit.md
git commit -m "docs(audit): findings cut and summary"
```

---

### Task 9: PR 0 — Open audit PR and merge on green

**Files:**
- (no new files — pushes the existing branch)

- [ ] **Step 1: Push the docs-review branch**

```bash
cd /Users/blove/repos/dawn/.worktrees/docs-review
git push -u origin feature/docs-review
```

Expected: branch pushes successfully to `origin/feature/docs-review`.

- [ ] **Step 2: Open the audit PR**

```bash
gh pr create --title "docs: docs review audit (PR 0 of 5)" --body "$(cat <<'EOF'
## Summary

This is PR 0 of the docs review series. It lands the audit report and design docs.

- Adds `docs/superpowers/specs/2026-05-06-docs-review-design.md`
- Adds `docs/superpowers/plans/2026-05-06-docs-review.md`
- Adds `docs/superpowers/audits/2026-05-06-docs-audit.md` with all critical and important findings categorized

Subsequent PRs (A, B, C, D) implement the fixes. Each branches from `main` after this PR lands so they can read findings from the audit at a stable path.

## Test plan

- [x] Audit report follows the documented schema
- [x] Findings tallied by severity match per-section summaries
- [ ] CI green
EOF
)"
```

- [ ] **Step 3: Wait for CI to go green, then merge**

```bash
gh pr checks --watch
```

When green:

```bash
gh pr merge --squash --delete-branch
```

Expected: PR merges, branch deletes.

- [ ] **Step 4: Sync local main and prepare for fix PRs**

```bash
cd /Users/blove/repos/dawn
git checkout main
git pull --rebase origin main
```

Expected: HEAD is at the squashed audit commit.

---

## Phase 2 — Fix PRs

Each fix PR follows the same pattern: branch from `main`, dispatch one implementer subagent with the relevant audit slice, verify, push, open PR, wait green, merge.

The implementer subagent for each fix PR receives:
- Path to the audit report on `main` (now stable)
- The exact F-NNN range / section that's relevant
- The verification command for that PR
- Explicit instruction to fix only critical and important findings (skip deferred minor ones unless trivial in the same edit)

### Task 10: PR B — Website docs and templates

**Files:**
- Modify: `apps/web/content/docs/{getting-started,routes,tools,state,cli,dev-server,testing,deployment}.mdx`
- Modify: `apps/web/content/templates/{AGENTS,CLAUDE}.md`

PR B goes first because it's the largest and other PRs may reference website URLs that this PR stabilizes.

- [ ] **Step 1: Branch from main**

```bash
cd /Users/blove/repos/dawn
git checkout -b fix/docs-website main
```

- [ ] **Step 2: Dispatch website-docs implementer subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are implementing fixes for the website docs and templates surface of the Dawn docs review.

Read first:
- docs/superpowers/audits/2026-05-06-docs-audit.md (the full audit report)
- docs/superpowers/specs/2026-05-06-docs-review-design.md (for context, especially the escape hatch)

Your scope: sections 2 (Website load-bearing pages), 3 (Website supporting pages), and 4 (Templates) of the audit.

Implement only critical and important findings. Skip minor findings unless fixing one is trivial in the same edit (then mention it in your summary).

Files you may modify:
- apps/web/content/docs/{getting-started,routes,tools,state,cli,dev-server,testing,deployment}.mdx
- apps/web/content/templates/{AGENTS,CLAUDE}.md

You may NOT modify code in packages/* unless the audit's escape hatch applies (one-line change to make a documented API match the docs, with the docs being right). If you exercise the escape hatch, list the change in your summary so it gets called out in the PR description.

For each finding F-NNN you address, leave a brief commit message that references the F-NNN.

Verification before you finish:
1. `cd /Users/blove/repos/dawn && pnpm --filter web build` — must succeed.
2. For load-bearing pages, re-run any code-example verification the auditor did. Reuse a /tmp/dawn-doc-verify/ scratch dir, then clean up.
3. Internal links: confirm every `[text](/docs/foo)` you wrote resolves to an existing page.

Make small, frequent commits — one per finding (or per cohesive group of findings on the same page). Do NOT push or open a PR; that's the controller's job.

Report back with:
- Which F-NNN findings you addressed (and which you skipped, if any)
- Any escape-hatch code changes
- Output of `pnpm --filter web build` (last 5 lines)
- A short list of files modified
```

- [ ] **Step 3: Dispatch spec-compliance reviewer subagent**

Use Task tool with subagent_type=general-purpose. Prompt:

```
You are reviewing PR B — website docs fixes — against the audit report.

Read:
- docs/superpowers/audits/2026-05-06-docs-audit.md (sections 2, 3, 4)
- The current diff (run: `git diff main..HEAD`)

Confirm: each in-scope critical + important finding from sections 2, 3, 4 is addressed by the diff. Any not addressed must have a written justification in the implementer's report (escape-hatch, deferred, etc.).

Flag any extra changes that don't correspond to a finding (scope creep).

Approve or list specific gaps. Do not modify files.
```

If reviewer flags gaps, re-dispatch the implementer with explicit fix instructions, then re-review.

- [ ] **Step 4: Dispatch code-quality reviewer subagent**

Use Task tool with subagent_type=superpowers:code-reviewer. Prompt:

```
Review the diff for PR B (docs website fixes).

BASE_SHA: $(git merge-base main HEAD)
HEAD_SHA: HEAD
DESCRIPTION: Website docs + templates fixes from the docs audit.

Focus on: clarity, technical accuracy of code examples, internal link health, consistency across pages. Skip nitpicks.
```

If reviewer flags issues, re-dispatch the implementer to fix, then re-review.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin fix/docs-website
gh pr create --title "docs: website docs and templates fixes (PR B)" --body "$(cat <<'EOF'
## Summary

Fixes critical and important findings from sections 2, 3, 4 of `docs/superpowers/audits/2026-05-06-docs-audit.md` (website docs + templates).

Findings addressed: <list F-NNN ranges from implementer report>.

<If any escape-hatch code changes were made, list them here.>

## Test plan

- [x] `pnpm --filter web build` succeeds locally
- [x] Internal links verified to resolve
- [ ] CI green
EOF
)"
```

- [ ] **Step 6: Wait for CI green, merge**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

- [ ] **Step 7: Sync local main**

```bash
git checkout main
git pull --rebase origin main
```

---

### Task 11: PR A — Root README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Branch from main**

```bash
cd /Users/blove/repos/dawn
git checkout -b fix/docs-readme main
```

- [ ] **Step 2: Dispatch root-README implementer subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are implementing fixes for the root README of the Dawn project.

Read first:
- docs/superpowers/audits/2026-05-06-docs-audit.md (full audit; focus on section 1)
- docs/superpowers/specs/2026-05-06-docs-review-design.md (for the escape hatch)

Your scope: section 1 (Root README) of the audit. Implement only critical and important findings.

Files you may modify:
- README.md

You may NOT modify code in packages/* unless the audit's escape hatch applies.

Verification before you finish:
1. Every CLI command shown in README.md must exist (grep packages/cli/src/commands).
2. Every code snippet typechecks against current SDK exports.
3. Every internal/external link resolves.

Make small commits — one per finding or cohesive group. Do NOT push or open a PR.

Report back with:
- F-NNN findings addressed
- Any escape-hatch code changes
- Files modified
```

- [ ] **Step 3: Dispatch spec-compliance reviewer subagent**

Same pattern as Task 10 Step 3, but for section 1 of the audit.

- [ ] **Step 4: Dispatch code-quality reviewer subagent**

Same pattern as Task 10 Step 4.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin fix/docs-readme
gh pr create --title "docs: root README fixes (PR A)" --body "$(cat <<'EOF'
## Summary

Fixes critical and important findings from section 1 of `docs/superpowers/audits/2026-05-06-docs-audit.md` (root README).

Findings addressed: <F-NNN list>.

## Test plan

- [x] CLI commands shown verified to exist
- [x] Code snippets typecheck
- [x] Links resolve
- [ ] CI green
EOF
)"
```

- [ ] **Step 6: Wait for CI green, merge**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

- [ ] **Step 7: Sync local main**

```bash
git checkout main
git pull --rebase origin main
```

---

### Task 12: PR C — Public package READMEs (fleshed out)

**Files:**
- Modify: `packages/sdk/README.md`, `packages/cli/README.md`, `packages/create-dawn-ai-app/README.md`

- [ ] **Step 1: Branch from main**

```bash
cd /Users/blove/repos/dawn
git checkout -b fix/docs-public-readmes main
```

- [ ] **Step 2: Dispatch public-READMEs implementer subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are fleshing out the README files for the three publicly-discoverable Dawn packages.

Read first:
- docs/superpowers/audits/2026-05-06-docs-audit.md (full audit; focus on section 5)
- docs/superpowers/specs/2026-05-06-docs-review-design.md (for the hybrid policy)
- packages/sdk/src/index.ts, packages/cli/src/commands/*.ts, packages/create-dawn-ai-app/src/bin.ts (to know what to feature)

Your scope: section 5 (Public package READMEs) of the audit. Implement all in-scope findings.

The hybrid policy says each public README needs:
1. One-paragraph overview of what the package does
2. Install instructions matching the package.json `name`
3. Key APIs/commands shown briefly with a small code example or two
4. Link to https://dawn-ai.org/docs/<page> for full docs

Files you may modify (only these):
- packages/sdk/README.md
- packages/cli/README.md
- packages/create-dawn-ai-app/README.md

Verification before you finish:
1. Each README's install command uses the right package name (compare to package.json).
2. Each code example in the README typechecks. Use the same /tmp/dawn-doc-verify/ approach as the load-bearing-page auditor.
3. Run `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/sdk pack --dry-run`, same for `@dawn-ai/cli` and `create-dawn-ai-app`. Confirm READMEs are included in the published files list.
4. Visually inspect each README for npm rendering (no broken markdown).

Make small commits — one per package. Do NOT push or open a PR.

Report back with:
- F-NNN findings addressed
- Output of `pack --dry-run` for each package (last few lines)
- Files modified
```

- [ ] **Step 3: Dispatch spec-compliance reviewer subagent**

Same pattern, scoped to section 5.

- [ ] **Step 4: Dispatch code-quality reviewer subagent**

Same pattern.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin fix/docs-public-readmes
gh pr create --title "docs: flesh out public package READMEs (PR C)" --body "$(cat <<'EOF'
## Summary

Fleshes out README.md for three publicly-discoverable Dawn packages per the hybrid policy in `docs/superpowers/specs/2026-05-06-docs-review-design.md`:
- `packages/sdk/README.md`
- `packages/cli/README.md`
- `packages/create-dawn-ai-app/README.md`

Each now has overview, install, key APIs, and a link to the website. Implements section 5 of the audit.

## Test plan

- [x] `pack --dry-run` includes README in published files for each package
- [x] Code examples typecheck
- [ ] CI green
EOF
)"
```

- [ ] **Step 6: Wait for CI green, merge**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

- [ ] **Step 7: Sync local main**

```bash
git checkout main
git pull --rebase origin main
```

---

### Task 13: PR D — Internal package READMEs (stub-with-pointer)

**Files:**
- Modify: `packages/{config-biome,config-typescript,core,devkit,langchain,langgraph,vite-plugin}/README.md`

- [ ] **Step 1: Branch from main**

```bash
cd /Users/blove/repos/dawn
git checkout -b fix/docs-internal-readmes main
```

- [ ] **Step 2: Dispatch internal-READMEs implementer subagent**

Use Task tool with subagent_type=general-purpose. Prompt (verbatim):

```
You are normalizing the seven internal-package READMEs to a stub-with-pointer template per the hybrid policy.

Read first:
- docs/superpowers/audits/2026-05-06-docs-audit.md (full audit; focus on section 6)
- docs/superpowers/specs/2026-05-06-docs-review-design.md (for the hybrid policy)

Your scope: section 6 (Internal package READMEs) of the audit. Implement all in-scope findings, plus normalize all seven to a single template.

Use this exact template (filling in package-specific values):

```
# @dawn-ai/<package-name>

<One sentence describing what this package does. Be specific.>

This package is an internal Dawn workspace package. For Dawn documentation, see <https://dawn-ai.org>.

## License

MIT
```

Files you may modify (only these):
- packages/config-biome/README.md
- packages/config-typescript/README.md
- packages/core/README.md
- packages/devkit/README.md
- packages/langchain/README.md
- packages/langgraph/README.md
- packages/vite-plugin/README.md

For each file:
1. Confirm the package name matches `name` in the corresponding package.json.
2. Pick a one-sentence description that's accurate to the current code (skim the package's src/index.ts for context).
3. Use the template verbatim otherwise — including the website URL.

Verification before you finish:
1. `diff -u packages/config-biome/README.md packages/core/README.md` and similar — should differ only in package name and one-sentence description, nothing else.

Make one commit per package, or a single commit normalizing all seven if they're trivial. Do NOT push or open a PR.

Report back with:
- F-NNN findings addressed
- Confirmation that all seven READMEs now use the same template structure
```

- [ ] **Step 3: Dispatch spec-compliance reviewer subagent**

Same pattern, scoped to section 6.

- [ ] **Step 4: Dispatch code-quality reviewer subagent**

Same pattern. (Likely will approve quickly given the small scope.)

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin fix/docs-internal-readmes
gh pr create --title "docs: normalize internal package READMEs (PR D)" --body "$(cat <<'EOF'
## Summary

Normalizes the seven internal-package README.md files to a stub-with-pointer template per the hybrid policy in `docs/superpowers/specs/2026-05-06-docs-review-design.md`.

Each now contains: package name, one-sentence description, link to https://dawn-ai.org, and license. Implements section 6 of the audit.

## Test plan

- [x] All seven READMEs follow the same template
- [x] Each package name matches its package.json
- [ ] CI green
EOF
)"
```

- [ ] **Step 6: Wait for CI green, merge**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

- [ ] **Step 7: Sync local main**

```bash
git checkout main
git pull --rebase origin main
```

---

### Task 14: File deferred-minor-findings issue and clean up

**Files:**
- (no files; GitHub issue + worktree cleanup)

- [ ] **Step 1: File a follow-up GitHub issue listing all deferred minor findings**

Run:

```bash
gh issue create --title "docs: deferred minor findings from 2026-05-06 audit" --body "$(cat <<'EOF'
This issue tracks the minor-severity findings deferred from the docs review audit at `docs/superpowers/audits/2026-05-06-docs-audit.md`.

These were intentionally out of scope for the five-PR docs review series (PR 0, A, B, C, D, all merged) so the fix PRs stayed reviewable.

## Deferred findings

<bulleted list of every "Severity: minor" finding from the audit, with F-NNN reference and one-line summary>

Anyone can pick these up incrementally.
EOF
)"
```

Capture the issue URL.

- [ ] **Step 2: Verify all five PRs merged and main is clean**

```bash
gh pr list --state merged --base main --head fix/docs-website,fix/docs-readme,fix/docs-public-readmes,fix/docs-internal-readmes,feature/docs-review --limit 10
```

Expected: five entries (audit + four fixes), all merged.

```bash
cd /Users/blove/repos/dawn
git status -s
```

Expected: empty.

- [ ] **Step 3: Clean up the docs-review worktree**

```bash
cd /Users/blove/repos/dawn
git worktree remove .worktrees/docs-review
git branch -D feature/docs-review 2>/dev/null || true
```

Expected: worktree directory and branch removed.

- [ ] **Step 4: Final verification**

Run: `git worktree list`
Expected: only the main worktree (and any unrelated worktrees), no `.worktrees/docs-review`.

Run: `git log --oneline -8 main`
Expected: five recent doc-related commits visible.

- [ ] **Step 5: Report completion to the user**

Summarize: PR 0 + A/B/C/D all merged, deferred-minor issue filed at <URL>, worktree cleaned up.
