# TypeScript 7 Tooling Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile Dawn and its Next.js applications with TypeScript 7 while consolidating all runtime compiler analysis in Core behind the official TypeScript 6 compatibility API, with permanent packed-artifact and post-publish smoke coverage.

**Architecture:** `@dawn-ai/core` gains a backend-neutral tool-analysis model plus one TypeScript-backed implementation file. Core, CLI, and Vite consume projections of that analysis; Vite no longer imports TypeScript. Next 16.3 applications use `experimental.useTypeScriptCli`, and reusable clean-consumer probes validate both locally packed and npm-published packages.

**Tech Stack:** TypeScript 7.0.2, `@typescript/typescript6` 6.0.2, Next.js 16.3, pnpm workspaces, Vitest, Node test runner, Changesets, GitHub Actions.

---

## Working constraints

- Work from `/Users/blove/repos/dawn/.worktrees/typescript-7-tooling` on `blove/typescript-7-tooling`.
- Run commands from the worktree root.
- Follow red-green-refactor for behavioral code. Do not delete the old implementation until the replacement tests are green.
- Do not run a bare workspace-wide Biome write. Scope formatting to changed files or use repository scripts.
- Build before executing anything that imports `dist/`.
- Preserve the existing Core route extraction public API. Remove only the explicitly unsupported Vite extraction helper exports.
- Do not implement the TypeScript 7 unstable API.
- Commit after each task with the messages specified below; commit messages and PR text must not reference assistant tooling.

## Intended file structure

New Core compiler files:

```text
packages/core/src/compiler/
  analyze-route-tools.ts    # discovery/merge and one-program route analysis
  index.ts                  # backend-neutral internal package entrypoint
  json-schema.ts            # TypeInfo -> existing Dawn JSON Schema
  model.ts                  # AnalyzedTool, TypeInfo, PropertyInfo
  typescript-backend.ts     # sole compiler-API import and implementation
```

New verification files:

```text
scripts/lib/typescript-tooling-probe.mjs   # reusable clean-consumer probe sources/runner
scripts/typescript-tooling-pack-smoke.mjs  # local packed-tarball installer and probe
```

The published smoke reuses the probe library instead of duplicating test programs.

### Task 1: Introduce the backend-neutral compiler model and source analyzer

**Files:**

- Create: `packages/core/src/compiler/model.ts`
- Create: `packages/core/src/compiler/typescript-backend.ts`
- Create: `packages/core/src/compiler/index.ts`
- Create: `packages/core/test/compiler-source-analysis.test.ts`
- Reference: `packages/vite-plugin/src/type-info.ts`
- Reference: `packages/vite-plugin/src/type-extractor.ts`
- Reference: `packages/vite-plugin/src/jsdoc-extractor.ts`

- [x] **Step 1: Write the failing source-analysis tests**

Create `packages/core/test/compiler-source-analysis.test.ts`. Import the not-yet-existing `analyzeToolSource` from `../src/compiler/index.ts`. Cover one behavior per test, including:

```ts
test("analyzes a typed default-exported tool", () => {
  const source = `
/**
 * Look up a customer
 * @param id - Customer ID
 */
export default async (input: { id: string; includeHistory?: boolean }) => ({
  found: true as boolean,
})
`

  expect(analyzeToolSource(source, "lookup.ts")).toEqual({
    name: "lookup",
    description: "Look up a customer",
    inputType: "{ id: string; includeHistory?: boolean; }",
    outputType: "{ found: boolean; }",
    parameter: {
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "includeHistory", type: { kind: "boolean" }, optional: true },
      ],
    },
    parameterDescriptions: new Map([["id", "Customer ID"]]),
  })
})
```

Add focused tests for literals, arrays, tuples, records, maps, sets, unions, intersections, enums, null, aliases, generics, imported input and output types, unknown inputs, no parameters, no default export, non-callable default export, inline property documentation, and multiline/default-export JSDoc. For the imported-type case, create a temporary sibling module and analyze a real source filename so the synthetic host's fallback filesystem and module resolution are exercised rather than mocked.

- [x] **Step 2: Run the new test and verify RED**

Run:

```bash
pnpm --filter @dawn-ai/core test -- compiler-source-analysis.test.ts
```

Expected: FAIL because `../src/compiler/index.ts` or `analyzeToolSource` does not exist.

- [x] **Step 3: Define the neutral model**

Move and extend the current Vite `TypeInfo` model into `packages/core/src/compiler/model.ts`:

