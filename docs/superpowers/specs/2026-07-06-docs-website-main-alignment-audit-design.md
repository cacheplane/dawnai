# Docs and Website Main-Branch Alignment Audit Design

Date: 2026-07-06
Status: approved design, pending implementation plan
Baseline: `origin/main`

## Goal

Create a thorough assessment, audit report, and prioritized implementation plan
for updating Dawn's docs, website, examples, scaffold output, package docs, and
other public developer surfaces so they align with the current `origin/main`
codebase.

The output is not the documentation update itself. The output is a grounded
audit and an implementation plan ready to execute with subagents, followed by a
PR and merge on green.

## Baseline and principles

`origin/main` is the only source of truth. The audit does not distinguish
released versus unreleased behavior, does not optimize for backward
compatibility, and does not preserve old docs patterns when the current main
branch has moved on.

Priority order:

1. Accuracy: broken, misleading, or contradicted content is addressed first.
2. Depth: missing reference material, missing examples, and incomplete coverage
   are captured after correctness risks.
3. Launch narrative: website and top-level messaging should reflect what Dawn
   currently does best, but narrative work must not outrank correctness.
4. Maintainability: repeated drift patterns should become reusable checks or
   explicit maintenance notes where practical.

## Scope

The audit covers the full external developer surface:

- Public docs site: `apps/web/content/docs`, docs page wrappers, nav, search
  index, markdown routes, and generated `llms` routes.
- Website narrative: landing page, feature sections, blueprints,
  prompts/templates, and current-positioning blog references where they affect
  today's product story.
- Developer entry points: root `README.md`, package READMEs, examples, scaffold
  templates/output, npm-facing package metadata, changelogs, and release notes
  where they shape current usage.
- Current code truth: package exports, public types, CLI commands, runtime Agent
  Protocol endpoints, config schema, capabilities, scaffold templates, examples,
  tests, recent specs/plans, and generated artifacts.

Out of scope:

- Preserving compatibility with older Dawn releases.
- Publishing packages or creating release notes for a release.
- Implementing the documentation edits during the audit phase.
- Auditing private/internal-only notes that do not affect developer-facing
  understanding.

## Approach chosen

Use an evidence matrix, then score gaps, then convert the result into a
subagent-ready implementation backlog.

Alternatives considered:

- Page-by-page audit. This is straightforward and catches stale text quickly,
  but it starts from existing content and is weaker at finding missing features.
- Feature-by-feature audit. This is strong for completeness, but can miss stale
  claims unless paired with a separate content sweep.
- Evidence matrix plus gap scoring. This is chosen because it combines
  correctness, completeness, and launch narrative while preserving traceability
  from every recommendation back to code.

## Evidence collection

The assessment phase builds two inventories and compares them.

The evidence matrix should use these columns:

- `surface_area`: package/API/CLI/config/capability/scaffold/example/docs/site
  area being assessed.
- `current_code_fact`: the main-branch behavior, API, command, or product claim.
- `source_reference`: exact file, test, route, package export, or spec reference
  proving the fact.
- `expected_external_surfaces`: docs/site/README/example/scaffold/package
  surfaces that should reflect the fact.
- `observed_external_surfaces`: where the fact is currently documented,
  missing, stale, or contradicted.
- `status`: aligned, stale, missing, contradicted, too shallow, or narrative
  opportunity.
- `finding_id`: linked finding when the row needs follow-up.
- `notes`: short context for batching, dependencies, or ambiguity.

### Code and capability inventory

Collect current facts from `origin/main`:

- Package exports and public types from `packages/*/src` and package
  `exports`.
- CLI commands, flags, generated outputs, and validation behavior.
- Runtime Agent Protocol routes, request/response shapes, stream event names,
  resume flows, and health endpoints.
- `DawnConfig` schema, defaults, capability configuration, and runtime
  resolution behavior.
- Built-in capabilities: agents, tools, subagents, workspace filesystem, memory,
  permissions, per-tool approval, sandboxing, context management, retry,
  planning, skills, testing, evals, blueprints, and observability behavior.
