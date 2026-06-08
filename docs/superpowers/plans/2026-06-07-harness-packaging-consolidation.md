# Harness-packaging Consolidation + `@dawn-ai/evals` Scaffold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5 copy-pasted `rewriteDependenciesToTarballs` functions + 9 inline `packageNames` lists across the generated-app harness lanes with one shared, data-driven helper, then add `@dawn-ai/evals` to the `create-dawn-app` scaffold template.

**Architecture:** A new `test/harness/scaffold-packaging.ts` exports `SCAFFOLD_PACKAGES` (the canonical workspace-package set to pack) and `rewriteGeneratedAppDependencies` (data-driven: swap any dep present in the packed-tarball map, set `pnpm.overrides` for every packed `SCAFFOLD_PACKAGES` entry, apply per-lane `extraDependencies`/`removeDependencies`). Each lane migrates to it (behavior-preserving — the existing harness lanes are the regression test). Then `@dawn-ai/evals` is added to `SCAFFOLD_PACKAGES` + the template + the `create-dawn-app`/devkit specifier threading.

**Tech Stack:** TypeScript (ESM, `node:` builtins), vitest, pnpm pack/install, the generated-app harness (`test/harness/packaged-app.ts`, `test/generated`, `test/runtime`, `test/smoke`), changesets.

**Spec:** `docs/superpowers/specs/2026-06-07-harness-packaging-consolidation-design.md`

**CRITICAL invariant for the migration tasks (T2–T6):** they are **behavior-preserving**. The proof is that each lane's harness run stays green on a COLD build. A purely visual diff is NOT enough — getting the forced-deps/overrides wrong silently breaks cold installs (the exact 404 trap we're removing). Every migration task MUST run its harness lane to completion. Lanes: `pnpm verify:harness:framework` (covers `test/generated/*`), `pnpm verify:harness:runtime` (covers `test/runtime/*`), `pnpm verify:harness:smoke` (covers `test/smoke/*`). NOTE: on macOS the runtime-contract lane shows false `/private/tmp` failures that pass on CI Linux — if the ONLY failures are `/private/tmp` path-equality, treat the lane as green (the `normalizePrivatePath` helper handles them in the assertion code; a residual is environmental).

---

## Current-state reference (read before starting)

Each lane currently has, inline, a `packageNames` array and a local `rewriteDependenciesToTarballs({ appRoot, tarballs })`. Their differences (confirmed against the code) — the only things that vary:

| Lane file | forced extra direct deps | deletes | tarball key style |
|---|---|---|---|
| `test/generated/run-generated-app.test.ts` | none | none | named `PackedTarballs` (`tarballs.cli`) |
| `test/generated/harness.ts` | none | none | named `PackedTarballs` |
| `test/runtime/run-runtime-contract.test.ts` | `@dawn-ai/permissions`, `@dawn-ai/sqlite-storage`, `@dawn-ai/workspace` | `langchain`, `@langchain/openai` | string `tarballs["@dawn-ai/cli"]` |
| `test/runtime/run-agent-protocol.test.ts` (×4 packageNames) | `@dawn-ai/permissions`, `@dawn-ai/sqlite-storage`, `@dawn-ai/workspace`, `@langchain/langgraph: "1.3.0"` | `langchain`, `@langchain/openai` | string |
| `test/smoke/run-smoke.test.ts` | `@dawn-ai/permissions`, `@dawn-ai/sqlite-storage`, `@dawn-ai/workspace` | `langchain`, `@langchain/openai` | string |

All five set `pnpm.overrides` to the same 10 `@dawn-ai/*` packages. The two generated-app lanes keep direct deps = the template's (`cli`/`core`/`langchain`/`sdk` + devDeps `config-typescript`/`testing`); the runtime/smoke lanes additionally force `permissions`/`sqlite-storage`/`workspace` as direct deps (their custom routes import them). **The forced-extra list does NOT grow when a scaffold dep is added unless that dep is a direct import in those custom runtime routes — `@dawn-ai/evals` is not, so adding it touches none of these per-lane options.**

`test/harness/packaged-app.ts` `createPackagedInstaller({ packageNames })` already prepends `@dawn-ai/devkit` + `create-dawn-ai-app`, dedupes, packs each, returns `{ installerDir, tarballs: Record<string,string> }`.

---

## Task 1: Shared `scaffold-packaging` helper

