# Docs and Website Main-Branch Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a code-grounded audit report and prioritized, subagent-ready implementation backlog for aligning Dawn's full external developer surface with `origin/main`.

**Architecture:** This is a two-phase documentation planning job. Phase 1 builds a traceable evidence matrix and audit report from code facts versus public surfaces; Phase 2 converts the findings into a prioritized implementation backlog that later subagents can execute in a PR-and-merge-on-green flow. The phase boundary is explicit: do not rewrite docs/site content during the audit except for the audit and plan artifacts themselves.

**Tech Stack:** Markdown planning artifacts, TypeScript/Next.js docs app inspection, `rg`, `find`, `git`, package metadata inspection, scaffold smoke checks, existing docs validation scripts. No production code changes during this plan.

**Spec:** `docs/superpowers/specs/2026-07-06-docs-website-main-alignment-audit-design.md`

---

## File structure

| File or directory | Responsibility |
|---|---|
| `docs/superpowers/audits/` | New directory for audit reports. |
| `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md` | Final audit report: evidence matrix, findings, exclusions, and verification notes. |
| `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md` | This plan. During execution, append the findings-driven implementation backlog under the marked section. |
| `docs/superpowers/specs/2026-07-06-docs-website-main-alignment-audit-design.md` | Approved design spec. Read-only reference unless a contradiction is found. |
| `apps/web/content/docs/**/*.mdx` | Public docs content to audit. Do not edit during audit phase. |
| `apps/web/app/**` | Docs/site wrappers, nav, search, generated text routes, landing page, sitemap, and route code to audit. Do not edit during audit phase. |
| `apps/web/content/{blueprints,blog,prompts,templates}/**` | Website content surfaces to audit. Do not edit during audit phase. |
| `README.md`, `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md` | Root developer entry-point surfaces to audit. Do not edit during audit phase. |
| `packages/*/{README.md,CHANGELOG.md,package.json}` | Package-facing docs and metadata to audit. Do not edit during audit phase. |
| `examples/**` | Example code and docs to audit. Do not edit during audit phase. |
| `packages/create-dawn-app/**`, `packages/devkit/templates/**` | Scaffold logic and templates to audit and smoke-check. Do not edit during audit phase. |

---

## Phase boundary

This plan has two deliverables:

1. **Audit deliverable:** Create the audit report with evidence, findings, exclusions, and verification notes.
2. **Backlog deliverable:** Append a concrete implementation backlog to this plan after the audit findings exist.

The later docs/site update work is intentionally deferred. When this plan is complete, the next execution pass should use the appended backlog to change docs/site/examples/scaffolds/package docs, open a PR, and merge on green.

---

## Task 0: Verify `origin/main` baseline

**Files:**
- Read-only verification of git state.

- [ ] **Step 1: Fetch the current main branch**

Run:

```bash
git fetch origin main
git log --oneline --decorate -1 origin/main
```

Expected: the latest `origin/main` commit is visible. Record the commit hash in the audit report header during Task 1.

- [ ] **Step 2: Confirm the worktree is based on `origin/main`**

Run:

```bash
git merge-base --is-ancestor origin/main HEAD && echo "origin/main is included in HEAD"
```

Expected: prints `origin/main is included in HEAD`. If this fails, stop and sync the worktree before auditing; otherwise the audit may compare docs against stale code.

- [ ] **Step 3: Confirm non-audit source files are not locally modified**

Run:

```bash
git diff --name-only origin/main -- . \
  ':(exclude)docs/superpowers/specs/2026-07-06-docs-website-main-alignment-audit-design.md' \
  ':(exclude)docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md' \
  ':(exclude)docs/superpowers/audits/**'
```

Expected: no output. If files outside the audit/spec/plan artifacts appear, stop and decide whether those changes are intentional main-branch facts or local drift that must not influence the audit.

- [ ] **Step 4: Record baseline verification**

After Task 1 creates the audit file, add the `origin/main` commit hash and the result of Steps 2-3 to `## Verification Notes`.

Expected: future readers can tell exactly which main commit was audited.

