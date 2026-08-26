# Dawn Workbench Scaffold Implementation Plan (SP3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the research template into an npm workspace (`server/` + `web/`) and ship the Dawn Workbench in it, so `npm create dawn-ai-app` generates the full two-package app — with the byte-for-byte example↔template parity guard extended to the web tree and the activation lane kept green.

**Architecture:** The template mirrors `examples/research`'s own shape: a private root orchestrator manifest plus `server/` and `web/` packages. The example stays authoritative; the parity guard grows a second comparison over the web tree; files that carry generation tokens stay outside parity roots, exactly as today. The single-process activation lane keeps proving the server lifecycle; two-process boot is SP3b.

**Tech Stack:** `packages/devkit` templates + `packages/create-dawn-app` (Node 24, npm 11 floor), the devkit parity tests, the Verdaccio-backed generated-app harness (touched only where the restructure forces it).

**Spec authority:** `docs/superpowers/specs/2026-08-19-dawn-workbench-design.md` §"Deferred to SP3 / SP4" — "npm-workspace template restructure, ports, `create-dawn-app` generation and next-steps, extending the byte-for-byte example↔template parity guard to a web tree". The harness two-process work ("boot two processes") is **SP3b**, a separate plan.

**Execution baseline:** Branch `blove/dawn-workbench-sp3` (already created) off `main` at `d2404dc7`.

**Toolchain traps:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && `. Never bare `biome check --write`. Never pipe a gate through `tail`. Other agent sessions have committed onto worktree branches mid-task in this repo: every implementer must verify `git branch --show-current` before starting and before each commit, and confirm commit placement afterwards.

---

## Research findings that shape this plan

All verified against source at `d2404dc7`, with two live spikes. Cite, don't re-derive; check anything that contradicts you.

### The scaffolder

- `create-dawn-ai-app` (`packages/create-dawn-app`) is pure argv — no prompts. Flags: positional target dir, `--template basic|research` (default research), `--mode external|internal` (default external), `--dist-tag` (default latest). Node 24 floor asserted before any I/O (`src/index.ts:24-34`).
- Templates live at `packages/devkit/templates/app-{basic,research}`, registered in `packages/devkit/src/templates.ts`. The copier (`packages/devkit/src/write-template.ts:19-61`) recurses directories, reads every file as UTF-8, applies `{{token}}` `replaceAll` substitutions to ALL files, and strips a per-segment `.template` suffix (`npmrc.template`→`.npmrc`, `gitignore.template`→`.gitignore`, otherwise drop the suffix). No changes to this mechanism are expected — it already handles nested trees.
- **There is no `workspace:*` rewrite.** Templates carry `{{dawnXxxSpecifier}}` tokens; external mode resolves every one to the dist-tag string (literally `"latest"`), internal mode to absolute `file://` URLs plus pnpm `overrides:`. **`dawnAgUiSpecifier` already exists in both maps** (`src/index.ts:264,290`) and `@dawn-ai/ag-ui` is already in the internal override list (`:313`) — no template consumes it yet. The plumbing for the web package's Dawn dep is already there.
- External mode deletes the generated `.npmrc` (`:114`). The template also ships `pnpm-workspace.yaml.template` (`packages: [.]`) for the pnpm-driven framework lane and internal mode.
- Next-steps text: `printNextSteps` (`src/index.ts:49-95`), with a win32 PowerShell variant. The research branch currently ends with a pointer AWAY to the web-UI recipe — SP3a replaces that with the app's own web UI.

### The parity guard

- `packages/devkit/test/templates.test.ts:220-350`: compares `examples/research/server` ↔ `templates/app-research` under an **allowlist of roots** (`.env.example`, `AGENTS.md`, `dawn.config.ts`, `src`, `test`, `workspace`), ignoring `workspace/reports` + `workspace/tool-outputs`, with `Buffer.equals` byte comparison and only the `.template`-suffix normalization. Substituted files (`package.json.template` etc.) are simply outside the roots — that is the whole mechanism for surviving tokens.
- **The example is authoritative; the template mirrors it. There is no sync script** — the failing test is the enforcement. Constraint from `docs/superpowers/plans/2026-08-09-research-starter-integrity.md:143`: literal `Buffer.equals`, "Do not keep a list of leaf files" — roots are filesystem-derived.
- `"byte-identical"` is a **banned phrase** in user-facing markdown AND changesets (`scripts/check-docs.mjs` — it has reddened a release before). `check-docs` scans `packages/**` markdown, so every new `.md` under the template is scanned.

