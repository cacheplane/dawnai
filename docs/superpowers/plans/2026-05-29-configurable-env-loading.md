# Configurable Env Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `dawn dev` and `dawn verify` resolve which `.env` to load via precedence `--env-file` flag > `dawn.config.ts` `env` > default `./.env`, so a monorepo app can load a root-level `.env`.

**Architecture:** Add a `DawnConfig.env` field; introduce a shared `resolveEnvPath` resolver; refactor `loadEnvFile(dir)` → `loadEnvFiles(absPaths)`; wire both `dev-session` and `verify` through the resolver; add a `--env-file` commander option to both commands. Deploy artifact (`deployment-config.ts`) untouched.

**Tech Stack:** TypeScript (ESM, **no semicolons**, double quotes — Biome enforced), `commander` for CLI, Vitest. Tests live in `packages/cli/test/`.

**Spec reference:** `docs/superpowers/specs/2026-05-29-configurable-env-loading-design.md`. Branch: `feat/configurable-env-loading` (off main).

**Conventions to match (verify before editing):**
- No semicolons, double quotes, 2-space indent. Run `pnpm --filter @dawn-ai/cli lint` after changes.
- Tests: `packages/cli/test/*.test.ts`, run via `pnpm --filter @dawn-ai/cli test`.
- Core types: `packages/core/src/types.ts`.

---

## Task 1: Add `DawnConfig.env` field

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add the field**

In `packages/core/src/types.ts`, inside `interface DawnConfig`, add the `env` field after `threadsStore`:

```ts
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  /**
   * Path to the env file loaded for local `dawn dev` / `dawn verify`,
   * relative to the app root. Defaults to "./.env". Does NOT affect the
   * deploy artifact (langgraph.json env is detected separately).
   */
  readonly env?: string
```

- [ ] **Step 2: Typecheck core**

Run: `pnpm --filter @dawn-ai/core build`
Expected: builds clean (the field is optional; no consumers break).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add optional DawnConfig.env field"
```

---

## Task 2: `resolveEnvPath` resolver + tests (TDD)

**Files:**
- Create: `packages/cli/src/lib/dev/resolve-env-path.ts`
- Create: `packages/cli/test/resolve-env-path.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/cli/test/resolve-env-path.test.ts`:

```ts
import { isAbsolute, join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveEnvPath } from "../src/lib/dev/resolve-env-path.js"

const APP = "/work/app"

describe("resolveEnvPath", () => {
  it("defaults to <appRoot>/.env", () => {
    const r = resolveEnvPath({ appRoot: APP })
    expect(r.source).toBe("default")
    expect(r.absPath).toBe(join(APP, ".env"))
  })

  it("uses config.env relative to appRoot", () => {
    const r = resolveEnvPath({ appRoot: APP, configEnv: "../.env" })
    expect(r.source).toBe("config")
    expect(r.absPath).toBe(join(APP, "../.env"))
  })

  it("flag wins over config", () => {
    const r = resolveEnvPath({ appRoot: APP, configEnv: "../.env", flag: "custom.env" })
    expect(r.source).toBe("flag")
    expect(r.absPath).toBe(join(APP, "custom.env"))
  })

  it("absolute flag passes through unchanged", () => {
    const r = resolveEnvPath({ appRoot: APP, flag: "/etc/secrets/.env" })
    expect(r.source).toBe("flag")
    expect(isAbsolute(r.absPath)).toBe(true)
    expect(r.absPath).toBe("/etc/secrets/.env")
  })

  it("absolute config.env passes through unchanged", () => {
    const r = resolveEnvPath({ appRoot: APP, configEnv: "/abs/.env" })
    expect(r.absPath).toBe("/abs/.env")
  })
})
```

- [ ] **Step 2: Run — fail (module not found)**

Run: `pnpm --filter @dawn-ai/cli test -- resolve-env-path`
Expected: FAIL, cannot find `resolve-env-path.js`.

- [ ] **Step 3: Implement resolver**

`packages/cli/src/lib/dev/resolve-env-path.ts`:

```ts
import { isAbsolute, resolve } from "node:path"

export interface ResolveEnvPathOptions {
  readonly appRoot: string
  /** From the --env-file CLI flag. Highest precedence. */
  readonly flag?: string
  /** From dawn.config.ts `env`. */
  readonly configEnv?: string
}

export interface ResolvedEnvPath {
  readonly absPath: string
  readonly source: "flag" | "config" | "default"
}