```ts
export type TypeInfo =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | { readonly kind: "unknown" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "array"; readonly element: TypeInfo }
  | { readonly kind: "tuple"; readonly elements: readonly TypeInfo[] }
  | { readonly kind: "object"; readonly properties: readonly PropertyInfo[] }
  | { readonly kind: "record"; readonly key: TypeInfo; readonly value: TypeInfo }
  | { readonly kind: "map"; readonly key: TypeInfo; readonly value: TypeInfo }
  | { readonly kind: "set"; readonly element: TypeInfo }
  | { readonly kind: "union"; readonly members: readonly TypeInfo[] }
  | { readonly kind: "intersection"; readonly members: readonly TypeInfo[] }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "optional"; readonly inner: TypeInfo }

export interface PropertyInfo {
  readonly name: string
  readonly type: TypeInfo
  readonly optional: boolean
  readonly description?: string
}

export interface AnalyzedTool {
  readonly name: string
  readonly description: string
  readonly inputType: string
  readonly outputType: string
  readonly parameter: TypeInfo | null
  readonly parameterDescriptions: ReadonlyMap<string, string>
}
```

Use conditional spreads for optional descriptions to satisfy `exactOptionalPropertyTypes`.

- [x] **Step 4: Implement the minimal TypeScript compatibility backend**

Create `typescript-backend.ts` as the only compiler-importing file. Move the current Vite type walker and JSDoc parser into it, then add exact input/output string generation and Promise unwrapping from Core's extractor.

Required entrypoint:

```ts
export function analyzeToolSource(source: string, fileName: string): AnalyzedTool | null
```

Use one synthetic `CompilerHost`, resolve the callable default export once, and populate every projection field from that resolved signature. Derive the tool name from the file basename. Keep a recursion/depth guard that yields `{ kind: "unknown" }` rather than recursing forever.

At the import, add the maintenance comment linking `https://github.com/microsoft/typescript-go/issues/4830` and explaining the TypeScript 6 bridge and TypeScript 7.1 revisit.

- [x] **Step 5: Export the neutral source-analysis surface internally**

Create `packages/core/src/compiler/index.ts`:

```ts
export { analyzeToolSource } from "./typescript-backend.js"
export type { AnalyzedTool, PropertyInfo, TypeInfo } from "./model.js"
```

Do not add these exports to Core's root `src/index.ts`.

- [x] **Step 6: Run the source-analysis tests and verify GREEN**

Run:

```bash
pnpm --filter @dawn-ai/core test -- compiler-source-analysis.test.ts
```

Expected: all new tests PASS with no warnings beyond existing Node SQLite notices.

- [x] **Step 7: Run the existing Vite extractor/JSDoc suites as characterization**

Run:

```bash
pnpm --filter @dawn-ai/vite-plugin test -- type-extractor.test.ts jsdoc-extractor.test.ts
```

Expected: existing suites remain PASS before their implementation is removed.

- [x] **Step 8: Commit**

```bash
git add packages/core/src/compiler packages/core/test/compiler-source-analysis.test.ts
git commit -m "refactor(core): add unified tool source analysis"
```

### Task 2: Analyze route tools once and render JSON Schema from the neutral model

**Files:**

- Create: `packages/core/src/compiler/analyze-route-tools.ts`
- Create: `packages/core/src/compiler/json-schema.ts`
- Create: `packages/core/test/compiler-route-analysis.test.ts`
- Create: `packages/core/test/compiler-json-schema.test.ts`
- Modify: `packages/core/src/compiler/index.ts`
- Reference: `packages/core/src/typegen/extract-tool-schema.ts`
- Reference: `packages/core/src/typegen/extract-tool-types.ts`

- [x] **Step 1: Write a failing one-program route-analysis test**

Create temporary shared and route tool directories. Import `analyzeRouteTools` and assert:

- shared/local merge and local shadowing;
- name sorting;
- description, exact input/output strings, and `TypeInfo` are returned together;
- no-parameter tools receive `inputType: "void"`, `parameter: null`, and an unwrapped output type.

Use an injectable backend factory or a test-only counter seam to assert one program is created for multiple tools without exposing compiler objects in the public result.

- [x] **Step 2: Run the route-analysis test and verify RED**

```bash
pnpm --filter @dawn-ai/core test -- compiler-route-analysis.test.ts
```

Expected: FAIL because `analyzeRouteTools` is absent.

- [x] **Step 3: Implement route discovery and batch analysis**

