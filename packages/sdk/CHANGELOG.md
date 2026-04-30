# @dawn-ai/sdk

## 0.1.0

### Minor Changes

- 1034806: Fix workspace:\* protocol leaking into published package dependencies.
  Republish with resolved version specifiers.

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.
