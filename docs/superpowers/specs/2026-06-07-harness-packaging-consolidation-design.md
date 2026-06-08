# Harness-packaging consolidation + `@dawn-ai/evals` scaffold (Design)

**Status:** Approved for planning
**Date:** 2026-06-07
**Context:** Follows eval-authoring ([PR #202]). Two coupled goals: (1) remove the generated-app harness "packaging trap" that makes adding a scaffold-template dependency error-prone, then (2) add `@dawn-ai/evals` to the `create-dawn-app` template so new apps get an eval out of the box.

## Problem

The generated-app verification lanes simulate a real end-user install: they `pnpm pack` each workspace package to a `.tgz`, then rewrite a generated app's `package.json` so its `@dawn-ai/*` deps point at those tarballs (offline "published" install). Two things are hardcoded per lane:

- **which packages to pack** — a `packageNames` array, and
- **how to rewrite the generated `package.json`** — a `rewriteDependenciesToTarballs` function with a ~20-line hardcoded `@dawn-ai/*` override block (deps + devDeps + `pnpm.overrides`).

This pair is **copy-pasted across 5 files (9 `packageNames` lists total)**: `test/generated/harness.ts`, `test/generated/run-generated-app.test.ts`, `test/runtime/run-agent-protocol.test.ts` (×4 lists), `test/runtime/run-runtime-contract.test.ts`, `test/smoke/run-smoke.test.ts`. Adding one scaffold dep means editing all of them correctly; miss one and **that lane fails silently with a cryptic cold-cache 404** (`ERR_PNPM_NO_MATCHING_VERSION @pkg@next`) or `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. This actually cost three CI cycles during eval-authoring (fix `run-generated-app` → red on `run-runtime-contract` → red on `run-smoke`).

Goal: collapse the duplication so adding a scaffold dependency is a near-template-only change, then add `@dawn-ai/evals`.

**Scope decision (deliberately right-sized, not gold-plated):** consolidate the rewrite + package list into one shared, data-driven helper. **Out of scope** (cut as over-engineering): deriving the package set by parsing `package.json.template` (a shared constant is simpler), and making the `run-generated-app` expected fixtures dep-agnostic (that snapshot fails loudly/obviously; a one-file update when adding a dep is acceptable).

## Verified facts (against current code)

- `test/harness/packaged-app.ts` `createPackagedInstaller({ packageNames })` already prepends `@dawn-ai/devkit` + `create-dawn-ai-app` and dedupes, packs each via `pnpm pack`, returns `{ installerDir, tarballs: Record<string,string> }` keyed by package name.
- The 5 `rewriteDependenciesToTarballs` copies all take `{ appRoot, tarballs }`; `run-agent-protocol`/`run-runtime-contract`/`run-smoke` already use the string-keyed `Record<string,string>` form; `run-generated-app.test.ts` and `harness.ts` additionally maintain a named `PackedTarballs` interface + `toPackedTarballs` mapper (used by `run-generated-app`'s fixture normalizer for `<tarball:@dawn-ai/X>` placeholders).
- Lane-specific deviations to preserve (the plan MUST read each lane's current `rewriteDependenciesToTarballs` to capture its exact behavior, not trust this summary): at least `run-agent-protocol` adds `@langchain/langgraph: "1.3.0"`, and the runtime lanes `delete` `langchain` + `@langchain/openai`. Each lane's exact delete/extra set is translated into `removeDependencies`/`extraDependencies` options.
- `run-generated-app` compares the generated app's full normalized `package.json` against `test/generated/fixtures/{basic,custom-app-dir}.expected.json` via `normalizeForFixture` (tarball paths → `<tarball:@dawn-ai/X>`) and `normalizeForInternalFixture` (file: edges → `<repo:@dawn-ai/X>`).
- The scaffold template `packages/devkit/templates/app-basic/` integrates `@dawn-ai/testing` only: `test/agent.test.ts.template`, `@dawn-ai/testing` + `vitest` devDeps, `"test": "vitest run"`. `create-dawn-app` threads `dawnTestingSpecifier` through `createTemplateReplacements` (internal file: + external dist-tag) + `applyInternalModePackageOverrides`; devkit `generated-app.ts` exposes `dawnTesting` in `GeneratedAppSpecifiers`/`normalizeSpecifiers` and writes `dawnTestingSpecifier`.
- `@dawn-ai/evals@1.0.0` and `@dawn-ai/testing@3.0.0` are published; the published `dawn eval` works in a fresh app (verified). The scaffold route is `hello/[tenant]`, key `/hello/[tenant]#agent`.

## Architecture

### Part 1 — shared packaging helper

New module **`test/harness/scaffold-packaging.ts`**:

```ts
/** Canonical set of @dawn-ai/* workspace packages a generated app may depend on. */
export const SCAFFOLD_PACKAGES: readonly string[] = [
  "@dawn-ai/cli",
  "@dawn-ai/config-typescript",
  "@dawn-ai/core",
  "@dawn-ai/evals",
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
  /** Extra non-workspace deps to force (e.g. { "@langchain/langgraph": "1.3.0" }). */
  readonly extraDependencies?: Readonly<Record<string, string>>
  /** Dep keys to delete before rewriting (e.g. ["langchain", "@langchain/openai"]). */
  readonly removeDependencies?: readonly string[]
}

/**
 * Data-driven rewrite: for every dep/devDep key present in `tarballs`, point it at
 * the tarball; rebuild pnpm.overrides from the same map. Adding a new packed package
 * needs no change here.
 */
export async function rewriteGeneratedAppDependencies(
  options: RewriteGeneratedAppDepsOptions,
): Promise<void>
```

Behavior:
1. Read `<appRoot>/package.json`.
2. Delete each key in `removeDependencies` from `dependencies`/`devDependencies`.
3. For each of `dependencies` and `devDependencies`, replace the value of any key that exists in `tarballs` with `tarballs[key]` (leaves unknown keys, e.g. `zod`, untouched).
4. Merge `extraDependencies` into `dependencies`.
5. Set `pnpm.overrides` = (existing overrides) merged with `{ name: tarballs[name] }` for **every** `tarballs` key that the app references in deps/devDeps (i.e. only packages the app actually uses), so the override set tracks the app. (Simplest correct rule; matches today's behavior where overrides list the workspace deps.)
6. Write back, pretty-printed + trailing newline (match current format).

All five lanes replace their local `rewriteDependenciesToTarballs` with a call to this; `run-agent-protocol`/`run-runtime-contract` pass `removeDependencies: ["langchain", "@langchain/openai"]` and `extraDependencies: { "@langchain/langgraph": "1.3.0" }`. All `packageNames: [ ...long list ]` become `packageNames: [...SCAFFOLD_PACKAGES]` (or rely on a helper default).

Delete: the 5 local `rewriteDependenciesToTarballs`, the 2 `PackedTarballs` interfaces, the 2 `toPackedTarballs` mappers, the 9 inline lists.

`run-generated-app`'s fixture normalizer stops using named `PackedTarballs` fields and instead iterates the `tarballs` record (keys ∈ `SCAFFOLD_PACKAGES` ∪ {`create-dawn-ai-app`,`@dawn-ai/devkit`}) to emit `[tarballPath, "<tarball:" + name + ">"]` replacement pairs; the internal-mode normalizer similarly iterates for `<repo:...>` edges. Fixtures themselves are unchanged by the refactor (no dep added yet).

### Part 2 — add `@dawn-ai/evals` to the scaffold

With Part 1 done, `@dawn-ai/evals` is already in `SCAFFOLD_PACKAGES` (added above), so every lane packs + overrides it automatically. Remaining, all template/scaffold side:

- **devkit template** `packages/devkit/templates/app-basic/`:
  - `package.json.template`: add `"@dawn-ai/evals": "{{dawnEvalsSpecifier}}"` to devDependencies and `"eval": "dawn eval"` to scripts.
  - New `test/`-sibling sample: `src/app/(public)/hello/[tenant]/evals/smoke.eval.ts.template` — `defineEval` with one inline-`script()`-fixture case + a `contains(...)` scorer + `threshold`, targeting the `hello/[tenant]` route. (Confirm the reply text the sample asserts matches the existing `agent.test.ts.template` fixture style so it passes deterministically.)
- **create-dawn-app** `src/index.ts`: add `dawnEvalsSpecifier` to `createTemplateReplacements` (internal file: → `packages/evals`; external → dist-tag) and to `applyInternalModePackageOverrides`.
- **devkit** `src/testing/generated-app.ts`: add `dawnEvals` to `GeneratedAppSpecifiers`, `normalizeSpecifiers` (default `workspace:*`), and write `dawnEvalsSpecifier` in `createGeneratedApp` replacements.
- **Assertions:** update `create-dawn-app/test/create-app.test.ts` and devkit `test/generated-app.test.ts` to assert the generated app has `evals/smoke.eval.ts`, the `@dawn-ai/evals` devDep, and the `eval` script (mirroring the existing `agent.test.ts`/testing assertions). Update the two `run-generated-app` fixtures (`basic`, `custom-app-dir`) to include the new `@dawn-ai/evals` devDep + `eval` script + override entry (the accepted loud diff).
- **Docs:** extend `apps/web/content/docs/evals.mdx` with a short "your scaffolded app already has an eval" note (no banned phrases per `check-docs.mjs`).

## Error handling / edge cases

- `rewriteGeneratedAppDependencies` with a dep key not in `tarballs` → left untouched (correct: e.g. `zod`, `@types/node`, `typescript`, `vitest`).
- A lane whose generated app does not reference a packed package → that package simply isn't added to overrides (overrides track app usage), which is fine.
- `extraDependencies`/`removeDependencies` default to none → lanes that don't need them call with neither.
- Format drift: write with `JSON.stringify(pkg, null, 2) + "\n"` to match the existing fixture format and avoid spurious diffs.

## Testing

- **Refactor is behavior-preserving:** the existing `verify:harness:framework` / `:runtime` / `:smoke` lanes are the regression test and must stay green (run all three; macOS-local `/private/tmp` notes still apply). Per-task, run the touched lane.
- **New unit test** `test/harness/scaffold-packaging.test.ts`: `rewriteGeneratedAppDependencies` on a synthetic temp `package.json` — swaps a known dep + devDep to tarball values, leaves an unknown dep (`zod`) untouched, applies `extraDependencies`, deletes `removeDependencies`, and writes overrides only for referenced packages.
- **Evals scaffold:** `create-app.test.ts` + devkit `generated-app.test.ts` assert the scaffolded eval file/devDep/script; the generated-app lanes prove the generated app still installs + builds cold with `@dawn-ai/evals` packed.
- Full `pnpm lint && build && typecheck && test && node scripts/check-docs.mjs` before PR.

## Out of scope (explicit)

- Parsing `package.json.template` as the package-set source (shared constant instead).
- Dep-agnostic `run-generated-app` fixtures (accept the one-file snapshot update when a dep is added).
- A new lane that executes `dawn eval` inside a generated app (covered by the published-prod smoke + the `examples/chat` dogfood).
- Touching `cli-testing-export.test.ts`'s own packageNames (it builds a bespoke installer for a different purpose and is not part of the generated-app rewrite duplication).