Move the duplicated `discoverToolFiles` and merge logic into `analyze-route-tools.ts`. Add a backend function that accepts the effective file map, creates one `Program`, and analyzes every source file through the same default-export/signature/type walker used by `analyzeToolSource`.

Required public shape within the internal subpath:

```ts
export interface AnalyzeRouteToolsOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
}

export function analyzeRouteTools(
  options: AnalyzeRouteToolsOptions,
): readonly AnalyzedTool[]
```

Keep the outer function synchronous unless actual asynchronous work is introduced; existing async projection APIs can await a non-Promise result without behavior changes.

- [x] **Step 4: Write failing neutral JSON Schema renderer tests**

Create `compiler-json-schema.test.ts` against a missing `typeInfoToToolParameters` function. Construct `TypeInfo` values directly and assert deterministic output for primitives, semantic optional fields, enum, nested object, array, record `additionalProperties`, object union `anyOf`, literal discriminants, descriptions, and depth fallback. Characterize the intentional clean behavior for mapped optional properties and specialized collection intersections instead of preserving compiler-internal legacy output.

- [x] **Step 5: Run the renderer tests and verify RED**

```bash
pnpm --filter @dawn-ai/core test -- compiler-json-schema.test.ts
```

Expected: FAIL because the renderer is absent.

- [x] **Step 6: Implement the renderer without compiler imports**

Move JSON Schema projection behavior into `json-schema.ts`:

```ts
export function typeInfoToToolParameters(
  parameter: TypeInfo | null,
): ExtractedToolSchema["parameters"]
```

Preserve `MAX_SCHEMA_DEPTH = 8`, `{ type: "string" }` fallback for unsupported neutral shapes, required-property ordering, `additionalProperties: false` for concrete objects, and record value schemas. Keep all JSON projection logic out of the compiler backend. Mapped properties use semantic optionality; collection intersections must not expand compiler-library method symbols.

- [x] **Step 7: Export and verify route analysis plus schema rendering**

Update `compiler/index.ts`, then run:

```bash
pnpm --filter @dawn-ai/core test -- compiler-route-analysis.test.ts compiler-json-schema.test.ts
```

Expected: both suites PASS.

- [x] **Step 8: Commit**

```bash
git add packages/core/src/compiler packages/core/test/compiler-route-analysis.test.ts packages/core/test/compiler-json-schema.test.ts
git commit -m "refactor(core): analyze route tools once"
```

### Task 3: Rewire Core and CLI to the combined analysis

**Files:**

- Modify: `packages/core/src/typegen/extract-tool-schema.ts`
- Modify: `packages/core/src/typegen/extract-tool-types.ts`
- Modify: `packages/core/src/compiler/index.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/cli/src/lib/typegen/run-typegen.ts`
- Modify: `packages/cli/vitest.config.ts`
- Modify: `packages/cli/package.json` only if the internal subpath needs an explicit dependency declaration change
- Modify: `packages/core/test/integration-dx-improvements.test.ts`
- Modify: `packages/cli/test/run-typegen.test.ts`

- [x] **Step 1: Add a failing combined-artifact assertion**

Expose an internal projection:

```ts
export interface ExtractedToolArtifacts {
  readonly types: readonly ExtractedToolType[]
  readonly schemas: readonly ExtractedToolSchema[]
}

export function extractToolArtifactsForRoute(
  options: AnalyzeRouteToolsOptions,
): ExtractedToolArtifacts
```

Add a Core integration test asserting a single call returns mutually consistent type and schema records. Add a CLI test that expects `runTypegen` to write both `.d.ts` types and `tools.json` schemas for the same route from this combined result.

- [x] **Step 2: Run the focused Core and CLI tests and verify RED**

```bash
pnpm --filter @dawn-ai/core test -- integration-dx-improvements.test.ts
pnpm --filter @dawn-ai/cli test -- run-typegen.test.ts
```

Expected: the new combined API assertion fails before implementation.

- [x] **Step 3: Replace Core's duplicate compiler walks with projections**

Make `extract-tool-types.ts` and `extract-tool-schema.ts` thin async-compatible wrappers around the combined internal analysis. Remove their TypeScript imports, duplicated discovery, compiler options, program construction, default-export lookup, and type walkers.

Keep their public names, options interfaces, return types, sorting, and error/skip behavior.

- [x] **Step 4: Make CLI typegen consume the combined result**

Import `extractToolArtifactsForRoute` from `@dawn-ai/core/internal/compiler` in `run-typegen.ts`. In each route iteration, call it once, append capability-contributed types as before, and write schemas as before.

Add Core's internal compiler export to `packages/core/package.json`:

```json
"./internal/compiler": {
  "types": "./dist/compiler/index.d.ts",
  "default": "./dist/compiler/index.js"
}
```

Before the existing broad `@dawn-ai/core` source alias in `packages/cli/vitest.config.ts`, add an explicit `@dawn-ai/core/internal/compiler` alias to `../core/src/compiler/index.ts`. Vitest/Vite string aliases also match subpaths; without the more specific first entry, CLI source-mode tests would incorrectly resolve the internal import under `src/index.ts/internal/compiler`.

- [x] **Step 5: Run all Core typegen and CLI typegen/verify tests**

```bash
pnpm --filter @dawn-ai/core test -- extract-tool-types.test.ts extract-tool-schema.test.ts nested-tool-inputs-integration.test.ts integration-dx-improvements.test.ts
pnpm --filter @dawn-ai/cli test -- run-typegen.test.ts typegen-command.test.ts verify-command.test.ts
```

Expected: all existing and new tests PASS. Supported schema outputs remain structure-compatible; assertions for mapped optional types and specialized collection intersections use the user-approved neutral behavior rather than compiler-dependent legacy output.

- [x] **Step 6: Build Core before CLI and verify declarations resolve**

```bash
pnpm turbo run build --filter=@dawn-ai/cli...
pnpm --filter @dawn-ai/cli typecheck
```

Expected: PASS; the internal subpath resolves from built Core declarations.

- [x] **Step 7: Commit**

```bash
git add packages/core packages/cli/src/lib/typegen/run-typegen.ts packages/cli/test/run-typegen.test.ts packages/cli/vitest.config.ts
git commit -m "refactor(typegen): share compiler analysis projections"
```

### Task 4: Rewire Vite and remove its compiler implementation

**Files:**

- Modify: `packages/vite-plugin/src/index.ts`
- Modify: `packages/vite-plugin/src/zod-generator.ts`
- Modify: `packages/vite-plugin/package.json`
- Modify: `packages/vite-plugin/test/plugin.test.ts`
- Modify: `packages/vite-plugin/test/zod-generator.test.ts`
- Modify: `packages/vite-plugin/vitest.config.ts` if Core source aliasing is required for source-mode tests
- Delete: `packages/vite-plugin/src/type-extractor.ts`
- Delete: `packages/vite-plugin/src/jsdoc-extractor.ts`
- Delete: `packages/vite-plugin/src/type-info.ts`
- Delete or migrate: `packages/vite-plugin/test/type-extractor.test.ts`
- Delete or migrate: `packages/vite-plugin/test/jsdoc-extractor.test.ts`
- Search/update: Vite README/docs references to removed exports

- [x] **Step 1: Add a failing ownership-boundary test**

In `plugin.test.ts` or a new focused test, read Vite's manifest/source and assert:

```ts
expect(packageJson.dependencies?.typescript).toBeUndefined()
expect(sourceFiles.some((text) => /from ["']typescript["']/.test(text))).toBe(false)
```

Also assert the root module no longer exports `extractJsDoc` or `extractParameterType` after the refactor.

- [x] **Step 2: Run the Vite tests and verify RED**

```bash
pnpm --filter @dawn-ai/vite-plugin test -- plugin.test.ts
```

Expected: FAIL because Vite still owns the compiler dependency/imports and helper exports.

- [x] **Step 3: Rewire `transformToolSource`**

Import `analyzeToolSource` and `TypeInfo` from `@dawn-ai/core/internal/compiler`. Replace separate JSDoc and parameter extraction with one analysis call. Preserve existing-export detection and inject only missing values.

Use the analysis' inline property descriptions first and `parameterDescriptions` as fallback. Do not mutate readonly `PropertyInfo`; make Zod generation accept both sources directly.

- [x] **Step 4: Move Vite tests to supported surfaces and delete legacy files**

Keep plugin transform and Zod rendering tests. Move any unique type/JSDoc cases not already covered into Core's compiler tests, prove those tests pass, then delete the old Vite extraction tests and source modules.

Remove the helper exports from `src/index.ts` and remove Vite's `typescript` dependency.

- [x] **Step 5: Run Vite plus Core compiler suites**

```bash
pnpm --filter @dawn-ai/core test -- compiler-source-analysis.test.ts
pnpm --filter @dawn-ai/vite-plugin test
pnpm turbo run build --filter=@dawn-ai/vite-plugin...
```

Expected: PASS. Confirm the ownership-boundary test is green.

- [x] **Step 6: Search for stale compiler ownership and removed APIs**

