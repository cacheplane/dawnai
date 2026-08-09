# CLI Documentation Turbo Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Turbo invalidate and restore the CLI's generated documentation whenever its website documentation sources change.

**Architecture:** Add a package-qualified `@dawn-ai/cli#build` override that retains default CLI inputs, adds the cross-package MDX/navigation inputs, and caches both `dist/**` and `docs/**`. Strengthen the existing repository build-cache check by parsing Turbo's effective dry-run task so future configuration drift fails before the build.

**Tech Stack:** Node.js ESM, Turbo 2.10.8, pnpm, JSON configuration, Changesets.

---

### Task 1: Make the cache-contract guard fail on the current configuration

**Files:**
- Modify: `scripts/check-build-cache-config.mjs`
- Test: `scripts/check-build-cache-config.mjs` through `pnpm check:build-cache`

- [x] **Step 1: Add effective-task inspection**

Import `execFileSync` from `node:child_process`. Add paths for the CLI package,
website docs source, navigation file, and local Turbo binary:

```js
const cliRoot = join(packageRoot, "cli")
const docsSourceRoot = join(repoRoot, "apps", "web", "content", "docs")
const docsNavPath = join(repoRoot, "apps", "web", "app", "components", "docs", "nav.ts")
const turboPath = join(repoRoot, "node_modules", "turbo", "bin", "turbo")
```

Add a recursive MDX inventory helper using `readdirSync(..., { withFileTypes: true })` and a normalizer that resolves Turbo input keys relative to `cliRoot` before converting them to repository-relative POSIX paths.

- [x] **Step 2: Parse the effective CLI build task**

Run Turbo without executing the build:

```js
const dryRun = JSON.parse(
  execFileSync(
    process.execPath,
    [turboPath, "run", "build", "--filter=@dawn-ai/cli", "--dry=json"],
    { cwd: repoRoot, encoding: "utf8" },
  ),
)
const cliBuildTask = dryRun.tasks?.find((task) => task.taskId === "@dawn-ai/cli#build")
```

If the task is absent, append a focused error. Otherwise create normalized input and output sets and require:

```text
apps/web/content/docs/**/*.mdx  (every current file)
apps/web/app/components/docs/nav.ts
packages/cli/src/index.ts
dist/**
docs/**
```

Accumulate all missing elements into the existing `errors` array. Wrap command execution and JSON parsing so failures add an actionable cache-check error instead of an unhandled stack trace.

- [x] **Step 3: Run the guard and verify RED**

```bash
pnpm check:build-cache
```

Expected: FAIL. The output identifies all website MDX inputs, the navigation input, and `docs/**` as missing. `packages/cli/src/index.ts` and `dist/**` should already be present, proving the default inputs and existing output are visible.

- [x] **Step 4: Commit the red guard**

```bash
git add scripts/check-build-cache-config.mjs
git commit -m "test(cli): guard bundled docs cache contract"
```

### Task 2: Declare the CLI documentation cache contract

**Files:**
- Modify: `turbo.json`
- Test: `scripts/check-build-cache-config.mjs` through `pnpm check:build-cache`

- [x] **Step 1: Add the package-qualified build task**

Add this sibling of the generic `build` task:

```json
"@dawn-ai/cli#build": {
  "dependsOn": ["^build"],
  "inputs": [
    "$TURBO_DEFAULT$",
    "$TURBO_ROOT$/apps/web/content/docs/**/*.mdx",
    "$TURBO_ROOT$/apps/web/app/components/docs/nav.ts"
  ],
  "outputs": ["dist/**", "docs/**"]
}
```

- [x] **Step 2: Run the guard and verify GREEN**

```bash
pnpm check:build-cache
```

Expected: PASS. The success message states that the generic `dist/**` contract and CLI bundled-docs contract were checked.

- [x] **Step 3: Inspect the effective task**

```bash
pnpm exec turbo run build --filter=@dawn-ai/cli --dry=json
```

Expected: `@dawn-ai/cli#build` contains all 42 current MDX files and the navigation file in `inputs`, retains `src/index.ts`, and lists `dist/**` plus `docs/**` in outputs.

- [x] **Step 4: Commit the configuration fix**

```bash
git add turbo.json
git commit -m "fix(cli): cache generated documentation"
```

### Task 3: Prove clean cache restoration

**Files:**
- Generated then remove/restore: `packages/cli/docs/**`
- Verify: `turbo.json`

- [x] **Step 1: Populate a fresh cache entry with generated docs**

```bash
pnpm exec turbo run build --filter=@dawn-ai/cli... --force
```

Expected: the CLI build executes and writes 42 topics plus `README.md`; `packages/cli/docs/README.md` exists.

- [x] **Step 2: Remove only the generated docs output**

Validate the exact target, then remove it:

```bash
test "$(git rev-parse --show-toplevel)" = "$PWD"
node -e "require('node:fs').rmSync('packages/cli/docs', { recursive: true, force: true })"
test ! -d packages/cli/docs
```

Expected: the gitignored generated directory is absent; tracked files are untouched.

- [x] **Step 3: Restore from an unchanged cache hit**

```bash
pnpm exec turbo run build --filter=@dawn-ai/cli...
test -f packages/cli/docs/README.md
test -f packages/cli/docs/getting-started.md
test -f packages/cli/docs/tools.md
```

Expected: Turbo reports cache hits, and representative bundled docs are restored without executing the generator.

- [x] **Step 4: Confirm no generated files are tracked**

```bash
git status --short
```

Expected: `packages/cli/docs/**` does not appear; it remains gitignored.

### Task 4: Add release metadata and verify

**Files:**
- Create: `.changeset/bright-docs-cache.md`
- Verify: `scripts/check-build-cache-config.mjs`
- Verify: `turbo.json`

- [x] **Step 1: Add a patch changeset**

Create:

```md
---
"@dawn-ai/cli": patch
---

Invalidate and restore the CLI's bundled documentation correctly through the Turbo build cache.
```

- [x] **Step 2: Run focused verification**

```bash
pnpm lint
pnpm check:build-cache
pnpm build
node scripts/check-docs.mjs
pnpm pack:check
```

Expected: all commands pass, the CLI docs are present after build/cache restoration, and the packed CLI contains its required documentation.

- [x] **Step 3: Run repository validation**

```bash
pnpm ci:validate
```

Expected: all Definition of Done lanes pass. Environment-gated Docker/Kubernetes lanes remain PR CI responsibilities.

- [x] **Step 4: Review the final diff**

```bash
git diff --check main...HEAD
git diff --check
git diff --cached --check
git status --short
```

Expected: no whitespace errors; only the approved spec/plan, cache-check script, Turbo configuration, and changeset are tracked changes.

- [x] **Step 5: Commit release metadata and any plan checkmarks**

```bash
git add .changeset/bright-docs-cache.md docs/superpowers/plans/2026-08-09-cli-docs-turbo-cache.md
git commit -m "chore(cli): document bundled docs cache fix"
```
