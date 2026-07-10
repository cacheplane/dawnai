# Public Package Pack Coverage Design

## Goal

Ensure `pnpm pack:check` validates every public Dawn workspace package so a new package or package README cannot be omitted from pre-publish artifact checks.

## Design

Move the package validation manifest out of the executable `scripts/pack-check.mjs` runner into a side-effect-free module. The runner will retain all build, pack, extraction, metadata, dependency, and cleanup behavior while importing the manifest.

Expand the manifest from its current subset to every non-private package under `packages/*`. Each entry will require `README.md`, `package.json`, representative runtime/type entrypoints or configuration files, and the metadata fields appropriate to that package type.

The runner will validate the manifest before packing. It will discover public package manifests from the workspace and require each public package directory to appear exactly once, with both `README.md` and `package.json` in its expected files. Adding a public package without complete artifact expectations will therefore fail `pnpm pack:check` in CI before publishing. Root `package.json` orchestration will make `pack:check` invoke the focused `node:test` suite before the artifact runner.

## Non-goals

- Do not change package `files` allowlists; npm already includes package READMEs automatically.
- Do not publish a package release or change the existing empty documentation changeset.
- Do not replace the manual real-registry verifier or smoke test.

## Verification

- The focused `node:test` coverage test must fail before the manifest is expanded and pass afterward.
- `pnpm pack:check` must pack and validate all public packages successfully.
- Formatting and diff checks must remain green.
