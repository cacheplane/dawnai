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

Use the same template for missing depth/reference coverage. Assign these primarily to Batch 3.

Expected: P2 findings identify the missing page, section, example, README coverage, or API reference.

- [ ] **Step 5: Write P3 findings**

Use the same template for launch narrative, IA, search, generated-surface, or polish opportunities. Assign these primarily to Batch 4.

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
rg -n "T[B]D|TO[D]O" docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
rg -n "\\[findin[g]" docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
rg -n "P[0-3]-00[X]" docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md
```

Expected: each command prints no unresolved-marker hits after Task 6. If hits remain, replace them with concrete content or remove them.

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

Use these batches to execute the audit findings without re-reading the whole audit. Before editing, each worker should still reread the listed source-of-truth references and affected files for their batch.

### Dependency Notes

- Batch 1 must run before Batch 4 because current Agent Protocol, scaffold, and compact docs language should be corrected before broader website narrative polish.
- Batch 2 can run independently, but should link to the final Batch 1 and Batch 3 docs wording when those updates are available.
- Batch 3 can run after Batch 1 or in parallel if source files do not overlap. Coordinate manually if Batch 1 edits `apps/web/app/llms.txt/route.ts` and Batch 3 changes generated/API documentation surfaces that should be reflected there.
- Batch 4 should run after Batch 1 and preferably after Batch 3 so FAQ/blog/current-route pointers reference the final onboarding and API-reference paths.

### Batch 1: P0/P1 correctness sweep

**Owner:** Docs accuracy subagent
**Finding IDs:** P0-001, P0-002, P0-003, P1-001
**Files:**
- `README.md`
- `packages/create-dawn-app/README.md`
- `apps/web/content/prompts/index.ts`
- `apps/web/content/templates/AGENTS.md`
- `apps/web/app/llms.txt/route.ts`

**Source-of-truth references to reread:**
- `packages/create-dawn-app/src/index.ts:76`
- `packages/create-dawn-app/src/index.ts:79`
- `packages/create-dawn-app/src/index.ts:99`
- `packages/create-dawn-app/src/index.ts:110`
- `packages/create-dawn-app/src/index.ts:121`
- `packages/core/src/types.ts:9`
- `packages/core/src/types.ts:28`
- `packages/cli/src/lib/dev/runtime-server.ts:216`
- `packages/cli/src/lib/dev/runtime-server.ts:227`
- `packages/cli/src/lib/dev/runtime-server.ts:295`
- `packages/cli/src/lib/dev/runtime-server.ts:317`
- `packages/devkit/templates/app-research/src/app/research/index.ts:3`
- Scaffold generation evidence in the audit showing generated `/research` files and route id `/research#agent`
- CLI registration scan evidence in the audit listing `add`, `build`, `docs`, `eval`, `memory`, and `verify`

**Expected edits:**
- Rewrite the root README quickstart around the default `research` scaffold and `/research#agent` route.
- Update `packages/create-dawn-app/README.md` so `research` is the documented default, `basic` is optional via `--template basic`, and `--mode external|internal` plus `--dist-tag` are documented.
- Rewrite scaffold prompt examples in `apps/web/content/prompts/index.ts` around `/research#agent`, with any `hello/[tenant]` mention clearly scoped to `--template basic`.
- Update compact agent guidance in `apps/web/content/templates/AGENTS.md` to cover current `DawnConfig` keys, threaded Agent Protocol endpoints, resume payload shape, and current route examples.
- Update `apps/web/app/llms.txt/route.ts` to summarize current config, Agent Protocol thread routes, resume behavior, and the full current CLI command set.

**Stale-term checks:**
- `rg -n "hello/\\[tenant\\]|/research#agent|pnpm create dawn-ai-app" README.md`
- `rg -n "default.*basic|--mode|--dist-tag|research|hello/\\[tenant\\]" packages/create-dawn-app/README.md`
- `rg -n "hello/\\[tenant\\]|/research#agent|--template basic" apps/web/content/prompts/index.ts`
- `rg -n "only supported field|assistant_id|/runs/(wait|stream)|toolOutput|summarization|memory|sandbox|verify|eval|dawn add" apps/web/content/templates/AGENTS.md apps/web/app/llms.txt/route.ts`

