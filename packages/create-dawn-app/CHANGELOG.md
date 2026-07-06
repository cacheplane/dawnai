# create-dawn-ai-app

## 0.8.6

### Patch Changes

- @dawn-ai/devkit@0.8.6

## 0.8.5

### Patch Changes

- @dawn-ai/devkit@0.8.5

## 0.8.4

### Patch Changes

- @dawn-ai/devkit@0.8.4

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
  - @dawn-ai/devkit@0.8.3

## 0.8.2

### Patch Changes

- @dawn-ai/devkit@0.8.2

## 0.8.1

### Patch Changes

- 306380e: Fix test-harness scenario isolation. `createAgentHarness().reset()` now clears
  the accumulated aimock fixtures (restoring the constructor baseline) instead of
  only swapping the thread id. Previously fixtures were registered additively and
  aimock's matcher is first-match-in-array-order, so a loosely-matched fixture
  from an earlier scenario (a raw `FixtureSet` without a `userMessage`, e.g. the
  offload pattern) could shadow a later run's first model call. This surfaced as a
  HITL permission interrupt that "only fired on the first run." The research
  scaffold's HITL test now shares one harness with `reset()` between tests instead
  of constructing a dedicated one.
- Updated dependencies [306380e]
  - @dawn-ai/devkit@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

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