```bash
rg -n 'from "typescript"|from '\''typescript'\''' packages/core/src packages/vite-plugin/src
rg -n 'extractJsDoc|extractParameterType' packages apps examples docs README.md
```

Expected: exactly one compiler import in `packages/core/src/compiler/typescript-backend.ts`; no stale supported-surface references to removed Vite exports.

- [x] **Step 7: Commit**

```bash
git add packages/core packages/vite-plugin
git commit -m "refactor(vite-plugin): centralize compiler analysis in core"
```

### Task 5: Install the TypeScript 6 API bridge and move the workspace compiler to TypeScript 7

**Files:**

- Modify: `packages/core/package.json`
- Modify: `package.json`
- Modify: every workspace `package.json` containing `typescript@6.0.2`
- Modify: `packages/devkit/templates/app-basic/package.json.template`
- Modify: `packages/devkit/templates/app-research/package.json.template`
- Modify: `test/generated/fixtures/handwritten-runtime-app/package.json`
- Modify: `scripts/published-artifact-smoke.mjs` AG-UI consumer compiler version
- Modify: `pnpm-lock.yaml`
- Create: `packages/core/test/compiler-dependency-boundary.test.ts`

- [x] **Step 1: Write a failing dependency-layout test**

Read Core's and Vite's manifests and assert:

```ts
expect(core.dependencies.typescript).toBe("npm:@typescript/typescript6@6.0.2")
expect(vite.dependencies?.typescript).toBeUndefined()
```

Resolve Core's installed `typescript` from Core's package context and assert `createProgram` and `createSourceFile` are functions. Resolve root `typescript/package.json` and assert version `7.0.2`.

- [x] **Step 2: Run the dependency test and verify RED**

```bash
pnpm --filter @dawn-ai/core test -- compiler-dependency-boundary.test.ts
```

Expected: FAIL because Core still declares ordinary TypeScript 5/6 and root is still TypeScript 6.

- [x] **Step 3: Update dependency manifests**

- Set Core's runtime `typescript` dependency to `npm:@typescript/typescript6@6.0.2`.
- Remove Vite's TypeScript dependency if Task 4 did not already do so.
- Set ordinary workspace/compiler/template/fixture references to exact `7.0.2`.
- Update the AG-UI published consumer probe to install `typescript@7.0.2`.

Use `rg -n -F '"typescript": "6.0.2"'` to ensure no unintended 6.0.2 compiler pins remain. The compatibility package's version is intentionally 6.0.2 under its npm alias.

- [x] **Step 4: Regenerate the lockfile**

```bash
pnpm install
```

Inspect `pnpm-lock.yaml` to confirm root/workspace TypeScript 7 and Core's isolated compatibility alias are both present.

- [x] **Step 5: Run dependency, compiler, build, and type checks**

```bash
pnpm --filter @dawn-ai/core test -- compiler-dependency-boundary.test.ts compiler-source-analysis.test.ts compiler-route-analysis.test.ts compiler-json-schema.test.ts
pnpm turbo run build --filter=@dawn-ai/vite-plugin...
pnpm --filter @dawn-ai/core typecheck
pnpm --filter @dawn-ai/vite-plugin typecheck
pnpm --filter @dawn-ai/cli typecheck
```

Expected: PASS while `pnpm exec tsc --version` reports 7.0.2.

- [x] **Step 6: Commit**

```bash
git add package.json packages examples apps test scripts/published-artifact-smoke.mjs pnpm-lock.yaml
git commit -m "build: compile workspace with TypeScript 7"
```