- Create-app templates and actual scaffold output.
- Examples and test fixtures that demonstrate canonical usage.
- Recent merged design/planning documents that describe features now present on
  main, especially recent memory recall, tool approval, sandbox, and scaffold
  updates.

### External-surface inventory

Collect content from:

- `apps/web/content/docs/**/*.mdx`
- `apps/web/app` docs wrappers, docs nav, search, routes, sitemap, robots, and
  generated markdown/LLM routes
- `apps/web/content/blueprints`
- `apps/web/content/blog` where posts are used as current positioning
- `apps/web/content/prompts` and `apps/web/content/templates`
- Root project docs such as `README.md`, `CONTRIBUTING.md`, `SUPPORT.md`, and
  security/support materials when relevant to developer onboarding
- `packages/*/README.md`, package metadata, and changelogs
- `examples/**/README.md` and example source
- Scaffold templates and generated scaffold output

### Stale-claim sweeps

Run targeted searches for likely drift, including:

- Old default scaffold routes, file names, and package names.
- Old model IDs or provider examples that no longer match the canonical
  scaffold.
- Old Agent Protocol request bodies or fabricated endpoint fields.
- Missing or stale config keys.
- Missing package exports or imports that no longer compile.
- Old testing/evals API examples.
- Deprecated or renamed capability terms.
- Website claims that imply capabilities are planned when they are already
  shipped, or imply capabilities exist when code does not support them.

The exact grep patterns should be derived during assessment from recent commits,
package APIs, scaffold output, and known historical docs plans.

## Finding format

Each finding in the audit report uses this schema:

- `id`: stable finding identifier.
- `severity`: `P0`, `P1`, `P2`, or `P3`.
- `category`: accuracy, completeness, onboarding, API reference, launch
  narrative, examples, search/IA, generated content, or maintenance guardrail.
- `source_of_truth`: exact code, test, package, scaffold, or spec reference.
- `affected_surface`: exact docs/site/README/example/scaffold files or routes.
- `problem`: concise statement of the mismatch or gap.
- `recommended_fix`: concrete edit, new page, rewrite, or validation guard.
- `subagent_batch`: proposed implementation group.
- `verification`: command, grep, build, test, or manual check proving the issue
  is fixed.

Severity definitions:

- `P0`: Content is broken or harmful. It leads to commands that fail, impossible
  API calls, incorrect endpoints, or severe misunderstanding of core behavior.
- `P1`: Content is misleading or blocks adoption. It may not be immediately
  broken, but it teaches stale patterns or hides current main-branch behavior.
- `P2`: Coverage or depth gap. Current behavior is real and developer-facing,
  but reference docs, examples, or cross-links are incomplete.
- `P3`: Opportunity or polish. Launch narrative, information architecture,
  search terms, or copy can better reflect the current product.

## Prioritized implementation batches

The implementation plan produced from the audit should group work into
subagent-sized batches ordered by risk and dependency.

### Batch 1: P0/P1 correctness sweep

Fix content contradicted by `origin/main`, including scaffold defaults, model
IDs, route examples, Agent Protocol bodies/endpoints, CLI behavior, config
options, memory/tool/permission behavior, testing/evals APIs, and package import
examples.

### Batch 2: Onboarding path rebuild

Ensure a new developer can move from README to create app to docs to run/test
eval/dev server without hitting stale commands or conceptual gaps.

### Batch 3: Reference completeness

Fill or update reference coverage for package APIs, `dawn.config.ts`, CLI,
Agent Protocol, capabilities, tools, workspace, permissions and per-tool
approval, sandbox, memory recall, testing/evals, and examples.

### Batch 4: Website and launch narrative

Align landing page, feature blocks, ecosystem claims, blueprints,
prompts/templates, and top-level positioning with the current codebase and
launch story.

### Batch 5: Examples, scaffolds, and package docs

Bring scaffold templates, examples, package READMEs, changelogs, and package
metadata into the same API shape and product story as the website/docs.

### Batch 6: Information architecture and generated surfaces

Tune nav/sidebar grouping, search terms, related links, generated `llms` output,
markdown routes, cross-links, and validation scripts so future drift is easier
to catch.