**Verification commands:**
- `node scripts/check-docs.mjs`
- `pnpm --filter @dawn-ai/web build`
- `bash -lc 'set -euo pipefail; PORT=4311; export PORT; rm -f /tmp/dawn-llms.txt /tmp/dawn-getting-started.md; node -e '\''const net=require("node:net"); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.env.PORT),"127.0.0.1",()=>s.close(()=>process.exit(0)))'\''; pnpm --filter @dawn-ai/web exec next start -p "$PORT" >/tmp/dawn-web-batch1.log 2>&1 & WEB_PID=$!; trap "kill $WEB_PID 2>/dev/null || true" EXIT; for i in $(seq 1 30); do kill -0 "$WEB_PID" 2>/dev/null || { cat /tmp/dawn-web-batch1.log; exit 1; }; curl -fsS "http://127.0.0.1:$PORT/llms.txt" >/tmp/dawn-llms.txt && break; sleep 1; done; kill -0 "$WEB_PID" 2>/dev/null || { cat /tmp/dawn-web-batch1.log; exit 1; }; test -s /tmp/dawn-llms.txt; rg -q "/research#agent" /tmp/dawn-llms.txt; rg -q "dawn verify" /tmp/dawn-llms.txt; rg -q "toolOutput" /tmp/dawn-llms.txt; rg -q "summarization" /tmp/dawn-llms.txt; rg -q "sandbox" /tmp/dawn-llms.txt; curl -fsS "http://127.0.0.1:$PORT/api/markdown/getting-started" >/tmp/dawn-getting-started.md; rg -q "pnpm create dawn-ai-app" /tmp/dawn-getting-started.md; rg -q "/research" /tmp/dawn-getting-started.md'`
- `bash -lc 'set -euo pipefail; tmpdir=$(mktemp -d); trap "rm -rf \"$tmpdir\"" EXIT; corepack pnpm exec turbo run build --filter=@dawn-ai/workspace --filter=@dawn-ai/permissions --filter=@dawn-ai/sdk --filter=@dawn-ai/core --filter=@dawn-ai/langgraph --filter=@dawn-ai/cli; corepack pnpm --filter create-dawn-ai-app build; node packages/create-dawn-app/dist/bin.js "$tmpdir/dawn-audit-app" --mode internal; test -f "$tmpdir/dawn-audit-app/dawn.config.ts"; test -f "$tmpdir/dawn-audit-app/src/app/research/index.ts"; test -f "$tmpdir/dawn-audit-app/test/research.test.ts"; test -f "$tmpdir/dawn-audit-app/workspace/AGENTS.md"; test -f "$tmpdir/dawn-audit-app/workspace/corpus/agent-architectures.md"'`
- `git diff --check`

**Commit message:** `docs: fix scaffold and compact docs accuracy`

- [ ] **Step 1:** Reread the source-of-truth references and affected files listed above.
- [ ] **Step 2:** Edit only the listed README, prompt, AGENTS template, and compact LLM route files.
- [ ] **Step 3:** Run the stale-term checks and resolve any misleading current-surface hits.
- [ ] **Step 4:** Run the verification commands.
- [ ] **Step 5:** Commit `docs: fix scaffold and compact docs accuracy`.

### Batch 2: Examples correctness

**Owner:** Docs accuracy subagent
**Finding IDs:** P1-002
**Files:**
- `examples/chat/README.md`

**Source-of-truth references to reread:**
- `packages/core/src/types.ts:15`
- `packages/core/src/types.ts:28`
- `packages/core/src/types.ts:47`
- `packages/core/src/capabilities/permission-gate.ts:156`
- `packages/cli/src/lib/runtime/execute-route.ts:1184`
- `packages/langchain/src/summarization/hook.ts:37`
- `apps/web/content/docs/permissions.mdx`
- `apps/web/content/docs/context-management.mdx`
- `apps/web/content/docs/configuration.mdx`

