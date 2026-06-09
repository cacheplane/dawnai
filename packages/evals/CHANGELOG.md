# @dawn-ai/evals

## 2.0.0

### Patch Changes

- @dawn-ai/testing@4.0.0

## 1.0.0

### Minor Changes

- b4a2295: Add eval authoring: a new `@dawn-ai/evals` package (`defineEval`, built-in + `custom` + `llmJudge` scorers, composable `gate.*` policies, `dataset` as array/path/function) and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores. Default execution is deterministic replay (per-case aimock fixtures, CI-safe); `dawn eval --live` runs the real model locally (gated on `OPENAI_API_KEY`, never in CI). Evals are discovered from `src/app/<route>/evals/*.eval.ts`, mirroring the `run.test.ts` convention.

### Patch Changes

- @dawn-ai/testing@3.0.0
