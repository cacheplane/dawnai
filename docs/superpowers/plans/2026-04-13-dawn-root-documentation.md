# Dawn Root Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add accurate, user-first root documentation for the current Dawn framework and a contributor guide for the current monorepo.

**Architecture:** This work adds two repo-root Markdown files with distinct audiences and no roadmap spillover. `README.md` becomes the framework-user entrypoint, while `CONTRIBUTORS.md` becomes the contributor operations guide, each grounded in the current CLI, template, package, and verification surfaces.

**Tech Stack:** Markdown, Node.js, pnpm, existing Dawn CLI/package surfaces, existing docs check script

---

## File Structure

### New Files

- Create: `/Users/blove/repos/dawn/README.md`
  - User-first overview, quickstart, app contract, commands, package map, current limits, contributor link.
- Create: `/Users/blove/repos/dawn/CONTRIBUTORS.md`
  - Contributor-first repo map, package ownership, setup, verification commands, harness overview, docs sources of truth.

### Reference Files

- Reference: `/Users/blove/repos/dawn/package.json`
  - Root command surface and workspace verification commands.
- Reference: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
  - Canonical implemented CLI commands.
- Reference: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
  - Current scaffolding behavior and defaults.
- Reference: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/dawn.config.ts`
  - Current scaffolded config shape.
- Reference: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
  - Current template route boundary.
- Reference: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`
  - Current template execution example.
- Reference: `/Users/blove/repos/dawn/packages/core/README.md`
- Reference: `/Users/blove/repos/dawn/packages/langgraph/README.md`
- Reference: `/Users/blove/repos/dawn/packages/cli/README.md`
- Reference: `/Users/blove/repos/dawn/packages/devkit/README.md`
  - Existing package descriptions to align package summaries without duplicating implementation detail.
- Reference: `/Users/blove/repos/dawn/scripts/check-docs.mjs`
  - Existing docs completeness gate.

---

### Task 1: Add The User-Facing Root README

**Files:**
- Create: `/Users/blove/repos/dawn/README.md`
- Reference: `/Users/blove/repos/dawn/package.json`
- Reference: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
- Reference: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
- Reference: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/dawn.config.ts`
- Reference: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
- Reference: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`

- [ ] **Step 1: Write the README content outline from current repo behavior**

Draft the exact section structure in `/Users/blove/repos/dawn/README.md`:

```md
# Dawn

<one-paragraph description>

## Status
## Quickstart
## App Contract
## Commands
## Packages
## Current Boundaries
## Contributing
```

The content must describe only current behavior:
- `pnpm create dawn-app`
- `dawn run`
- `dawn dev`
- current `basic` template route at `src/app/(public)/hello/[tenant]/workflow.ts`
- `appDir` as the only supported `dawn.config.ts` option today

- [ ] **Step 2: Write the quickstart examples against the real scaffold**

Add runnable examples covering:

```bash
pnpm create dawn-app my-app
cd my-app
pnpm install
echo '{"tenant":"acme"}' | pnpm exec dawn run 'src/app/(public)/hello/[tenant]/workflow.ts'
```

And the optional local runtime flow:

```bash
pnpm exec dawn dev --port 3001
echo '{"tenant":"acme"}' | pnpm exec dawn run 'src/app/(public)/hello/[tenant]/workflow.ts' --url http://127.0.0.1:3001
```

Be explicit that the route path must be quoted in shells because it contains `(`, `)`, and `[` characters.

- [ ] **Step 3: Write the command and package sections**

Document only implemented commands:
- `create-dawn-app`
- `dawn check`
- `dawn routes`
- `dawn typegen`
- `dawn run`
- `dawn test`
- `dawn dev`

Document the current package map at a high level:
- `@dawn-ai/core`
- `@dawn-ai/langgraph`
- `@dawn-ai/cli`
- `create-dawn-app`
- `@dawn-ai/devkit`
- `@dawn-ai/config-typescript`
- `@dawn-ai/config-biome`

Keep package summaries concise and route deeper repo detail to `CONTRIBUTORS.md`.

- [ ] **Step 4: Verify the README content directly**

Run: `sed -n '1,260p' README.md`

Expected:
- quickstart commands match the implemented CLI
- no future-tense or roadmap language
- framework boundaries are explicit
- contributor section links to `CONTRIBUTORS.md`

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add README.md
git commit -m "docs: add root framework README"
```

---

### Task 2: Add The Contributor Guide

**Files:**
- Create: `/Users/blove/repos/dawn/CONTRIBUTORS.md`
- Reference: `/Users/blove/repos/dawn/package.json`
- Reference: `/Users/blove/repos/dawn/packages/core/package.json`
- Reference: `/Users/blove/repos/dawn/packages/langgraph/package.json`
- Reference: `/Users/blove/repos/dawn/packages/cli/package.json`
- Reference: `/Users/blove/repos/dawn/packages/devkit/package.json`
- Reference: `/Users/blove/repos/dawn/packages/create-dawn-app/package.json`
- Reference: `/Users/blove/repos/dawn/scripts/check-docs.mjs`

- [ ] **Step 1: Write the contributor doc structure**

Draft `/Users/blove/repos/dawn/CONTRIBUTORS.md` with this structure:

```md
# Contributing To Dawn