**Expected edits:**
- Replace deferred-capability language for HITL permissions, tool-output offload, and context summarization with current supported behavior.
- Link or point readers to permissions/resume, offload configuration, and opt-in summarization docs.
- Keep any limitations scoped to current behavior rather than roadmap gaps.
- Do not edit example runtime code unless verification exposes a README/code mismatch that cannot be fixed in prose.

**Stale-term checks:**
- `rg -n "deferred|not yet|permission|offload|summar" examples/chat/README.md`

**Verification commands:**
- `node scripts/check-docs.mjs`
- `git diff --check`

**Commit message:** `docs: refresh chat example capability notes`

- [ ] **Step 1:** Reread the source-of-truth references and `examples/chat/README.md`.
- [ ] **Step 2:** Replace stale deferred-language with current capability guidance.
- [ ] **Step 3:** Run the stale-term check and confirm remaining hits are intentional current guidance.
- [ ] **Step 4:** Run the verification commands.
- [ ] **Step 5:** Commit `docs: refresh chat example capability notes`.

### Batch 3: Package/API reference completion

**Owner:** Reference completeness subagent
**Finding IDs:** P2-001, P2-002, P2-003
**Files:**
- `packages/memory/README.md`
- `packages/sandbox/README.md`
- `packages/workspace/README.md`
- `packages/core/README.md`
- `packages/testing/README.md`
- `packages/evals/README.md`
- `apps/web/content/docs/api.mdx`

**Source-of-truth references to reread:**
- `find packages -maxdepth 2 -name package.json -print | sort`
- `packages/core/src/index.ts:1`
- `packages/core/src/index.ts:10`
- `packages/core/src/index.ts:18`
- `packages/core/src/index.ts:35`
- `packages/core/src/index.ts:39`
- `packages/core/src/index.ts:50`
- `packages/core/src/index.ts:61`
- `packages/core/src/capabilities/built-in/memory.ts:16`
- `packages/core/src/capabilities/built-in/workspace.ts:80`
- `packages/sandbox/src/docker/docker-sandbox.ts:18`
- `packages/testing/src/index.ts:1`
- `packages/testing/src/index.ts:17`
- `packages/testing/src/index.ts:35`
- `packages/testing/src/index.ts:54`
- `packages/evals/src/index.ts:1`
- `packages/evals/src/scorers.ts:112`
- `packages/evals/src/scorers.ts:130`
- `packages/evals/src/scorers.ts:145`
- `apps/web/content/docs/memory.mdx`
- `apps/web/content/docs/sandbox.mdx`
- `apps/web/content/docs/workspace.mdx`
- `apps/web/content/docs/testing-agents.mdx`
- `apps/web/content/docs/evals.mdx`

**Expected edits:**
- Add package READMEs for memory and sandbox with install/import snippets, public API summaries, config links, testing notes, and limitations/security notes.
- Expand the workspace README with activation behavior, backend contract, `WorkspaceFs`, `workspaceRoot`, and sandbox integration coverage.
- Expand the core README with grouped public exports, import examples, and links to conceptual docs.
- Expand testing and evals READMEs with exported groups, common examples, and links to testing/eval docs.
- Add API reference sections in `apps/web/content/docs/api.mdx` for `@dawn-ai/core`, `@dawn-ai/testing`, and `@dawn-ai/evals`.

**Stale-term checks:**
- `test -f packages/memory/README.md && test -f packages/sandbox/README.md && rg -n "sqliteMemoryStore|Docker|WorkspaceFs|workspaceRoot" packages/memory/README.md packages/sandbox/README.md packages/workspace/README.md`
- `rg -n "@dawn-ai/core|createWorkspaceFs|loadDawnConfig|discoverRoutes|renderTypeDefinitions" apps/web/content/docs/api.mdx packages/core/README.md`
- `rg -n "@dawn-ai/testing|createAgentHarness|expectNoToolErrors|@dawn-ai/evals|runEval|memoryRecalled|memoryFresh|memoryIsolated" apps/web/content/docs/api.mdx packages/testing/README.md packages/evals/README.md`

