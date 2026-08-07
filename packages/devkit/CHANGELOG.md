# @dawn-ai/devkit

## 0.8.18

### Patch Changes

- 7088072: Fix two defects found smoke-testing the published 0.8.17 artifacts.

  **`dawn memory` subcommand flags were rejected by the CLI.** `memory` is registered as
  `memory [subcommand] [args...]`, and commander claimed every `--flag` after the
  subcommand for itself — so each one failed with `error: unknown option` before the
  handler that parses it ever ran. This made every documented subcommand flag unusable
  from the real CLI: `prune --cap`, `prune --namespace`, and all five distillation flags
  (`--dry-run`, `--namespace`, `--model`, `--provider`, `--max-batches`), including the
  `--dry-run` the cron recipe recommends for a zero-cost plan. The `prune` flags have been
  broken since they were introduced; the distillation flags since 0.8.17.

  The command now uses `passThroughOptions()` (with `enablePositionalOptions()` on the
  program, which commander requires for it). The flags reached the handler correctly all
  along — the repo's tests called `runMemoryCommand([...])` directly and so never crossed
  commander's parsing layer. Added tests that drive the real program.

  **A fresh `create-dawn-ai-app` research app failed `npm test` out of the box.** The
  research template's `test/research.test.ts.template` is kept byte-identical to the
  dogfooded `examples/research/server/test/research.test.ts`, but the Memory Inspector
  change that reworded CLI approve output to `approved <id> (activated)` updated only the
  example. The template kept asserting `Approved: <id>`, so the default template — the one
  whose generated README tells users to run `npm test` — shipped a failing suite from
  0.8.14 through 0.8.17. Fixed the assertion and added a parity test asserting the shared
  test files stay identical, so the example can no longer be fixed without the template.

## 0.8.17

### Patch Changes

- 1a9ae7b: Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
  to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

  Consolidate tool analysis in Core behind one compiler boundary and program, with shared
  projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
  the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
  API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
  optionality and use a compiler-neutral fallback for collection intersections.

  Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
  and `extractParameterType` exports. Their removal is an intentional breaking change.

  Add permanent packed-consumer and exact-version post-publish verification for the
  TypeScript tooling packages.

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- 3b8ffd5: Scaffold templates now pin `vitest` with a caret (`^4.1.10`) instead of an exact
  stale version. The old exact `4.1.4` pin made fresh `npm install`s crash with
  npm's arborist `edgesOut` bug after an upstream peer-landscape change (vitest
  ≤4.1.9 became uninstallable under npm's strict peer resolution) — a failure
  mode a caret range rides out automatically. Existing broken scaffolds can fix
  themselves with `npm install --legacy-peer-deps` or by bumping `vitest` to
  `^4.1.10`.

## 0.8.15

## 0.8.14

### Patch Changes

- 937be0f: New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
  Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
  memories with supersede-aware approval. Ships as a scaffold devDependency.

  BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
  must implement them (the built-in sqlite/pgvector stores already do, and
  `runMemoryStoreConformance` enforces the contract). The config-facing store type is
  now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
  contradicting active row instead of leaving two actives.

## 0.8.13

### Patch Changes

- a7e4ced: Improve the getting-started experience for scaffolded apps. `create-dawn-app`
  now prints next-steps guidance after creating an app (cd / install / test / run
  it live), the templates gain a `dev` script (`dawn dev --port 3000`) so you can
  actually run the agent, and the research template README shows the live path
  (ask a question via `/agui`) plus a pointer to the web-UI recipe.

## 0.8.12

## 0.8.11

## 0.8.10

## 0.8.9

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

## 0.8.7

### Patch Changes

- ef2e583: Fix fresh scaffolds failing `npm install`: the app templates pinned `zod@^3.24.0` while `@dawn-ai/sdk` declares an optional peer of `zod@^4`, which npm's strict peer resolution rejects (ERESOLVE) on every new app. Templates now scaffold `zod@^4.0.0` (the template code uses only APIs present in both majors, and `@langchain/core` accepts `^3.25.76 || ^4`).

## 0.8.6

## 0.8.5

## 0.8.4

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

## 0.8.2

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

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

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

## 0.6.0

### Patch Changes

- 95ae2f9: `create-dawn-ai-app` now scaffolds a sample `@dawn-ai/evals` eval (`evals/smoke.eval.ts`) plus an `eval` script in new apps, alongside the existing `@dawn-ai/testing` sample test, so a freshly scaffolded app can run `dawn eval` out of the box.

## 0.5.0

## 0.4.0

### Patch Changes

- 1387bd5: `create-dawn-ai-app` now scaffolds a working `test/agent.test.ts` in new apps: it imports `@dawn-ai/testing`, adds it (plus `vitest`) to devDependencies, and wires a `"test": "vitest run"` script. The sample drives the generated `hello/[tenant]` agent route through `createAgentHarness` with an inline `script()` fixture, so a freshly scaffolded app has a passing, CI-safe agent test out of the box. This was deferred until `@dawn-ai/testing` was published to npm (now at 1.0.0).

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

## 0.0.4

### Patch Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

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
