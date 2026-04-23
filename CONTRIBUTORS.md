# Contributors

## Overview

This guide is for engineers working inside the Dawn monorepo. It covers the current repo layout, package boundaries, local setup, verification commands, and where the living documentation lives.

## Repository Layout

- `apps/web` contains the documentation website and user-facing docs pages.
- `packages/*` contains the publishable packages and internal workspace packages that implement Dawn.
- `test/*` contains repo-level verification lanes, including runtime, generated-app, and smoke coverage.
- `scripts/*` contains workspace scripts for validation, harness reporting, smoke checks, and packaging checks.
- `docs/*` contains the design specs, implementation plans, and other superpowers-era project history.

## Package Responsibilities

- `@dawnai.org/core` owns app discovery, config loading, validation, and route type generation.
- `@dawnai.org/sdk` owns the backend-neutral author-facing contract: types, helpers, runtime context, and tool authoring.
- `@dawnai.org/langgraph` is the LangGraph adapter that implements the `@dawnai.org/sdk` contract and wires it to LangGraph.
- `@dawnai.org/cli` owns the user-facing commands and the local runtime behavior.
- `create-dawn-app` owns app scaffolding.
- `@dawnai.org/devkit` owns shared template and file-generation helpers.
- `@dawnai.org/config-typescript` and `@dawnai.org/config-biome` own the shared workspace configuration packages.

## Local Setup

- Use Node `>=22.12.0`.
- Run `pnpm install` from the repo root.
- Run root workspace commands from the repo root so Turbo, harness scripts, and docs checks resolve the workspace correctly.

## Contributor-Local Scaffold Path

For local authoring work, the canonical contributor-local path is:

```bash
pnpm --filter create-dawn-app build
node packages/create-dawn-app/dist/index.js ../my-dawn-app --mode internal
cd ../my-dawn-app
pnpm install
```

From that generated app root, the supported contributor-local commands are:

```bash
pnpm exec dawn verify
pnpm exec dawn run "src/app/(public)/hello/[tenant]"
pnpm exec dawn test
pnpm exec dawn dev
```

The generated `basic` app now demonstrates the route authoring lane with:

- `src/app/(public)/hello/[tenant]/index.ts`
- `src/app/(public)/hello/[tenant]/tools/greet.ts`

Use this path only when you intentionally want the generated app wired to the local Dawn checkout. The public user path remains `pnpm create dawn-app`.

## Common Commands

- `pnpm lint` runs Biome and package lint tasks.
- `pnpm typecheck` runs the workspace type checks.
- `pnpm test` runs the workspace test entrypoint.
- `pnpm build` builds the workspace packages.
- `pnpm ci:validate` runs the full repository validation sequence.
- `pnpm verify:harness` runs the framework, runtime, and smoke harness reports together.
- `node scripts/publish-smoke.mjs` runs the publish smoke check.
- `node scripts/check-docs.mjs` checks that the website docs contain the required current-copy text.

## Verification And Test Lanes

The repo uses a layered verification model:

- Package and CLI tests run under Vitest inside the relevant package workspaces.
- `verify:harness:framework` covers the framework lane.
- `verify:harness:runtime` covers the runtime contract lane.
- `verify:harness:smoke` covers the smoke lane.
- Generated and packaged app verification lives under the generated and packaged-app test surfaces.
- `node scripts/publish-smoke.mjs` checks the publishable package surface before release.

Treat these lanes as distinct: package tests prove package behavior, harness lanes prove repo-level runtime behavior, and publish smoke proves the distribution surface.

## Documentation Sources

- Root docs (`README.md` and this file) are the primary repo entrypoints.
- Package `README.md` files document package-local behavior.
- The website under `apps/web` is the user-facing long-form docs surface.
- `docs/superpowers` contains the design specs, implementation plans, and implementation history for the current work.

## Working Expectations

- Keep changes scoped to the package or lane they affect.
- Do not use root docs to describe planned behavior as if it already exists.
- Keep command examples and repo guidance aligned with the current workspace scripts.
- Prefer the narrowest change that preserves the current contract and verification model.
