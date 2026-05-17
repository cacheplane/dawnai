# @dawn-ai/vite-plugin

## 1.0.0

### Minor Changes

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).

### Patch Changes

- Updated dependencies [dd242ac]
- Updated dependencies [34e615b]
- Updated dependencies [2ba0773]
- Updated dependencies [affeb46]
- Updated dependencies [12ee95f]
  - @dawn-ai/core@1.0.0

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
