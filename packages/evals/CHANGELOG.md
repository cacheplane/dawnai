# @dawn-ai/evals

## 0.8.13

### Patch Changes

- @dawn-ai/testing@0.8.13

## 0.8.12

### Patch Changes

- @dawn-ai/testing@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/testing@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/testing@0.8.10

## 0.8.9

### Patch Changes

- Updated dependencies [ca9bc13]
- Updated dependencies [1dd2147]
  - @dawn-ai/testing@0.8.9

## 0.8.8

### Patch Changes

- Updated dependencies [6fb2b10]
  - @dawn-ai/testing@0.8.8

## 0.8.7

### Patch Changes

- @dawn-ai/testing@0.8.7

## 0.8.6

### Patch Changes

- @dawn-ai/testing@0.8.6

## 0.8.5

### Patch Changes

- cdcda20: Default example/scaffold model is now `gpt-5-mini` (the basic scaffold template, README/package-README examples, landing snippets, AGENTS.md template, prompts, and the `llmJudge` default) — finishing the move off `gpt-4o-mini`. Scaffold templates also pre-approve esbuild's build script (`pnpm.onlyBuiltDependencies`) so `pnpm install` works non-interactively in CI and Docker.
  - @dawn-ai/testing@0.8.5

## 0.8.4

### Patch Changes

- @dawn-ai/testing@0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.
- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/testing@0.8.3

## 0.8.2

### Patch Changes

- Updated dependencies [5372180]
- Updated dependencies [f62b555]
- Updated dependencies [1241d21]
  - @dawn-ai/testing@0.8.2

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