---

## Task 1: Create the audit artifact skeleton

**Files:**
- Create: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`
- Modify: `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`

- [ ] **Step 1: Create the audits directory**

Run:

```bash
mkdir -p docs/superpowers/audits
```

Expected: directory exists; no output is fine.

- [ ] **Step 2: Create the audit report skeleton**

Create `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md` with this structure:

```markdown
# Docs and Website Main-Branch Alignment Audit

Date: 2026-07-06
Baseline: `origin/main`
Baseline commit: `<fill from Task 0>`
Spec: `docs/superpowers/specs/2026-07-06-docs-website-main-alignment-audit-design.md`
Plan: `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`

## Executive Summary

This section is populated in Task 5 after the evidence matrix, findings, and
implementation order are known.

## Scope

This audit covers Dawn's full external developer surface against `origin/main`:
public docs, website narrative, README/package docs, examples, scaffold output,
npm-facing metadata, and generated docs/LLM surfaces.

## Evidence Matrix

| Surface area | Current code fact | Source reference | Expected external surfaces | Observed external surfaces | Status | Finding ID | Notes |
|---|---|---|---|---|---|---|---|

## Findings

### P0: Broken or harmful

### P1: Misleading or adoption-blocking

### P2: Missing depth or reference coverage

### P3: Narrative, IA, or polish opportunity

## Intentionally Excluded

| Area | Reason | Revisit trigger |
|---|---|---|

## Stale-Term Sweeps

| Sweep | Command | Result | Follow-up finding IDs |
|---|---|---|---|

## Verification Notes

| Check | Command | Result | Notes |
|---|---|---|---|
| Baseline fetch | `git fetch origin main && git log --oneline --decorate -1 origin/main` |  |  |
| Baseline ancestry | `git merge-base --is-ancestor origin/main HEAD` |  |  |
| Non-audit diff | `git diff --name-only origin/main -- ...` |  |  |

## Findings-Driven Implementation Batches

These batches are mirrored into the plan after the audit is complete.
```

- [ ] **Step 3: Preserve the implementation-backlog marker in this plan**

At the end of this plan, keep the `Findings-Driven Backlog` section. Later tasks will replace the reserved text with concrete subagent batches derived from the audit.

- [ ] **Step 4: Verify only audit artifacts changed**

Run:

```bash
git status --short
```

Expected: only `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md` and this plan file are new/modified.

- [ ] **Step 5: Commit the skeleton**

Run:

```bash
git add docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
git commit -m "docs: start main-branch alignment audit"
```

Expected: commit succeeds.

---

## Task 2: Inventory current code facts

**Files:**
- Modify: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`

**Recommended subagent:** Code/API inventory agent.

- [ ] **Step 1: Capture package names, versions, and exports**

Run:

```bash
find packages -maxdepth 2 -name package.json -print | sort
```

For each package, inspect:

```bash
node -e 'const fs=require("node:fs"); for (const p of process.argv.slice(1)) { const j=JSON.parse(fs.readFileSync(p,"utf8")); console.log("\\n"+p); console.log(JSON.stringify({name:j.name, version:j.version, exports:j.exports}, null, 2)); }' $(find packages -maxdepth 2 -name package.json -print | sort)
```

Expected: package names and export surfaces are available for evidence rows.

- [ ] **Step 2: Capture public source barrels**

Run:

```bash
rg -n "^export " packages/*/src packages/create-dawn-app/src --glob '*.ts'
```

Expected: public types/functions and package barrels are visible. Add evidence rows for developer-facing exports that need docs or README coverage.

- [ ] **Step 3: Capture config schema and defaults**

Run:

```bash
rg -n "export interface DawnConfig|readonly .*\\?:|toolOutput|summarization|memory|sandbox|permissions|backends" packages/core/src packages/cli/src packages/memory/src packages/permissions/src packages/sandbox/src --glob '*.ts'
```

Expected: current config keys and runtime defaults are visible. Add evidence rows for every developer-facing config area.

- [ ] **Step 4: Capture CLI command and dev-server behavior**

