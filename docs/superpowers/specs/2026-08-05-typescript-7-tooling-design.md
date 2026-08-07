# TypeScript 7 Tooling Migration Design

**Status:** Approved for spec review
**Date:** 2026-08-05
**Scope:** TypeScript 7 compiler adoption, Next.js 16.3 CLI type checking, consolidated Dawn compiler analysis, and local/post-publish verification

## Goal

Adopt the TypeScript 7 compiler throughout Dawn without depending on TypeScript 7.0's unfinished native compiler API. Next.js applications use Next 16.3's CLI type-checking backend, while Dawn's runtime compiler analysis is consolidated in `@dawn-ai/core` and temporarily backed by Microsoft's TypeScript 6 compatibility package. The release must be protected by clean-consumer smoke tests both before and after npm publication.

## Problem

Dependabot PR #348 upgrades `typescript` to 7.0.2. TypeScript 7 deliberately removes the stable JavaScript compiler API from the package root; the root export contains version information, not `createProgram`, `createSourceFile`, compiler enums, symbols, types, or checker operations. Dawn currently imports that API in four source files across two packages:

- `packages/core/src/typegen/extract-tool-schema.ts`
- `packages/core/src/typegen/extract-tool-types.ts`
- `packages/vite-plugin/src/type-extractor.ts`
- `packages/vite-plugin/src/jsdoc-extractor.ts`

The duplication is broader than the imports. Core independently discovers tool files and builds a TypeScript program for type strings and JSON Schema. The Vite plugin creates another program for source transforms and separately parses the same default export's JSDoc. A future native API port would therefore have several migration sites and several subtly different interpretations of the same tool.

Next.js 16.2 is a second, independent blocker. It loads `typescript/lib/typescript.js` for configuration and type checking, but TypeScript 7 does not publish that file. Next 16.3 adds `experimental.useTypeScriptCli`, which invokes the project-local `tsc` executable instead of loading the JavaScript API.

## Approved decisions

1. **No new workspace package.** `@dawn-ai/core` owns compiler-backed analysis because Vite already depends on Core and the dependency direction is acyclic.
2. **No compatibility requirement for Vite's extraction helper exports.** `extractJsDoc` and `extractParameterType` may be removed from `@dawn-ai/vite-plugin` along with their implementation modules.
3. **One backend-neutral analysis model.** Type strings, JSON Schema, and generated Zod source are projections of one analyzed tool rather than separate TypeScript walks.
4. **One direct compiler-API boundary.** Only Core's compatibility backend imports `typescript` and manipulates compiler objects.
5. **TypeScript 7.0 compiles the workspace.** Core's runtime import is separately resolved to Microsoft's TypeScript 6 compatibility package.
6. **Next applications move together.** The docs site, Inspector, chat web, and research web all upgrade to Next 16.3 and enable the CLI checker before receiving TypeScript 7.
7. **Verification is a deliverable.** Clean packed-artifact and post-publication compiler smokes are permanent CI/release lanes, not manual release notes.
8. **Compiler-neutral projection takes precedence over legacy edge-case output.** Supported schema shapes remain deterministic, but Dawn does not preserve accidental compiler-dependent output for mapped optional properties or collection intersections. `Partial<T>` follows semantic optionality, and specialized intersections project from neutral `TypeInfo` rather than compiler-internal method symbols.

## Non-goals

- Do not port to `typescript/unstable/sync` or `typescript/unstable/async` in this change.
- Do not add `@dawn-ai/compiler` or another publishable package.
- Do not redesign Dawn's author-facing tool contract or require explicit schemas.
- Do not intentionally change generated TypeScript, Zod, or JSDoc behavior. JSON Schema remains stable for supported primitives, objects, arrays, records, enums, unions, descriptions, and depth fallbacks; compiler-dependent mapped/intersection edge cases may adopt the clean neutral projection described above.
- Do not remove Core's existing public route extraction functions; CLI and external consumers may continue to call them.
- Do not automate rollback of an npm release. Post-publish verification can detect and report failure after publication, but npm publication is not transactional.

