# Root `AGENTS.md` — design

**Date:** 2026-07-12
**Status:** approved (brainstorm)
**Topic:** A canonical repo-root `AGENTS.md` — one standards doc (workspace map + Definition of Done + conventions) for human contributors and coding agents.

## Problem

Contributor/agent standards are scattered and incomplete:
- `CONTRIBUTING.md` — public PR path (setup, `pnpm ci:validate`, build-before-`dist`, changesets, CLA/DCO). Good but not agent-oriented and has no package map.
- `CONTRIBUTORS.md` — internal monorepo guide with per-package responsibilities for only ~8 of 19 packages, the `--mode internal` scaffold path, verification lanes.
- The high-value **conventions** (patch/fixed-group changesets, `exactOptionalPropertyTypes` spreads, never bare `biome check --write`, `src`→`.js`/`test`→`.ts` imports, gpt-5-only examples, branch-per-PR, banned doc phrases) live **only in dated `docs/superpowers/plans/*` files** — invisible to a new contributor or a coding agent.

There is **no root `AGENTS.md`**, which is the emerging convention coding agents look for at repo root.

**Name-collision hazard (must be addressed):** Dawn ships a runtime capability (`packages/core/src/capabilities/built-in/agents-md.ts`) that injects an *app's* `<appRoot>/workspace/AGENTS.md` into the agent's system prompt as "# Memory". ~10 such runtime files exist under `examples/*/server/workspace/`, `packages/devkit/templates/*`, `apps/web/`. A repo-root contributor `AGENTS.md` means something completely different. The doc must open by stating this distinction.

## Goal

A single `AGENTS.md` at repo root that is the canonical entrypoint for "how to work in this repo," linked from `README.md`, `CONTRIBUTING.md`, and `CONTRIBUTORS.md`. It does not replace those two (per decision — keep all three, cross-link); it consolidates the map + DoD + conventions that currently have no home.

## Non-goals

- Not deleting or rewriting `CONTRIBUTING.md`/`CONTRIBUTORS.md` (they keep their roles; we add cross-links and, where `CONTRIBUTORS.md`'s partial package list overlaps, point it at the AGENTS.md map rather than maintaining two divergent lists).
- Not documenting the runtime `workspace/AGENTS.md` capability beyond the one-paragraph disambiguation (that's `/docs/*` territory).
- Not a tutorial (that's `getting-started.mdx`).

## Structure of `AGENTS.md`

1. **What this file is (and isn't)** — repo-root contributor/agent standards. Explicit callout: *not* the runtime `workspace/AGENTS.md` agent-memory feature (link to the sandbox/capabilities docs for that).
2. **Workspace map** — all 19 packages grouped, `name → one-line purpose` (from each package's README first line):
   - Core framework: `@dawn-ai/sdk`, `@dawn-ai/core`, `@dawn-ai/cli`, `@dawn-ai/langgraph`, `@dawn-ai/langchain`
   - Capabilities/integrations: `@dawn-ai/ag-ui`, `@dawn-ai/permissions`, `@dawn-ai/workspace`, `@dawn-ai/sandbox`, `@dawn-ai/vite-plugin`
   - Storage/memory: `@dawn-ai/memory`, `@dawn-ai/memory-pgvector`, `@dawn-ai/sqlite-storage`
   - Testing/evals: `@dawn-ai/testing`, `@dawn-ai/evals`
   - Scaffolding/tooling: `create-dawn-ai-app`, `@dawn-ai/devkit`, `@dawn-ai/config-typescript`, `@dawn-ai/config-biome`
   - Apps: `@dawn-ai/web`
   - Examples: `@dawn-example/chat`, `examples/memory`, `@dawn-example/research`
   - Charts (not pnpm members): `dawn-app`, `dawn-sandbox-infra`
   - Note: `test/` and `scripts/` are repo-level, not workspace packages.
3. **Definition of Done** — the exact gates a change must pass, derived from `.github/workflows/ci.yml` `validate` job: `pnpm lint` · `check:build-cache` · `pnpm build` · `pnpm typecheck` · `pnpm test` · `check-docs` · `pack:check` · `verify:harness:{self-test,framework,runtime,smoke}`; plus the `changesets` gate (PRs). Note the gated lanes (`sandbox-docker`, `pgvector-docker`, `sandbox-k8s`, `*-e2e`, `chart-*`) and that they run behind env flags. State the one-liner: run `pnpm ci:validate` locally to approximate the DoD.
4. **Conventions (promoted to first-class)** — each a short rule + why:
   - Changesets: the publishable set is a **fixed group** — on 0.x a `minor` bumps everyone to 1.0.0, so use `patch` unless intentionally releasing 1.0.
   - `exactOptionalPropertyTypes: true` → conditional-spread optionals, never `{ x: undefined }`.
   - Never bare `biome check --write` (mass-reformats); use `pnpm lint` or scope to changed files.
   - `src/` imports use `.js` specifiers, `test/` uses `.ts` (NodeNext ESM).
   - Any `model:` example in docs/examples/scaffolds must be **gpt-5 family** (`check-docs.mjs` enforces).
   - Branch per PR; when dispatching parallel agents, pin the branch first (multi-worktree detached-HEAD hazard).
   - Build before running anything against `dist/` (link to `CONTRIBUTING.md`'s section rather than re-deriving).
   - Banned doc phrases (`check-docs.mjs` greps them out) — link to the list.
   - Always run commands from the repo root (Turbo/workspace resolution).
5. **Where things live / how to find them** — one-liners: docs site (`apps/web/content/docs/*.mdx`), specs+plans (`docs/superpowers/`), CI (`.github/workflows/ci.yml`), changeset config (`.changeset/config.json`).
6. **Cross-links** — `CONTRIBUTING.md` (PR/CLA), `CONTRIBUTORS.md` (scaffold-internal path + local setup), `README.md`.

## Maintenance / drift control

The workspace map and DoD can drift as packages/CI change. Two low-cost guards (either/both, decided at plan time):
- A `scripts/check-agents-md.mjs` (optional, added to the `validate` lane) that asserts every `packages/*` dir appears in the AGENTS.md map and every `validate`-job step name appears in the DoD section. This keeps the doc honest automatically.
- At minimum, a comment in `AGENTS.md` pointing maintainers to update it when adding a package or a CI gate.

Recommendation: ship the doc first; add the check as a fast-follow only if drift proves real (YAGNI).

## Testing

- `node scripts/check-docs.mjs` still passes (AGENTS.md is not under `apps/web/content/docs`, so it's not part of the site nav topology — confirm the docs-check doesn't require registration for a root markdown file).
- If the optional `check-agents-md.mjs` guard is built, it gets a unit test (fixture repo dir → asserts pass/fail on a missing package/gate).
- Links in `AGENTS.md` resolve (manual + the guard if built).

## Rollout

Single PR: `AGENTS.md` + the three cross-links (`README.md`, `CONTRIBUTING.md`, `CONTRIBUTORS.md`). No changeset (no `packages/**` change). Smallest, zero-runtime-risk of the three DX follow-ups — good first.