## Subagent execution model

The implementation plan should be written for subagent execution. Suggested
subagent roles:

- Code/API inventory agent: builds the source-of-truth inventory.
- Docs accuracy agent: checks existing docs against code and finds P0/P1
  content risks.
- Website narrative agent: audits landing, feature, blueprint, prompt/template,
  and current-positioning surfaces.
- README/examples/scaffold agent: audits root README, package READMEs,
  examples, scaffold templates, and generated app output.
- Reference completeness agent: checks that current APIs and capabilities have
  enough reference coverage.
- IA/search/generated-surfaces agent: audits nav, cross-links, search, markdown
  routes, generated LLM text, and validation scripts.
- Verification agent: runs checks, stale-term sweeps, builds, targeted tests,
  and scaffold smoke checks.

The main agent owns integration: reconcile overlapping recommendations,
normalize voice/style, remove duplicate work, resolve contradictions, and turn
the audit into one coherent prioritized plan.

Each implementation task should include:

- Objective.
- Files or routes to inspect/edit.
- Source-of-truth references.
- Expected changes.
- Stale-term grep or generated-content check.
- Verification commands.
- Handoff notes for dependencies on other batches.

## Deliverables

### 1. Assessment and audit report

A ranked findings document with the evidence matrix, high-risk inaccuracies,
missing coverage, launch narrative gaps, and opportunity notes.

Recommended location:
`docs/superpowers/audits/2026-07-06-docs-website-main-alignment-audit.md`

The audit report must also include an "Intentionally excluded" table with:

- `area`: the feature, page, or surface excluded.
- `reason`: why it does not need docs/site work in this pass.
- `revisit_trigger`: what future change should cause the exclusion to be
  reconsidered.

### 2. Prioritized implementation plan

A subagent-ready checklist grouped by implementation batch, with each task tied
to source-of-truth code references and verification commands.

Recommended location:
`docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`

### 3. PR readiness checklist

A concise gate list included at the end of the implementation plan: docs check,
web build, stale-term sweep, generated route checks, scaffold smoke checks where
practical, and CI green before merge.

## Verification gates

The audit and implementation plan should specify exact commands after the
assessment discovers the final affected surfaces. Expected gates include:

- `node scripts/check-docs.mjs`
- `pnpm --filter @dawn-ai/web build`
- Tests for docs helpers/routes when docs app code changes.
- Stale-term sweeps across docs, website, README, package docs, examples, and
  scaffold templates.
- Generated `llms`/markdown route checks where content generation is affected.
- Scaffold smoke checks where create-app or onboarding examples are changed.
- CI must be green before merge.

## PR and merge workflow

After the assessment and implementation plan are approved:

1. Execute the plan using subagents for independent batches.
2. Main agent integrates the patches and runs verification.
3. Commit intentionally with a clear docs/audit scope.
4. Push a branch and open a PR.
5. Monitor CI and fix failures.
6. Merge only after CI is green.

## Acceptance criteria

- Every major public feature on `origin/main` is documented, explicitly queued
  for documentation, or intentionally excluded with rationale.
- Every `P0` and `P1` finding has a concrete file-level fix path.
- The implementation work is split into independent subagent batches with clear
  ownership boundaries.
- Launch narrative work is included but cannot outrank correctness.
- Verification commands prove docs/site alignment after implementation.
- The workflow ends with PR and merge on green, not merely opening a PR.

## Risks and mitigations

- Risk: the audit becomes too broad to execute. Mitigation: severity scoring and
  subagent batches separate urgent correctness from narrative and completeness.
- Risk: subagents produce overlapping or inconsistent recommendations.
  Mitigation: main agent owns integration and normalizes final task boundaries.
- Risk: current-code facts are inferred from docs rather than code. Mitigation:
  every finding requires a source-of-truth reference.
- Risk: launch narrative edits introduce fresh inaccuracies. Mitigation:
  narrative work is verified against the same evidence matrix and cannot
  outrank correctness.
- Risk: drift recurs after the update. Mitigation: capture repeated stale-claim
  patterns as validation checks or maintenance notes where practical.
