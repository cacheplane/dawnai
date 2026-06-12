# @dawn-ai/config-typescript

## 0.8.0

### Patch Changes

- 777f3eb: Refresh README files for GTM developer growth: SEO keyword pass and a
  Star/Docs/Discussions CTA band on the root and developer-facing package
  READMEs, doc links repointed to the live dawnai.org site, and READMEs added
  for previously-blank published packages (`workspace`, `permissions`,
  `sqlite-storage`, `testing`, `evals`). Patch bump republishes the packages so
  the updated READMEs render on npm.

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.

## 0.1.8

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.