## Overview
## Repository Layout
## Package Responsibilities
## Local Setup
## Common Commands
## Verification And Test Lanes
## Documentation Sources
## Working Expectations
```

The tone should stay operational and repo-specific.

- [ ] **Step 2: Document the local setup, repo layout, and ownership**

In `## Local Setup`, document the current contributor bootstrap requirements:
- Node `>=22.12.0`
- `pnpm install`
- root workspace commands are run from the repo root

Then explain the actual top-level areas and ownership:

- `apps/web`
- `packages/*`
- `test/*`
- `scripts/*`
- `docs/*`

Map package responsibilities clearly:
- discovery/config/types in `@dawn-ai/core`
- route authoring contracts in `@dawn-ai/langgraph`
- CLI/runtime in `@dawn-ai/cli`
- scaffolding in `create-dawn-app`
- shared templating in `@dawn-ai/devkit`
- shared config in the config packages

- [ ] **Step 3: Document the real contributor commands and verification lanes**

List the current commands exactly:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm ci:validate
pnpm verify:harness
node scripts/publish-smoke.mjs
node scripts/check-docs.mjs
```

Explain the current harness lanes in contributor terms:
- package/unit and CLI tests under Vitest
- framework verification
- runtime contract verification
- smoke verification
- generated/packaged app verification
- publish smoke

Describe `docs/superpowers` as design and implementation history, not the primary onboarding surface.

- [ ] **Step 4: Verify the contributor guide directly**

Run: `sed -n '1,320p' CONTRIBUTORS.md`

Expected:
- commands match the repo root scripts and current tooling
- no aspirational features are documented as current contributor workflow
- docs-source-of-truth section clearly separates root docs, package READMEs, website docs, and `docs/superpowers`

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add CONTRIBUTORS.md
git commit -m "docs: add contributor guide"
```

---

### Task 3: Run Documentation Verification And Final Cleanup

**Files:**
- Verify: `/Users/blove/repos/dawn/README.md`
- Verify: `/Users/blove/repos/dawn/CONTRIBUTORS.md`
- Reference: `/Users/blove/repos/dawn/scripts/check-docs.mjs`

- [ ] **Step 1: Run the existing docs completeness gate**

Run: `node scripts/check-docs.mjs`

Expected: `Docs completeness check passed.`

- [ ] **Step 2: Run a targeted quickstart smoke check against the documented route**

Run:

```bash
pnpm --filter create-dawn-app build
rm -rf tmp/docs-readme-smoke
node packages/create-dawn-app/dist/index.js tmp/docs-readme-smoke --template basic --mode internal
cd tmp/docs-readme-smoke
pnpm install
echo '{"tenant":"acme"}' | pnpm exec dawn run 'src/app/(public)/hello/[tenant]/workflow.ts'
```

Expected:
- the scaffold succeeds
- install succeeds
- `dawn run` returns a passed result for `src/app/(public)/hello/[tenant]/workflow.ts`
- the route path documented in `README.md` is proven against the real scaffold

- [ ] **Step 3: Run a targeted local runtime smoke check for the documented `dawn dev` flow**

Run:

```bash
cd /Users/blove/repos/dawn/tmp/docs-readme-smoke
pnpm exec dawn dev --port 3111 > /tmp/dawn-docs-dev.log 2>&1 &
DEV_PID=$!
node --input-type=module -e "const started=Date.now(); const url='http://127.0.0.1:3111/healthz'; const check=async()=>{while(Date.now()-started<15000){try{const r=await fetch(url); if(r.ok){process.exit(0)}}catch{} await new Promise(r=>setTimeout(r,250))} process.exit(1)}; await check();"
echo '{"tenant":"acme"}' | pnpm exec dawn run 'src/app/(public)/hello/[tenant]/workflow.ts' --url http://127.0.0.1:3111
kill $DEV_PID
wait $DEV_PID || true
```

Expected:
- `dawn dev` becomes ready on port `3111`
- `dawn run --url` returns a passed result for the documented route
- the README server-mode example remains aligned with the real local runtime

- [ ] **Step 4: Run the repo test gate to guard against accidental collateral changes**

Run: `pnpm test`

Expected:
- all Vitest suites pass
- no documentation-only change introduced collateral failures

- [ ] **Step 5: Check the final diff for scope discipline**

Run: `git diff --stat HEAD~2..HEAD` after the task commits, then `git status --short`

Expected:
- only `README.md` and `CONTRIBUTORS.md` are new tracked deliverables from this plan
- no unrelated package or source changes were introduced

- [ ] **Step 6: Commit any final cleanup if needed**

If verification required documentation-only touchups:

```bash
git add README.md CONTRIBUTORS.md
git commit -m "docs: refine root repository documentation"
```

If no cleanup was required, do not add an extra commit.

- [ ] **Step 7: Prepare for execution handoff**

Be ready to execute with fresh subagents per task, then review each task for:
- spec compliance first
- code and documentation quality second

At completion, verification evidence must include:
- `node scripts/check-docs.mjs`
- the quickstart smoke for `dawn run`
- the local runtime smoke for `dawn dev`
- `pnpm test`

---

## Notes For Implementers

- Keep the root docs accurate to the repository as it exists today.
- Prefer direct statements over marketing language.
- Do not copy roadmap material from `docs/superpowers` into the root docs.
- Do not document commands or package behavior that is not already implemented.
- Keep examples small and runnable.
