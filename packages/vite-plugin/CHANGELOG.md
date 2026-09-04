# @dawn-ai/vite-plugin

## 0.8.24

### Patch Changes

- @dawn-ai/core@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/core@0.8.23

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- d42774e: **Breaking:** scenario files must default export `scenarios("<route>")` from
  `@dawn-ai/sdk/testing`. A plain default-exported array now throws
  `RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
  migrate.

  Add route-scoped fluent `dawn test` scenarios with generated application-tool
  types, invocation-local in-process tool mocks, and declarative mock call
  assertions.

- Updated dependencies [a530e70]
- Updated dependencies [8398c90]
- Updated dependencies [3c68800]
- Updated dependencies [908d690]
- Updated dependencies [d42774e]
  - @dawn-ai/core@0.8.22

## 0.8.21

### Patch Changes

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/core@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/core@0.8.20

## 0.8.19

### Patch Changes

- Updated dependencies [9dde7c6]
  - @dawn-ai/core@0.8.19

## 0.8.18

### Patch Changes

- Updated dependencies [c6b08a9]
  - @dawn-ai/core@0.8.18

## 0.8.17

### Patch Changes

- 1a9ae7b: Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
  to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

  Consolidate tool analysis in Core behind one compiler boundary and program, with shared
  projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
  the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
  API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
  optionality and use a compiler-neutral fallback for collection intersections.

  Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
  and `extractParameterType` exports. Their removal is an intentional breaking change.

  Add permanent packed-consumer and exact-version post-publish verification for the
  TypeScript tooling packages.

- Updated dependencies [713797f]
- Updated dependencies [7f4bce6]
- Updated dependencies [1a9ae7b]
  - @dawn-ai/core@0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [d845720]
- Updated dependencies [2da55fa]
  - @dawn-ai/core@0.8.16

## 0.8.15

### Patch Changes

- Updated dependencies [029a2cf]
  - @dawn-ai/core@0.8.15

## 0.8.14

### Patch Changes

- Updated dependencies [937be0f]
- Updated dependencies [83e5153]
  - @dawn-ai/core@0.8.14

## 0.8.13

### Patch Changes

- Updated dependencies [18df470]
  - @dawn-ai/core@0.8.13

## 0.8.12

### Patch Changes

- Updated dependencies [e413b05]
  - @dawn-ai/core@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/core@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/core@0.8.10

## 0.8.9

### Patch Changes

- Updated dependencies [d3d94af]
- Updated dependencies [1dd2147]
  - @dawn-ai/core@0.8.9

## 0.8.8

### Patch Changes

- Updated dependencies [dd02f56]
- Updated dependencies [5ccae68]
  - @dawn-ai/core@0.8.8

## 0.8.7

### Patch Changes

- Updated dependencies [6a683c8]
  - @dawn-ai/core@0.8.7

## 0.8.6

### Patch Changes

- Updated dependencies [4ede7b8]
- Updated dependencies [1d51b75]
  - @dawn-ai/core@0.8.6

## 0.8.5

### Patch Changes

- Updated dependencies [f195096]
  - @dawn-ai/core@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [4e3e020]
  - @dawn-ai/core@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/core@0.8.3

## 0.8.2

### Patch Changes

- @dawn-ai/core@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [89b2a73]
  - @dawn-ai/core@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Patch Changes

- Updated dependencies [a38ff61]
  - @dawn-ai/core@0.7.0

## 0.6.0

### Patch Changes

- @dawn-ai/core@0.6.0

## 0.5.0

### Patch Changes

- @dawn-ai/core@0.5.0

## 0.4.0

### Patch Changes

- @dawn-ai/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/core@0.3.0

## 0.2.0

### Minor Changes

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- Updated dependencies [17fa4aa]
- Updated dependencies [82dd52f]
- Updated dependencies [8e02fe1]
- Updated dependencies [cfc3e8c]
- Updated dependencies [dd242ac]
- Updated dependencies [c777569]
- Updated dependencies [34e615b]
- Updated dependencies [2ba0773]
- Updated dependencies [affeb46]
- Updated dependencies [12ee95f]
  - @dawn-ai/core@0.2.0

## 0.1.8

### Patch Changes

- @dawn-ai/core@0.1.8

## 0.1.7

### Patch Changes

- @dawn-ai/core@0.1.7

## 0.1.6

### Patch Changes

- @dawn-ai/core@0.1.6

## 0.1.5

### Patch Changes

- @dawn-ai/core@0.1.5

## 0.1.4

### Patch Changes

- @dawn-ai/core@0.1.4

## 0.1.3

### Patch Changes

- @dawn-ai/core@0.1.3

## 0.1.2

### Patch Changes

- @dawn-ai/core@0.1.2

## 0.0.3

### Patch Changes

- Updated dependencies [fbe7770]
  - @dawn-ai/core@0.1.0

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/core@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/core@0.0.1
