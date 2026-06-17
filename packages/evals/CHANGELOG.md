# @dawn-ai/evals

## 0.8.1

### Patch Changes

- Updated dependencies [306380e]
  - @dawn-ai/testing@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward. This package is renumbered down from its previous independent 3.x line; the old higher versions were removed from npm.

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
