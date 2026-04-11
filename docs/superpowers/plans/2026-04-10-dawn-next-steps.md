# Dawn Next Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current Dawn bootstrap into a genuinely publishable, releasable, and externally usable framework starter, then extend the product surface from bootstrap commands to a coherent public v0 release.

**Architecture:** Keep Dawn’s current thin-runtime structure, but harden the package and release boundary. The next work should focus on publish-safe package metadata, tarball-level validation, release automation, and a scaffolder that can generate external apps without relying on this repo’s checkout layout. Only after those constraints are solved should Dawn add broader CLI surface area or richer website/docs features.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript project references, Changesets, npm publishing, Next.js 16 App Router, publint, Are the Types Wrong, GitHub Actions

---

## Research Summary

These plan choices are informed by current primary sources:

- pnpm’s workspace protocol is intended for source-package development and is rewritten before publish, so source packages can keep `workspace:*` dependencies as long as publish validation happens at the packed artifact level.
- npm scoped public packages still require `npm publish --access public` on first publication, so Dawn should encode public access in package metadata and release scripts.
- the Changesets GitHub Action supports version PRs and publish flows cleanly, but expects the repository to provide its own build/publish scripts where needed.
- Next.js 16’s current deployment docs support both Node and static export modes; the current Dawn site is static-only, so it can be planned for static-friendly deployment without coupling it to the runtime product.
- publint is now a straightforward way to lint packed package metadata and entrypoints, and should be part of publish readiness checks.

## Scope

This is a follow-on plan after bootstrap. It is intentionally focused on turning the current repo into a releasable v0 foundation rather than adding every optional CLI command from the original RFC.

## File Structure Map

- Release and packaging:
  - Modify: `/Users/blove/repos/dawn/package.json`
  - Modify: `/Users/blove/repos/dawn/.changeset/config.json`
  - Create: `/Users/blove/repos/dawn/.github/workflows/release.yml`
  - Create: `/Users/blove/repos/dawn/.github/workflows/ci.yml`
  - Create: `/Users/blove/repos/dawn/scripts/pack-check.mjs`
  - Create: `/Users/blove/repos/dawn/scripts/publish-smoke.mjs`
- Package metadata and docs:
  - Modify: `/Users/blove/repos/dawn/packages/core/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/langgraph/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/devkit/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/config-biome/package.json`
  - Modify: `/Users/blove/repos/dawn/packages/config-typescript/package.json`
  - Create: `/Users/blove/repos/dawn/packages/core/README.md`
  - Create: `/Users/blove/repos/dawn/packages/langgraph/README.md`
  - Create: `/Users/blove/repos/dawn/packages/cli/README.md`
  - Create: `/Users/blove/repos/dawn/packages/devkit/README.md`
  - Create: `/Users/blove/repos/dawn/packages/create-dawn-app/README.md`
  - Create: `/Users/blove/repos/dawn/packages/config-biome/README.md`
  - Create: `/Users/blove/repos/dawn/packages/config-typescript/README.md`
- Scaffolder externalization:
  - Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
  - Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/package.json.template`
  - Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/.npmrc`
  - Modify: `/Users/blove/repos/dawn/pnpm-workspace.yaml`