function toAbs(appRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(appRoot, p)
}

/** Resolve the env file path: flag > config > "<appRoot>/.env". */
export function resolveEnvPath(options: ResolveEnvPathOptions): ResolvedEnvPath {
  if (options.flag !== undefined && options.flag.length > 0) {
    return { absPath: toAbs(options.appRoot, options.flag), source: "flag" }
  }
  if (options.configEnv !== undefined && options.configEnv.length > 0) {
    return { absPath: toAbs(options.appRoot, options.configEnv), source: "config" }
  }
  return { absPath: resolve(options.appRoot, ".env"), source: "default" }
}
```

(Note: tests use `join` while the impl uses `resolve`; for absolute `appRoot` like `/work/app`, `resolve("/work/app", "../.env")` and `join("/work/app", "../.env")` both normalize to `/work/.env`. If a test mismatches due to normalization, switch the test's expectation to use `resolve` — the impl's `resolve` is correct for path semantics.)

- [ ] **Step 4: Run — pass**

Run: `pnpm --filter @dawn-ai/cli test -- resolve-env-path`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/resolve-env-path.ts packages/cli/test/resolve-env-path.test.ts
git commit -m "feat(cli): add resolveEnvPath (flag > config > default)"
```

---

## Task 3: Refactor `loadEnvFile` → `loadEnvFiles` (TDD)

**Files:**
- Modify: `packages/cli/src/lib/dev/load-env.ts`
- Modify: `packages/cli/test/load-env.test.ts`

- [ ] **Step 1: Read the existing test to preserve coverage**

Run: `cat packages/cli/test/load-env.test.ts`
Note the existing cases (they call `loadEnvFile(dir)`); they must keep passing via the back-compat wrapper.

- [ ] **Step 2: Add failing tests for `loadEnvFiles`**

Append to `packages/cli/test/load-env.test.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadEnvFiles } from "../src/lib/dev/load-env.js"

describe("loadEnvFiles", () => {
  let dir: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dawn-loadenvfiles-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
  })

  it("loads from an explicit absolute path", () => {
    const p = join(dir, "custom.env")
    writeFileSync(p, "DAWN_TEST_A=1\n")
    delete process.env.DAWN_TEST_A
    const n = loadEnvFiles([p])
    expect(n).toBeGreaterThanOrEqual(1)
    expect(process.env.DAWN_TEST_A).toBe("1")
  })

  it("does not override an already-set var (shell wins)", () => {
    const p = join(dir, ".env")
    writeFileSync(p, "DAWN_TEST_B=fromfile\n")
    process.env.DAWN_TEST_B = "fromshell"
    loadEnvFiles([p])
    expect(process.env.DAWN_TEST_B).toBe("fromshell")
  })

  it("loads multiple paths in order; first to set a key wins", () => {
    const a = join(dir, "a.env")
    const b = join(dir, "b.env")
    writeFileSync(a, "DAWN_TEST_C=fromA\n")
    writeFileSync(b, "DAWN_TEST_C=fromB\n")
    delete process.env.DAWN_TEST_C
    loadEnvFiles([a, b])
    expect(process.env.DAWN_TEST_C).toBe("fromA")
  })

  it("missing file contributes zero", () => {
    const n = loadEnvFiles([join(dir, "nope.env")])
    expect(n).toBe(0)
  })

  it("auto-enables LANGCHAIN_TRACING_V2 when LANGSMITH_API_KEY present", () => {
    const p = join(dir, ".env")
    writeFileSync(p, "LANGSMITH_API_KEY=ls-xyz\n")
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGCHAIN_TRACING_V2
    loadEnvFiles([p])
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true")
  })
})
```

- [ ] **Step 3: Run — fail (`loadEnvFiles` not exported)**

Run: `pnpm --filter @dawn-ai/cli test -- load-env`
Expected: FAIL on the new `loadEnvFiles` cases; existing `loadEnvFile` cases still referenced.

- [ ] **Step 4: Refactor `load-env.ts`**

Rewrite `packages/cli/src/lib/dev/load-env.ts` so the core parses one file, `loadEnvFiles` iterates, and `loadEnvFile` stays as a back-compat wrapper. The LangSmith auto-trace runs once after all files:

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"

function parseAndApply(absPath: string): number {
  let content: string
  try {
    content = readFileSync(absPath, "utf8")
  } catch {
    return 0
  }

  let loaded = 0
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue
    }
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) {
      continue
    }
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded++
    }
  }
  return loaded
}

