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
node packages/create-dawn-app/dist/bin.js ../my-dawn-app --mode internal --template basic
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

The generated `basic` app is a single flat package, and demonstrates the route authoring lane with:

- `src/app/(public)/hello/[tenant]/index.ts`
- `src/app/(public)/hello/[tenant]/tools/greet.ts`

Drop `--template basic` to scaffold the default `research` app instead. That one is a two-package workspace (`server/` holds the Dawn app, `web/` the Dawn Workbench UI), so the Dawn CLI runs from `server/` rather than the generated root, and the root `package.json` scripts delegate there for you.

Use this path only when you intentionally want the generated app wired to the local Dawn checkout. The public user path remains `pnpm create dawn-ai-app`.

## Common Commands

- `pnpm lint` runs Biome and package lint tasks.
- `pnpm typecheck` runs the workspace type checks.
- `pnpm test` runs the workspace test entrypoint.
- `pnpm build` builds the workspace packages.
- `pnpm test:release-integrity` runs content pins and recovery-policy checks after installation, without a build. CI and local validation run this preflight before expensive checks; the complete controller suite still runs later.
- `pnpm ci:validate` runs the full repository validation sequence locally. CI runs source, controller, packaging, and harness checks concurrently; the required `validate` check succeeds only when all four lanes succeed.
- `pnpm verify:harness` runs the framework, runtime, and smoke harness reports together.
- `node scripts/publish-smoke.mjs` runs the publish smoke check.
- `node scripts/check-docs.mjs` checks that the website docs contain the required current-copy text.

## Brand assets

- Rebuild and validate the deterministic README media with
  `pnpm media:readme:capture` and `pnpm media:readme:check -- --local`. See
  [docs/brand/README.md](./docs/brand/README.md) and the
  [recording guide](./docs/brand/recording-guide.md) for prerequisites,
  generated artifacts, and the fixture-backed Workbench boundary.

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

- **Workflow entrypoints and executable steps have exact fixtures.** `scripts/release/test/fixtures/workflow-entrypoints.json` records the complete reviewed workflow, job, and step descriptors, including byte-exact `run:` bodies. `scripts/release/test/fixtures/workflow-safe-executables.json` independently enumerates every executable `run` body and pinned action reference with its release classification. The suite discovers every workflow file and rejects missing, extra, or changed structure and executables. There is no regeneration script: an intended workflow edit has to be transcribed into the applicable fixtures and reviewed.
- **Owner preflight binds fresh schema-v2 evidence to the checkout.** `scripts/release/preflight.mjs` exposes only the owner `capture` and `verify` commands. Capture writes one exclusive canonical schema-v2 evidence file containing the phase, exact HEAD, hashes of the owner-controlled workflow and policy files, and GitHub and npm observations. Verify re-reads those files and binds the evidence to the requested phase, current HEAD, bounded validity window, workflow topology, repository settings, and trusted-publisher configuration.
- **Final-owner reachability defines the script hash set.** `scripts/release/test/fixtures/release-script-hashes.json` must contain exactly the repository files reachable from the final release-owner workflows. The suite derives the entrypoints from literal `scripts/...` paths in workflow `run:` bodies and action `with:` inputs, plus one-level `pnpm` package-script expansion, then closes that set transitively over each entrypoint's repository-local module loads: static `import`/`export ... from`, dynamic `import()` with a literal specifier, and `new URL("./sibling.mjs", import.meta.url)` — the form `scripts/release/cli.mjs` hands to its injected loader for most of its sibling graph. Bare and `node:` specifiers are skipped as non-repository files. A specifier that cannot be resolved statically, or a repository-relative one that does not resolve to a regular file, fails closed rather than being dropped from the set; the audited exceptions are listed in `REVIEWED_DYNAMIC_IMPORT_SEAMS`. Files a pinned module reads off disk rather than importing — `scripts/release/controller-schema.json`, which selects the npm trusted-publisher and abandonment environments, and `scripts/release/recovery/policy.json`, which defines recovery admission and verification — are declared in `RELEASE_DATA_FILES` and must still be named by a module in the closure, so a data pin cannot outlive its reader. An unpinned reachable file, stale pin, or command that cannot be followed fails closed. Editing a reachable file also fails until its SHA256 is updated in the same commit, so both the command-line and content changes receive release-integrity review.
- **In-repo scripts generally are not pinned.** Everything else under `scripts/` — including `check-docs.mjs`, `check-changesets.mjs`, and `prime-kind-cache.sh`, which run in CI rather than in the release — is covered by branch protection and review, not by a content hash.

### Kubernetes compatibility

For ordinary local compatibility verification against the cluster already
selected in kubeconfig, run:

```sh
pnpm verify:k8s:compat -- --target <1.34|1.35|1.36> --context <exact-context> [--storage-class <name>] [--keep-on-failure]
```

The context argument must exactly match the current context. The command
preflights its tools, server minor, storage selection, unused temporary
namespaces, and complete administrative permission set before installation; it
also requires Pod Security Admission and a policy-enforcing CNI. Dynamic RWO
provisioning is a runtime prerequisite verified by the lifecycle, not proven by
preflight.

The policy-pinned Kind/Calico matrix covers Kubernetes 1.34, Kubernetes 1.35,
and Kubernetes 1.36. The lower and upper endpoint Kind lanes are scoped to
Kubernetes-relevant pull requests and also run nightly (or by manual dispatch).
The full packaged-app `sandbox-k8s-e2e` lane remains on Kubernetes 1.35.

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