### Task 6: Upgrade all Next applications to the TypeScript CLI backend

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/web/next.config.ts`
- Modify: `packages/inspector/package.json`
- Modify: `packages/inspector/next.config.ts`
- Modify: `examples/chat/web/package.json`
- Modify: `examples/chat/web/next.config.mjs`
- Modify: `examples/research/web/package.json`
- Modify: `examples/research/web/next.config.mjs`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Capture the expected failing Next 16.2 + TypeScript 7 integration**

After Task 5 and before changing Next, run one representative build without Turbo cache:

```bash
pnpm --filter @dawn-example/chat-web build
```

Expected: FAIL because Next 16.2 attempts to load the unavailable TypeScript JavaScript compiler API. Record the relevant diagnostic in the task notes; do not weaken type checking.

- [x] **Step 2: Upgrade Next and enable CLI checking**

- Set all four `next` dependencies to exact `16.3.0`.
- Set `apps/web`'s `@next/mdx` to exact `16.3.0`.
- Add `experimental: { useTypeScriptCli: true }` to every Next config, merging with existing options.
- Preserve Inspector's `output`, tracing root, and external-package configuration.

- [x] **Step 3: Regenerate the lockfile**

```bash
pnpm install
```

- [x] **Step 4: Build each Next application directly**

```bash
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/inspector build
pnpm --filter @dawn-example/chat-web build
pnpm --filter @dawn-example/research-web build
```

Expected: each log identifies Next 16.3 and finishes the TypeScript CLI check successfully.

- [x] **Step 5: Run Inspector standalone e2e**

```bash
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
```

Expected: PASS, proving the standalone artifact resolves Core and its compatibility compiler dependency at runtime.

- [x] **Step 6: Commit**

```bash
git add apps/web packages/inspector examples/chat/web examples/research/web pnpm-lock.yaml
git commit -m "build(next): use TypeScript 7 CLI checking"
```

### Task 7: Add the reusable TypeScript-tooling clean-consumer probe

**Files:**

- Create: `scripts/lib/typescript-tooling-probe.mjs`
- Modify: `scripts/published-artifacts.test.mjs`

- [x] **Step 1: Write failing probe-source and command tests**

Add tests for missing exports from `typescript-tooling-probe.mjs`. Assert the generated probe:

- imports only installed `@dawn-ai/core` and `@dawn-ai/vite-plugin` public surfaces;
- creates representative tool files;
- asserts exact extracted type and schema structures;
- calls `dawnToolSchemaPlugin().transform` and checks generated Zod and descriptions;
- checks consumer `typescript.version === "7.0.2"`;
- verifies Core operations succeed, which proves its nested compatibility API is usable;
- emits a NodeNext TypeScript consumer and runs `tsc --noEmit`.

- [x] **Step 2: Run the script tests and verify RED**

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: FAIL because the reusable probe module does not exist.

- [x] **Step 3: Implement reusable probe generation/execution**

Export pure source/config builders plus a runner that accepts:

```js
{
  root,
  runCommand,
  expectedTypeScriptVersion: "7.0.2"
}
```

Keep installation outside the probe library so local tarball and npm-published callers can select their own package sources. Avoid repository-relative imports in generated code.

- [x] **Step 4: Run tests and verify GREEN**

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/typescript-tooling-probe.mjs scripts/published-artifacts.test.mjs
git commit -m "test: add TypeScript tooling consumer probe"
```

### Task 8: Add the local packed-artifact smoke to `ci:validate`

**Files:**

- Create: `scripts/typescript-tooling-pack-smoke.mjs`
- Create or modify: `scripts/typescript-tooling-pack-smoke.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/lib/pack-check.mjs` only if shared packing helpers are extracted

- [x] **Step 1: Write failing orchestration tests**

Test pure selection/argument functions and inject command/temp-dir dependencies. Assert the orchestrator packs Core and Vite, installs both tarballs plus `typescript@7.0.2`, `tsx`, and `zod` in a clean project, then invokes the reusable probe. Assert cleanup runs after simulated install and probe failures.

- [x] **Step 2: Run and verify RED**

```bash
node --test scripts/typescript-tooling-pack-smoke.test.mjs
```

Expected: FAIL because the smoke orchestrator is absent.

- [x] **Step 3: Implement the local pack smoke**

Build/pack the two packages, install their tarballs in a temporary npm project, reject native lifecycle scripts and unresolved `workspace:`/`file:` specs using existing published-artifact helpers, then run the reusable probe. Always remove the temporary root.

Add scripts:

```json
"test:typescript-tooling-pack-smoke": "node --test scripts/typescript-tooling-pack-smoke.test.mjs",
"verify:typescript-tooling-pack": "node scripts/typescript-tooling-pack-smoke.mjs"
```

Place `pnpm verify:typescript-tooling-pack` after `pnpm pack:check` in `ci:validate`.
Add the same command immediately after the `Pack check` step in `.github/workflows/ci.yml`'s `validate` job because that workflow spells out the Definition of Done gates rather than invoking `ci:validate`.

- [x] **Step 4: Run unit and real packed-artifact smoke**

```bash
node --test scripts/typescript-tooling-pack-smoke.test.mjs
pnpm build
pnpm verify:typescript-tooling-pack
```

Expected: unit tests and the clean installed-artifact probe PASS.

- [x] **Step 5: Commit**

```bash
git add package.json .github/workflows/ci.yml scripts/typescript-tooling-pack-smoke.mjs scripts/typescript-tooling-pack-smoke.test.mjs scripts/lib
git commit -m "test: smoke packed TypeScript tooling"
```