**Verification commands:**
- `node scripts/check-docs.mjs`
- `pnpm --filter @dawn-ai/web build`
- `bash -lc 'set -euo pipefail; PORT=4313; export PORT; rm -f /tmp/dawn-llms.txt /tmp/dawn-api.md; node -e '\''const net=require("node:net"); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.env.PORT),"127.0.0.1",()=>s.close(()=>process.exit(0)))'\''; pnpm --filter @dawn-ai/web exec next start -p "$PORT" >/tmp/dawn-web-batch3.log 2>&1 & WEB_PID=$!; trap "kill $WEB_PID 2>/dev/null || true" EXIT; for i in $(seq 1 30); do kill -0 "$WEB_PID" 2>/dev/null || { cat /tmp/dawn-web-batch3.log; exit 1; }; curl -fsS "http://127.0.0.1:$PORT/llms.txt" >/tmp/dawn-llms.txt && break; sleep 1; done; kill -0 "$WEB_PID" 2>/dev/null || { cat /tmp/dawn-web-batch3.log; exit 1; }; test -s /tmp/dawn-llms.txt; curl -fsS "http://127.0.0.1:$PORT/api/markdown/api" >/tmp/dawn-api.md; test -s /tmp/dawn-api.md; rg -q "@dawn-ai/core" /tmp/dawn-api.md; rg -q "@dawn-ai/testing" /tmp/dawn-api.md; rg -q "@dawn-ai/evals" /tmp/dawn-api.md'`
- `git diff --check`

**Commit message:** `docs: expand package api references`

- [ ] **Step 1:** Reread the source-of-truth references and affected package/API docs.
- [ ] **Step 2:** Add or expand package README reference sections.
- [ ] **Step 3:** Add website API reference coverage for the missing public packages.
- [ ] **Step 4:** Run the stale-term checks and resolve missing-symbol coverage.
- [ ] **Step 5:** Run the verification commands.
- [ ] **Step 6:** Commit `docs: expand package api references`.

### Batch 4: Website narrative and IA refresh

**Owner:** Website narrative subagent
**Finding IDs:** P3-001, P3-002
**Files:**
- `apps/web/content/blog/2026-06-18-eve-validates-the-shape.mdx`
- `apps/web/app/components/landing/Faq.tsx`
- `apps/web/content/blog/2026-06-02-dawn-0-4-release.mdx`
- `README.md`
- `apps/web/content/prompts/index.ts`

**Source-of-truth references to reread:**
- `packages/core/src/types.ts:66`
- `packages/sandbox/src/docker/docker-sandbox.ts:18`
- `packages/evals/src/index.ts:19`
- `packages/testing/src/index.ts:54`
- `packages/cli/src/lib/dev/runtime-server.ts:227`
- `packages/cli/src/lib/dev/runtime-server.ts:295`
- `packages/cli/src/lib/dev/runtime-server.ts:317`
- `apps/web/content/docs/sandbox.mdx`
- `apps/web/content/docs/evals.mdx`
- `apps/web/content/docs/testing-agents.mdx`
- `apps/web/content/docs/dev-server.mdx`

**Expected edits:**
- Refresh FAQ and launch narrative so sandbox, replay/live evals, and testing helpers are described as available where they are shipped.
- Reserve roadmap language for concrete current limitations only.
- Add dated-blog framing or update notes where older posts could be read as current Agent Protocol guidance.
- Tighten current README/prompt wording from vague "LangSmith-style" language to current Agent Protocol thread routes, while preserving historical context in dated posts.

**Stale-term checks:**
- `rg -n "roadmap|planned|not yet|sandbox|evaluation harness|replay|live eval" apps/web/content/blog/2026-06-18-eve-validates-the-shape.mdx apps/web/app/components/landing/Faq.tsx`
- `rg -n "byte-identical|LangSmith-style|Agent Protocol|/threads|runs/wait|runs/stream" apps/web/content/blog/2026-06-02-dawn-0-4-release.mdx README.md apps/web/content/prompts/index.ts`

**Verification commands:**
- `node scripts/check-docs.mjs`
- `pnpm --filter @dawn-ai/web build`
- `git diff --check`

**Commit message:** `docs: refresh website narrative for shipped capabilities`

