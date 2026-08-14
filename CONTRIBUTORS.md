# Contributors

## Overview

This guide is for engineers working inside the Dawn monorepo. It covers the current repo layout, package boundaries, local setup, verification commands, and where the living documentation lives.

Canonical standards (workspace map, Definition of Done, and conventions) live in [AGENTS.md](./AGENTS.md); see that first.

## Repository Layout

- `apps/web` contains the documentation website and user-facing docs pages.
- `packages/*` contains the publishable packages and internal workspace packages that implement Dawn.
- `test/*` contains repo-level verification lanes, including runtime, generated-app, and smoke coverage.
- `scripts/*` contains workspace scripts for validation, harness reporting, smoke checks, and packaging checks.
- `docs/*` contains the design specs, implementation plans, and other superpowers-era project history.

## Package Responsibilities

See the [workspace map in AGENTS.md](./AGENTS.md#workspace-map) for the full,
current list of all 19 `packages/*` plus apps, examples, and charts — this
section used to duplicate a partial list and drifted out of date. Keep the
map in `AGENTS.md` current when a package is added or its scope changes;
don't re-list packages here.

## Local Setup

- Use Node `>=22.12.0`.
- Run `pnpm install` from the repo root.
- Run root workspace commands from the repo root so Turbo, harness scripts, and docs checks resolve the workspace correctly.

## Contributor-Local Scaffold Path

For local authoring work, the canonical contributor-local path is:

```bash
pnpm --filter create-dawn-ai-app build
node packages/create-dawn-app/dist/bin.js ../my-dawn-app --mode internal
cd ../my-dawn-app
pnpm install
```

From that generated app root, the supported contributor-local commands are:

```bash
pnpm exec dawn verify
echo '{"tenant":"acme"}' | pnpm exec dawn run '/hello/[tenant]'
pnpm exec dawn test
pnpm exec dawn dev
```

The generated `basic` app now demonstrates the route authoring lane with:

- `src/app/(public)/hello/[tenant]/index.ts`
- `src/app/(public)/hello/[tenant]/tools/greet.ts`

Use this path only when you intentionally want the generated app wired to the local Dawn checkout. The public user path remains `pnpm create dawn-ai-app`.

## Common Commands

- `pnpm lint` runs Biome and package lint tasks.
- `pnpm typecheck` runs the workspace type checks.
- `pnpm test` runs the workspace test entrypoint.
- `pnpm build` builds the workspace packages.
- `pnpm ci:validate` runs the full repository validation sequence.
- `pnpm verify:harness` runs the framework, runtime, and smoke harness reports together.
- `node scripts/publish-smoke.mjs` runs the publish smoke check.
- `node scripts/check-docs.mjs` checks that the website docs contain the required current-copy text.

## Brand assets

- Rebuild the README demo gif with `./docs/brand/build-gif.sh` (requires `brew install vhs`). The script scaffolds a temp app, starts `node docs/brand/stub-openai.mjs --fixture docs/brand/quickstart-fixture.json --port 4317`, and runs `vhs docs/brand/quickstart.tape`. See [docs/brand/README.md](./docs/brand/README.md) for details and the fixture-recapture flow.

## Verification And Test Lanes

The repo uses a layered verification model:

- Package and CLI tests run under Vitest inside the relevant package workspaces.
- `verify:harness:framework` covers the framework lane.
- `verify:harness:runtime` covers the runtime contract lane.
- `verify:harness:smoke` covers the smoke lane.
- Generated and packaged app verification lives under the generated and packaged-app test surfaces.
- `node scripts/publish-smoke.mjs` checks the publishable package surface before release.

Treat these lanes as distinct: package tests prove package behavior, harness lanes prove repo-level runtime behavior, and publish smoke proves the distribution surface.

## Release Integrity Coverage

`pnpm test:release-controller` pins the release path. It is worth knowing exactly how far that pin reaches, because the answer is narrower than "the release is pinned":

- **Workflow structure and command lines are pinned.** `scripts/release/test/fixtures/workflow-entrypoints.json` and `workflow-safe-executables.json` record every workflow's jobs, steps, and `run:` bodies byte-for-byte, and `scripts/release/preflight.mjs` re-checks `.github/workflows/release.yml` against its own expected shape before a release publishes. Drift fails closed, and there is no regeneration script: an intended edit has to be transcribed into the fixture and reviewed.
- **The bytes of the four scripts `release.yml` runs are pinned.** `scripts/release/test/fixtures/release-script-hashes.json` records the SHA256 of `scripts/backfill-release-tags.mjs`, `scripts/release-publish.mjs`, `scripts/sync-chart-appversion.mjs`, and `scripts/upload-release-assets.mjs`. Two are `run:` steps; the other two are reached through the changesets action's `publish:` and `version:` inputs. Editing any of them fails the release-controller suite until its hash is updated in the same commit, so the diff is reviewed as a release-integrity change rather than landing invisibly behind an already-audited command line.
- **A fifth script cannot join `release.yml` unpinned.** The suite re-derives which repository scripts `release.yml` reaches, by both routes a script can enter it — a literal `scripts/...` path in a `run:` body or in an action `with:` input, and a `pnpm <name>` input resolved one step through `package.json` — and requires that set to equal the pinned set exactly. Commands it cannot follow fail rather than being skipped: a `run:` step may only invoke the pnpm scripts named in its audited list, and a `with:` input that names an unknown pnpm script, or one that resolves to something with no visible script path, is reported. It does **not** follow the pnpm scripts inside `run:` bodies (`ci:validate`, `published:verify`, `published:smoke`), so editing one of *those* package.json entries to reach a new script is not caught here — review is what covers that.
- **In-repo scripts generally are not pinned.** Everything else under `scripts/` — including `check-docs.mjs`, `check-changesets.mjs`, and `prime-kind-cache.sh`, which run in CI rather than in the release — is covered by branch protection and review, not by a content hash.

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
