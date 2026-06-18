# OSSF Scorecard Uplift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Dawn's live OpenSSF Scorecard from 4.1/10 toward ~8/10 by fixing the high- and medium-weight checks currently scoring 0 (Token-Permissions, Pinned-Dependencies, SAST, Vulnerabilities).

**Architecture:** Two independently-mergeable phases. Phase 1 is pure GitHub Actions workflow config (least-privilege token permissions, SHA-pinned actions, a new CodeQL workflow) — zero runtime risk. Phase 2 is dependency remediation to clear 25 OSV advisories in dev/docs tooling, gated by full CI + the harness verification suite.

**Tech Stack:** GitHub Actions YAML, `ossf/scorecard-action`, `github/codeql-action`, pnpm 10.33.0 workspaces, changesets.

**Reference spec:** `docs/superpowers/specs/2026-06-18-ossf-scorecard-uplift-design.md`

**Resolved action SHAs (pin targets):**

| Action | Tag | SHA |
|---|---|---|
| actions/checkout | v6 | `df4cb1c069e1874edd31b4311f1884172cec0e10` |
| actions/setup-node | v6 | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |
| actions/upload-artifact | v7 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| pnpm/action-setup | v4 | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| changesets/action | v1.9.0 | `a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d` |
| ossf/scorecard-action | v2.4.3 | `4eaacf0543bb3f2c246792bd56e8cdeffafb205a` |
| github/codeql-action/* | v4 | `8aad20d150bbac5944a9f9d289da16a4b0d87c1e` |

> Note: this plan is executed inside the worktree on branch `blove/sharp-yalow-6d182d`. Phase 1 and Phase 2 produce separate commits intended to become two PRs; the actual PR split / push is handled later via `superpowers:finishing-a-development-branch`.

---

## Phase 1 — Workflow config (Token-Permissions, Pinned-Dependencies, SAST)

### Task 1: Lock down and pin `ci.yml`

Adds a top-level least-privilege `permissions` block and pins all actions to SHAs. This addresses Token-Permissions (`ci.yml` currently declares no permissions → token defaults to write-all) and contributes to Pinned-Dependencies.

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add top-level permissions and pin actions**

Replace the top of the file (the `on:` block is unchanged; insert `permissions:` after it) and replace every `uses:` line. The full resulting file:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  changesets:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
        with:
          fetch-depth: 0

      - name: Require changeset for user-facing changes
        env:
          BASE_REF: origin/${{ github.event.pull_request.base.ref }}
          HEAD_REF: ${{ github.event.pull_request.head.ref }}
          PR_AUTHOR: ${{ github.event.pull_request.user.login }}
        run: node scripts/check-changesets.mjs

  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6

      - name: Setup pnpm
        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
        with:
          version: 10.33.0

      - name: Setup Node.js
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          # 22.14.0 — node:sqlite (used by @dawn-ai/sqlite-storage) is only
          # available without the --experimental-sqlite flag from 22.13+.
          # Matches release.yml and the engines floor.
          node-version: 22.14.0
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Build
        run: pnpm build

      - name: Typecheck
        run: pnpm typecheck

      - name: Source Tests
        run: pnpm test

      - name: Docs Check
        run: node scripts/check-docs.mjs

      - name: Pack Check
        run: pnpm pack:check

      - name: Harness Coordinator Self-Test
        run: pnpm verify:harness:self-test

      - name: Framework Verification
        run: pnpm verify:harness:framework

      - name: Runtime Contract Verification
        run: pnpm verify:harness:runtime

      - name: Smoke Harness Verification
        run: pnpm verify:harness:smoke

      - name: Upload Harness Artifacts
        if: failure()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: harness-artifacts
          path: artifacts/testing/
          retention-days: 7
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Verify pins and permissions are present**

Run: `grep -c 'uses: .*@[0-9a-f]\{40\} #' .github/workflows/ci.yml && grep -A1 '^on:' -m1 /dev/null; grep -n '^permissions:' .github/workflows/ci.yml`
Expected: count `4` (four SHA-pinned actions), and a line `permissions:` at top level. No remaining `@v` tags: `grep -n 'uses: .*@v' .github/workflows/ci.yml` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: least-privilege token permissions and SHA-pin actions in ci.yml"
```

### Task 2: Add top-level permissions and pin `release.yml`

`release.yml` already sets job-level write permissions; add a top-level read-only default (Scorecard wants top-level read, writes only at job level) and pin its actions.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add top-level permissions and pin actions**

Full resulting file:

```yaml
name: Release

on:
  push:
    branches:
      - main

concurrency: ${{ github.workflow }}-${{ github.ref }}

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    env:
      NPM_CONFIG_PROVENANCE: "true"

    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
        with:
          fetch-depth: 0

      - name: Setup pnpm
        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
        with:
          version: 10.33.0

      - name: Setup Node.js
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: 22.14.0
          cache: pnpm
          registry-url: https://registry.npmjs.org

      # Trusted publishing requires npm 11.5.1+. Node 22's bundled npm 10.x
      # doesn't fully support the OIDC trusted-publishing flow.
      - name: Upgrade npm for trusted publishing
        run: npm install --global npm@latest

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Validate Release Candidate
        run: pnpm ci:validate

      # Trusted publishing is configured per-package on npm; no NPM_TOKEN needed.
      # The OIDC token from id-token: write authenticates this workflow as a
      # trusted publisher for each package.
      - name: Create Release Pull Request or Publish
        uses: changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d # v1.9.0
        with:
          version: pnpm exec changeset version
          publish: pnpm release:publish
          title: Version Packages
          commit: Version Packages
          createGithubReleases: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Verify pins and no remaining tags**

Run: `grep -n 'uses: .*@v' .github/workflows/release.yml`
Expected: no output. And `grep -n '^permissions:' .github/workflows/release.yml` shows a top-level block.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add top-level read permissions and SHA-pin actions in release.yml"
```

### Task 3: Pin `scorecard.yml`

Pins the remaining actions. Top-level `permissions: contents: read` already exists here.

**Files:**
- Modify: `.github/workflows/scorecard.yml`

- [ ] **Step 1: Pin actions to SHAs**

Full resulting file:

```yaml
name: OpenSSF Scorecard

on:
  branch_protection_rule:
  push:
    branches:
      - main
  schedule:
    - cron: "17 12 * * 2"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  scorecard:
    name: Scorecard
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      id-token: write
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
        with:
          persist-credentials: false

      - name: Run Scorecard
        uses: ossf/scorecard-action@4eaacf0543bb3f2c246792bd56e8cdeffafb205a # v2.4.3
        with:
          results_file: scorecard.sarif
          results_format: sarif
          publish_results: true

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4
        with:
          sarif_file: scorecard.sarif
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/scorecard.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Verify no remaining tags**

Run: `grep -n 'uses: .*@v' .github/workflows/scorecard.yml`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/scorecard.yml
git commit -m "ci: SHA-pin actions in scorecard.yml"
```

### Task 4: Add CodeQL SAST workflow

Adds the SAST check Scorecard looks for. Uses CodeQL `build-mode: none` (JS/TS is interpreted — no build needed), keeping it fast and robust against the pnpm monorepo. Actions pinned to SHAs; least-privilege permissions.

**Files:**
- Create: `.github/workflows/codeql.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: CodeQL

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  schedule:
    - cron: "23 4 * * 1"

permissions:
  contents: read

jobs:
  analyze:
    name: Analyze (javascript-typescript)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      security-events: write
      actions: read

    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6

      - name: Initialize CodeQL
        uses: github/codeql-action/init@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4
        with:
          languages: javascript-typescript
          build-mode: none

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4
        with:
          category: "/language:javascript-typescript"
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/codeql.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Confirm actions are SHA-pinned**

Run: `grep -n 'uses: .*@v' .github/workflows/codeql.yml`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/codeql.yml
git commit -m "ci: add CodeQL SAST workflow (javascript-typescript, build-mode none)"
```

### Task 5: Phase 1 verification

- [ ] **Step 1: Lint all workflows with actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint || echo "actionlint not installed — relying on YAML parse + post-merge Scorecard"`
Expected: `actionlint` prints no errors, OR the fallback message. (actionlint is optional; do not install it just for this.)

- [ ] **Step 2: Confirm every workflow action is SHA-pinned repo-wide**

Run: `grep -rn 'uses: .*@v' .github/workflows/ ; echo "exit: $?"`
Expected: no `uses: ...@v` matches (grep exit `1` = no matches).

- [ ] **Step 3: Confirm Dependabot still covers github-actions**

Run: `grep -n 'github-actions' .github/dependabot.yml`
Expected: a match — Dependabot updates SHA pins automatically, so no change is needed here.

- [ ] **Step 4: Note for post-merge**

Phase 1's real verification is the recomputed Scorecard. After this is on `main`, re-check `https://api.scorecard.dev/projects/github.com/cacheplane/dawnai` (within ~1–2 days, or trigger the workflow via `workflow_dispatch`). Expect: Token-Permissions 0→10, Pinned-Dependencies 0→~9, SAST 0→10.

---

## Phase 2 — Dependency remediation (Vulnerabilities 0→10)

25 OSV advisories, all in dev/docs/test tooling (no published runtime package is affected). The Vulnerabilities check stays near 0 until almost all clear, so this phase iterates until `pnpm audit` is essentially clean, gated by full CI + the harness suite. Work in the main repo checkout where dependencies install (`/Users/blove/repos/dawn`) or run `pnpm install` in the worktree first.

**Known advisory clusters (from `pnpm audit`, 2026-06-18):** `next` ×8, `next`→misc, `vite` ×3, `vitest` (1 critical), `esbuild` ×2, `turbo` ×2, `ws`, `js-yaml`, `uuid`, `langsmith`.

**Files:**
- Modify: `package.json` (root — `pnpm.overrides`), `apps/web/package.json` or wherever `next` is declared, package(s) declaring `vitest`/`turbo`.
- Modify: `pnpm-lock.yaml` (regenerated by install).

### Task 6: Bump direct dependencies

- [ ] **Step 1: Record the baseline advisory count**

Run: `pnpm audit --json | python3 -c "import sys,json; print(json.load(sys.stdin)['metadata']['vulnerabilities'])"`
Expected: a dict like `{'info':0,'low':4,'moderate':12,'high':11,'critical':1}` (baseline = 28 counted entries / 25 advisories). Save this number.

- [ ] **Step 2: Locate the direct declarations**

Run: `grep -rln '"next"\|"turbo"\|"vitest"' --include=package.json --exclude-dir=node_modules .`
Expected: the package.json files that declare these as direct deps (the `next` one is the private `@dawn-ai/web` docs app; `turbo` and `vitest` are at the workspace root).

- [ ] **Step 3: Bump to latest patched versions**

Edit each declaration to the latest published versions (these patch the listed advisories):
- `next`: `16.2.3` → `16.2.9`
- `turbo`: `2.9.6` → `2.9.18`
- `vitest` (root devDependency, currently `4.1.4`): → `4.1.9`

Use the exact version strings already in use (the repo pins exact versions for these — keep that style, no `^`).

- [ ] **Step 4: Reinstall and rebuild the lockfile**

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` updated.

- [ ] **Step 5: Re-audit**

Run: `pnpm audit --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['metadata']['vulnerabilities']); [print(' ',a.get('module_name'),a.get('severity')) for a in (d.get('advisories') or {}).values()]"`
Expected: the `next`/`turbo`/`vitest` clusters gone; remaining advisories are transitive (`ws`, `esbuild`, `js-yaml`, `uuid`, `vite`, `langsmith`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(deps): bump next, turbo, vitest to clear OSV advisories"
```

### Task 7: Add pnpm overrides for transitive advisories

Transitive advisories can't be fixed by a direct bump — force patched versions via `pnpm.overrides`. Choose the lowest version that satisfies the advisory AND installs cleanly across all consumers (pnpm errors if an override is unsatisfiable; if so, widen the range or scope the override).

**Files:**
- Modify: `package.json` (root `pnpm.overrides`)

- [ ] **Step 1: Extend the overrides block**

Current root `pnpm.overrides` is `{ "langsmith": "0.5.19", "postcss": "8.5.10" }`. Update it to force patched transitive versions. Start with these (latest published, all backward-compatible within consumers' major ranges):

```json
"pnpm": {
  "overrides": {
    "langsmith": "0.7.10",
    "postcss": "8.5.10",
    "ws@>=8 <8.18.1": "8.18.3",
    "esbuild@<0.25.0": "0.25.10",
    "js-yaml@<4.1.1": "4.2.0",
    "uuid@<11.1.0": "11.1.0"
  }
}
```

Notes:
- `langsmith` bumped `0.5.19`→`0.7.10` (the high-severity prompt-pull advisory).
- Selector-scoped overrides (`pkg@<range`) only rewrite the vulnerable versions, minimizing blast radius. If pnpm reports an unsatisfiable override, replace the selector form with a plain `"pkg": "<version>"` or widen the target.
- `vite`/`esbuild` are coupled (vite bundles esbuild). If a `vite` advisory remains after the esbuild override, add a `vite` override to the latest patch within each consumer's major (the repo has consumers on `^5`, `^6`, `^7`) — prefer per-major scoped selectors over a single global bump that would break `^5` consumers.

- [ ] **Step 2: Reinstall**

Run: `pnpm install`
Expected: completes with no "unsatisfiable override" / peer errors. If it errors, adjust the offending override per the notes above and rerun.

- [ ] **Step 3: Re-audit until clean**

Run: `pnpm audit`
Expected: `No known vulnerabilities found` — or only advisories with no available patched version (record any such residue explicitly). Loop Steps 1–3, adding/adjusting one override at a time, until the count is 0 or only-unfixable.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): pnpm overrides to clear transitive OSV advisories"
```

### Task 8: Phase 2 full verification gate

The dependency changes are the only ones that can break the build. Everything must be green before this phase is considered done.

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: passes.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: passes.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 4: Tests**

Run: `pnpm test`
Expected: passes (note the harness tests must pack `@dawn-ai/langchain` alongside `@dawn-ai/cli`; this is already wired in the suite).

- [ ] **Step 5: Pack check**

Run: `pnpm pack:check`
Expected: passes.

- [ ] **Step 6: Harness verification suite**

Run: `pnpm verify:harness:self-test && pnpm verify:harness:framework && pnpm verify:harness:runtime && pnpm verify:harness:smoke`
Expected: all four pass. If any fail due to a dependency bump, that bump is the suspect — narrow the override scope or pin a different patch version, then re-run from Task 8 Step 1.

- [ ] **Step 7: Final audit confirmation**

Run: `pnpm audit`
Expected: `No known vulnerabilities found` (or documented unfixable residue only).

- [ ] **Step 8: Note for post-merge**

After merge to `main`, confirm Scorecard's Vulnerabilities check rises from 0 toward 10 at `https://api.scorecard.dev/projects/github.com/cacheplane/dawnai`.

---

## Out of scope (tracked elsewhere — see spec)

These need Brian's GitHub account and are **not** implemented by this plan:
- **Branch-Protection** (-1): create a fine-grained PAT with admin:read, store as the `repo_token`/`SCORECARD_TOKEN` secret, pass it to `ossf/scorecard-action`.
- **Code-Review** (0): route future `main` commits through reviewed PRs (start by reviewing/merging Phase 1 and Phase 2 as PRs).
- **CII-Best-Practices** (0): self-certify at bestpractices.dev.
- **Maintained** (0): auto-resolves ~2026-07-14 (90-day repo age) — no action.
- **Signed-Releases** (-1) and **Packaging** (-1): deferred; own spec later.

---

## Self-review notes

- **Spec coverage:** Token-Permissions (Tasks 1–2), Pinned-Dependencies (Tasks 1–4 + Task 5 sweep), SAST (Task 4), Vulnerabilities (Tasks 6–8). Branch-Protection / Code-Review / CII / Maintained / Signed-Releases / Packaging are explicitly out of scope per the approved design.
- **Pin consistency:** every workflow action uses the SHA table at the top; the CodeQL `init`/`analyze`/`upload-sarif` paths share the one `github/codeql-action` SHA `8aad20d…`.
- **Risk isolation:** Phase 1 cannot affect runtime; Phase 2 is gated by the full harness suite (Task 8) before completion.
