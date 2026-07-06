# Research Demo — Slice 1 (Server App + Deterministic Tests) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a polished, standalone `examples/research` Dawn server app that dogfoods the research workflow, subagents, tools, memory candidates/approval, planning, offloading, HITL permissions, and an (optional) Docker sandbox — deterministic and green in CI with no API key.

**Architecture:** A new in-repo pnpm workspace package `@dawn-example/research-server` under `examples/research/server`, mirroring the shape of `examples/chat/server`. It **promotes** the existing `packages/devkit/templates/app-research` template (which is the default scaffold) into a concrete, non-`.template` example: workspace deps (`workspace:*`), no mustache, no standalone-scaffold packaging files. Determinism comes from the same `@dawn-ai/testing` `aimock`/`script()` fixture suite the template ships. CI picks it up automatically: turbo runs `build`/`typecheck` for every workspace package, and the root vitest workspace runs the package's test project (exactly as `examples/chat/server` already does).

**Tech Stack:** TypeScript, `@dawn-ai/{sdk,cli,core,langchain,sandbox}`, `@dawn-ai/{evals,testing,config-typescript}`, Vitest, Zod 4, pnpm workspaces, Turbo.

**Scope note:** This is Slice 1 of 4 (see `docs/superpowers/specs/2026-07-06-research-demo-design.md`). Slices 2–4 (web UI + demo mode, scaffold slimming, docs-recipe extraction) are separate plans. Do **not** touch `packages/devkit/templates/app-research` in this slice.

**Working directory:** This plan executes in the existing worktree `.claude/worktrees/zealous-goldberg-ab9dfc` on branch `blove/zealous-goldberg-ab9dfc`. All paths below are relative to the repo root of that worktree.

---

## File Structure

New files under `examples/research/`:

```
examples/research/
  README.md                         # brief pointer (root convenience)
  package.json                      # non-member convenience scripts (server-only for now)
  server/
    README.md                       # the tour (adapted from template README)
    package.json                    # @dawn-example/research-server, workspace:* deps
    tsconfig.json                   # from template tsconfig.json.template (verbatim)
    vitest.config.ts                # from examples/chat/server/vitest.config.ts (verbatim)
    dawn.config.ts                  # from template (verbatim)
    .gitignore                      # from template gitignore.template (verbatim)
    .env.example                    # new
    AGENTS.md                       # from template (verbatim)
    src/
      app/research/
        index.ts                    # from template (verbatim)
        state.ts                    # from template (verbatim)
        memory.ts                   # from template (verbatim)
        memory.md                   # from template (verbatim)
        plan.md                     # from template (verbatim)
        subagents/researcher/index.ts   # from template (verbatim)
        skills/cite-sources/SKILL.md         # from template (verbatim)
        skills/synthesize-findings/SKILL.md  # from template (verbatim)
        evals/research-quality.eval.ts       # from template .eval.ts.template (verbatim)
      tools/searchCorpus.ts         # from template (verbatim)
      tools/readDoc.ts              # from template (verbatim)
    test/
      research.test.ts              # from template research.test.ts.template (verbatim)
      sandbox-docker.test.ts        # from template sandbox-docker.test.ts.template (verbatim)
    workspace/
      AGENTS.md                     # from template (verbatim)
      corpus/*.md                   # 5 docs from template (verbatim)
      scripts/fetch-source.mjs      # from template (verbatim)
```

Modified files:

```
vitest.workspace.ts                 # add the research server test project
```

**Not** created (these are standalone-scaffold-only, unnecessary inside the monorepo): `package.json.template` (replaced with concrete), `npmrc.template`, `pnpm-workspace.yaml.template`, and the generated `.dawn/` directory (gitignored, produced at runtime).

---

## Task 1: Server package skeleton — configs + promoted source, install/typecheck/build green