- [ ] **Step 1:** Confirm Batch 1 is complete, then reread the source-of-truth references and affected website/current-copy files.
- [ ] **Step 2:** Refresh FAQ and blog narrative for shipped sandbox/eval/testing capabilities.
- [ ] **Step 3:** Add historical framing and current-route pointers for old Agent Protocol/LangSmith wording.
- [ ] **Step 4:** Run the stale-term checks and confirm remaining historical hits are framed as historical.
- [ ] **Step 5:** Run the verification commands.
- [ ] **Step 6:** Commit `docs: refresh website narrative for shipped capabilities`.

## PR Readiness Checklist

- [ ] `node scripts/check-docs.mjs`
- [ ] `pnpm --filter @dawn-ai/web build`
- [ ] targeted route/helper tests when app route/helper code changes: `pnpm --filter @dawn-ai/web exec vitest run app/blueprints/routes.test.ts app/blueprints/blueprints-lib.test.ts app/components/blog/post-index.test.ts app/components/blog/rss-feed.test.ts`
- [ ] stale-term sweep across README, apps, docs, packages, examples
- [ ] scaffold smoke check if create-app or onboarding examples changed: `bash -lc 'set -euo pipefail; tmpdir=$(mktemp -d); trap "rm -rf \"$tmpdir\"" EXIT; corepack pnpm exec turbo run build --filter=@dawn-ai/workspace --filter=@dawn-ai/permissions --filter=@dawn-ai/sdk --filter=@dawn-ai/core --filter=@dawn-ai/langgraph --filter=@dawn-ai/cli; corepack pnpm --filter create-dawn-ai-app build; node packages/create-dawn-app/dist/bin.js "$tmpdir/dawn-audit-app" --mode internal; test -f "$tmpdir/dawn-audit-app/dawn.config.ts"; test -f "$tmpdir/dawn-audit-app/src/app/research/index.ts"; test -f "$tmpdir/dawn-audit-app/test/research.test.ts"; test -f "$tmpdir/dawn-audit-app/workspace/AGENTS.md"; test -f "$tmpdir/dawn-audit-app/workspace/corpus/agent-architectures.md"'`
- [ ] generated `llms`/markdown route check when generated docs surfaces changed: `bash -lc 'set -euo pipefail; PORT=4317; export PORT; rm -f /tmp/dawn-llms.txt /tmp/dawn-getting-started.md /tmp/dawn-api.md; node -e '\''const net=require("node:net"); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.env.PORT),"127.0.0.1",()=>s.close(()=>process.exit(0)))'\''; pnpm --filter @dawn-ai/web exec next start -p "$PORT" >/tmp/dawn-web-pr.log 2>&1 & WEB_PID=$!; trap "kill $WEB_PID 2>/dev/null || true" EXIT; for i in $(seq 1 30); do kill -0 "$WEB_PID" 2>/dev/null || { cat /tmp/dawn-web-pr.log; exit 1; }; curl -fsS "http://127.0.0.1:$PORT/llms.txt" >/tmp/dawn-llms.txt && break; sleep 1; done; kill -0 "$WEB_PID" 2>/dev/null || { cat /tmp/dawn-web-pr.log; exit 1; }; test -s /tmp/dawn-llms.txt; rg -q "/research#agent" /tmp/dawn-llms.txt; rg -q "dawn verify" /tmp/dawn-llms.txt; rg -q "toolOutput" /tmp/dawn-llms.txt; rg -q "summarization" /tmp/dawn-llms.txt; rg -q "sandbox" /tmp/dawn-llms.txt; curl -fsS "http://127.0.0.1:$PORT/api/markdown/getting-started" >/tmp/dawn-getting-started.md; test -s /tmp/dawn-getting-started.md; rg -q "pnpm create dawn-ai-app" /tmp/dawn-getting-started.md; rg -q "/research" /tmp/dawn-getting-started.md; curl -fsS "http://127.0.0.1:$PORT/api/markdown/api" >/tmp/dawn-api.md; test -s /tmp/dawn-api.md; rg -q "@dawn-ai/core" /tmp/dawn-api.md; rg -q "@dawn-ai/testing" /tmp/dawn-api.md; rg -q "@dawn-ai/evals" /tmp/dawn-api.md'`
- [ ] commit all intended changes
- [ ] push branch
- [ ] open PR
- [ ] monitor CI
- [ ] merge only after CI is green