### Task 9: Extend npm-published artifact verification

**Files:**

- Modify: `scripts/lib/published-artifacts.mjs`
- Modify: `scripts/published-artifact-smoke.mjs`
- Modify: `scripts/published-artifacts.test.mjs`
- Modify: `.github/workflows/published-artifact-verify.yml`

- [x] **Step 1: Add failing package-set and selection tests**

Assert:

```js
assert.deepEqual(packageSets["typescript-tooling"], [
  "@dawn-ai/core",
  "@dawn-ai/vite-plugin",
  "@dawn-ai/cli",
])
```

Add a `shouldRunTypeScriptToolingProbe` test that selects only when Core and Vite are both installed.

- [x] **Step 2: Run and verify RED**

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: FAIL until the package set and selector exist.

- [x] **Step 3: Add the package set and published probe hook**

After installing the selected npm packages and running native-script checks, explicitly install consumer-side `typescript@7.0.2`, `tsx@4.23.0`, and the repository's supported Zod version in the temporary project before invoking the reusable TypeScript-tooling probe. This explicit root install prevents Core's nested aliased TypeScript 6 dependency from becoming the consumer's apparent compiler. Do not run pgvector unless requested; the compiler probe must be network-free after package installation.

Add `typescript-tooling` to the manual workflow's package-set choices.

- [x] **Step 4: Run script tests**

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: PASS.

- [x] **Step 5: Exercise against the current npm release without claiming the new bridge**

Run metadata selection and installation against `latest` only if the current release contains the required probe surface. Otherwise run the command with a test double/local registry and record that the exact post-release execution is intentionally deferred until publication.

- [x] **Step 6: Commit**

```bash
git add scripts/lib/published-artifacts.mjs scripts/published-artifact-smoke.mjs scripts/published-artifacts.test.mjs .github/workflows/published-artifact-verify.yml
git commit -m "ci: verify published TypeScript tooling"
```

### Task 10: Automate exact-version verification after release publication

**Files:**

- Modify: `scripts/lib/published-artifacts.mjs`
- Modify: `scripts/published-artifact-verify.mjs`
- Modify: `scripts/published-artifacts.test.mjs`
- Modify: `.github/workflows/release.yml`

- [x] **Step 1: Write failing bounded-registry-wait tests**

Add a pure/injectable helper test covering:

- immediate visibility;
- delayed visibility after retries;
- one missing package among the package set;
- timeout diagnostics containing exact package and version;
- no unbounded wait.

Proposed helper:

```js
export async function waitForPublishedVersions({
  packages,
  version,
  attempts,
  delayMs,
  npmViewImpl = npmView,
  delay = defaultDelay,
})
```

- [x] **Step 2: Run and verify RED**

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: FAIL because wait support is absent.

- [x] **Step 3: Implement wait support and CLI flags**

Add bounded `--wait-attempts` and `--wait-delay-ms` options to `published-artifact-verify.mjs`, defaulting to no wait for existing manual behavior. When enabled, poll all selected packages for the exact version before tarball verification.

- [x] **Step 4: Add conditional post-publish release steps**

After existing attestation/assets/backfill steps, and only when `${{ steps.changesets.outputs.published == 'true' }}`:

1. Read the exact fixed-group version from `packages/core/package.json` into `DAWN_PUBLISHED_VERSION`.
2. Run `pnpm published:verify -- --version "$DAWN_PUBLISHED_VERSION" --package-set typescript-tooling --wait-attempts 18 --wait-delay-ms 10000`.
3. Run `pnpm published:smoke -- --version "$DAWN_PUBLISHED_VERSION" --package-set typescript-tooling`.

Keep each individual poll delay below 60 seconds and the total bounded by the release job timeout.

- [x] **Step 5: Run unit tests and validate workflow syntax by inspection/tooling**

```bash
node --test scripts/published-artifacts.test.mjs
pnpm lint
```

If `actionlint` is available, run it on both changed workflows. Otherwise rely on repository workflow lint/checks and document the unavailable local validator.

- [x] **Step 6: Commit**

```bash
git add scripts/lib/published-artifacts.mjs scripts/published-artifact-verify.mjs scripts/published-artifacts.test.mjs .github/workflows/release.yml
git commit -m "ci: smoke TypeScript tooling after publish"
```

### Task 11: Add release documentation and changeset

**Files:**

