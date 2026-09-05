# create-dawn-ai-app

## 0.8.26

### Patch Changes

- @dawn-ai/devkit@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/devkit@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/devkit@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [21654e8]
- Updated dependencies [7e62bb1]
  - @dawn-ai/devkit@0.8.23

## 0.8.22

### Patch Changes

- 95abcf5: Expose Dawn planning and subagent progress as bounded standard AG-UI activity
  snapshots. The research web example renders plan checklists and delegated-work
  status from those snapshots, which exclude child prose, prompts, tool inputs,
  tool outputs, and final child answers. The generated research starter renders these
  activities in the web client it ships.
- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- 0bf4ed9: Leave CopilotKit telemetry off in a scaffolded app.

  CopilotKit's runtime reports usage by default, so `npm run build` on a freshly
  generated app POSTed to `https://telemetry.copilotkit.ai/ingest` while Next
  collected page data — before the author had written a line of code. The
  generated `web/next.config.mjs` now sets `COPILOTKIT_TELEMETRY_DISABLED` unless
  the environment already says otherwise, so opting back in is still one variable
  away.

  The placement is the fix, not a detail. CopilotKit builds its telemetry client
  at module scope and reads the environment inside that constructor, and ESM
  evaluates imports before the importing module's body — so setting this in the
  route handler that imports the runtime would look correct and change nothing.
  `next.config.mjs` is the first module Next evaluates, for `next build`,
  `next dev` and `next start` alike.

- 56d2758: Scaffold the Dawn Workbench alongside the agent.

  `npm create dawn-ai-app` now generates a two-package npm workspace instead of a
  flat server-only app. `server/` holds everything that used to sit at the project
  root and runs on port 3002; `web/` is the Dawn Workbench — a Next 16 client with
  a thread rail, a streaming transcript, plan and subagent activity cards, tool
  cards, permission prompts that survive a reload, a memory-candidate panel, and a
  connect screen — on port 3010. One `npm install` at the root installs both, and
  the root scripts delegate into the package that owns each job.

  The template's web tree mirrors `examples/research/web` under a parity guard that
  compares the two trees byte-for-byte, so the shipped scaffold cannot drift from
  the example it is dogfooded against.

  Two fixes fall out of the restructure. `dawn verify`'s dependency probe now walks
  parent `node_modules` directories the way Node itself resolves, so hoisted
  workspace dependencies are no longer reported as missing. And the generated web
  package ships an ambient CSS declaration, so `npm run typecheck` succeeds on a
  freshly scaffolded app rather than only after a build has generated Next's own
  type declarations.

- 8ec1cfa: Point new users at a UI after scaffolding. The research template's next steps
  name `npx dawn inspect` (the Inspector the template already installs), and the
  basic template no longer points at a README it does not ship.
- 1f5f3f8: The research scaffold gains a complete npm lifecycle (`install` → `verify` →
  `dev`) and an explicit `.env` handoff, and its AG-UI wiring is checked against
  the packaged build.
- Updated dependencies [95abcf5]
- Updated dependencies [bedad77]
- Updated dependencies [0bf4ed9]
- Updated dependencies [56d2758]
- Updated dependencies [8ec1cfa]
- Updated dependencies [d42774e]
- Updated dependencies [1f5f3f8]
  - @dawn-ai/devkit@0.8.22

## 0.8.21

### Patch Changes

- @dawn-ai/devkit@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/devkit@0.8.20

## 0.8.19

### Patch Changes

- @dawn-ai/devkit@0.8.19

## 0.8.18

### Patch Changes

- Updated dependencies [7088072]
  - @dawn-ai/devkit@0.8.18

## 0.8.17

### Patch Changes

- Updated dependencies [1a9ae7b]
  - @dawn-ai/devkit@0.8.17

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
- Updated dependencies [2da55fa]
- Updated dependencies [3b8ffd5]
  - @dawn-ai/devkit@0.8.16

## 0.8.15

### Patch Changes

- @dawn-ai/devkit@0.8.15

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

- Updated dependencies [937be0f]
  - @dawn-ai/devkit@0.8.14

## 0.8.13

### Patch Changes

- a7e4ced: Improve the getting-started experience for scaffolded apps. `create-dawn-app`
  now prints next-steps guidance after creating an app (cd / install / test / run
  it live), the templates gain a `dev` script (`dawn dev --port 3000`) so you can
  actually run the agent, and the research template README shows the live path
  (ask a question via `/agui`) plus a pointer to the web-UI recipe.
- Updated dependencies [a7e4ced]
  - @dawn-ai/devkit@0.8.13

## 0.8.12

### Patch Changes

- @dawn-ai/devkit@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/devkit@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/devkit@0.8.10

## 0.8.9

### Patch Changes

- @dawn-ai/devkit@0.8.9

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

- Updated dependencies [6fb2b10]
  - @dawn-ai/devkit@0.8.8

## 0.8.7

### Patch Changes

- ef2e583: Fix fresh scaffolds failing `npm install`: the app templates pinned `zod@^3.24.0` while `@dawn-ai/sdk` declares an optional peer of `zod@^4`, which npm's strict peer resolution rejects (ERESOLVE) on every new app. Templates now scaffold `zod@^4.0.0` (the template code uses only APIs present in both majors, and `@langchain/core` accepts `^3.25.76 || ^4`).
- Updated dependencies [ef2e583]
  - @dawn-ai/devkit@0.8.7

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