- CLI/runtime polish:
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/typegen-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/langgraph/test/define-entry.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/langgraph/test/route-module.test.ts`
- Website/docs:
  - Modify: `/Users/blove/repos/dawn/apps/web/app/docs/getting-started/page.tsx`
  - Modify: `/Users/blove/repos/dawn/apps/web/app/docs/packages/page.tsx`
  - Modify: `/Users/blove/repos/dawn/apps/web/app/docs/cli/page.tsx`
  - Create: `/Users/blove/repos/dawn/apps/web/app/robots.ts`
  - Create: `/Users/blove/repos/dawn/apps/web/app/sitemap.ts`
  - Create: `/Users/blove/repos/dawn/scripts/check-docs.mjs`

### Task 1: Make Packages Publish-Ready

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/core/package.json`
- Modify: `/Users/blove/repos/dawn/packages/langgraph/package.json`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- Modify: `/Users/blove/repos/dawn/packages/devkit/package.json`
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/package.json`
- Modify: `/Users/blove/repos/dawn/packages/config-biome/package.json`
- Modify: `/Users/blove/repos/dawn/packages/config-typescript/package.json`
- Create: `/Users/blove/repos/dawn/packages/core/README.md`
- Create: `/Users/blove/repos/dawn/packages/langgraph/README.md`
- Create: `/Users/blove/repos/dawn/packages/cli/README.md`
- Create: `/Users/blove/repos/dawn/packages/devkit/README.md`
- Create: `/Users/blove/repos/dawn/packages/create-dawn-app/README.md`
- Create: `/Users/blove/repos/dawn/packages/config-biome/README.md`
- Create: `/Users/blove/repos/dawn/packages/config-typescript/README.md`

- [ ] **Step 1: Write the failing packaging smoke test**

Create a temporary validation script or test that runs `pnpm pack` for each publishable package and fails if:
- the tarball omits expected runtime files
- package metadata still contains repo-local `file:` dependencies
- public package metadata is missing required publish fields

- [ ] **Step 2: Run packaging smoke test to verify it fails**

Run: `node scripts/pack-check.mjs`
Expected: FAIL on at least one package in the current tree because publishability is not fully normalized yet.

- [ ] **Step 3: Normalize package metadata**

For each publishable package:
- add `publishConfig.access` or equivalent package-level access policy
- add `repository`, `homepage`, `bugs`, `license`, and `engines` metadata where appropriate
- ensure `files`, `bin`, `types`, and `exports` are correct for packed artifacts
- add package README files that describe the actual public surface

This task explicitly includes `@dawn/config-biome` and `@dawn/config-typescript` as public packages. Do not leave them outside publish normalization if `.changeset/config.json` continues to allow publishing them.

- [ ] **Step 4: Add package metadata validation**

Integrate `publint` and a tarball inspection step into the repo so packed packages are checked as packed packages, not only as workspace source folders.

- [ ] **Step 5: Run verification**

Run: `node scripts/pack-check.mjs`
Expected: PASS.

Run: `pnpm exec publint packages/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/*/package.json packages/*/README.md scripts/pack-check.mjs package.json pnpm-lock.yaml
git commit -m "chore: make packages publish-ready"
```

### Task 2: Decouple `create-dawn-app` From Repo-Local Paths

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/package.json.template`
- Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/.npmrc`
- Modify: `/Users/blove/repos/dawn/pnpm-workspace.yaml`

- [ ] **Step 1: Write the failing standalone scaffolder smoke test**

Add a test that packs and installs `create-dawn-app` outside the repo workspace, runs the built `create-dawn-app` binary, and verifies the generated app does not depend on repo-relative `file:` paths.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter create-dawn-app test -- --run packages/create-dawn-app/test/create-app.test.ts`
Expected: FAIL because the generated app still assumes repo-local package edges.

- [ ] **Step 3: Implement release-channel-aware scaffolding**

Change scaffolding so generated apps can be created in two clean modes:
- external/default mode using published package versions or a configurable dist-tag
- internal dev mode for this monorepo when explicitly requested

The default path should not require the caller to be inside this repo layout.

- [ ] **Step 4: Remove bootstrap-only workspace coupling**

Stop relying on `tmp/*` being part of the permanent workspace for normal scaffolder behavior. If the repo still needs an internal smoke path, make it an explicit test-only or script-only flow.

- [ ] **Step 5: Run verification**

Run: `pnpm --filter create-dawn-app test`
Expected: PASS.

Run: `node scripts/publish-smoke.mjs`
Expected: PASS with a generated app created from packed or published Dawn packages.

- [ ] **Step 6: Commit**

```bash
git add packages/create-dawn-app packages/devkit/templates pnpm-workspace.yaml scripts/publish-smoke.mjs
git commit -m "feat: make create-dawn-app standalone"
```

### Task 3: Add CI and Release Automation

**Files:**
- Create: `/Users/blove/repos/dawn/.github/workflows/ci.yml`
- Create: `/Users/blove/repos/dawn/.github/workflows/release.yml`
- Modify: `/Users/blove/repos/dawn/package.json`
- Modify: `/Users/blove/repos/dawn/.changeset/config.json`

- [ ] **Step 1: Write the failing release workflow validation**

Add a local validation step that fails because CI/release workflows do not yet exist.

- [ ] **Step 2: Run validation to verify it fails**

Run: `test -f .github/workflows/ci.yml && test -f .github/workflows/release.yml`
Expected: FAIL because the workflows are missing.

- [ ] **Step 3: Add CI workflow**

Create a CI workflow that runs:
- install
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- package pack/publish smoke validation

- [ ] **Step 4: Add release workflow**

Create a Changesets-based release workflow that:
- opens version PRs on `main`
- publishes changed packages with npm auth
- runs build/pack validation before publish

- [ ] **Step 5: Run verification**

Run: `pnpm exec changeset status`
Expected: PASS.

Run: `node scripts/pack-check.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows package.json .changeset/config.json scripts/pack-check.mjs
git commit -m "chore: add ci and release automation"
```