- Create: `.changeset/<descriptive-name>.md`
- Modify: `packages/vite-plugin/README.md` if it documents removed helpers
- Modify: relevant TypeScript support documentation only where current claims require updating
- Verify: `docs/superpowers/specs/2026-08-05-typescript-7-tooling-design.md`

- [ ] **Step 1: Search for stale supported versions and removed helper APIs**

```bash
rg -n 'TypeScript 6|typescript@6|6\.0\.2|extractJsDoc|extractParameterType' README.md CONTRIBUTING.md CONTRIBUTORS.md apps packages examples docs scripts test --glob '!docs/superpowers/**'
```

Classify every match; update only claims and templates affected by this migration.

- [ ] **Step 2: Add a patch changeset**

Include affected publishable packages such as Core, Vite plugin, CLI, Inspector, and Devkit. Describe:

- TypeScript 7 compiler support;
- Next 16.3 CLI type checking;
- Core's internal TypeScript 6 API bridge;
- removal of unsupported Vite extraction helpers;
- stronger packed and post-publish verification.

Use patch bumps because the repository is on a fixed 0.x release train.

- [ ] **Step 3: Run docs and changeset checks**

```bash
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .changeset packages/vite-plugin/README.md apps packages examples docs scripts test
git commit -m "docs: document TypeScript 7 support"
```

### Task 12: Complete verification and review

**Files:**

- Verify all changed files
- Update plan checkboxes as tasks complete

- [ ] **Step 1: Run formatting/lint checks**

```bash
pnpm lint
git diff --check
```

Expected: PASS with no formatting or whitespace errors.

- [ ] **Step 2: Run targeted TypeScript-tooling tests from a fresh build**

```bash
pnpm build
pnpm --filter @dawn-ai/core test
pnpm --filter @dawn-ai/vite-plugin test
pnpm --filter @dawn-ai/cli test
pnpm verify:typescript-tooling-pack
```

Expected: PASS.

- [ ] **Step 3: Run all four Next production builds and Inspector e2e**

```bash
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/inspector build
pnpm --filter @dawn-example/chat-web build
pnpm --filter @dawn-example/research-web build
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
```

Expected: PASS using Next 16.3's CLI checker and TypeScript 7.

- [ ] **Step 4: Run the full Definition of Done lane**

```bash
pnpm ci:validate
```

Expected: PASS through lint, build-cache, build, typecheck, tests, release-script tests, docs, pack, TypeScript-tooling packed smoke, and harness lanes.

- [ ] **Step 5: Run available gated runtime smokes**

Run locally available Docker/Inspector/full-arc lanes. At minimum:

```bash
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
DAWN_TEST_DOCKER=1 pnpm --filter @dawn-ai/sandbox test
```

Run Kubernetes/pgvector/full-e2e lanes where their required infrastructure is available. Record skipped lanes explicitly for GitHub CI rather than claiming them.

- [ ] **Step 6: Verify dependency and import invariants**

```bash
pnpm exec tsc --version
rg -n 'from "typescript"|from '\''typescript'\''' packages/core/src packages/vite-plugin/src
rg -n -F '"typescript": "6.0.2"' . --glob '!pnpm-lock.yaml' --glob '!docs/superpowers/**'
pnpm pack:check
```

Expected:

- compiler version 7.0.2;
- exactly one compiler import, in Core's backend;
- no unintended TypeScript 6 manifest pins;
- pack check PASS.

- [ ] **Step 7: Request code review**

Use `superpowers:requesting-code-review`. Address technically valid feedback with `superpowers:receiving-code-review`, rerunning affected verification after every change.

- [ ] **Step 8: Run final fresh verification**

Use `superpowers:verification-before-completion` and rerun `pnpm ci:validate` plus the packed smoke after all review changes. Read the complete exit status before claiming success.

- [ ] **Step 9: Commit any final review/verification changes**

```bash
git status --short
git add <only-intended-files>
git commit -m "test: finalize TypeScript 7 verification"
```

Skip the commit when no files changed.

## Post-merge and post-release acceptance

These steps require external state and are not claimed during local implementation:

1. Confirm all required PR checks pass, including Inspector, Vercel, Docker/Kubernetes, and other gated lanes.
2. After the fixed-group release publishes, confirm the Release workflow's exact-version `typescript-tooling` metadata and runtime smoke steps pass.
3. If registry propagation exceeds the bounded wait, rerun the manual Published Artifact Verification workflow for the exact version and `typescript-tooling` package set.
4. Treat a real probe failure as a release incident: preserve logs, identify the affected package/version, and fix forward with a patch release.