### The activation lane (kept green, not extended, in SP3a)

- `test/generated/run-generated-research-activation.test.ts` proves the npm lifecycle end-to-end against Verdaccio: scaffold with NO `--template` flag, install, typegen/check/typecheck/test/eval/verify/build, boot `npm run dev`, drive AG-UI journeys, boot `npm start`. It **asserts the exact `scripts` map** of the generated package (`:990-1003`) and asserts `src/app/research/index.ts` exists (`:902-907`) — the restructure breaks both DELIBERATELY; updating them is in-scope.
- Ambient-credential proof: the harness sets `OPENAI_BASE_URL=http://127.0.0.1:1/v1` + sentinel key on its own env and strips them from every generated-app command (`GENERATED_APP_UNSET_ENV`); a green lane proves non-inheritance.
- The framework lane ALSO drives generated apps with **pnpm** (`test/generated/harness.ts`), and `test/harness/scaffold-packaging.ts:51-78` **appends** build policy to the generated `pnpm-workspace.yaml`. Verdaccio publishes every non-private `packages/*` — `@dawn-ai/ag-ui` included — so the web package's Dawn dep resolves in-harness. The web's npm-registry deps (`next`, `react`, `@copilotkit/*`) flow through Verdaccio's `"**"` npmjs proxy: heavier installs, watch lane timeouts.
- The `verify:harness:framework` wrapper swallows assertion output — real failures live in `artifacts/testing/harness-*/framework/transcript.log` and `vitest-report.json`. Bypass for iteration: `pnpm exec vitest --run --config test/generated/vitest.config.ts -t "activates the default research scaffold"`.

### Workspace and ports — the sharp edges

- **Nothing in the repo is a working model of a self-contained two-package workspace.** `examples/research/package.json` is an orphan aggregator (NOT a workspace member — root `pnpm-workspace.yaml` matches `examples/*/*` only) whose scripts only work inside the monorepo. It cannot be promoted as-is.
- The generated app is an **npm** product (next-steps, README, activation lane assert npm 11); the framework lane and internal mode are **pnpm**. Root orchestration must work under BOTH: npm needs a `"workspaces"` array; pnpm needs `pnpm-workspace.yaml` listing the members.
- Ports: the example pins server **3002** / web **3010**; the template currently pins **3000**. The web tree's source (`AppShell.tsx` `DEFAULT_SERVER_URL`, `.env.example`, both API routes) hard-pins 3002 — **byte parity of the web tree therefore forces the generated server onto 3002**. The next-steps text and template README follow.
- **SPIKE RESULT (live):** `next dev -p 3010 --port 4123` binds **4123** — last flag wins, so the harness's `-- --port N` append pattern works for Next unchanged (matters for SP3b; recorded here so nobody re-derives it).
- devkit's vitest include (`test/**/*.test.ts`) and lint script do NOT touch `templates/` — but the repo convention is that template files named `*.test.ts` carry `.template` (both existing ones do). Follow the convention for the web tree's test files; plain `.ts`/`.tsx` source files stay unsuffixed (the existing template's `src/**/*.ts` files are unsuffixed).

### Copy that cannot be identical must be MADE identical — in the example first

The web tree's `ConnectScreen.tsx` currently renders "Start it from `examples/research`:" and `pnpm dev:server` — monorepo-specific copy inside a tree that must be byte-equal to the template's. The resolution is NOT to exclude the file (roots, not leaf-lists) but to change the EXAMPLE's copy to words that are true in both contexts, then mirror. `npm run dev:server` works in both (in the example, npm executes the aggregator script whose body uses pnpm; in the generated app, the root script uses npm) — verified reasoning, but the implementer must confirm `npm run dev:server` actually works inside `examples/research` before relying on it, and update the ConnectScreen tests' copy assertions.

---

## CORRECTIONS FROM THE SPIKE ROUND (2026-08-25) — these override the tasks below

Five spikes ran before implementation. They discharged every "SPIKE REQUIRED" marker in this plan and **corrected four of its instructions**. Where this section and a task disagree, this section wins. The full decision sheet (with literal command output) is in the session scratchpad as `sp3a-decision-sheet.md`; it is deliberately not committed because it quotes a phrase the docs gate bans.

**C1 — Task 1 Step 2's root scripts are broken. Every single-workspace delegator needs a trailing ` --`.**
Verified on node 24.19.0 / npm 11.17.0: `npm run dev --workspace server` invoked as `npm run dev -- --port 4123` passes the child only `["4123"]` — npm eats the flag NAME — and `dawn dev` then hard-errors `too many arguments for 'dev'`. With a trailing ` --` the child receives `["--port","4123"]`. The harness boots generated apps exactly that way, so without this the activation lane dies 200 lines later as an unrelated-looking health-check timeout. Use the map in the decision sheet verbatim: trailing ` --` on every `--workspace` delegator, `--if-present` on every `--workspaces` fan-out, and no trailing `--` on the fan-outs.

**C2 — Task 3 Step 1 understates the parity work.** `RESEARCH_PARITY_ROOTS`/`RESEARCH_PARITY_IGNORED_PATHS` are module-level constants read *inside* `inventoryParityTree`, and `compareParityTrees` takes only `(exampleRoot, templateRoot)`. A "second describe block using the same comparator" would silently compare the web trees against the SERVER's roots — finding nothing and passing. Both functions must be parameterized with `parityRoots` (+ `ignoredPaths`) and all four callsites updated (three are the existing fixture tests).

**C3 — Task 5 Step 3 is a no-op; delete it.** `writePnpmWorkspaceBuildPolicy` early-returns because the template already carries all three markers. `test/generated/harness.ts` scaffolds `--template basic` in both modes, so the research restructure cannot reach it.

**C4 — Task 1 Step 1's single root gitignore is unsafe. Ship three.** Root (hand-written, must keep exactly one `.vercel/` line — `template-gitignore.test.ts` asserts it — and must add `.env`/`.env.*`/`!.env.example`, which the server's own file lacks) plus byte mirrors of the example's `server/.gitignore` and `web/.gitignore`. Hoisting breaks directory-anchored `workspace/*` entries and lets web's unanchored `AGENTS.md` hide the parity-guarded `server/AGENTS.md`. **Every one ships as `gitignore.template` at its own level** — `npm pack` silently drops a literal `.gitignore` at any depth.