**Files:**
- Create: `examples/research/package.json`, `examples/research/README.md`
- Create: `examples/research/server/package.json`, `.env.example`, `README.md`
- Create (copied verbatim): everything under `examples/research/server/{src,workspace,test-configs}` per the mapping below
- Modify: root `pnpm-lock.yaml` (implicitly, via `pnpm install`)

- [ ] **Step 1: Create the copied tree from the template**

Run this exact block from the repo root. It copies every verbatim file and renames the `.template` files. It intentionally does NOT copy `package.json.template`, `npmrc.template`, or `pnpm-workspace.yaml.template`.

```bash
SRC=packages/devkit/templates/app-research
DST=examples/research/server
mkdir -p "$DST/src/app/research/subagents/researcher" \
         "$DST/src/app/research/skills/cite-sources" \
         "$DST/src/app/research/skills/synthesize-findings" \
         "$DST/src/app/research/evals" \
         "$DST/src/tools" \
         "$DST/test" \
         "$DST/workspace/corpus" \
         "$DST/workspace/scripts"

# Root-level app files (verbatim)
cp "$SRC/dawn.config.ts"        "$DST/dawn.config.ts"
cp "$SRC/AGENTS.md"             "$DST/AGENTS.md"
cp "$SRC/tsconfig.json.template" "$DST/tsconfig.json"
cp "$SRC/gitignore.template"    "$DST/.gitignore"

# Route + tools (verbatim)
cp "$SRC/src/app/research/index.ts"  "$DST/src/app/research/index.ts"
cp "$SRC/src/app/research/state.ts"  "$DST/src/app/research/state.ts"
cp "$SRC/src/app/research/memory.ts" "$DST/src/app/research/memory.ts"
cp "$SRC/src/app/research/memory.md" "$DST/src/app/research/memory.md"
cp "$SRC/src/app/research/plan.md"   "$DST/src/app/research/plan.md"
cp "$SRC/src/app/research/subagents/researcher/index.ts" "$DST/src/app/research/subagents/researcher/index.ts"
cp "$SRC/src/app/research/skills/cite-sources/SKILL.md"        "$DST/src/app/research/skills/cite-sources/SKILL.md"
cp "$SRC/src/app/research/skills/synthesize-findings/SKILL.md" "$DST/src/app/research/skills/synthesize-findings/SKILL.md"
cp "$SRC/src/tools/searchCorpus.ts" "$DST/src/tools/searchCorpus.ts"
cp "$SRC/src/tools/readDoc.ts"      "$DST/src/tools/readDoc.ts"

# Eval + tests (strip .template)
cp "$SRC/src/app/research/evals/research-quality.eval.ts.template" "$DST/src/app/research/evals/research-quality.eval.ts"
cp "$SRC/test/research.test.ts.template"        "$DST/test/research.test.ts"
cp "$SRC/test/sandbox-docker.test.ts.template"  "$DST/test/sandbox-docker.test.ts"

# Workspace (verbatim)
cp "$SRC/workspace/AGENTS.md" "$DST/workspace/AGENTS.md"
cp "$SRC/workspace/corpus/"*.md "$DST/workspace/corpus/"
cp "$SRC/workspace/scripts/fetch-source.mjs" "$DST/workspace/scripts/fetch-source.mjs"
```

- [ ] **Step 2: Write the server `package.json`**

Create `examples/research/server/package.json`:

```json
{
  "name": "@dawn-example/research-server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "node node_modules/@dawn-ai/cli/dist/index.js dev --port 3002",
    "build": "node node_modules/@dawn-ai/cli/dist/index.js build",
    "typecheck": "tsc -p . --noEmit",
    "check": "node node_modules/@dawn-ai/cli/dist/index.js check",
    "test": "vitest run",
    "test:sandbox:docker": "DAWN_DEMO_DOCKER_SANDBOX=1 vitest run test/sandbox-docker.test.ts",
    "eval": "node node_modules/@dawn-ai/cli/dist/index.js eval",
    "memory:list": "node node_modules/@dawn-ai/cli/dist/index.js memory list",
    "memory:approve": "node node_modules/@dawn-ai/cli/dist/index.js memory approve"
  },
  "dependencies": {
    "@dawn-ai/cli": "workspace:*",
    "@dawn-ai/core": "workspace:*",
    "@dawn-ai/langchain": "workspace:*",
    "@dawn-ai/sandbox": "workspace:*",
    "@dawn-ai/sdk": "workspace:*",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@dawn-ai/evals": "workspace:*",
    "@dawn-ai/testing": "workspace:*",
    "@types/node": "26.1.0",
    "typescript": "6.0.2",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 3: Write the server `vitest.config.ts`**

Create `examples/research/server/vitest.config.ts` (identical to `examples/chat/server/vitest.config.ts` — the suite boots in-process agents + a `dawn dev` subprocess and mutates process-global `OPENAI_BASE_URL`, so files must run sequentially):

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    // The capability suites boot in-process agents + a real dawn dev subprocess
    // and mutate process-global OPENAI_BASE_URL — run files sequentially to
    // avoid cross-file env/port races.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
```

- [ ] **Step 4: Write the server `.env.example`**

Create `examples/research/server/.env.example`:

```bash
# Only needed for live/model runs (e.g. `pnpm eval -- --live`, or `dawn run`
# without fixtures). Offline tests and evals replay recorded fixtures and need
# no API key.
OPENAI_API_KEY=
```

- [ ] **Step 5: Write the server `README.md` (the tour)**

Create `examples/research/server/README.md`:

```markdown
# Research demo — server

The flagship [Dawn](https://github.com/cacheplane/dawn) example: a deep-research
assistant that plans sub-questions, researches a bundled local corpus with a
specialist subagent, and writes a cited report. It runs **offline and
deterministically** out of the box, and against a real model when you opt in.

> This is Slice 1 (the server). A polished web UI with a no-key demo mode lands
> in a later slice; today you exercise the app through its tests, `dawn run`, and
> `dawn dev`.

## Run it

```bash
pnpm install                 # from the repo root
pnpm --filter @dawn-example/research-server check   # generate route + tool types
pnpm --filter @dawn-example/research-server test    # harness tests, offline (replay fixtures)
pnpm --filter @dawn-example/research-server eval     # quality evals, offline (replay fixtures)
pnpm --filter @dawn-example/research-server memory:list
```

To run against a real model, set `OPENAI_API_KEY` and add `--live`
(e.g. `pnpm --filter @dawn-example/research-server eval -- --live`). The offline
path uses recorded fixtures, so tests and evals are deterministic and need no
API key.

To dogfood the Docker sandbox, start Docker and run:

```bash
pnpm --filter @dawn-example/research-server test:sandbox:docker
```

The normal test path uses the local `workspace/` so the bundled corpus works
immediately. The Docker sandbox path creates an isolated per-thread workspace;
the sandbox test seeds a corpus document there before running the same tools.

## The tour — where each capability lives

| Capability | File | What it shows |
|---|---|---|
| Agent route | `src/app/research/index.ts` | the research coordinator |
| Tools + typegen | `src/tools/` | shared `searchCorpus`, `readDoc`; `dawn check` types them |
| Subagents | `src/app/research/subagents/researcher/` | dispatched via `task({ subagent, input })` |
| Planning | `src/app/research/plan.md` | seeded checklist becomes the thread's todos |
| Offloading | `dawn.config.ts` + a large `readDoc` | big results spill to the workspace, stubbed in-context |
| Memory | `workspace/AGENTS.md`, `memory.md`, `memory.ts` | prompt memory plus typed `recall`/`remember` |
| Skills | `src/app/research/skills/` | `cite-sources`, `synthesize-findings` |
| HITL permissions | `dawn.config.ts` + `workspace/scripts/fetch-source.mjs` | the external fetch pauses for approval |
| Workspace | `workspace/` | corpus + report output behind a path-jail |
| Docker sandbox | `dawn.config.ts`, `test/sandbox-docker.test.ts` | opt-in isolated workspace via `@dawn-ai/sandbox` |
| Persistence | (default) | threads survive a restart (SQLite) |
| Tests | `test/research.test.ts` | `createAgentHarness` + `script()` |
| Evals | `src/app/research/evals/` | `defineEval` + scorers + a gate |

## Memory review

This app uses candidate memory writes. When the agent calls `remember`, the
memory is saved for review instead of becoming active immediately.

```bash
pnpm --filter @dawn-example/research-server memory:list
pnpm --filter @dawn-example/research-server memory:approve -- <memory-id>
```

The tests show both paths: seeding an active memory with `seedMemory`, and
writing a reviewable candidate through the real `remember` tool.
```

