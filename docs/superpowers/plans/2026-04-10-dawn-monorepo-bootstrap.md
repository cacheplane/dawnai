# Dawn Monorepo Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the initial `dawn` monorepo with a working workspace foundation, publishable TypeScript packages, a `dawn` CLI, a `create-dawn-app` scaffolder, and a minimal marketing/docs website.

**Architecture:** Use a `pnpm` workspace monorepo coordinated by `turbo`, with TypeScript project references and `tsc -b` for package builds. Keep Dawn-specific behavior in `@dawn-ai/core` and compose it into `@dawn-ai/cli` and `create-dawn-app`, while leaving runtime-facing route authoring thin and native-first.

**Tech Stack:** Node 22.x, pnpm 10.33.0, turbo 2.9.6, TypeScript 6.0.2, Next.js 16.2.3, React 19.2.0, Vitest 4.1.4, Biome 2.4.11, Changesets 2.30.0, Commander 14.0.3, Zod 4.3.6

---

## File Structure Map

- Root config and workspace:
  - Create: `package.json`
  - Create: `pnpm-workspace.yaml`
  - Create: `turbo.json`
  - Create: `.gitignore`
  - Create: `.npmrc`
  - Create: `tsconfig.json`
  - Create: `vitest.workspace.ts`
  - Create: `.changeset/README.md`
- Shared config packages:
  - Create: `packages/config-typescript/*`
  - Create: `packages/config-biome/*`
- Core framework package:
  - Create: `packages/core/*`
  - Create: `packages/core/src/discovery/*`
  - Create: `packages/core/src/typegen/*`
  - Create: `packages/core/test/*`
- LangGraph integration package:
  - Create: `packages/langgraph/*`
  - Create: `packages/langgraph/src/*`
  - Create: `packages/langgraph/test/*`
- CLI package:
  - Create: `packages/cli/*`
  - Create: `packages/cli/src/commands/*`
  - Create: `packages/cli/test/*`
- Scaffolder and templates:
  - Create: `packages/create-dawn-app/*`
  - Create: `packages/devkit/*`
  - Create: `templates/app-basic/*`
  - Create: `packages/create-dawn-app/test/*`
- Website:
  - Create: `apps/web/*`

### Task 1: Workspace Foundation

**Files:**
- Create: `/Users/blove/repos/dawn/package.json`
- Create: `/Users/blove/repos/dawn/pnpm-workspace.yaml`
- Create: `/Users/blove/repos/dawn/turbo.json`
- Create: `/Users/blove/repos/dawn/.gitignore`
- Create: `/Users/blove/repos/dawn/.npmrc`
- Create: `/Users/blove/repos/dawn/tsconfig.json`
- Create: `/Users/blove/repos/dawn/vitest.workspace.ts`
- Create: `/Users/blove/repos/dawn/.changeset/README.md`

- [ ] **Step 1: Write the failing workspace smoke test**