function applyLangsmithTracing(): number {
  if (process.env.LANGSMITH_API_KEY && !process.env.LANGCHAIN_TRACING_V2) {
    process.env.LANGCHAIN_TRACING_V2 = "true"
    return 1
  }
  return 0
}

/**
 * Load one or more .env files into process.env, in order.
 * Only sets variables not already defined (shell + earlier files win).
 * Returns the total count of variables set.
 */
export function loadEnvFiles(absPaths: readonly string[]): number {
  let loaded = 0
  for (const p of absPaths) {
    loaded += parseAndApply(p)
  }
  loaded += applyLangsmithTracing()
  return loaded
}

/**
 * Back-compat: load `<dir>/.env`.
 * @deprecated prefer resolveEnvPath + loadEnvFiles.
 */
export function loadEnvFile(dir: string): number {
  return loadEnvFiles([join(dir, ".env")])
}
```

- [ ] **Step 5: Run — pass**

Run: `pnpm --filter @dawn-ai/cli test -- load-env`
Expected: PASS — both existing `loadEnvFile` cases and new `loadEnvFiles` cases.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/load-env.ts packages/cli/test/load-env.test.ts
git commit -m "refactor(cli): loadEnvFile -> loadEnvFiles with back-compat wrapper"
```

---

## Task 4: Wire resolver into `dev-session.ts`

**Files:**
- Modify: `packages/cli/src/lib/dev/dev-session.ts`

- [ ] **Step 1: Read current env-load + discovery ordering**

Run: `sed -n '20,55p' packages/cli/src/lib/dev/dev-session.ts`
Confirm: env loads from `options.cwd` (line ~26) BEFORE `discoverInitialApp` (line ~31). We move it AFTER discovery so `config.env` (which needs `appRoot`) is available.

- [ ] **Step 2: Add `envFile` to the options + reorder env loading**

Update `startDevSession`:
- add `readonly envFile?: string` to the options object type.
- replace the import `import { loadEnvFile } from "./load-env.js"` with `import { loadEnvFiles } from "./load-env.js"` and add `import { resolveEnvPath } from "./resolve-env-path.js"`.
- import config loader: `loadDawnConfig` is already imported from `@dawn-ai/core`.
- remove the pre-discovery `loadEnvFile(options.cwd)` block.
- after `const discoveredApp = await discoverInitialApp(options.cwd)`, add:

```ts
  let configEnv: string | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot: discoveredApp.appRoot })
    configEnv = loaded.config.env
  } catch {
    // No dawn.config.ts (or it failed to load) — fall through to default.
    configEnv = undefined
  }

  const resolved = resolveEnvPath({
    appRoot: discoveredApp.appRoot,
    flag: options.envFile,
    configEnv,
  })
  const envLoaded = loadEnvFiles([resolved.absPath])
  if (envLoaded > 0) {
    writeLine(
      options.io.stdout,
      `Loaded ${envLoaded} variable(s) from ${relative(options.cwd, resolved.absPath) || ".env"}`,
    )
  }
```

(`relative` is already imported from `node:path` at the top of the file.)

- [ ] **Step 3: Typecheck + build cli**

Run: `pnpm --filter @dawn-ai/cli build`
Expected: builds clean.

- [ ] **Step 4: Run the dev-session-affecting tests**