- [ ] **Step 6: Write the example root `package.json` and `README.md`**

Create `examples/research/package.json` (a non-member convenience holder — the `examples/*/*` workspace glob makes `server` the package, not this file; web scripts arrive in Slice 2):

```json
{
  "name": "@dawn-example/research",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "pnpm --filter ./server dev",
    "build": "pnpm --filter ./server build",
    "typecheck": "pnpm --filter ./server typecheck",
    "test": "pnpm --filter ./server test"
  }
}
```

Create `examples/research/README.md`:

```markdown
# Research demo

The flagship Dawn example — a deep-research assistant. See
[`server/README.md`](./server/README.md) for the full tour and how to run it.

- `server/` — the Dawn app (this slice): routes, tools, subagents, memory,
  planning, offloading, HITL permissions, optional Docker sandbox, tests, evals.
- `web/` — a Next.js UI with a no-API-key demo mode (added in a later slice).
```

- [ ] **Step 7: Install so pnpm links the new workspace package**

Run: `pnpm install`
Expected: completes without error; `examples/research/server` is now a linked workspace package (its `node_modules` contains symlinks to `@dawn-ai/*`).

- [ ] **Step 8: Typecheck the new package**

Run: `pnpm --filter @dawn-example/research-server typecheck`
Expected: `tsc -p . --noEmit` exits 0 with no errors. (The generated `.dawn/dawn.generated.d.ts` is absent; TypeScript treats the missing `include` entry as an empty glob, and no source references generated ambient types — the same reason `examples/chat/server` typechecks without it.)

- [ ] **Step 9: Build the new package**

Run: `pnpm --filter @dawn-example/research-server build`
Expected: `dawn build` compiles the routes and exits 0 (same build command `examples/chat/server` uses).

- [ ] **Step 10: Commit**