## Architecture

### Core compiler-analysis boundary

Add a focused internal compiler area under `packages/core/src/compiler/`:

- `model.ts` defines backend-neutral `AnalyzedTool`, `TypeInfo`, and property/documentation structures. It has no TypeScript import.
- `typescript-backend.ts` is the only source file that imports `typescript`. It owns compiler options, program/host construction, default-export and callable-signature resolution, exact input/output type rendering, Promise unwrapping, JSDoc extraction, and conversion from compiler types to `TypeInfo`.
- `json-schema.ts` renders the existing Dawn JSON Schema contract from `TypeInfo` without seeing compiler objects.
- `analyze-route-tools.ts` discovers and merges shared/route-local files, asks the backend to analyze all files in one program, and returns sorted `AnalyzedTool` records.
- `index.ts` exposes the minimum cross-package internal API required by CLI and Vite.

Core adds a package export such as `@dawn-ai/core/internal/compiler`. The path name communicates that it is for Dawn workspace packages and is not a supported author-facing API. It exports backend-neutral values and functions only; it never exports TypeScript compiler objects.

The TypeScript backend contains a maintenance comment that records:

- TypeScript 7.0 has no stable compiler API.
- Core's `typescript` dependency is aliased to `@typescript/typescript6`.
- The compatibility backend should be reconsidered when TypeScript 7.1 exposes stable equivalents for ad-hoc `createProgram` and `createSourceFile` analysis.
- The upstream tracking link is `https://github.com/microsoft/typescript-go/issues/4830`.

### Normalized analysis model

An analyzed callable tool contains, at minimum:

```ts
interface AnalyzedTool {
  readonly name: string
  readonly description: string
  readonly inputType: string
  readonly outputType: string
  readonly parameter: TypeInfo | null
  readonly parameterDescriptions: ReadonlyMap<string, string>
}
```

`TypeInfo` covers the shapes already recognized by the Vite generator: primitives, literals, arrays, tuples, objects, records, maps, sets, unions, intersections, enums, optional values, null, and unknown. Object properties carry optionality and symbol/JSDoc descriptions.

The backend must terminate recursive/self-referential analysis deterministically. It tracks recursion without allowing infinite compiler walks; `json-schema.ts` independently applies the JSON Schema depth policy. Projection behavior is stable except for the explicitly accepted compiler-dependent JSON edge cases:

- exact input/output strings still come from `checker.typeToString(...NoTruncation)`;
- JSON Schema keeps its current `MAX_SCHEMA_DEPTH` fallback and current unsupported-type fallbacks;
- mapped optional properties use semantic optionality, so `Partial<T>` fields are no longer incorrectly required merely because their originating declaration lacked `?`;
- collection intersections do not expose compiler-library method symbols as tool parameters and instead use the neutral unsupported/root fallback;
- Zod generation keeps the existing `z.unknown()` behavior for unknown shapes;
- missing/default-export/non-callable sources retain current skip or `null` behavior;
- route-local tools continue to shadow shared tools;
- results remain name-sorted.

Default-export descriptions and property descriptions come from compiler symbols. The source analyzer also preserves Vite's current leading-JSDoc `@param` parsing so property descriptions can fall back to `@param propertyName` text when inline property documentation is absent.

### Core and CLI data flow

`analyzeRouteTools(options)` discovers the effective files and creates one compatibility compiler program. Each default-exported callable is analyzed once.

The existing Core APIs remain as projections:

- `extractToolTypesForRoute` maps analyses to `ExtractedToolType`.
- `extractToolSchemasForRoute` maps analyses through the backend-neutral JSON Schema renderer.

Add an internal combined route-analysis entry point so `packages/cli/src/lib/typegen/run-typegen.ts` can obtain type and schema projections from one program rather than calling two independent extractors. CLI verification paths that require only types may continue to use the public projection.

### Vite data flow

