# create-dawn-app

## 1.0.0

### Patch Changes

- @dawn-ai/devkit@1.0.0

## 0.1.8

### Patch Changes

- @dawn-ai/devkit@0.1.8

## 0.1.7

### Patch Changes

- db635b1: Docs overhaul.

  - **Public package READMEs** (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`) fleshed out with overview, install, key APIs, and links to the website.
  - All package READMEs include the Dawn brand image header.

  No code or runtime behavior changes — README content only.

  - @dawn-ai/devkit@0.1.7

## 0.1.6

### Patch Changes

- @dawn-ai/devkit@0.1.6

## 0.1.5

### Patch Changes

- @dawn-ai/devkit@0.1.5

## 0.1.4

### Patch Changes

- @dawn-ai/devkit@0.1.4

## 0.1.3

### Patch Changes

- @dawn-ai/devkit@0.1.3

## 0.1.2

### Patch Changes

- @dawn-ai/devkit@0.1.2

## 0.0.4

### Patch Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

- Updated dependencies [fbe7770]
  - @dawn-ai/devkit@0.0.4

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/devkit@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/devkit@0.0.1