```bash
git add examples/research vitest.workspace.ts 2>/dev/null; git add examples/research pnpm-lock.yaml
git commit -m "feat(examples): scaffold research demo server (promote app-research template)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Deterministic capability suite runs green offline

The suite was copied in Task 1 (`test/research.test.ts`). It is the acceptance test for the promoted app — it exercises corpus search + citation, the `researcher` subagent, memory candidate → CLI-approve → fresh-thread recall, planning, tool-output offloading, and the HITL permission interrupt/resume. Because the app code is a promotion of a known-good template, this task **runs** the suite to confirm the behavior survives promotion, rather than writing new tests first.

**Files:**
- Test: `examples/research/server/test/research.test.ts` (already present)

- [ ] **Step 1: Run the offline suite (no API key)**

Run: `pnpm --filter @dawn-example/research-server test`
Expected: `research.test.ts` reports **7 passed**; `sandbox-docker.test.ts` reports **1 skipped** (Docker gate off). Overall: `Test Files 2 passed`, `Tests 7 passed | 1 skipped`. No network/API key required (all model calls resolve against `aimock` fixtures).

- [ ] **Step 2: Confirm determinism (re-run)**

Run: `pnpm --filter @dawn-example/research-server test`
Expected: identical result — 7 passed, 1 skipped. If any test flakes, stop and debug (do not proceed): most likely a stale `.dawn/memory.sqlite`; the suite's `cleanMemoryDb()` in `beforeAll`/`afterAll` should handle it, but a crashed prior run can leave `-wal`/`-shm` files — remove `examples/research/server/.dawn/memory.sqlite*` and re-run.

- [ ] **Step 3: Commit (no code change; record the green gate)**

No file changes are expected in this task. If the run required removing a stale `.dawn` artifact, nothing to commit (it is gitignored). Skip the commit if `git status` is clean.

---

## Task 3: Gated Docker sandbox test + eval — present, typechecked, skip-clean

**Files:**
- Test: `examples/research/server/test/sandbox-docker.test.ts` (already present)
- Eval: `examples/research/server/src/app/research/evals/research-quality.eval.ts` (already present)

- [ ] **Step 1: Confirm the sandbox test skips cleanly without Docker**

Run: `pnpm --filter @dawn-example/research-server test`
Expected: `sandbox-docker.test.ts` shows its single case **skipped** (guarded by `it.skipIf(!enabled)` where `enabled = process.env.DAWN_DEMO_DOCKER_SANDBOX === "1"`). No Docker daemon is contacted.

- [ ] **Step 2 (optional, only if Docker is available): Run the sandbox path**

Run: `pnpm --filter @dawn-example/research-server test:sandbox:docker`
Expected (Docker running): the sandbox case passes — shared corpus tools run against an isolated `node:22-slim` per-thread workspace, the sandbox-only report is NOT written to the host (`workspace/reports/sandbox-only.md` absent), and a fresh thread cannot read the prior thread's sandbox file. If Docker is not installed, skip this step — it is explicitly optional and not part of the CI gate.

- [ ] **Step 3: Confirm the eval typechecks (it is compiled but not executed in CI)**

Run: `pnpm --filter @dawn-example/research-server typecheck`
Expected: exits 0. The eval file lives under `src/**/*.ts` and is type-checked; it is executed only via `pnpm ... eval` (Task 5), not during `pnpm test`.

- [ ] **Step 4: Commit (only if anything changed)**

No file changes are expected here (both files were added in Task 1). If `git status` is clean, skip. Otherwise:

```bash
git add examples/research/server
git commit -m "test(examples): verify research demo sandbox gate + eval typecheck

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the demo into the monorepo CI gate

Register the package's test project in the root vitest workspace (turbo already covers `build`/`typecheck`/`lint` for every workspace package, so no turbo config change is needed — the same way `examples/chat/server` is handled).

**Files:**
- Modify: `vitest.workspace.ts`

- [ ] **Step 1: Add the research server test project**

In `vitest.workspace.ts`, add the research project immediately after the chat entry. The `projects` array currently ends with:

```ts
    "./examples/chat/server/vitest.config.ts",
  ],
```

Change it to:

```ts
    "./examples/chat/server/vitest.config.ts",
    "./examples/research/server/vitest.config.ts",
  ],
```

- [ ] **Step 2: Confirm the root vitest workspace picks up the new project**

Run: `pnpm exec vitest --run --config vitest.workspace.ts examples/research/server/test/research.test.ts`
Expected: vitest resolves the `@dawn-example/research-server` project and runs `research.test.ts` → **7 passed**. This proves the project is registered under the workspace config that `pnpm test` uses.

- [ ] **Step 3: Confirm turbo builds and typechecks the package in the graph**

Run: `pnpm exec turbo run typecheck build --filter=@dawn-example/research-server`
Expected: both tasks succeed for `@dawn-example/research-server` (turbo discovers it as a workspace package with `typecheck` and `build` scripts).

- [ ] **Step 4: Commit**