### Task 4: Harden Public Consumption Checks

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/langgraph/test/define-entry.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/langgraph/test/route-module.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/typegen-command.test.ts`

- [ ] **Step 1: Write failing packaged-consumer tests**

Add tests that consume the built or packed artifacts instead of source aliases, and fail if the published package surfaces do not match runtime usage.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn/langgraph test`
Expected: FAIL if the packaged-consumer path is not yet covered or breaks.

- [ ] **Step 3: Implement packaged-consumer smoke coverage**

Add:
- one smoke test for `@dawn/langgraph` through packed or built output
- one direct executable smoke test for the `dawn` bin path without `node <path>`
- one external-style `typegen` smoke test using a custom `appDir`

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @dawn/langgraph test`
Expected: PASS.

Run: `pnpm --filter @dawn/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langgraph/test packages/cli/test
git commit -m "test: harden packaged-consumer coverage"
```

### Task 5: Turn Lint Into a Real Gate

**Files:**
- Modify: `/Users/blove/repos/dawn/package.json`
- Modify: `/Users/blove/repos/dawn/packages/config-biome/package.json`
- Modify: `/Users/blove/repos/dawn/packages/config-typescript/package.json`
- Modify: `/Users/blove/repos/dawn/packages/core/package.json`
- Modify: `/Users/blove/repos/dawn/packages/langgraph/package.json`
- Modify: `/Users/blove/repos/dawn/packages/cli/package.json`
- Modify: `/Users/blove/repos/dawn/packages/devkit/package.json`
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/package.json`
- Modify: `/Users/blove/repos/dawn/apps/web/package.json`

- [ ] **Step 1: Write the failing lint gate**

Add `lint` scripts to packages and verify the root `pnpm lint` currently does not exercise any tasks.

- [ ] **Step 2: Run lint to verify the current gap**

Run: `pnpm lint`
Expected: PASS with `No tasks were executed`, proving lint is not yet a real gate.

- [ ] **Step 3: Add package-level lint scripts**

Wire package-level lint scripts using Biome where appropriate and Next-supported linting paths for the web app if needed.

- [ ] **Step 4: Run verification**

Run: `pnpm lint`
Expected: PASS with real package tasks executed.

- [ ] **Step 5: Commit**

```bash
git add package.json packages/*/package.json apps/web/package.json
git commit -m "chore: make lint a real verification gate"
```

### Task 6: Polish the Public Site for v0

**Files:**
- Modify: `/Users/blove/repos/dawn/apps/web/app/docs/getting-started/page.tsx`
- Modify: `/Users/blove/repos/dawn/apps/web/app/docs/packages/page.tsx`
- Modify: `/Users/blove/repos/dawn/apps/web/app/docs/cli/page.tsx`
- Create: `/Users/blove/repos/dawn/apps/web/app/robots.ts`
- Create: `/Users/blove/repos/dawn/apps/web/app/sitemap.ts`
- Create: `/Users/blove/repos/dawn/scripts/check-docs.mjs`

- [ ] **Step 1: Write the failing docs completeness check**

Create `scripts/check-docs.mjs` so it fails if the docs pages do not mention:
- supported `dawn.config.ts` subset
- current package publishability status
- CLI command scope

- [ ] **Step 2: Run check to verify it fails**

Run: `node scripts/check-docs.mjs`
Expected: FAIL until the content is updated to cover the required topics.

- [ ] **Step 3: Update docs and deployment readiness**

Document:
- the narrow supported config syntax
- the package roles and release channel
- the distinction between bootstrap-local scaffolding and published scaffolding

Add `robots.ts` and `sitemap.ts` so the site is ready for public indexing once deployed.

- [ ] **Step 4: Run verification**

Run: `node scripts/check-docs.mjs`
Expected: PASS.

Run: `pnpm --filter @dawn/web typecheck`
Expected: PASS.

Run: `pnpm --filter @dawn/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web scripts/check-docs.mjs
git commit -m "docs: polish public site for v0"
```

## Recommended Execution Order

1. Task 1: Make Packages Publish-Ready
2. Task 2: Decouple `create-dawn-app` From Repo-Local Paths
3. Task 3: Add CI and Release Automation
4. Task 4: Harden Public Consumption Checks
5. Task 5: Turn Lint Into a Real Gate
6. Task 6: Polish the Public Site for v0

## Why This Order

- Package publishability is the current highest-leverage bottleneck.
- The scaffolder cannot become a real external entrypoint until package publishing semantics are stable.
- CI and release automation should be added only after package metadata and pack validation are trustworthy.
- Packaged-consumer smoke tests then lock the public boundary in place.
- Lint should become a real gate before public release, but it does not block the publishability work itself.
- The website should reflect the final packaging/release shape, not guess ahead of it.