Run: `pnpm --filter @dawn-ai/cli test -- dev`
Expected: existing dev tests still pass (env now loads post-discovery; nothing between depends on env).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/dev-session.ts
git commit -m "feat(cli): dev-session resolves env via flag/config/default"
```

---

## Task 5: Add `--env-file` to `dawn dev` (TDD)

**Files:**
- Modify: `packages/cli/src/commands/dev.ts`
- Modify: `packages/cli/test/dev-command.test.ts`

- [ ] **Step 1: Read the current dev command + its test**

Run: `cat packages/cli/src/commands/dev.ts` and `sed -n '1,40p' packages/cli/test/dev-command.test.ts`
Note how `DevOptions` is shaped and how options thread into `startDevSession` (port is the existing precedent).

- [ ] **Step 2: Write a failing test asserting the flag threads through**

Add to `packages/cli/test/dev-command.test.ts` a case that invokes the command action with `--env-file ./custom.env` and asserts the value reaches `startDevSession` (mirror however the existing test asserts `port`; if it spies/mocks `startDevSession`, assert `envFile: "./custom.env"` is in the passed options). Use the existing test's harness pattern verbatim — do not invent a new mocking style.

Expected after writing: FAIL (option not parsed / not passed).

- [ ] **Step 3: Add the commander option + thread it through**

In `packages/cli/src/commands/dev.ts`:
- add `readonly envFile?: string` to `interface DevOptions`.
- add the option to the command definition: `.option("--env-file <path>", "Path to a .env file (overrides dawn.config.ts env and the default ./.env)")`.
- pass it into `startDevSession({ ..., envFile: options.envFile })`.

- [ ] **Step 4: Run — pass**

Run: `pnpm --filter @dawn-ai/cli test -- dev-command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/dev.ts packages/cli/test/dev-command.test.ts
git commit -m "feat(cli): add --env-file flag to dawn dev"
```

---

## Task 6: Unify `verify` + add `--env-file` (TDD)

**Files:**
- Modify: `packages/cli/src/lib/verify/check-dependencies.ts`
- Modify: `packages/cli/src/commands/` verify command (locate in Step 1)
- Modify: `packages/cli/test/check-dependencies.test.ts`

- [ ] **Step 1: Locate the verify command + read check-dependencies signature**

Run: `grep -rln "check-dependencies\|checkDependencies\|verify" packages/cli/src/commands packages/cli/src/lib/verify | head` and `sed -n '1,75p' packages/cli/src/lib/verify/check-dependencies.ts`
Identify the function signature (it currently takes `appRoot` and reads `<appRoot>/.env`) and how the verify command calls it.

- [ ] **Step 2: Write a failing test**

In `packages/cli/test/check-dependencies.test.ts`, add a case: given a temp app whose recommended var is absent from `<appRoot>/.env` but present in a file pointed to by `configEnv` (or an `envFile` arg), the var is reported satisfied (not missing). Match the existing test's setup helpers.

Expected: FAIL (today it only reads `<appRoot>/.env`).

- [ ] **Step 3: Refactor check-dependencies to use `resolveEnvPath`**

Change the env-var existence check: instead of reading `join(appRoot, ".env")` directly, accept an optional `envFile` param and compute the path via `resolveEnvPath({ appRoot, flag: envFile, configEnv })` (load `configEnv` via `loadDawnConfig` with the same try/catch as dev-session). Read that resolved path for the `${envVar}=` name check. Keep checking `process.env` first (unchanged).

```ts
// signature becomes:
export async function checkDependencies(opts: {
  readonly appRoot: string
  readonly envFile?: string
}): Promise<{ missingPackages: string[]; missingEnvVars: string[] }>
```

(If the current export is a different shape, adapt minimally — keep the return type identical so callers don't break, only thread `envFile` + resolver in.)

- [ ] **Step 4: Add `--env-file` to the verify command**

Add the same `.option("--env-file <path>", ...)` to the verify command and pass `envFile` into `checkDependencies`.

- [ ] **Step 5: Run — pass**

Run: `pnpm --filter @dawn-ai/cli test -- check-dependencies`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/verify/check-dependencies.ts packages/cli/src/commands packages/cli/test/check-dependencies.test.ts
git commit -m "feat(cli): verify uses shared env resolver + --env-file"
```

---

## Task 7: Integration test — monorepo env loading

**Files:**
- Create: `packages/cli/test/env-loading-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Exercise the resolver + loader against a temp monorepo layout (no full `dawn dev` server needed — test the resolve+load seam directly, which is what the wiring uses):

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveEnvPath } from "../src/lib/dev/resolve-env-path.js"
import { loadEnvFiles } from "../src/lib/dev/load-env.js"

describe("env loading (monorepo integration)", () => {
  let root: string
  const saved = { ...process.env }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-env-int-"))
    mkdirSync(join(root, "app"), { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  })

  it("config.env '../.env' loads the workspace-root .env from a nested app", () => {
    writeFileSync(join(root, ".env"), "DAWN_ROOT_VAR=root\n")
    delete process.env.DAWN_ROOT_VAR
    const appRoot = join(root, "app")
    const r = resolveEnvPath({ appRoot, configEnv: "../.env" })
    expect(r.source).toBe("config")
    loadEnvFiles([r.absPath])
    expect(process.env.DAWN_ROOT_VAR).toBe("root")
  })

  it("--env-file overrides config.env", () => {
    writeFileSync(join(root, ".env"), "DAWN_PICK=root\n")
    writeFileSync(join(root, "app", "custom.env"), "DAWN_PICK=custom\n")
    delete process.env.DAWN_PICK
    const appRoot = join(root, "app")
    const r = resolveEnvPath({ appRoot, configEnv: "../.env", flag: "custom.env" })
    loadEnvFiles([r.absPath])
    expect(process.env.DAWN_PICK).toBe("custom")
  })

  it("regression: plain app/.env with no config/flag still loads", () => {
    writeFileSync(join(root, "app", ".env"), "DAWN_LOCAL=local\n")
    delete process.env.DAWN_LOCAL
    const appRoot = join(root, "app")
    const r = resolveEnvPath({ appRoot })
    expect(r.source).toBe("default")
    loadEnvFiles([r.absPath])
    expect(process.env.DAWN_LOCAL).toBe("local")
  })
})
```