**C5 — `web/tsconfig.json` goes INSIDE parity, unchanged.** It is self-contained (no `extends`, no `references`). Do NOT "tidy" it onto `@dawn-ai/config-typescript/nextjs`: that preset flips `jsx` and `allowJs` and adds two strict flags — a behavior change that also breaks parity.

**C6 — The web tree is 49 tracked files, not ~30** (14 of them tests).

**C7 — Two banned-phrase hits must be fixed on the EXAMPLE side before any mirroring**, in `examples/research/web/app/components/ui.ts:6` and `app/lib/hydrate.test.ts:484`. They are invisible today only because `examples` is outside the docs gate's roots; they become a hard failure the moment the file lands under `packages/`. Parity is byte-for-byte, so they cannot be fixed template-side.

**Discharged spikes (do not re-run):** `next dev -p 3010 --port 4123` binds 4123 (last flag wins). `npm run dev:server`/`dev:web` work inside `examples/research`. `--workspaces --if-present` exits 0 when a member lacks the script. `--workspaces` never fail-fasts — it reports the LAST failing workspace's code. `npm install` at the root hoists to one `node_modules` with members symlinked. `--workspace <dir>` resolves by directory, not package name.

**Highest-value traps** (full ranked list in the sheet): the trailing ` --` reads as a typo and will be "cleaned up" — add a devkit test asserting the literal strings end with `" --"`; the activation lane's `.env` must move to `server/.env` FIRST and ALONE, because a root `.env` makes `npm start` fail as an unrelated request-count assertion; `applyInternalModePackageOverrides` OVERWRITES `pnpm-workspace.yaml` with `packages:\n  - .`, so internal mode cannot install until it emits the two members; and two assertions go green-but-meaningless after the move (`packaged-app.test.ts`'s template-manifest byte check, and the activation lane's negative `src/app/(public)/hello/…` check).

---

### Task 0: Baseline

- [ ] **Step 1: Confirm branch and green start**

```bash
git branch --show-current    # blove/dawn-workbench-sp3
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/devkit test
```

Expected: 33 tests pass (7 files). Also run `pnpm --filter @dawn-example/research-web test` → 208 passed. Record both counts.

---

### Task 1: Restructure the template into a workspace (server side)

