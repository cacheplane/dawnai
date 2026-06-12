# create-dawn-app

## 0.7.0

### Minor Changes

- 16268a6: Add a "research" scaffold template — a deep-research assistant that showcases
  Dawn's broad capability set (planning, subagents, custom tools + typegen,
  tool-output offloading, AGENTS.md memory, skills, HITL permissions, workspace,
  persistence, tests, and evals) — and make it the default `create-dawn-ai-app`
  output. It runs offline and deterministically out of the box (replay fixtures)
  and against a real model under `--live`. The minimal "basic" template remains
  available via `--template basic`.

### Patch Changes

- c35ccba: The research scaffold template now defaults to the `gpt-5-mini` model (was `gpt-4o-mini`) for its coordinator, researcher subagent, and eval judge.
- Updated dependencies [c35ccba]
- Updated dependencies [16268a6]
  - @dawn-ai/devkit@0.7.0

## 0.6.0

### Minor Changes

- 95ae2f9: `create-dawn-ai-app` now scaffolds a sample `@dawn-ai/evals` eval (`evals/smoke.eval.ts`) plus an `eval` script in new apps, alongside the existing `@dawn-ai/testing` sample test, so a freshly scaffolded app can run `dawn eval` out of the box.

### Patch Changes

- Updated dependencies [95ae2f9]
  - @dawn-ai/devkit@0.6.0

## 0.5.0

### Patch Changes

- @dawn-ai/devkit@0.5.0

## 0.4.0

### Minor Changes

- 1387bd5: `create-dawn-ai-app` now scaffolds a working `test/agent.test.ts` in new apps: it imports `@dawn-ai/testing`, adds it (plus `vitest`) to devDependencies, and wires a `"test": "vitest run"` script. The sample drives the generated `hello/[tenant]` agent route through `createAgentHarness` with an inline `script()` fixture, so a freshly scaffolded app has a passing, CI-safe agent test out of the box. This was deferred until `@dawn-ai/testing` was published to npm (now at 1.0.0).

### Patch Changes

- Updated dependencies [1387bd5]
  - @dawn-ai/devkit@0.4.0

## 0.3.0

### Patch Changes

- @dawn-ai/devkit@0.3.0

## 0.2.0

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- Updated dependencies [82dd52f]
  - @dawn-ai/devkit@0.2.0

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