Run:

```bash
rg -n "program\\.command|\\.command\\(|option\\(|/threads|runs/(wait|stream)|resume|healthz|validateApRunBody|LANGSMITH|LANGCHAIN" packages/cli/src --glob '*.ts'
```

Expected: CLI commands, flags, Agent Protocol endpoints, run bodies, resume behavior, and tracing behavior are available for evidence rows.

- [ ] **Step 5: Capture capability registrations and runtime behavior**

Run:

```bash
rg -n "capability|built-in|workspace|permission|approve|sandbox|memory|recall|toolOutput|summar|task\\(|subagent|retry|skill" packages/core/src packages/sdk/src packages/langchain/src packages/testing/src packages/evals/src packages/workspace/src packages/memory/src packages/sandbox/src --glob '*.ts'
```

Expected: current capabilities and public behavior are available for evidence rows.

- [ ] **Step 6: Capture scaffold source and generated output**

Run:

```bash
rg -n "template|research|basic|gpt-|route|eval|workspace|AGENTS|package.json" packages/create-dawn-app/src packages/devkit/templates --glob '*'
```

Then generate a temporary scaffold without committing it:

```bash
tmpdir="$(mktemp -d)"
node packages/create-dawn-app/dist/bin.js "$tmpdir/dawn-audit-app" --mode internal
find "$tmpdir/dawn-audit-app" -maxdepth 5 -type f | sort
```

If `dist/bin.js` is missing, first run the package build command used by the repo, then retry. Record the exact build command and result in `Verification Notes`.

Expected: scaffold tree, scripts, route IDs, default model IDs, eval/test files, and workspace files are available for evidence rows.

- [ ] **Step 7: Capture recent main-branch feature context**

Run:

```bash
git log --oneline --decorate -30
ls docs/superpowers/specs | sort | tail -30
ls docs/superpowers/plans | sort | tail -30
```

Expected: recent merged work and planning artifacts are visible. Add evidence rows for recent features that should be reflected in docs/site surfaces.

- [ ] **Step 8: Update audit evidence matrix**

Add rows to `## Evidence Matrix` for each code fact. Use this status vocabulary:

- `aligned`
- `stale`
- `missing`
- `contradicted`
- `too shallow`
- `narrative opportunity`

Do not create findings yet unless the external surface has already been checked. Use blank `Finding ID` for source facts awaiting comparison.

- [ ] **Step 9: Commit code inventory**

Run:

```bash
git add docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md
git commit -m "docs: inventory main-branch code facts for audit"
```

Expected: commit succeeds.

---

## Task 3: Inventory external developer surfaces

**Files:**
- Modify: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`

**Recommended subagent:** README/examples/scaffold agent plus IA/search/generated-surfaces agent.

- [ ] **Step 1: List public docs and docs app routes**

Run:

```bash
rg --files apps/web/content/docs apps/web/app | sort
```

Expected: all docs content pages, docs wrappers, nav/search components, markdown routes, LLM routes, sitemap, and landing app files are visible.

- [ ] **Step 2: List website content surfaces**

Run:

```bash
rg --files apps/web/content apps/web/app/components/landing apps/web/app/page.tsx | sort
```

Expected: landing components, blueprints, blog posts, prompts, and templates are visible.

- [ ] **Step 3: List README/package/example/scaffold surfaces**

Run:

```bash
find . -path './node_modules' -prune -o -path './.git' -prune -o \
  \( -name README.md -o -name CHANGELOG.md -o -name package.json \
     -o -name CONTRIBUTING.md -o -name SUPPORT.md -o -name SECURITY.md \
     -o -name CODE_OF_CONDUCT.md -o -name CONTRIBUTORS.md \
     -o -iname '*release*notes*' \) -print | sort
