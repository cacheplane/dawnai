# @dawn-ai/cli

## 0.1.4

### Patch Changes

- 86e24c0: Switch to pure OIDC trusted publishing (no npm token required)
  - @dawn-ai/core@0.1.4
  - @dawn-ai/langchain@0.1.4
  - @dawn-ai/langgraph@0.1.4

## 0.1.3

### Patch Changes

- 78745f6: chore: validate trusted publishing pipeline
  - @dawn-ai/core@0.1.3
  - @dawn-ai/langchain@0.1.3
  - @dawn-ai/langgraph@0.1.3

## 0.1.2

### Patch Changes

- Fix watch-mode typegen not picking up file changes due to ESM import cache
  - @dawn-ai/core@0.1.2
  - @dawn-ai/langchain@0.1.2
  - @dawn-ai/langgraph@0.1.2

## 0.1.0

### Minor Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

### Patch Changes

- Updated dependencies [fbe7770]
  - @dawn-ai/core@0.1.0

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/core@0.0.2
  - @dawn-ai/langchain@0.0.2
  - @dawn-ai/langgraph@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/core@0.0.1
  - @dawn-ai/langchain@0.0.1
  - @dawn-ai/langgraph@0.0.1