**Files:**
- Move: every current file of `packages/devkit/templates/app-research/` (except `gitignore.template`, `npmrc.template`, `pnpm-workspace.yaml.template`) into `packages/devkit/templates/app-research/server/`
- Create: `packages/devkit/templates/app-research/package.json.template` (new root orchestrator)
- Modify: `packages/devkit/templates/app-research/pnpm-workspace.yaml.template`
- Keep at root: `gitignore.template`, `npmrc.template` (they configure the whole app)
- Modify: `packages/devkit/templates/app-research/server/package.json.template` (the old root manifest, now the server's: port 3002)
- Modify: `packages/devkit/test/templates.test.ts` (parity template root becomes `app-research/server`)
- Modify: `packages/devkit/templates/app-research/server/README.md` + create a short new root `README.md`

- [ ] **Step 1: Move the tree with `git mv`** so history follows. The server keeps: `.dawn/`, `.env.example`, `AGENTS.md`, `README.md`, `dawn.config.ts`, `package.json.template`, `tsconfig.json.template`, `src/`, `test/`, `workspace/`. Decide `gitignore.template` placement by reading its content: entries like `.dawn/build` are server-relative — if so, a root gitignore with adjusted paths OR one gitignore per package, whichever `examples/research` itself uses (read it; the example is authoritative; if the example has separate `.gitignore`s per package, mirror that).

- [ ] **Step 2: Root orchestrator manifest.** Create `package.json.template`:

```json
{
  "name": "{{appName}}",
  "private": true,
  "workspaces": ["server", "web"],
  "scripts": {
    "dev": "npm run dev --workspace server",
    "dev:server": "npm run dev --workspace server",
    "dev:web": "npm run dev --workspace web",
    "verify": "npm run verify --workspace server",
    "typegen": "npm run typegen --workspace server",
    "check": "npm run check --workspace server",
    "typecheck": "npm run typecheck --workspaces",
    "test": "npm run test --workspaces --if-present",
    "eval": "npm run eval --workspace server",
    "build": "npm run build --workspaces",
    "start": "npm run start --workspace server",
    "memory:list": "npm run memory:list --workspace server",
    "memory:approve": "npm run memory:approve --workspace server"
  },
  "engines": { "node": ">=24.0.0" }
}
```

The server package becomes `"name": "{{appName}}-server"`, the web `"name": "{{appName}}-web"` (npm workspaces need distinct names; `{{appName}}` stays the root). **SPIKE REQUIRED before locking these scripts:** in a throwaway dir, verify with npm 11 that (a) `npm run dev -- --port 4123` at root forwards the flag through `--workspace` to the server script (the harness appends exactly that; if forwarding drops the flag, use the script shape that preserves it — candidates: `npm --workspace server run dev` vs `npm run dev --workspace server`; test both), (b) `npm run test --workspaces --if-present` skips a package without a test script rather than failing, (c) install-from-workspace-root resolves both packages' deps. Record the spike transcript in your report; the activation lane's exact-scripts assertion gets updated to whatever this spike proves.

- [ ] **Step 3: Server manifest updates.** `server/package.json.template`: name `{{appName}}-server`, `"dev": "dawn dev --port 3002"` (forced by web-tree parity — see research), everything else unchanged. `pnpm-workspace.yaml.template` → `packages: ["server", "web"]` (keep `onlyBuiltDependencies`/`allowBuilds`; the harness's `writePnpmWorkspaceBuildPolicy` APPENDS to this file — read it and make sure the result parses).

- [ ] **Step 4: Update the parity guard's template root** in `packages/devkit/test/templates.test.ts`: `resolveTemplateDir("research")` + `/server` for the existing comparison. The roots and ignore set are unchanged. Run `pnpm --filter @dawn-ai/devkit test` — the parity block must pass again (the moved files are unchanged bytes).

- [ ] **Step 5: READMEs.** Root README: short — what the two packages are, `npm install` once at root, `npm run dev:server` + `npm run dev:web` (two terminals), where the key goes (`server/.env`), port table (3002/3010). Server README: fix paths and the "server-first, no web UI" sentence — it is now false. Remember `check-docs` scans these; no banned phrases (spell byte-for-byte comparisons as "byte-for-byte", never the banned spelling — check `scripts/check-docs.mjs`'s list if unsure).

- [ ] **Step 6: Verify devkit tests pass; commit** (`feat(devkit): restructure the research template into a workspace`). The scaffolder and activation lane are now BROKEN (expected — Tasks 3 and 5 fix them); state that plainly in the commit body so a bisector isn't surprised, and do NOT push until the branch is whole.

---

### Task 2: The web template tree

**Files:**
- Create: `packages/devkit/templates/app-research/web/` — mirrored from `examples/research/web`
- Modify (example side): `examples/research/web/app/components/ConnectScreen.tsx` + its tests (context-neutral copy), possibly `examples/research/README.md`
- Create: `packages/devkit/templates/app-research/web/package.json.template` (tokens)

- [ ] **Step 1: Make the example's copy context-neutral FIRST.** In `examples/research/web/app/components/ConnectScreen.tsx`: "Start it from `examples/research`:" → wording true in both contexts (e.g. "From the app root:"), and `pnpm dev:server` → `npm run dev:server`. **Verify `npm run dev:server` works inside `examples/research`** (run it; npm executes the aggregator script, whose body may use pnpm — fine in the monorepo). Update the ConnectScreen test copy assertions. Run the web suite (208 must stay 208) and commit on the example side (`fix(example): make the connect screen's commands context-neutral`).

- [ ] **Step 2: Mirror the tree.** Copy `examples/research/web` → `templates/app-research/web` with these transforms only:
  - `package.json` → `package.json.template`: name `{{appName}}-web`, `"@dawn-ai/ag-ui": "{{dawnAgUiSpecifier}}"`, `"@dawn-ai/config-typescript"` — decide: the example's web uses it as a devDependency `workspace:*`; the generated app should get `{{dawnConfigTypescriptSpecifier}}` (token exists). Drop the example-only `lint` script (it reaches `../../../packages/config-biome` — impossible in a generated app) or replace with a self-contained lint; dropping matches the server template (which has no lint script) — drop, and note it.
  - Test files: `*.test.ts`/`*.test.tsx` gain `.template` per convention.
  - Do NOT copy: `node_modules`, `.next`, `AGENTS.md`/`CLAUDE.md` (Next-generated), `.turbo`.
  - Everything else byte-equal — that is the point.
- [ ] **Step 3: Check hidden tripwires**: does anything at repo root glob `templates/**/*.tsx` (root tsconfig, biome config, `check-docs` markdown scan hits `web/README.md` — read the banned-phrase list and scan the file)? Run `pnpm build`, `pnpm lint`, `node scripts/check-docs.mjs`, root `pnpm test` — all must pass with the new tree present.
- [ ] **Step 4: Commit** (`feat(devkit): ship the workbench in the research template`).

---

### Task 3: Extend the parity guard to the web tree

**Files:**
- Modify: `packages/devkit/test/templates.test.ts`

- [ ] **Step 1: Write the failing test.** A second describe block, `"research template parity with examples/research/web"`, same comparator, example root `examples/research/web`, template root `templates/app-research/web`, roots:

```ts
const WEB_PARITY_ROOTS = [
  ".env.example",
  "app",
  "next.config.mjs",
  "postcss.config.mjs",
  "vitest.config.ts",
] as const
```

`package.json` (tokens) and `tsconfig.json` + `README.md` stay outside — BUT verify `tsconfig.json` first: if the example's is workspace-independent (read it), include it; if it references the monorepo, exclude and say so. Test files inside `app/` carry `.template` on the template side — the existing `normalizeParitySegment` already handles the suffix; confirm the `.test.tsx.template` → `.test.tsx` normalization works (the existing normalizer strips one trailing `.template` segment-wise — it does), and that the fixture tests still pass.
- [ ] **Step 2: Run; fix any real divergence the guard finds** (fix by correcting the TEMPLATE — the example is authoritative). Expected end state: four empty arrays.
- [ ] **Step 3: Commit** (`test(devkit): extend research parity to the web tree`).

---

### Task 4: The scaffolder generates the workspace

**Files:**
- Modify: `packages/create-dawn-app/src/index.ts` (specifier wiring already exists; internal-mode overrides; next-steps)
- Modify: `packages/create-dawn-app/test/*` (whatever asserts generation output)

- [ ] **Step 1: Verify generation end-to-end locally**: `node packages/create-dawn-app/dist/bin.js /tmp/sp3-spike --mode internal` (build first). Assert the output tree has root+server+web, tokens resolved everywhere (`grep -r "{{" /tmp/sp3-spike` → nothing), internal-mode overrides cover the web package too, and `npm install` then `npm run typecheck` succeed in the generated app (internal mode; Node 24). Fix what breaks — likely candidates: internal-mode `pnpm-workspace.yaml` override writing (`applyInternalModePackageOverrides` assumes the old single-package shape — read it), `.npmrc` handling, and any path assumption in `assertInternalModeWorkspace`.
- [ ] **Step 2: Next-steps text**: root-level flow — `npm install`, key into `server/.env` (`cp server/.env.example server/.env`), `npm run verify`, `npm run dev:server` + `npm run dev:web` (two terminals), web on `http://localhost:3010`. Drop the recipe-URL pointer; the app now ships the UI. Keep the win32 variant in sync.
- [ ] **Step 3: Update create-dawn-app's own tests** to the new tree shape; run `pnpm --filter create-dawn-ai-app test` + `pnpm --filter @dawn-ai/devkit test`.
- [ ] **Step 4: Commit** (`feat(create-dawn-app): generate the two-package research workspace`).

---

### Task 5: Keep the harness lanes green

**Files:**
- Modify: `test/generated/run-generated-research-activation.test.ts`
- Modify: `test/generated/harness.ts` and/or `test/harness/*` — only where the restructure forces it

- [ ] **Step 1: Inventory the breakage** — run the framework lane via the direct vitest command (NOT the wrapper) and list every failure. Expected: the exact-scripts assertion, the `src/app/research/index.ts` existence check (now `server/src/...`), possibly the pnpm-workspace append, possibly `npm run dev`'s port forwarding.
- [ ] **Step 2: Update the activation lane deliberately**: new exact root-scripts map (from Task 1's spike), path assertions to `server/src/app/research/index.ts` + web markers (`web/app/page.tsx` exists), the lifecycle commands unchanged in spirit (they now run against root scripts that proxy to the server), `npm run dev -- --port N` forwarding per the spike. Assert the web workspace INSTALLED (e.g. `web/node_modules/.package-lock.json` or `npm ls` output) and `npm run build --workspaces` builds BOTH (the web build runs `next build` — this is the one new heavyweight step; watch the 600s budget and raise deliberately if needed, reserving the 30s cleanup margin).
- [ ] **Step 3: Framework/pnpm lane**: fix `writePnpmWorkspaceBuildPolicy` interplay and any `pnpm exec dawn` working-directory assumptions (`dawn` now lives in `server/`'s deps; `pnpm --filter`/`-C server` as needed).
- [ ] **Step 4: Run both lanes to green** via direct vitest; then once through the real wrapper (`pnpm verify:harness:framework`) to confirm the wrapper also passes. Budget: the web install through Verdaccio's npmjs proxy is the new slow step.
- [ ] **Step 5: Commit** (`test(harness): prove the generated workspace end to end`).

---

### Task 6: Verification and handoff

- [ ] **Step 1: Full gates**, each with exit codes captured (no `tail`): `pnpm build`, `pnpm lint`, `node scripts/check-docs.mjs`, `pnpm test` (root — includes devkit parity), `pnpm --filter @dawn-example/research-web test` (208), `pnpm verify:harness:framework`, `pnpm --filter create-dawn-ai-app test`.
- [ ] **Step 2: One real generation smoke** (external mode against the local Verdaccio via the harness, or internal mode locally): generate, install, `npm run dev:server` + `npm run dev:web`, open the workbench in a browser, see the connect-screen-then-workbench flow with the generated app. Report what you observed.
- [ ] **Step 3: Changesets.** This branch DOES touch published packages: `@dawn-ai/devkit` (templates ship in its tarball) and `create-dawn-ai-app`. Add a changeset (patch — check GOTCHA 6: the fixed 0.x group turns minor into 1.0.0; use patch) describing the workspace restructure and the bundled web UI. NO banned phrases in the changeset (they reach the CHANGELOG and red the release — GOTCHA 12).
- [ ] **Step 4: Docs**: template READMEs already done (Tasks 1–2); check `apps/web/content/docs/` for scaffold docs that describe the old flat layout (`getting-started`, anything quoting `create-dawn-ai-app` output) and update what this branch falsifies. Re-verify attributed code blocks mechanically.
- [ ] **Step 5:** superpowers:requesting-code-review on `git diff main...HEAD`, then superpowers:finishing-a-development-branch. PR title: `feat(devkit): scaffold the Dawn Workbench`.

---

## Out of scope

- **SP3b** — teaching the harness to boot two processes with a Next-aware readiness predicate (the `/healthz` contract mismatch, dual port allocation, `DAWN_SERVER_URL` injection into the web process) and extending the activation journey through the web app's own `/api/copilotkit`.
- **SP4** — the Playwright activation gate (browser-level: suggestion click → plan → subagent → gate → approve → memory candidate) against deterministic aimock.
- A template sync script (manual mirroring under test enforcement, as today; revisit if the web tree churns).
- Any change to `app-basic`.
