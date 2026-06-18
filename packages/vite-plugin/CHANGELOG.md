# @dawn-ai/vite-plugin

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