rg --files examples packages/create-dawn-app packages/devkit/templates | sort
```

Expected: root docs, support/security/contribution docs, package docs, changelogs, release-note surfaces, examples, create-app logic, and scaffold templates are visible.

- [ ] **Step 4: List generated/docs-consumer surfaces**

Run:

```bash
rg -n "llms|markdown|search|DOCS_NAV|sitemap|robots|metadata|openGraph" apps/web/app apps/web/lib apps/web/content --glob '*.ts' --glob '*.tsx' --glob '*.mdx'
```

Expected: docs nav, search index, generated markdown, LLM routes, and metadata surfaces are visible.

- [ ] **Step 5: Add external-surface notes to audit**

In `## Evidence Matrix`, update `Expected external surfaces` and `Observed external surfaces` for every code fact from Task 2.

For surfaces that have no corresponding code fact yet, add a new row with `surface_area` and `observed_external_surfaces`, then fill `current_code_fact` during Task 4.

- [ ] **Step 6: Commit external-surface inventory**

Run:

```bash
git add docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md
git commit -m "docs: inventory external developer surfaces"
```

Expected: commit succeeds.

---

## Task 4: Run stale-claim sweeps

**Files:**
- Modify: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`

**Recommended subagent:** Docs accuracy agent.

- [ ] **Step 1: Run scaffold/model/route sweeps**

Run:

```bash
rg -n "hello/\\[tenant\\]|hello-dawn|gpt-4o-mini|gpt-4\\.1|smoke\\.eval\\.ts|agent\\.test\\.ts|/research#agent|/research" README.md CONTRIBUTING.md SUPPORT.md SECURITY.md CODE_OF_CONDUCT.md CONTRIBUTORS.md audit-known-issues.md apps docs packages examples --glob '!node_modules/**'
```

Expected: hits are reviewed and classified as aligned, stale, intentionally historical, or needing a finding.

- [ ] **Step 2: Run Agent Protocol sweeps**

Run:

```bash
rg -n "assistant_id|on_completion|route_id|runs/wait|runs/stream|/threads|interrupt_id|decision|healthz|metadata\\.dawn|Agent Protocol|LangSmith protocol" README.md CONTRIBUTING.md SUPPORT.md SECURITY.md CODE_OF_CONDUCT.md CONTRIBUTORS.md audit-known-issues.md apps docs packages examples --glob '!node_modules/**'
```

Expected: hits are checked against current `packages/cli/src` behavior.

- [ ] **Step 3: Run config/capability sweeps**

Run:

```bash
rg -n "DawnConfig|toolOutput|summarization|memory\\.recall|permissions|approve|sandbox|workspace|runBash|writeFile|readFile|listDir|context management|offload|AGENTS\\.md" README.md CONTRIBUTING.md SUPPORT.md SECURITY.md CODE_OF_CONDUCT.md CONTRIBUTORS.md audit-known-issues.md apps docs packages examples --glob '!node_modules/**'
```

Expected: missing/stale config and capability coverage is identified.

- [ ] **Step 4: Run testing/evals/package API sweeps**

Run:

```bash
rg -n "createAgentHarness|live: true|runEval|resolveGate|deriveToolResults|expectNoToolErrors|@dawn-ai/testing|@dawn-ai/evals|@dawn-ai/memory|sqliteMemoryStore|create-dawn-ai-app" README.md CONTRIBUTING.md SUPPORT.md SECURITY.md CODE_OF_CONDUCT.md CONTRIBUTORS.md audit-known-issues.md apps docs packages examples --glob '!node_modules/**'
```

Expected: testing/evals/package examples are checked against current exports and source behavior.

- [ ] **Step 5: Run website narrative sweeps**

Run:

```bash
rg -n "planned|coming soon|not yet|experimental|prototype|LangGraph|LangSmith|local-first|workspace|memory|approval|sandbox|eval|testing|blueprint|agentic" apps/web/content apps/web/app README.md CONTRIBUTING.md SUPPORT.md SECURITY.md CODE_OF_CONDUCT.md CONTRIBUTORS.md audit-known-issues.md docs/marketing docs/dev --glob '!node_modules/**'
```

Expected: launch narrative claims are checked against main-branch capabilities.

- [ ] **Step 6: Record sweep results**

In `## Stale-Term Sweeps`, add one row per sweep with:

- command
- count or summary of hits
- result
- follow-up finding IDs

- [ ] **Step 7: Commit stale-sweep notes**

Run:

```bash
git add docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md
git commit -m "docs: record stale-claim sweeps for alignment audit"
```

Expected: commit succeeds.

---

## Task 5: Create scored findings

**Files:**
- Modify: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`

**Recommended subagents:** Docs accuracy agent, Reference completeness agent, Website narrative agent.

- [ ] **Step 1: Assign finding IDs**

Use this ID format:

- `P0-001`, `P0-002`, ...
- `P1-001`, `P1-002`, ...
- `P2-001`, `P2-002`, ...
- `P3-001`, `P3-002`, ...

Expected: every non-aligned evidence row that needs follow-up has a stable finding ID.

- [ ] **Step 2: Write P0 findings**

For each broken/harmful mismatch, add a finding with this template:

```markdown
#### P0-001: Short title

- **Category:** accuracy
- **Source of truth:** `path/to/file.ts:line` or command output summary
- **Affected surface:** `path/to/doc-or-route`
- **Problem:** What is broken or impossible for a developer.
- **Recommended fix:** Concrete file-level edit or rewrite.
- **Subagent batch:** Batch 1: P0/P1 correctness sweep
- **Verification:** Exact command/grep/build/manual check.
```

Expected: P0 findings are file-level and immediately actionable.

- [ ] **Step 3: Write P1 findings**

Use the same template for misleading or adoption-blocking issues. Assign these primarily to Batch 1 or Batch 2.

Expected: P1 findings explain how stale guidance blocks correct usage.

- [ ] **Step 4: Write P2 findings**

Use the same template for missing depth/reference coverage. Assign these primarily to Batch 3 or Batch 5.

Expected: P2 findings identify the missing page, section, example, README coverage, or API reference.

- [ ] **Step 5: Write P3 findings**

Use the same template for launch narrative, IA, search, generated-surface, or polish opportunities. Assign these primarily to Batch 4 or Batch 6.

Expected: P3 findings are concrete and tied to specific surfaces, not broad copy opinions.

- [ ] **Step 6: Fill the Intentionally Excluded table**

For every major feature or surface reviewed but not queued for work, add:

```markdown
| Area | Reason | Revisit trigger |
|---|---|---|
| Example area | Already aligned with main and not externally confusing. | Revisit when the API or route changes. |
```

Expected: exclusions are explicit enough that later workers do not re-audit the same surface accidentally.

- [ ] **Step 7: Update the executive summary**

Write:

- one paragraph on overall alignment health
- top 3-5 correctness risks
- top 3-5 completeness/narrative opportunities
- recommended implementation order

Expected: a reader can understand the audit outcome without reading every finding.

- [ ] **Step 8: Commit scored findings**

Run:

```bash
git add docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md
git commit -m "docs: score main-branch docs alignment findings"
```

Expected: commit succeeds.

---

## Task 6: Convert findings into a prioritized implementation backlog

**Files:**
- Modify: `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`
- Modify: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`

**Recommended subagent:** Main agent integration task, with Verification agent review.

- [ ] **Step 1: Replace the reserved `Findings-Driven Backlog` text**

At the bottom of this plan, replace the reserved text with concrete batches derived from audit findings:

```markdown
## Findings-Driven Backlog

### Batch 1: P0/P1 correctness sweep

**Owner:** Docs accuracy subagent
**Finding IDs:** P0-001, P1-001, ...
**Files:** ...

- [ ] **Step 1:** Read source references ...
- [ ] **Step 2:** Edit files ...
- [ ] **Step 3:** Run verification ...
- [ ] **Step 4:** Commit `docs: ...`
```

Expected: every P0/P1 finding appears in Batch 1 or Batch 2.

- [ ] **Step 2: Add one concrete task per implementation batch**

For each batch, include:

- owner role
- finding IDs
- exact files to modify
- source-of-truth references to reread
- expected edits
- stale-term checks
- verification commands
- commit message

Expected: a subagent can execute each batch without re-reading the whole audit.