`@dawn-ai/vite-plugin` imports the backend-neutral source analyzer and `TypeInfo` from Core's internal compiler subpath. Its transform flow becomes:

1. Ignore non-tool files and tools that already define both exports.
2. Analyze the in-memory source through Core.
3. Project `TypeInfo` to Zod source in the Vite package.
4. Merge normalized property descriptions and parsed `@param` descriptions.
5. Inject only the missing `description` and/or `schema` exports.

Delete Vite's `type-extractor.ts`, `jsdoc-extractor.ts`, and local `type-info.ts` after equivalent Core characterization tests exist. Remove their exports from Vite's root entry point and remove Vite's direct `typescript` dependency. Existing plugin transformation and Zod-generator tests remain behavioral regression coverage.

### Dependency layout

Use TypeScript 7.0.2 as the workspace compiler and in application/example/template dev dependencies.

Core alone declares the compatibility API under the import name its backend uses:

```json
"typescript": "npm:@typescript/typescript6@6.0.2"
```

This is a runtime dependency, not a dev dependency. Published Core code imports `typescript`; package-manager resolution gives Core the compatibility implementation even when the consuming application has TypeScript 7 at its root. The lockfile records the resolved TypeScript 6 implementation.

Vite removes its `typescript` dependency. All other workspace packages use ordinary `typescript@7.0.2` where they invoke `tsc` or expose a generated template. TypeScript versions embedded in devkit templates, generated fixtures, and published-artifact type probes are updated so Dawn's advertised and tested consumer compiler matches the workspace compiler.

### Next.js 16.3 CLI backend

Upgrade these packages to `next@16.3.0` and, where present, matching `@next/mdx@16.3.0`:

- `apps/web`
- `packages/inspector`
- `examples/chat/web`
- `examples/research/web`

Add the following to each Next configuration, preserving all existing options:

```ts
experimental: {
  useTypeScriptCli: true,
}
```

The option is explicit; Next does not automatically choose the CLI backend for TypeScript 7. Next remains responsible for generating `next-env.d.ts`, route types, and recommended configuration before invoking `tsc`.

Inspector keeps externalizing the runtime `typescript` import name because Core continues to import that name. Its standalone output must be inspected and executed to prove npm/package-manager layout includes Core's aliased compatibility implementation without replacing the app's TypeScript 7 CLI.

## Error behavior

- Next CLI diagnostics fail `next build` normally and are not suppressed with `ignoreBuildErrors`.
- A tool source without a callable default export remains non-fatal and produces no analysis.
- Vite transform analysis that produces no supported input remains a no-op, matching current behavior.
- Route typegen continues skipping individual unresolvable tool entries where it does today.
- Missing compatibility packages, missing internal exports, broken packed dependency specs, or compiler backend initialization failures are fatal verification failures.
- Smoke scripts clean temporary directories and child processes in `finally` paths.
- Post-publish registry polling is bounded and reports the exact package/version that failed to become visible.

## Testing and verification

### Baseline

The isolated implementation branch starts from current `main` (`48dbddfb`). Before dependency changes:

- `pnpm build`: 24/24 tasks successful.
- `pnpm test`: 226 files passed, 8 skipped; 1,373 tests passed, 32 skipped.

The TypeScript upgrade is applied during implementation so TDD failures can be distinguished from a known-good starting point.

### Characterization and TDD

Before moving implementation, add failing tests for the new combined analyzer and its intended package boundary. Characterization must include:

- exact nested input/output type strings without truncation;
- primitives, literals, optional values, nullable values, arrays, tuples, records, maps, sets, unions, intersections, enums, aliases, imported and generic types;
- JSON Schema descriptions, required properties, records, object unions, discriminants, and depth fallback;
- default-export and property JSDoc plus `@param` fallback;
- route/shared merging, shadowing, sorting, no-parameter tools, missing exports, and untyped inputs;
- source analysis parity with the current Vite transform;
- a static boundary assertion that Vite has no compiler import or TypeScript dependency.