- [ ] **Step 2: Run — pass**

Run: `pnpm --filter @dawn-ai/cli test -- env-loading-integration`
Expected: PASS, 3 tests.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/env-loading-integration.test.ts
git commit -m "test(cli): monorepo env-loading integration"
```

---

## Task 8: Full verify + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Lint**

Run: `pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/core lint`
Expected: clean (no semicolon/quote violations). Fix any Biome findings.

- [ ] **Step 2: Full cli + core test + build**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli test`
Expected: all green.

- [ ] **Step 3: Manual smoke (optional, real)**

```bash
# from a temp app dir with dawn.config.ts `env: "../.env"` and a parent .env
dawn dev
# expect "Loaded N variable(s) from ../.env" in the startup output
```

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/configurable-env-loading
gh pr create --title "feat(cli): configurable env loading (--env-file + dawn.config env)" --body "$(cat <<'EOF'
## Summary
- `dawn dev` / `dawn verify` resolve the `.env` to load via precedence: `--env-file` flag > `dawn.config.ts` `env` > default `./.env`. Shell vars still win over file contents.
- New `DawnConfig.env` field (local-only; does not affect the deploy artifact).
- New `--env-file <path>` flag on `dawn dev` and `dawn verify`.
- `loadEnvFile(dir)` → `loadEnvFiles(absPaths)` (back-compat wrapper kept). Shared `resolveEnvPath`; `dev` and `verify` now agree on which file they read.
- Deploy `langgraph.json` env detection unchanged.

Solves the monorepo case: a nested app sets `env: "../../.env"` and loads the workspace-root `.env`.

Spec: `docs/superpowers/specs/2026-05-29-configurable-env-loading-design.md`
Plan: `docs/superpowers/plans/2026-05-29-configurable-env-loading.md`

## Test plan
- [ ] `pnpm --filter @dawn-ai/cli test` green (resolver, loadEnvFiles, dev-command, check-dependencies, integration)
- [ ] `pnpm --filter @dawn-ai/cli lint` clean
- [ ] manual: `dawn dev` in a nested app with `env: "../.env"` loads the parent file
EOF
)"
```

- [ ] **Step 5: No commit** — PR step.

---

## Self-review

**Spec coverage:**
- ✅ `DawnConfig.env` — Task 1
- ✅ `resolveEnvPath` precedence — Task 2
- ✅ `loadEnvFile` → `loadEnvFiles` + back-compat + LangSmith trace — Task 3
- ✅ dev-session wiring (post-discovery, config load) — Task 4
- ✅ `--env-file` on `dawn dev` — Task 5
- ✅ verify unified via resolver + `--env-file` — Task 6
- ✅ monorepo integration + regression — Task 7
- ✅ deploy untouched — no task modifies `deployment-config.ts` (by design)
- ✅ lint/build/test/PR — Task 8

**Placeholder scan:** Tasks 5 and 6 reference "match the existing test harness/setup" rather than inlining test bodies — intentional, because the exact mocking style of `dev-command.test.ts` / `check-dependencies.test.ts` must be read first (Step 1 of each) and mirrored; inventing a divergent harness would be the bigger error. All non-test code is complete and inlined.

**Type consistency:** `resolveEnvPath(ResolveEnvPathOptions) → ResolvedEnvPath` consistent across Tasks 2, 4, 6, 7. `loadEnvFiles(readonly string[]) → number` consistent across Tasks 3, 4, 7. `DawnConfig.env: string` consistent across Tasks 1, 4, 6. `envFile` option name consistent across Tasks 4, 5, 6.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-configurable-env-loading.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task with two-stage review.

**2. Inline Execution** — Execute tasks in this session with batch checkpoints.

Which approach?