- [ ] **Step 3: Add dependency notes**

Record dependencies between batches. Examples:

- nav/search/generated routes may depend on new or renamed docs pages
- launch narrative should wait until correctness pages are updated
- package README examples should align with the final onboarding path

Expected: independent batches are clearly separated from sequential work.

- [ ] **Step 4: Add PR readiness checklist**

Include:

```markdown
## PR Readiness Checklist

- [ ] `node scripts/check-docs.mjs`
- [ ] `pnpm --filter @dawn-ai/web build`
- [ ] targeted docs route/helper tests when app code changes
- [ ] stale-term sweep across README, apps, docs, packages, examples
- [ ] scaffold smoke check if create-app or onboarding examples changed
- [ ] generated `llms`/markdown route check when generated docs surfaces changed
- [ ] commit all intended changes
- [ ] push branch
- [ ] open PR
- [ ] monitor CI
- [ ] merge only after CI is green
```

Expected: PR/merge-on-green workflow is explicit.

- [ ] **Step 5: Mirror batch summary into the audit**

In the audit report's `## Findings-Driven Implementation Batches`, summarize the batches and link to this plan.

Expected: audit and plan agree.

- [ ] **Step 6: Commit backlog conversion**

Run:

```bash
git add docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md
git commit -m "docs: plan docs alignment implementation batches"
```

Expected: commit succeeds.

---

## Task 7: Verify audit and plan quality

**Files:**
- Modify if needed: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`
- Modify if needed: `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`

**Recommended subagent:** Verification agent.

- [ ] **Step 1: Check for unresolved markers**

Run:

```bash
rg -n "T[B]D|TO[D]O|\\[finding|P[0-3]-00X" docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
```

Expected: no unresolved-marker hits remain after Task 6. If hits remain, replace them with concrete content or remove them.

- [ ] **Step 2: Check finding coverage**

Run:

```bash
rg -o "P[0-3]-[0-9]{3}" docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md | sort -u
rg -o "P[0-3]-[0-9]{3}" docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md | sort -u
```

Expected: every finding ID in the audit appears in the plan backlog or in the intentionally excluded rationale if it was deliberately not scheduled.

- [ ] **Step 3: Check source references are concrete**

Run:

```bash
rg -n "Source of truth:|Source reference|source_reference|`[^`]+:[0-9]+`" docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
```

Expected: findings and backlog tasks cite exact files, and line references are present where they materially reduce ambiguity.

- [ ] **Step 4: Check markdown formatting**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Run docs checker if audit links or docs scripts changed**

Run:

```bash
node scripts/check-docs.mjs
```

Expected: `Docs completeness check passed.` If the checker does not inspect `docs/superpowers`, still record the result in the audit `Verification Notes`.

- [ ] **Step 6: Commit verification fixes**

If any fixes were needed, run:

```bash
git add docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
git commit -m "docs: verify docs alignment audit plan"
```

Expected: commit succeeds if changes were made; otherwise no commit is needed.

---

## Task 8: Hand off to docs/site update execution

**Files:**
- Read: `docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`
- Read: `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`

- [ ] **Step 1: Confirm working tree state**

Run:

```bash
git status --short --branch
```

Expected: clean working tree before starting the docs/site update execution pass.

- [ ] **Step 2: Decide execution mode**

Use the plan handoff:

- Subagent-driven execution is recommended for the findings-driven backlog.
- Inline execution is acceptable only if the backlog is small and conflicts are likely to require one editor.

Expected: user chooses an execution mode before docs/site files are changed.

- [ ] **Step 3: Start the next skill**

If the user chooses subagent-driven execution, use `superpowers:subagent-driven-development`.

If the user chooses inline execution, use `superpowers:executing-plans`.

Expected: no docs/site implementation starts without the correct execution skill.

---

## Findings-Driven Backlog

Reserved until Tasks 2-5 produce the audit findings. Replace this section during Task 6 with concrete subagent batches that include finding IDs, exact files, source references, edits, checks, and commit messages.