**Files:**
- Create: `test/harness/scaffold-packaging.ts`
- Test: `test/harness/scaffold-packaging.test.ts`

> Note: `SCAFFOLD_PACKAGES` here is the CURRENT set (no `@dawn-ai/evals` yet) so T1–T6 are a pure behavior-preserving refactor. `@dawn-ai/evals` is added in Task 7.

- [ ] **Step 1: Write the failing test `test/harness/scaffold-packaging.test.ts`**

```typescript
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { rewriteGeneratedAppDependencies, SCAFFOLD_PACKAGES } from "./scaffold-packaging.js"

async function makePkg(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scaffold-pkg-"))
  await writeFile(join(dir, "package.json"), JSON.stringify(contents), "utf8")
  return dir
}
async function readPkg(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
}

const tarballs = {
  "@dawn-ai/cli": "/packs/cli.tgz",
  "@dawn-ai/core": "/packs/core.tgz",
  "@dawn-ai/permissions": "/packs/permissions.tgz",
  "@dawn-ai/sqlite-storage": "/packs/sqlite.tgz",
  "@dawn-ai/workspace": "/packs/workspace.tgz",
  "@dawn-ai/config-typescript": "/packs/config-ts.tgz",
  "@dawn-ai/devkit": "/packs/devkit.tgz", // present in tarballs but NOT in overrides
  "create-dawn-ai-app": "/packs/create.tgz",
}

describe("SCAFFOLD_PACKAGES", () => {
  it("lists @dawn-ai workspace packages, excluding devkit/create-dawn-ai-app", () => {
    expect(SCAFFOLD_PACKAGES).toContain("@dawn-ai/cli")
    expect(SCAFFOLD_PACKAGES).toContain("@dawn-ai/testing")
    expect(SCAFFOLD_PACKAGES).not.toContain("@dawn-ai/devkit")
    expect(SCAFFOLD_PACKAGES).not.toContain("create-dawn-ai-app")
  })
})

describe("rewriteGeneratedAppDependencies", () => {
  it("swaps existing deps/devDeps that are in the tarball map, leaves unknown deps untouched", async () => {
    const dir = await makePkg({
      dependencies: { "@dawn-ai/cli": "next", "@dawn-ai/core": "next", zod: "^3.24.0" },
      devDependencies: { "@dawn-ai/config-typescript": "next", vitest: "4.1.4" },
    })
    await rewriteGeneratedAppDependencies({ appRoot: dir, tarballs })
    const pkg = await readPkg(dir)
    expect(pkg.dependencies["@dawn-ai/cli"]).toBe("/packs/cli.tgz")
    expect(pkg.dependencies["@dawn-ai/core"]).toBe("/packs/core.tgz")
    expect(pkg.dependencies.zod).toBe("^3.24.0")
    expect(pkg.devDependencies["@dawn-ai/config-typescript"]).toBe("/packs/config-ts.tgz")
    expect(pkg.devDependencies.vitest).toBe("4.1.4")
  })

  it("sets pnpm.overrides for every packed SCAFFOLD package (not devkit/create-app)", async () => {
    const dir = await makePkg({ dependencies: { "@dawn-ai/cli": "next" } })
    await rewriteGeneratedAppDependencies({ appRoot: dir, tarballs })
    const pkg = await readPkg(dir)
    expect(pkg.pnpm.overrides["@dawn-ai/cli"]).toBe("/packs/cli.tgz")
    expect(pkg.pnpm.overrides["@dawn-ai/permissions"]).toBe("/packs/permissions.tgz")
    expect(pkg.pnpm.overrides["@dawn-ai/devkit"]).toBeUndefined()
    expect(pkg.pnpm.overrides["create-dawn-ai-app"]).toBeUndefined()
  })

  it("applies extraDependencies (forced direct deps + version strings) and removeDependencies", async () => {
    const dir = await makePkg({
      dependencies: { "@dawn-ai/cli": "next", langchain: "0.3.0", "@langchain/openai": "0.3.0" },
    })
    await rewriteGeneratedAppDependencies({
      appRoot: dir,
      tarballs,
      extraDependencies: {
        "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"],
        "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"],
        "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"],
        "@langchain/langgraph": "1.3.0",
      },
      removeDependencies: ["langchain", "@langchain/openai"],
    })
    const pkg = await readPkg(dir)
    expect(pkg.dependencies.langchain).toBeUndefined()
    expect(pkg.dependencies["@langchain/openai"]).toBeUndefined()
    expect(pkg.dependencies["@dawn-ai/permissions"]).toBe("/packs/permissions.tgz")
    expect(pkg.dependencies["@langchain/langgraph"]).toBe("1.3.0")
  })
})
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run ../../test/harness/scaffold-packaging.test.ts` — if that path resolution is awkward, run from repo root: `pnpm exec vitest --run test/harness/scaffold-packaging.test.ts --config vitest.workspace.ts` is NOT valid; instead the harness tests run via the lane scripts. Simplest: `npx vitest run test/harness/scaffold-packaging.test.ts` from repo root.
Expected: FAIL (cannot find `./scaffold-packaging.js`).