Create `vitest.workspace.ts` with project entries that reference `packages/core`, `packages/cli`, and `packages/create-dawn-app` before those package configs exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest --run --config vitest.workspace.ts`
Expected: FAIL because package-level Vitest configs and source files do not exist yet.

- [ ] **Step 3: Write the minimal workspace foundation**

Create:

```json
{
  "name": "dawn",
  "private": true,
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "check": "turbo run check",
    "dev": "turbo run dev --parallel",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.11",
    "@changesets/cli": "2.30.0",
    "turbo": "2.9.6",
    "typescript": "6.0.2",
    "vitest": "4.1.4"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - templates/*
```

Create `turbo.json` with `build`, `check`, `lint`, `test`, and `typecheck` pipelines using declared outputs only for build artifacts.

Create `.gitignore` for Node, Next.js, and build output.

Create root `tsconfig.json` with empty `files` and project `references` for each workspace package as they are added.

- [ ] **Step 4: Run basic install verification**

Run: `pnpm install`
Expected: PASS with lockfile created and workspace recognized.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json .gitignore .npmrc tsconfig.json vitest.workspace.ts .changeset/README.md pnpm-lock.yaml
git commit -m "chore: bootstrap workspace foundation"
```

### Task 2: Shared Config Packages

**Files:**
- Create: `/Users/blove/repos/dawn/packages/config-typescript/package.json`
- Create: `/Users/blove/repos/dawn/packages/config-typescript/base.json`
- Create: `/Users/blove/repos/dawn/packages/config-typescript/library.json`
- Create: `/Users/blove/repos/dawn/packages/config-typescript/node.json`
- Create: `/Users/blove/repos/dawn/packages/config-typescript/nextjs.json`
- Create: `/Users/blove/repos/dawn/packages/config-biome/package.json`
- Create: `/Users/blove/repos/dawn/packages/config-biome/biome.json`

- [ ] **Step 1: Write the failing config package checks**

Create root script references so `pnpm --filter @dawn-ai/config-typescript typecheck` and `pnpm --filter @dawn-ai/config-biome check` fail before the packages exist.

- [ ] **Step 2: Run checks to verify they fail**

Run: `pnpm --filter @dawn-ai/config-typescript typecheck`
Expected: FAIL because package is missing.

Run: `pnpm --filter @dawn-ai/config-biome check`
Expected: FAIL because package is missing.

- [ ] **Step 3: Write the minimal shared config packages**

Create `@dawn-ai/config-typescript` with JSON config exports covering:
- base TypeScript settings
- library build settings with declarations
- Node package settings
- Next.js app settings

Create `@dawn-ai/config-biome` with a reusable `biome.json` that enables formatting and linting defaults suitable for the monorepo.

- [ ] **Step 4: Run checks to verify they pass**

Run: `pnpm --filter @dawn-ai/config-typescript typecheck`
Expected: PASS or no-op with exit code 0.

Run: `pnpm --filter @dawn-ai/config-biome check`
Expected: PASS with valid configuration.

- [ ] **Step 5: Commit**

```bash
git add packages/config-typescript packages/config-biome
git commit -m "chore: add shared workspace configs"
```

### Task 3: `@dawn-ai/core` Discovery and Typegen

**Files:**
- Create: `/Users/blove/repos/dawn/packages/core/package.json`
- Create: `/Users/blove/repos/dawn/packages/core/tsconfig.json`
- Create: `/Users/blove/repos/dawn/packages/core/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/config.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/discovery/find-dawn-app.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/discovery/discover-routes.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/discovery/route-segments.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/typegen/render-route-types.ts`
- Create: `/Users/blove/repos/dawn/packages/core/src/types.ts`
- Test: `/Users/blove/repos/dawn/packages/core/test/discover-routes.test.ts`
- Test: `/Users/blove/repos/dawn/packages/core/test/render-route-types.test.ts`

- [ ] **Step 1: Write the failing discovery test**

Create `discover-routes.test.ts` with a fixture app tree asserting that:
- app root is detected from `dawn.config.ts`
- discovery starts at `src/app`
- route groups like `(public)` are ignored in public paths
- dynamic segments like `[tenant]` are preserved in route metadata
- catch-all segments like `[...path]` are preserved in route metadata
- optional catch-all segments like `[[...path]]` are preserved in route metadata
- `_private` folders are excluded from public route discovery
- `graph.ts` and `workflow.ts` are accepted as alternative entrypoints

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/core test -- --run packages/core/test/discover-routes.test.ts`
Expected: FAIL because `@dawn-ai/core` does not exist yet.

- [ ] **Step 3: Write the failing typegen test**

Create `render-route-types.test.ts` asserting that a discovered route manifest renders a `dawn.generated.d.ts` style string containing route path unions and route parameter types.

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/core test -- --run packages/core/test/render-route-types.test.ts`
Expected: FAIL because the typegen module does not exist yet.

- [ ] **Step 5: Write the minimal implementation**

Implement `@dawn-ai/core` with:
- a config loader for `dawn.config.ts`
- app-root discovery from current working directory or explicit path
- route discovery under `src/app`
- route metadata model
- validation helpers for canonical Dawn app shape and route entry errors
- type rendering for route unions and route params

Use focused modules; keep filesystem parsing separate from rendering.

- [ ] **Step 6: Run package verification**

Run: `pnpm --filter @dawn-ai/core test`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/core typecheck`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/core build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core tsconfig.json vitest.workspace.ts
git commit -m "feat: add dawn core discovery and typegen"
```

### Task 4: `@dawn-ai/langgraph` Integration Contracts

**Files:**
- Create: `/Users/blove/repos/dawn/packages/langgraph/package.json`
- Create: `/Users/blove/repos/dawn/packages/langgraph/tsconfig.json`
- Create: `/Users/blove/repos/dawn/packages/langgraph/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/define-entry.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/route-module.ts`
- Test: `/Users/blove/repos/dawn/packages/langgraph/test/define-entry.test.ts`
- Test: `/Users/blove/repos/dawn/packages/langgraph/test/route-module.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create tests asserting:
- `graph.ts` modules can export a native-first entry and route config
- `workflow.ts` modules are accepted as alternative executable route entries
- the package exposes types and helpers that `@dawn-ai/core` and the template app can consume without inventing a second runtime

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/langgraph test -- --run packages/langgraph/test/define-entry.test.ts`
Expected: FAIL because the package does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement a minimal publishable package with:
- route entry and route module types
- a small helper for normalizing `graph.ts` or `workflow.ts` exports
- explicit `exports` and `types` fields suitable for publishing

- [ ] **Step 4: Run package verification**

Run: `pnpm --filter @dawn-ai/langgraph test`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/langgraph typecheck`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/langgraph build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langgraph tsconfig.json vitest.workspace.ts
git commit -m "feat: add langgraph integration contracts"
```

### Task 5: `@dawn-ai/cli` Commands

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/package.json`
- Create: `/Users/blove/repos/dawn/packages/cli/tsconfig.json`
- Create: `/Users/blove/repos/dawn/packages/cli/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/check.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/routes.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/typegen.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/output.ts`
- Test: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
- Test: `/Users/blove/repos/dawn/packages/cli/test/routes-command.test.ts`
- Test: `/Users/blove/repos/dawn/packages/cli/test/typegen-command.test.ts`

- [ ] **Step 1: Write the failing command tests**

Create tests asserting:
- `dawn check` exits cleanly for a valid fixture app and reports validation success
- `dawn check` exits non-zero for an invalid fixture app and reports the failing validation
- `dawn routes --json` prints discovered route metadata
- `dawn typegen` writes generated types into the target app

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/cli test -- --run packages/cli/test/routes-command.test.ts`
Expected: FAIL because the CLI package does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement the CLI with Commander and compose `@dawn-ai/core` helpers. Support:
- optional `--cwd` path argument for app root targeting
- human-readable output by default
- JSON output for `routes`
- validation output and non-zero exit codes for `check`
- writing generated types to `src/app/dawn.generated.d.ts`

- [ ] **Step 4: Run package verification**

Run: `pnpm --filter @dawn-ai/cli test`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/cli build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli tsconfig.json vitest.workspace.ts
git commit -m "feat: add dawn cli commands"
```

### Task 6: `@dawn-ai/devkit` and `create-dawn-app`

**Files:**
- Create: `/Users/blove/repos/dawn/packages/devkit/package.json`
- Create: `/Users/blove/repos/dawn/packages/devkit/tsconfig.json`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/templates.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/write-template.ts`
- Create: `/Users/blove/repos/dawn/packages/create-dawn-app/package.json`
- Create: `/Users/blove/repos/dawn/packages/create-dawn-app/tsconfig.json`
- Create: `/Users/blove/repos/dawn/packages/create-dawn-app/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
- Test: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- Create: `/Users/blove/repos/dawn/templates/app-basic/package.json.template`
- Create: `/Users/blove/repos/dawn/templates/app-basic/dawn.config.ts`
- Create: `/Users/blove/repos/dawn/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
- Create: `/Users/blove/repos/dawn/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`
- Create: `/Users/blove/repos/dawn/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`

- [ ] **Step 1: Write the failing scaffolder test**

Create `create-app.test.ts` asserting that the scaffolder:
- creates a target directory
- writes `package.json` and `dawn.config.ts`
- writes the canonical `src/app` route structure
- produces an installable fixture app

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter create-dawn-app test -- --run packages/create-dawn-app/test/create-app.test.ts`
Expected: FAIL because the scaffolder package does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement `@dawn-ai/devkit` template copying helpers and `create-dawn-app` CLI entrypoint. Support one template only: `basic`.

- [ ] **Step 4: Run package verification**

Run: `pnpm --filter create-dawn-app test`
Expected: PASS.

Run: `pnpm --filter create-dawn-app typecheck`
Expected: PASS.

Run: `pnpm --filter create-dawn-app build`
Expected: PASS.

- [ ] **Step 5: Run generated-app smoke verification**

Run: `node packages/create-dawn-app/dist/index.js tmp/dawn-smoke --template basic`
Expected: PASS with a generated Dawn app.

Run: `pnpm install --dir tmp/dawn-smoke`
Expected: PASS.

Run: `pnpm --dir tmp/dawn-smoke typecheck`
Expected: PASS.

Run: `pnpm --dir tmp/dawn-smoke check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/devkit packages/create-dawn-app templates/app-basic
git commit -m "feat: add create-dawn-app scaffolder"
```

### Task 7: `apps/web` Marketing and Docs Site

**Files:**
- Create: `/Users/blove/repos/dawn/apps/web/package.json`
- Create: `/Users/blove/repos/dawn/apps/web/tsconfig.json`
- Create: `/Users/blove/repos/dawn/apps/web/next.config.ts`
- Create: `/Users/blove/repos/dawn/apps/web/app/layout.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/docs/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/docs/getting-started/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/docs/app-graph/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/docs/packages/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/docs/cli/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/docs/examples/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/globals.css`

- [ ] **Step 1: Write the failing app build test**

Create the package entry and root workspace references so `pnpm --filter @dawn-ai/web build` fails before the app exists.

- [ ] **Step 2: Run build to verify it fails**

Run: `pnpm --filter @dawn-ai/web build`
Expected: FAIL because the app package does not exist yet.

- [ ] **Step 3: Write the minimal website implementation**

Build a minimal Next.js App Router site with:
- a landing page
- a docs shell
- a getting started page
- an App Graph concept page
- a packages overview page
- a CLI commands page
- an examples overview page
- a concise visual identity for Dawn
- copy that reflects the approved spec

Keep the site static-friendly and independent from unfinished runtime internals.

- [ ] **Step 4: Run app verification**

Run: `pnpm --filter @dawn-ai/web typecheck`
Expected: PASS.

Run: `pnpm --filter @dawn-ai/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add dawn marketing site"
```

### Task 8: Repo-Wide Verification and History Cleanup

**Files:**
- Modify: `/Users/blove/repos/dawn/tsconfig.json`
- Modify: `/Users/blove/repos/dawn/vitest.workspace.ts`
- Modify: `/Users/blove/repos/dawn/package.json`
- Modify: `/Users/blove/repos/dawn/docs/superpowers/plans/2026-04-10-dawn-monorepo-bootstrap.md`

- [ ] **Step 1: Run full verification**

Run: `pnpm lint`
Expected: PASS.

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm test`
Expected: PASS.

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 2: Fix any remaining integration issues**

Adjust workspace references, package scripts, or generated files only as needed to make the full monorepo verification pass cleanly.

- [ ] **Step 3: Remove generated smoke artifacts from version control scope**

Ensure `tmp/` is ignored, remove any generated smoke-app files from staging, and keep only intentional repo files in the final commit.

- [ ] **Step 4: Rewrite local history if needed to keep commit messages neutral**

If any commit message contains `codex`, rewrite local history before finalizing. If not, leave history unchanged.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: finalize dawn monorepo bootstrap"
```