Each behavior change follows red-green-refactor. Existing Core and Vite tests remain in place until their coverage has moved or is demonstrably redundant.

### Targeted development checks

Run after each relevant slice:

- Core compiler-analysis and route typegen tests.
- Vite plugin transform and Zod tests.
- CLI typegen and verify tests.
- Type checks for Core, Vite, and CLI using the TypeScript 7 executable.
- Individual production builds for all four Next applications.
- Inspector standalone end-to-end tests.

### Full local acceptance

Before completion, run from the repository root:

1. `pnpm ci:validate`
2. the Inspector build plus `DAWN_TEST_INSPECTOR=1` test lane
3. applicable full-arc runtime smoke lanes available locally
4. a clean packed-artifact compiler smoke described below

Docker/Kubernetes gated lanes that cannot run locally remain required CI evidence before merge; their absence is reported rather than inferred.

### Clean packed-artifact compiler smoke

Add a permanent local smoke command to the validation lane after `pack:check`. It:

1. builds and packs Core and Vite;
2. creates a clean temporary npm project;
3. installs the tarballs alongside ordinary `typescript@7.0.2` and required runtime peers;
4. type-checks a consumer import with the TypeScript 7 CLI;
5. writes representative tool files and invokes Core's installed type and schema extraction;
6. invokes the installed Vite plugin transform and evaluates/asserts its generated description and Zod source;
7. proves the consumer compiler remains TypeScript 7 while Core resolves a compiler API that exposes `createProgram` and `createSourceFile`;
8. fails on native install scripts, workspace/file dependency specs, missing exports, or version/layout mismatches;
9. removes its temporary project in all outcomes.

The smoke uses packed artifacts, not workspace source imports, so it detects dependency rewriting and package-layout failures.

### Published-artifact verification

Add a `typescript-tooling` package set containing `@dawn-ai/core`, `@dawn-ai/vite-plugin`, and `@dawn-ai/cli`. Extend the existing published smoke with the same TypeScript 7 compiler/typegen/Vite probe, installed from the requested npm version or dist-tag.

The manual `.github/workflows/published-artifact-verify.yml` exposes `typescript-tooling` as a package-set choice for reruns.

When Changesets reports that a release was published, `.github/workflows/release.yml`:

1. derives the exact fixed-group version from the Changesets published-package output;
2. polls npm with a bounded retry until every TypeScript-tooling package exposes that exact version;
3. runs registry/tarball metadata verification for the exact version;
4. installs and runs the published TypeScript-tooling smoke with TypeScript 7;
5. marks the release workflow failed with package/version-specific diagnostics if any step fails.

Attestation, release asset upload, and tag backfill retain their existing ordering and behavior. The published smoke runs after publication and release bookkeeping; it is an immediate alarm and release-quality record, not a rollback mechanism.

## Documentation and release notes

- Add a patch changeset for affected publishable packages according to the repository's fixed-group rules.
- Describe TypeScript 7 compiler support, the internal TypeScript 6 API bridge, removal of Vite's unsupported extraction helpers, and Next 16.3 CLI adoption.
- Keep the TypeScript 7.1 migration note close to the backend code and in this design; do not promise a date or stable upstream API shape.
- Do not expose `@typescript/typescript6` as an author requirement. It is Core's implementation dependency.

## Completion criteria

The change is complete only when:

- exactly one Dawn source file imports the TypeScript compiler API;
- Vite has no TypeScript dependency and no old extraction-helper exports;
- Core produces existing type, JSON Schema, JSDoc, and Vite Zod behavior from one normalized analysis;
- all four Next applications build on Next 16.3 using the TypeScript CLI backend and TypeScript 7;
- the clean packed-artifact compiler smoke passes locally;
- `pnpm ci:validate` passes;
- Inspector standalone e2e passes;
- required GitHub checks and gated lanes pass;
- after the subsequent npm release, the exact-version published TypeScript-tooling smoke passes.