- [ ] **Step 3: Write `test/harness/scaffold-packaging.ts`**

```typescript
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Canonical set of @dawn-ai/* workspace packages a generated app may depend on.
 * createPackagedInstaller additionally packs @dawn-ai/devkit + create-dawn-ai-app,
 * which are deliberately NOT in this list (they are never generated-app overrides).
 */
export const SCAFFOLD_PACKAGES: readonly string[] = [
  "@dawn-ai/cli",
  "@dawn-ai/config-typescript",
  "@dawn-ai/core",
  "@dawn-ai/langchain",
  "@dawn-ai/langgraph",
  "@dawn-ai/permissions",
  "@dawn-ai/sdk",
  "@dawn-ai/sqlite-storage",
  "@dawn-ai/testing",
  "@dawn-ai/workspace",
]

export interface RewriteGeneratedAppDepsOptions {
  readonly appRoot: string
  readonly tarballs: Readonly<Record<string, string>>
  /** Forced deps to add (tarball paths for @dawn pkgs, or version strings e.g. @langchain/langgraph). */
  readonly extraDependencies?: Readonly<Record<string, string>>
  /** Dep keys to delete from deps+devDeps before rewriting (e.g. langchain, @langchain/openai). */
  readonly removeDependencies?: readonly string[]
}

interface MutablePackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  pnpm?: { overrides?: Record<string, string> }
}

export async function rewriteGeneratedAppDependencies(
  options: RewriteGeneratedAppDepsOptions,
): Promise<void> {
  const packageJsonPath = join(options.appRoot, "package.json")
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as MutablePackageJson

  for (const key of options.removeDependencies ?? []) {
    if (pkg.dependencies) delete pkg.dependencies[key]
    if (pkg.devDependencies) delete pkg.devDependencies[key]
  }

  const swap = (deps: Record<string, string> | undefined): void => {
    if (!deps) return
    for (const name of Object.keys(deps)) {
      const tarball = options.tarballs[name]
      if (tarball) deps[name] = tarball
    }
  }
  swap(pkg.dependencies)
  swap(pkg.devDependencies)

  if (options.extraDependencies) {
    pkg.dependencies = { ...pkg.dependencies, ...options.extraDependencies }
  }

  // pnpm.overrides pins EVERY packed SCAFFOLD package (direct + transitive) to its
  // tarball — this is what makes a cold install resolve offline. Data-driven: adding
  // a package to SCAFFOLD_PACKAGES propagates here automatically.
  const overrides: Record<string, string> = { ...(pkg.pnpm?.overrides ?? {}) }
  for (const name of SCAFFOLD_PACKAGES) {
    const tarball = options.tarballs[name]
    if (tarball) overrides[name] = tarball
  }
  pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides }

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
}
```

- [ ] **Step 4: Run it (passes)**

Run: `npx vitest run test/harness/scaffold-packaging.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add test/harness/scaffold-packaging.ts test/harness/scaffold-packaging.test.ts
git commit -m "test(harness): shared data-driven scaffold-packaging helper"
```

---

## Task 2: Migrate the smoke lane

**Files:**
- Modify: `test/smoke/run-smoke.test.ts`

- [ ] **Step 1: Read the current file.** Locate the inline `packageNames: [ ...10 @dawn pkgs ]` and the local `async function rewriteDependenciesToTarballs(...)`.

