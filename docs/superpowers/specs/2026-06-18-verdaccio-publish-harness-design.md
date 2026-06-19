# Verdaccio-backed generated-app publish harness (Design)

**Status:** Approved for planning
**Date:** 2026-06-18
**Roadmap:** Postmortem follow-up to the 0.8.2 release-gate break (PRs #237/#241). The generated-app verify lanes simulate "what a user installs from npm" via `pnpm pack → pin tarball paths → pnpm.overrides → fail-closed .npmrc`. That approximation produced two stacked silent fallbacks and a release-gate landmine. This replaces the approximation with the real thing: publish the workspace to a local registry (Verdaccio) and install the scaffolded app from it exactly as a published user would — no overrides, no tarball pinning, no fail-closed hack.

## Problem

Today an external-mode generated app is built like this (see `test/harness/scaffold-packaging.ts`, `test/harness/packaged-app.ts`, `test/generated/harness.ts`):

1. `createPackagedInstaller` packs every `@dawn-ai/*` (+ `devkit` + `create-dawn-ai-app`) into tarballs and builds an `installer/` dir with `pnpm.overrides` pinning a couple of them.
2. `create-dawn-ai-app --dist-tag next` scaffolds an app whose `package.json` deps are the **dist-tag string** (e.g. `"@dawn-ai/core": "next"`).
3. `rewriteGeneratedAppDependencies` overwrites those specs with tarball paths, injects `pnpm.overrides` for the whole scaffold set, promotes transitive-only packages to direct deps via `extraDependencies`, and writes `FAIL_CLOSED_NPMRC` (`@dawn-ai:registry=http://127.0.0.1:1/`).
4. `pnpm install` resolves `@dawn-ai/*` from local tarballs/overrides.

This is a faithful-ish simulation that diverges from real npm resolution in exactly the ways that bit us:

- **pnpm applies a file-path override inconsistently across a complex graph** — a transitive-only package (`@dawn-ai/workspace` via `core`/`langchain`/`testing`/`evals`) had *both* a `file:` and a registry `@dawn-ai/workspace@<v>` edge in the lockfile. The registry edge silently succeeded while the version was published and only `ERR_PNPM_NO_MATCHING_VERSION`-ed at release time (unpublished bumped version).
- The mitigations (`extraDependencies` promotions, the dead-registry `.npmrc`, throw-on-missing-tarball) are scaffolding around an approximation, not the real resolution path.

## Decisions (from brainstorming)

- **Local registry = Verdaccio**, started **programmatically** (`runServer` + `listen(0)`), not CLI-spawned or Docker.
- **Whole-registry resolution + npmjs uplink** (not per-scope): the app's `.npmrc` sets `registry=<verdaccio>`; Verdaccio serves `@dawn-ai/*` locally and proxies everything else to npmjs. One resolution path — the most faithful "real npm user" model (the Nx/changesets pattern).
- **`@dawn-ai/*` scope is local-only** (no `proxy:` field) so freshly published versions are never shadowed/409'd by npmjs. `**` catch-all keeps `proxy: npmjs`. Pattern order: scope before catch-all.
- **Publish the whole workspace atomically at one canonical version.** `pnpm -r publish` publishes every publishable workspace package and rewrites `workspace:*` to the exact current version. Before publishing, **assert all publishable packages share one identical version** (the fixed-group invariant) and fail loudly on any drift — never publish a skewed set. Fresh per-run storage means a mid-publish failure leaves no partial state: the run fails and the next run republishes clean. We do **not** mutate working-tree versions.
- **Scaffold with the default `latest` dist-tag** (drop the harness's historical `next`) — a real user runs the default. Publish to Verdaccio tagged `latest`, so `@dawn-ai/core@latest` resolves to exactly the code under test.
- **All lanes migrate at once** (framework + runtime + smoke + cli-testing-export). Delete the old mechanism entirely — no dual path, no backwards compat.
- **Internal mode is untouched** — `buildLocalContributorPackages` + `--mode internal` (file:-linked monorepo) tests the contributor/checkout experience, a genuinely different thing.

## Verified facts (against the worktree)

- `packages/devkit/templates/app-basic/package.json.template` writes the dist-tag literally: `"@dawn-ai/core": "{{dawnCoreSpecifier}}"` where the specifier *is* the dist-tag string. `create-dawn-app`'s default `distTag = "latest"` (`packages/create-dawn-app/src/index.ts:81`).
- `@dawn-ai/*` packages depend on each other via `workspace:*` (e.g. `packages/cli/package.json`), which `pnpm -r publish` rewrites to the exact version at publish time.
- The real release publishes per-package via `pnpm pack` + `npm publish --provenance` (`scripts/release-publish.mjs`); provenance/OIDC is npmjs-specific, so the harness uses `pnpm -r publish` against Verdaccio instead (equivalent resolution result, no provenance).
- Lanes and call sites: `createPackagedInstaller` / `rewriteGeneratedAppDependencies` are called from `test/generated/run-generated-app.test.ts`, `test/generated/harness.ts`, `test/smoke/run-smoke.test.ts`, `test/runtime/run-agent-protocol.test.ts`, `test/runtime/run-runtime-contract.test.ts`, and `test/generated/cli-testing-export.test.ts`. Lanes run via `scripts/harness-report.mjs` against `test/{generated,runtime,smoke}/vitest.config.ts`.

## Architecture

A **per-lane ephemeral Verdaccio**. Each lane's vitest config gains a `globalSetup` that:

1. Starts Verdaccio programmatically: `runServer(config)` then `server.listen(0)`; read back the random port → `url`. Fresh `mkdtemp` storage dir. The `listen` callback is the readiness signal (no polling). Random port also **busts pnpm's per-registry metadata cache** between runs.
2. Publishes the whole workspace once: assert uniform version → `pnpm -r publish --registry <url> --tag latest --no-git-checks` with a publish-time `.npmrc`/env carrying a throwaway `//host:port/:_authToken="fake"` (npm refuses to publish without a token even when the scope allows `$anonymous`).
3. Exposes `url` to the lane's tests via `process.env.DAWN_TEST_REGISTRY_URL`.
4. Returns a teardown that `server.close()`s and `rm`s the storage dir.

Per scenario (external mode):

- Scaffold with `create-dawn-ai-app <appRoot> --template <t>` (default `latest` dist-tag).
- Write a real `.npmrc` into the app: `registry=<url>` (+ the fake `_authToken` line for parity; not needed for reads).
- `pnpm install` — `@dawn-ai/*@latest` resolves from Verdaccio, everything else via its npmjs uplink. **No overrides, no rewrite.**
- Run the existing lifecycle (`dawn verify`/`routes`/`typegen`, `typecheck`, `build`) and dev-server scenarios (runtime/smoke) unchanged.
- Compare against fixtures.

### Verdaccio config (object form)

```js
{
  storage,                 // fresh mkdtemp dir; self_path: storage (v5 object-config requirement)
  uplinks: { npmjs: { url: "https://registry.npmjs.org/", maxage: "30m" } },
  packages: {
    "@dawn-ai/*": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" }, // NO proxy → local-only
    "**":         { access: "$all", publish: "$anonymous", proxy: "npmjs" },
  },
  logs: { type: "stdout", format: "pretty", level: "warn" },
}
```

## Components

**New — `test/harness/local-registry.ts`**
- `startLocalRegistry(): Promise<{ url, stop() }>` — programmatic Verdaccio on `listen(0)`, temp storage, config above.
- `publishWorkspace(url): Promise<void>` — assert uniform version across publishable packages; `pnpm -r publish --registry url --tag latest --no-git-checks` with the fake-token `.npmrc`/env.
- One small function each; both independently testable.

**New — per-lane `globalSetup`** wiring start → publish → expose `DAWN_TEST_REGISTRY_URL` → teardown, referenced from the three lane vitest configs.

**Changed — `test/harness/packaged-app.ts` (`createPackagedInstaller`)**: collapses to "make `create-dawn-ai-app` available from the registry" (install/`dlx` it against Verdaccio). The tarball-map + installer-overrides logic is removed; packing per-package for pinning is no longer needed (the registry holds everything).

**Changed — scaffold-side helper**: a tiny `writeRegistryNpmrc(appRoot, url)` replaces `rewriteGeneratedAppDependencies` at every external call site. Scaffolders pass `--dist-tag latest` (or omit, since it's the default).

**Changed — `normalizeForFixture`**: drop tarball-path/override normalization; add `@dawn-ai` resolved-**version** normalization (published version = current monorepo version, changes each release → `<version:@dawn-ai/...>`).

**Deleted**: `rewriteGeneratedAppDependencies`, `FAIL_CLOSED_NPMRC`, all `extraDependencies` promotions (workspace/sqlite-storage/langgraph/permissions) across every lane call site, the installer-override path, and the related guard tests in `scaffold-packaging.test.ts` (tarball/override/.npmrc assertions).

**Untouched**: internal mode (`buildLocalContributorPackages`, `--mode internal`, the `<repo:...>` internal fixture). The `test/harness/**` test-include wiring added in #241 stays (now covers `local-registry.ts`).

## Store freshness (shared global store, no isolation)

We keep the **shared global pnpm store** (fast — third-party deps stay cached) and rely on two facts for `@dawn-ai` freshness:

1. **Random port → unique registry URL per run → pnpm metadata cache miss** for `@dawn-ai/*`, so resolution always re-reads Verdaccio's fresh packument.
2. **Content-addressable store**: changed `@dawn-ai` content under the same version yields a new tarball integrity in Verdaccio's packument → store miss → fresh fetch.

So same-version-different-content cannot serve stale bits. **This is verified empirically in the first implementation step**; documented fallback if it proves flaky is an isolated `--store-dir <temp>` per lane (slower, re-proxies third-party deps).

## Error handling

- **Readiness**: `listen` callback; no log-grep.
- **Missing/unpublished `@dawn-ai` package**: Verdaccio 404 (local-only scope) → loud install failure. This *replaces* the dead-registry fail-closed guard.
- **Publish-too-fast 409 / "Failed to save packument"**: fresh temp storage per run + `pnpm -r` serializes; add a bounded retry if observed flaky.
- **Atomicity**: assert uniform version pre-publish (fail loud on drift); any publish error fails the lane; fresh storage prevents partial-state carryover.
- **Uplink cold cache**: first run pays npmjs latency for third-party metadata (cached by `maxage`); acceptable.
- **Teardown**: always `server.close()` + `rm` storage, even on failure.

## Testing

- **`local-registry.ts` unit/integration test** (runs in the framework lane via the `test/harness/**` include): start → publish → a probe `pnpm install` of a tiny app resolves `@dawn-ai/core@latest` from the registry → teardown leaves nothing listening.
- **Negative test**: scaffold/probe an app referencing an `@dawn-ai` package that was *not* published → `pnpm install` 404s. Preserves the fail-closed property the dead-registry `.npmrc` used to give.
- **Lane fixtures regenerated**: `basic` / `custom-app-dir` app `package.json` becomes the plain scaffolded template (`"@dawn-ai/core": "latest"`, **no `pnpm.overrides`**). `normalizeForFixture` version-normalizes `@dawn-ai` resolutions. Internal-mode fixture unchanged.
- **All three lanes green** under `pnpm verify:harness` with the new model; no overrides/`.npmrc`-hack present in any generated app.

## Out of scope

- Internal/contributor-local mode (stays file:-linked).
- The real release path (`scripts/release-publish.mjs`, OIDC/provenance) — unchanged; the harness mirrors *resolution*, not provenance.
- Publishing real packages anywhere outside the ephemeral local registry.

## Risks

- **Uplink latency/availability** for third-party deps on a cold cache (first CI run slower; npmjs dependency). Mitigated by `maxage` and the warm shared store.
- **pnpm + Verdaccio publish race** (#11454) — mitigated by fresh storage + serialized `pnpm -r`; retry if needed.
- **Shared-store freshness reasoning** — verified empirically in step 1 before building on it; isolated store is the fallback.
