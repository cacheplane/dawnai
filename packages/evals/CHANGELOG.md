# @dawn-ai/evals

## 4.0.0

### Patch Changes

- 777f3eb: Refresh README files for GTM developer growth: SEO keyword pass and a
  Star/Docs/Discussions CTA band on the root and developer-facing package
  READMEs, doc links repointed to the live dawnai.org site, and READMEs added
  for previously-blank published packages (`workspace`, `permissions`,
  `sqlite-storage`, `testing`, `evals`). Patch bump republishes the packages so
  the updated READMEs render on npm.
- Updated dependencies [777f3eb]
  - @dawn-ai/testing@6.0.0

## 3.0.0

### Patch Changes

- Updated dependencies [2be46a4]
  - @dawn-ai/testing@5.0.0

## 2.0.0

### Patch Changes

- @dawn-ai/testing@4.0.0

## 1.0.0

### Minor Changes

- b4a2295: Add eval authoring: a new `@dawn-ai/evals` package (`defineEval`, built-in + `custom` + `llmJudge` scorers, composable `gate.*` policies, `dataset` as array/path/function) and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores. Default execution is deterministic replay (per-case aimock fixtures, CI-safe); `dawn eval --live` runs the real model locally (gated on `OPENAI_API_KEY`, never in CI). Evals are discovered from `src/app/<route>/evals/*.eval.ts`, mirroring the `run.test.ts` convention.

### Patch Changes

- @dawn-ai/testing@3.0.0