- [ ] **Step 2: Replace the packageNames + rewrite usage.**
  - Add import: `import { rewriteGeneratedAppDependencies, SCAFFOLD_PACKAGES } from "../harness/scaffold-packaging.js"`.
  - Replace the inline `packageNames: [ ... ]` with `packageNames: [...SCAFFOLD_PACKAGES]`.
  - Replace the call site `await rewriteDependenciesToTarballs({ appRoot, tarballs })` with:
    ```typescript
    await rewriteGeneratedAppDependencies({
      appRoot,
      tarballs,
      extraDependencies: {
        "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
        "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
        "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
      },
      removeDependencies: ["langchain", "@langchain/openai"],
    })
    ```
  - Delete the local `async function rewriteDependenciesToTarballs` definition.

- [ ] **Step 3: Run the smoke lane (cold, must stay green).**

Run: `pnpm verify:harness:smoke 2>&1 | grep -E "passed=|failed:|status:"`
Expected: `status: passed`, `passed=1 failed=0`. (If failures appear, the forced-deps/overrides set drifted — compare the generated app's `package.json` under the preserved artifact dir against the pre-migration shape.)

- [ ] **Step 4: Lint.** Run: `pnpm --filter @dawn-example/chat-server exec biome check --config-path ../../../packages/config-biome/biome.json test/smoke/run-smoke.test.ts` is wrong path; instead from repo root: `npx biome check --config-path packages/config-biome/biome.json test/smoke/run-smoke.test.ts`. Fix any issues.

- [ ] **Step 5: Commit**

```bash
git add test/smoke/run-smoke.test.ts
git commit -m "test(smoke): use shared scaffold-packaging helper"
```

---

## Task 3: Migrate the runtime-contract lane

**Files:**
- Modify: `test/runtime/run-runtime-contract.test.ts`

- [ ] **Step 1: Read the current file** — find the `packageNames` list and local `rewriteDependenciesToTarballs`.

- [ ] **Step 2: Replace** (same shape as Task 2, but this lane forces the same three extra deps and the same deletes):
  - Add import: `import { rewriteGeneratedAppDependencies, SCAFFOLD_PACKAGES } from "../harness/scaffold-packaging.js"`.
  - `packageNames: [...SCAFFOLD_PACKAGES]`.
  - Call site →
    ```typescript
    await rewriteGeneratedAppDependencies({
      appRoot,
      tarballs,
      extraDependencies: {
        "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
        "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
        "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
      },
      removeDependencies: ["langchain", "@langchain/openai"],
    })
    ```
  - Delete the local `rewriteDependenciesToTarballs`.

- [ ] **Step 3: Run the runtime lane.**

Run: `pnpm verify:harness:runtime 2>&1 | grep -E "passed=|failed:|status:"`
Expected: `status: passed`. (macOS caveat: if the only failures are `/private/tmp` path-equality in run-runtime-contract, that's the known environmental issue — confirm by checking the failure messages are all `/private/tmp` vs `/tmp`.)

- [ ] **Step 4: Lint** `npx biome check --config-path packages/config-biome/biome.json test/runtime/run-runtime-contract.test.ts` — fix issues.

- [ ] **Step 5: Commit**

```bash
git add test/runtime/run-runtime-contract.test.ts
git commit -m "test(runtime-contract): use shared scaffold-packaging helper"
```

---

## Task 4: Migrate the agent-protocol lane (4 packageNames lists)

**Files:**
- Modify: `test/runtime/run-agent-protocol.test.ts`

- [ ] **Step 1: Read the current file** — it has **four** inline `packageNames` lists and one local `rewriteDependenciesToTarballs` that additionally adds `@langchain/langgraph: "1.3.0"`.

- [ ] **Step 2: Replace.**
  - Add import: `import { rewriteGeneratedAppDependencies, SCAFFOLD_PACKAGES } from "../harness/scaffold-packaging.js"`.
  - Replace **all four** `packageNames: [ ... ]` with `packageNames: [...SCAFFOLD_PACKAGES]`.
  - Replace each `await rewriteDependenciesToTarballs({ appRoot, tarballs })` call (there may be one shared call or several) with:
    ```typescript
    await rewriteGeneratedAppDependencies({
      appRoot,
      tarballs,
      extraDependencies: {
        "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
        "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
        "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
        "@langchain/langgraph": "1.3.0",
      },
      removeDependencies: ["langchain", "@langchain/openai"],
    })
    ```
  - Delete the local `rewriteDependenciesToTarballs`.

- [ ] **Step 3: Run the runtime lane (covers agent-protocol).**

Run: `pnpm verify:harness:runtime 2>&1 | grep -E "passed=|failed:|status:"`
Expected: `status: passed` (modulo the macOS `/private/tmp` caveat).

- [ ] **Step 4: Lint** `npx biome check --config-path packages/config-biome/biome.json test/runtime/run-agent-protocol.test.ts` — fix issues.

- [ ] **Step 5: Commit**

```bash
git add test/runtime/run-agent-protocol.test.ts
git commit -m "test(agent-protocol): use shared scaffold-packaging helper"
```

---

## Task 5: Migrate `test/generated/harness.ts`

**Files:**
- Modify: `test/generated/harness.ts`

This lane uses the named `PackedTarballs` interface + `toPackedTarballs` mapper. Remove them.

- [ ] **Step 1: Read the current file** — find `interface PackedTarballs`, `function toPackedTarballs`, the inline `packageNames`, and `rewriteDependenciesToTarballs` (no extra/remove for this lane).

- [ ] **Step 2: Replace.**
  - Add import: `import { rewriteGeneratedAppDependencies, SCAFFOLD_PACKAGES } from "../harness/scaffold-packaging.js"`.
  - `packageNames: [...SCAFFOLD_PACKAGES]`.
  - Where the code does `tarballs = toPackedTarballs(packagedInstaller.tarballs)`, change `tarballs` to be the raw `packagedInstaller.tarballs` (`Record<string,string>`) and update its type annotation (the `tarballs` variable type changes from `PackedTarballs` to `Readonly<Record<string,string>>`).
  - Replace the `rewriteDependenciesToTarballs` call with `await rewriteGeneratedAppDependencies({ appRoot, tarballs })` (no extra/remove).
  - Delete `interface PackedTarballs`, `function toPackedTarballs`, and the local `rewriteDependenciesToTarballs`.
  - If `PackedTarballs` is referenced elsewhere in this file (e.g. a `tarballs?: PackedTarballs` field on an options/return type), change those to `Readonly<Record<string, string>>`.

- [ ] **Step 3: Run the framework lane.**

Run: `pnpm verify:harness:framework 2>&1 | grep -E "passed=|failed:|status:"`
Expected: `status: passed`. (The `run-generated-runtime-contract` suite runs through this harness; fixtures must still match.)

- [ ] **Step 4: Lint** `npx biome check --config-path packages/config-biome/biome.json test/generated/harness.ts` — fix issues.

- [ ] **Step 5: Commit**

```bash
git add test/generated/harness.ts
git commit -m "test(generated-harness): use shared scaffold-packaging helper"
```

---

## Task 6: Migrate `run-generated-app.test.ts` (incl. fixture normalizer)

**Files:**
- Modify: `test/generated/run-generated-app.test.ts`

This file has its own `PackedTarballs`/`toPackedTarballs`, a local `rewriteDependenciesToTarballs` (no extra/remove), AND `normalizeForFixture`/`normalizeForInternalFixture` that build `<tarball:@dawn-ai/X>` / `<repo:@dawn-ai/X>` replacement pairs from the named `PackedTarballs` fields. Genericize the normalizers over the tarball map.

- [ ] **Step 1: Read the current file** — find `interface PackedTarballs`, `toPackedTarballs`, `rewriteDependenciesToTarballs`, `normalizeForFixture`, `normalizeForInternalFixture`, `pathToRepoPackageFileSpecifier`.

- [ ] **Step 2: Migrate packing + rewrite.**
  - Add import: `import { rewriteGeneratedAppDependencies, SCAFFOLD_PACKAGES } from "../harness/scaffold-packaging.js"`.
  - `packageNames: [...SCAFFOLD_PACKAGES]`.
  - Change `tarballs` from `PackedTarballs` to the raw `packagedInstaller.tarballs` (`Record<string,string>`); update the variable's type and the `tarballs?: PackedTarballs` field on the scenario options/result types to `Readonly<Record<string, string>>`.
  - Replace `rewriteDependenciesToTarballs({ appRoot, tarballs })` with `await rewriteGeneratedAppDependencies({ appRoot, tarballs })`.
  - Delete `interface PackedTarballs`, `toPackedTarballs`, and local `rewriteDependenciesToTarballs`.

- [ ] **Step 3: Genericize `normalizeForFixture`.** It currently has hardcoded pairs like `[context.tarballs.cli, "<tarball:@dawn-ai/cli>"]`. Replace those hardcoded `@dawn-ai/*` + `create-dawn-ai-app`/`@dawn-ai/devkit` tarball pairs with a generated list over the tarball map. Keep the existing non-tarball replacements (`<app-root>`, `<packs-dir>`, `<version:...>`). Concretely, build the replacement array like:

```typescript
const tarballPairs: Array<readonly [string, string]> = Object.entries(context.tarballs).map(
  ([name, tarballPath]) => [tarballPath, `<tarball:${name}>`] as const,
)
```

and spread `...tarballPairs` into the `normalizeValue(value, [ ... ])` array IN PLACE OF the hardcoded `[context.tarballs.cli, "<tarball:@dawn-ai/cli>"]` lines. Keep `[`/private`+dirname, "<packs-dir>"]` and version/app-root pairs. (Order: put `tarballPairs` where the old per-package lines were; the `<packs-dir>` collapse must still run — keep it after, matching current ordering.)

- [ ] **Step 4: Genericize `normalizeForInternalFixture` + `pathToRepoPackageFileSpecifier`.** The internal normalizer maps each repo file: specifier → `<repo:@dawn-ai/X>`. Replace its hardcoded per-package lines with a loop over `SCAFFOLD_PACKAGES`:

```typescript
const repoPairs = SCAFFOLD_PACKAGES.map(
  (name) => [pathToRepoPackageFileSpecifier(name), `<repo:${name}>`] as const,
)
```

spread `...repoPairs` where the hardcoded `[pathToRepoPackageFileSpecifier("@dawn-ai/cli"), "<repo:@dawn-ai/cli>"]` lines were. Change `pathToRepoPackageFileSpecifier`'s parameter type from the explicit string-union to `string`, and its internal `packageDirByName` lookup: replace the hardcoded map with deriving the dir from the name — `resolve(REPO_ROOT, "packages", name.replace("@dawn-ai/", ""))` then `pathToFileURL(...).toString()`. (Confirm against the current body; the package dir for `@dawn-ai/X` is `packages/X`.)

- [ ] **Step 5: Run the framework lane (fixtures must still match — pure refactor).**

Run: `pnpm verify:harness:framework 2>&1 | grep -E "passed=|failed:|status:"`
Expected: `status: passed`. If a fixture mismatch appears, the normalizer genericization changed a placeholder; diff the failing report's normalized output against the expected fixture and align the normalizer (do NOT edit the fixtures in this task — behavior is preserved).

- [ ] **Step 6: Lint** `npx biome check --config-path packages/config-biome/biome.json test/generated/run-generated-app.test.ts` — fix issues.

- [ ] **Step 7: Commit**

```bash
git add test/generated/run-generated-app.test.ts
git commit -m "test(generated-app): use shared scaffold-packaging helper + generic fixture normalizers"
```

---

## Task 7: Thread `@dawn-ai/evals` specifier through create-dawn-app + devkit

**Files:**
- Modify: `test/harness/scaffold-packaging.ts`
- Modify: `packages/create-dawn-app/src/index.ts`
- Modify: `packages/devkit/src/testing/generated-app.ts`

- [ ] **Step 1: Add `@dawn-ai/evals` to `SCAFFOLD_PACKAGES`** in `test/harness/scaffold-packaging.ts` — insert `"@dawn-ai/evals",` in alphabetical position (after `@dawn-ai/core`). Update the `SCAFFOLD_PACKAGES` test in `test/harness/scaffold-packaging.test.ts` to also `expect(SCAFFOLD_PACKAGES).toContain("@dawn-ai/evals")`. Run `npx vitest run test/harness/scaffold-packaging.test.ts` → PASS.

- [ ] **Step 2: Thread `dawnEvalsSpecifier` in `packages/create-dawn-app/src/index.ts`.** Read the file; mirror EXACTLY how `dawnTestingSpecifier` is handled. Add to the `createTemplateReplacements` return type `readonly dawnEvalsSpecifier: string`; in the internal-mode branch add `dawnEvalsSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/evals"))`; in the external-mode branch add `dawnEvalsSpecifier: options.distTag`; and in `applyInternalModePackageOverrides` add `"@dawn-ai/evals": replacements.dawnEvalsSpecifier,`.

- [ ] **Step 3: Thread `dawnEvals` in `packages/devkit/src/testing/generated-app.ts`.** Add `readonly dawnEvals: string` to `GeneratedAppSpecifiers`; add `dawnEvals: specifiers?.dawnEvals ?? "workspace:*"` to `normalizeSpecifiers`; add `dawnEvalsSpecifier: specifiers.dawnEvals` to the `writeTemplate` replacements in `createGeneratedApp`.

- [ ] **Step 4: Build the touched packages.**

Run: `pnpm --filter create-dawn-ai-app --filter @dawn-ai/devkit build`
Expected: success (the new replacement key compiles; `writeTemplate` accepts it once the template uses `{{dawnEvalsSpecifier}}` — added in Task 8, but the replacement object can carry an unused key now).

- [ ] **Step 5: Commit**

```bash
git add test/harness/scaffold-packaging.ts test/harness/scaffold-packaging.test.ts packages/create-dawn-app/src/index.ts packages/devkit/src/testing/generated-app.ts
git commit -m "feat(scaffold): thread @dawn-ai/evals specifier + add to SCAFFOLD_PACKAGES"
```

---

## Task 8: Add the evals sample to the template

**Files:**
- Modify: `packages/devkit/templates/app-basic/package.json.template`
- Create: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/evals/smoke.eval.ts.template`

- [ ] **Step 1: Update `package.json.template`.** Add `"@dawn-ai/evals": "{{dawnEvalsSpecifier}}"` to `devDependencies` (alphabetical, after `@dawn-ai/config-typescript`) and `"eval": "dawn eval"` to `scripts` (after `"check"`).

- [ ] **Step 2: Inspect the existing test sample** `packages/devkit/templates/app-basic/test/agent.test.ts.template` to copy its route key (`/hello/[tenant]#agent`) and the exact reply text its `script()` fixture uses, so the eval's fixture is deterministic against the same route.

- [ ] **Step 3: Create `…/hello/[tenant]/evals/smoke.eval.ts.template`** (use the SAME input + reply as the agent test sample so it passes deterministically — adjust the literals to match what Step 2 found):

```typescript
import { contains, defineEval } from "@dawn-ai/evals"
import { script } from "@dawn-ai/testing"

export default defineEval({
  name: "greets the tenant",
  dataset: [
    {
      name: "hello",
      input: "Say hello",
      fixtures: script().user("Say hello").replies("Hello from Acme!"),
    },
  ],
  scorers: [contains("Hello", { threshold: 1 })],
  threshold: 1,
})
```

- [ ] **Step 4: Sanity-generate locally (internal mode) and run `dawn eval`.**

```bash
pnpm --filter create-dawn-ai-app build
node packages/create-dawn-app/dist/bin.js /tmp/evals-tmpl-check --mode internal
cd /tmp/evals-tmpl-check && pnpm install && pnpm exec dawn eval ; echo "exit=$?" ; cd - ; rm -rf /tmp/evals-tmpl-check
```
Expected: `dawn eval` prints `PASS` and `exit=0`. (If the reply/scorer don't match, align the eval's fixture/scorer to the route's real behavior.)

- [ ] **Step 5: Commit**

```bash
git add "packages/devkit/templates/app-basic/package.json.template" "packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/evals/smoke.eval.ts.template"
git commit -m "feat(scaffold): scaffold a sample @dawn-ai/evals eval in new apps"
```

---

## Task 9: Update scaffold assertions + generated-app fixtures

**Files:**
- Modify: `packages/create-dawn-app/test/create-app.test.ts`
- Modify: `packages/devkit/test/generated-app.test.ts`
- Modify: `test/generated/fixtures/basic.expected.json`
- Modify: `test/generated/fixtures/custom-app-dir.expected.json`

- [ ] **Step 1: Update `create-app.test.ts`.** Read it; mirror the existing `@dawn-ai/testing` / `test/agent.test.ts` assertions. In both the external-mode and internal-mode scenarios add assertions that the generated app: contains `src/app/(public)/hello/[tenant]/evals/smoke.eval.ts` (via the existing `assertExists` helper), has `@dawn-ai/evals` in devDependencies (matching the same `not.toMatch(/^file:/)` / `toBe("next")` pattern used for `@dawn-ai/testing` externally, and the `toMatch(/^file:/)` pattern internally), and `packageJson.scripts.eval === "dawn eval"`.

- [ ] **Step 2: Update devkit `generated-app.test.ts`.** Mirror the `@dawn-ai/testing` assertions: assert the generated `package.json` contains `"@dawn-ai/evals": "workspace:*"`, `"eval": "dawn eval"`, and that `evals/smoke.eval.ts` exists.

- [ ] **Step 3: Regenerate the two fixtures.** The `run-generated-app` snapshots now need the `@dawn-ai/evals` devDep (`<tarball:@dawn-ai/evals>`), the `eval` script, and the `@dawn-ai/evals` override entry. Run the framework lane to get the exact expected diff, then update `basic.expected.json` and `custom-app-dir.expected.json` to match the produced normalized output:

```bash
pnpm verify:harness:framework 2>&1 | grep -E "passed=|failed:|status:"
```
On failure, read the preserved artifact's actual normalized result (the harness prints the artifact path) and update both fixtures' `packageJson` blocks: add `"eval": "dawn eval"` to `scripts`, `"@dawn-ai/evals": "<tarball:@dawn-ai/evals>"` to `devDependencies`, and `"@dawn-ai/evals": "<tarball:@dawn-ai/evals>"` to `pnpm.overrides`. Re-run until `status: passed`.

- [ ] **Step 4: Run the scaffold unit tests + framework lane.**

Run: `pnpm --filter create-dawn-ai-app --filter @dawn-ai/devkit test` → all pass.
Run: `pnpm verify:harness:framework 2>&1 | grep -E "passed=|status:"` → `status: passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/create-dawn-app/test/create-app.test.ts packages/devkit/test/generated-app.test.ts test/generated/fixtures/basic.expected.json test/generated/fixtures/custom-app-dir.expected.json
git commit -m "test(scaffold): assert scaffolded eval + update generated-app fixtures"
```

---

## Task 10: Docs, changeset, full validation

**Files:**
- Modify: `apps/web/content/docs/evals.mdx`
- Create: `.changeset/scaffold-evals.md`

- [ ] **Step 1: Add a scaffold note to `evals.mdx`.** A short section: "your scaffolded app already has an eval" — `create-dawn-ai-app` generates `evals/smoke.eval.ts` + an `eval` script; run `dawn eval`. Mirror the equivalent note in `testing-agents.mdx`. Do NOT use banned phrases (`byte-identical`, "What works locally works in production", etc. — see `scripts/check-docs.mjs`).

- [ ] **Step 2: Write `.changeset/scaffold-evals.md`:**

```markdown
---
"create-dawn-ai-app": minor
"@dawn-ai/devkit": patch
---

`create-dawn-ai-app` now scaffolds a sample `@dawn-ai/evals` eval (`evals/smoke.eval.ts`) plus an `eval` script in new apps, alongside the existing `@dawn-ai/testing` sample test, so a freshly scaffolded app can run `dawn eval` out of the box.
```

- [ ] **Step 3: Full validation.**

```
pnpm install
pnpm lint
pnpm build
pnpm typecheck
pnpm test
node scripts/check-docs.mjs
pnpm verify:harness:framework
pnpm verify:harness:runtime
pnpm verify:harness:smoke
```
Expected: all green (macOS `/private/tmp` caveat applies only to local runtime-contract; CI Linux is clean). Fix anything that breaks.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/evals.mdx .changeset/scaffold-evals.md
git commit -m "docs(scaffold): evals scaffold note + changeset"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** shared helper + SCAFFOLD_PACKAGES + data-driven rewrite (T1); migrate all 5 lanes / 9 lists (T2–T6, incl. the named-PackedTarballs removal in T5/T6 and fixture-normalizer genericization in T6); add evals to SCAFFOLD_PACKAGES + specifier threading (T7); template devDep/script/sample (T8); assertions + fixtures (T9); docs + changeset + full validate across all three harness lanes (T10). Out-of-scope items (template-parsing, dep-agnostic fixtures, new dawn-eval-in-generated-app lane) are honored — none are tasks.

**Placeholder scan:** the migration tasks (T2–T6) intentionally say "read the current file" because they transform existing per-file code into a shared call with EXACTLY specified options (extra/remove deps given verbatim per lane) — the variable part (each lane's options) is fully specified; the surrounding wiring is read, not invented. No TBDs.

**Type consistency:** `rewriteGeneratedAppDependencies({ appRoot, tarballs, extraDependencies?, removeDependencies? })` and `SCAFFOLD_PACKAGES` are defined once (T1) and used identically in T2–T7; `tarballs` becomes `Readonly<Record<string,string>>` everywhere (the named `PackedTarballs` type is deleted in T5/T6); `dawnEvalsSpecifier`/`dawnEvals` mirror the existing `dawnTestingSpecifier`/`dawnTesting` names.