```bash
git add vitest.workspace.ts
git commit -m "test(examples): run research demo server in the root vitest workspace

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Local runtime verification + final green gate

Prove the app is genuinely runnable (typegen + a live/optional run), then confirm the broader CI-relevant gates pass locally.

**Files:** none created; verification + optional docs touch-ups only.

- [ ] **Step 1: Generate route + tool types**

Run: `pnpm --filter @dawn-example/research-server check`
Expected: `dawn check` writes `examples/research/server/.dawn/dawn.generated.d.ts` and exits 0. Confirm the file exists and is gitignored:

Run: `git status --porcelain examples/research/server/.dawn`
Expected: empty output (the `.dawn/` directory is ignored by the copied `.gitignore`).

- [ ] **Step 2: Offline eval replay**

Run: `pnpm --filter @dawn-example/research-server eval`
Expected: `dawn eval` runs the `research quality` dataset against recorded fixtures and the gate passes (`gate.all(gate.passRate(1), gate.perScorer())`) with no API key. If the runner requires an explicit offline flag in this repo's CLI version, consult `pnpm --filter @dawn-example/research-server exec dawn eval --help` and use the offline/replay form; do not add `--live`.

- [ ] **Step 3 (optional, needs `OPENAI_API_KEY`): a live smoke run**

Run:
```bash
cp examples/research/server/.env.example examples/research/server/.env   # then set OPENAI_API_KEY
echo '{"input":"What are common agent architectures?"}' | \
  pnpm --filter @dawn-example/research-server exec dawn run /research#agent
```
Expected (with a key): the coordinator plans, searches the corpus, and returns a cited answer containing `[corpus/…]`. This step is optional and never part of the CI gate.

- [ ] **Step 4: Final local gate mirroring CI**

Run each and confirm success:
```bash
pnpm --filter @dawn-example/research-server typecheck
pnpm --filter @dawn-example/research-server build
pnpm exec vitest --run --config vitest.workspace.ts examples/research/server/test/research.test.ts
```
Expected: all exit 0; the vitest run reports 7 passed. (A full `pnpm typecheck`/`pnpm build`/`pnpm test` at the repo root is the ultimate gate but is heavy; run it once before opening the PR.)

- [ ] **Step 5: Commit any docs touch-ups**

If Steps 1–4 surfaced a README correction (e.g. an eval flag name), fix it inline and:

```bash
git add examples/research
git commit -m "docs(examples): correct research demo run instructions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Otherwise skip — `git status` should be clean.

---

## Self-Review

**Spec coverage (against `2026-07-06-research-demo-design.md`):**
- Standalone `examples/research` server mirroring `examples/chat` → Tasks 1–4. ✓
- Concepts dogfooded (coordinator+subagent, tools+offloading, memory candidate/approve/recall, planning, skills, HITL, sandbox, workspace, evals, tests) → all present via the promoted template; exercised by Task 2 and the eval. ✓
- Deterministic by default, live gated → offline `aimock` fixtures (Task 2), `.env.example` + `--live` opt-in, `dawn run` optional (Task 5). ✓
- Docker sandbox explicit but optional → env-gated test, skips without Docker (Task 3). ✓
- Local runtime verification + harness/test strategy → Tasks 4–5; wired into root vitest workspace + turbo. ✓
- Blueprint/docs extraction end state → deferred to Slice 4 by design; the server README tour table already maps capability→file, which is the raw material for extraction. ✓ (no Slice-1 task needed)
- Do NOT bloat/modify the default scaffold → this slice creates only `examples/research/*` and one line in `vitest.workspace.ts`; the template is untouched. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every created file has concrete content or an exact `cp` source; every command has an expected result. ✓

**Type/name consistency:** package name `@dawn-example/research-server` used consistently in all `--filter` commands and the root `package.json`; test project path `./examples/research/server/vitest.config.ts` matches the created config; scripts (`check`/`build`/`typecheck`/`test`/`eval`/`memory:list`/`memory:approve`/`test:sandbox:docker`) match those referenced in the README and verification steps. ✓

**Known assumption to verify during execution (Task 5, Step 2):** the exact offline invocation for `dawn eval` in this CLI version. The fixtures are inline in the eval, so replay should be the default with no key; the step tells the executor to confirm via `--help` rather than guessing a flag.
