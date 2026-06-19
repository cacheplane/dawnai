# Signed Releases — Design

**Date:** 2026-06-19
**Status:** Approved (design)
**Goal:** Attach a signed artifact to each GitHub Release so OSSF Scorecard's **Signed-Releases** check (currently `-1` / inconclusive) finds a recognized signature file in release assets, raising the aggregate Scorecard score.

## Background

OSSF Scorecard's Signed-Releases check scans a project's most recent GitHub Release **assets** for signature files (`*.minisig`, `*.asc`, `*.sig`, `*.sign`, `*.sigstore`, `*.sigstore.json`, `*.intoto.jsonl`). A SLSA in-toto provenance (`*.intoto.jsonl`) scores 10/10.

Dawn already produces **npm provenance** (`npm publish --provenance`, OIDC trusted publishing), but those Sigstore attestations live on the **npm registry / transparency log**, not in GitHub Release assets — so Scorecard never sees them. (The sibling `cacheplane/angular-agent-framework` repo has the same gap: its releases have empty assets.)

Current pipeline (`release.yml` → `changesets/action` with `publish: pnpm release:publish`):
- `scripts/release-publish.mjs` iterates the **fixed group of 15 packages**: `pnpm pack` → `npm publish <tarball> --provenance` → **deletes the tarball** (`rm`) → `git tag <name>@<version>`.
- `changesets/action` (`createGithubReleases: true`) then creates **15 GitHub Releases per version** (one per package tag), each with **empty assets**.

## Architecture

Keep the existing per-package release structure; add a sign-and-upload stage after publish.

### 1. Retain tarballs (`scripts/release-publish.mjs`)
Stop deleting each tarball. Move it into a staging directory `release-artifacts/` at the repo root, and include the path in the returned result so downstream steps can find it. Return shape per published package: `{ name, version, tag: "<name>@<version>", tarballPath }`.

### 2. Attest — keyless Sigstore (`release.yml`)
After the `changesets/action` step (which has created the 15 GitHub Releases), add a step:
`actions/attest-build-provenance` with `subject-path: release-artifacts/*.tgz`. This registers SLSA in-toto provenance for each tarball in GitHub's attestation store (verifiable later via `gh attestation verify <tarball>`) and writes a bundle file. Pin the action to a commit SHA (consistent with the repo's Pinned-Dependencies posture).

### 3. Upload assets to each release (`scripts/upload-release-assets.mjs` — new)
A new script uploads, for each of the 15 per-package releases:
- that package's `<name>-<version>.tgz`, and
- its attestation as a `<name>-<version>.intoto.jsonl` asset,
via `gh release upload "<tag>" <files> --clobber`.

Attaching to **all 15** releases each version guarantees that whatever subset Scorecard samples (the most recent ~5) has signed assets. The script reads the published-package list (from step 1's output or by globbing `release-artifacts/`) and resolves each tarball's attestation bundle. It has a unit test (`scripts/upload-release-assets.test.mjs`) following the existing `scripts/release-publish.test.mjs` pattern — exercising the per-package tag→asset mapping and the "skip if asset already present" idempotence branch with an injected fake `gh` runner (no network).

### 4. Permissions (`release.yml`)
Add `attestations: write` to the `release` job permissions. It already declares `id-token: write` and `contents: write`; top-level stays `contents: read`.

## Decisions

- **Keep 15 per-package releases** (not consolidate to one `vX.Y.Z` release per version): least disruption, preserves the npm-convention tags (`@dawn-ai/cli@x.y.z`) that npm links to. Consolidating would change the tagging scheme and require replacing `createGithubReleases` with custom release-creation logic — out of scope.
- **Attach both the `.tgz` and the `.intoto.jsonl`** (not just the signature): the release then carries the actual artifact plus verifiable provenance, which is more meaningful than a lone signature file and still satisfies Scorecard.
- **Signing method: GitHub build provenance (Sigstore) via `actions/attest-build-provenance`** — keyless OIDC, no key management, conceptually matches the existing npm provenance, scores high (in-toto = 10/10).

## Failure model

The sign-and-upload stage runs **after** `npm publish`, so a failure there surfaces as a red workflow but never unpublishes or blocks what's already on npm. The upload script is **idempotent**: it skips a release that already has the expected asset (so a re-run after a partial failure is safe). A signing/upload failure should fail the workflow (visible), since a release without its provenance is a real gap to fix — but it does not roll back the npm publish.

## Testing

- **Unit:** `scripts/upload-release-assets.test.mjs` — pure logic (tag→asset mapping, idempotence skip) with an injected fake command runner; no network, runs in the existing `pnpm test` / `node --test` suite.
- **Live verification:** on the next real release, confirm each GitHub Release has a `*.tgz` + `*.intoto.jsonl` asset (`gh release view <tag> --json assets`), that `gh attestation verify <tarball> --repo cacheplane/dawnai` passes, and — after Scorecard recomputes — that Signed-Releases moves from `-1` to ~10 at `api.scorecard.dev`.

## Portability

The `attest-build-provenance` + `gh release upload` pattern drops into `angular-agent-framework`'s `publish-middleware-*.yml` workflows with minimal change (same OIDC, same upload step), solving the same gap there.

## Out of scope

- Consolidating to one aggregate release per version.
- Cosign / GPG signing paths.
- Signing anything beyond the published package tarballs (e.g., a source archive).
- Verifying attestations as a release gate (we generate and attach; consumers verify via `gh attestation verify`).

## Risks

- `actions/attest-build-provenance` multi-subject behavior: it produces attestations for each globbed subject. The plan must confirm whether it yields one combined bundle or per-subject bundles, and map each tarball to the correct `*.intoto.jsonl` asset accordingly. (Scorecard only needs a recognized filename present; genuine per-tarball verification is the stronger goal and drives the mapping.)
- Runner filesystem persistence: `release-artifacts/` is written during the `changesets/action` step and read by later steps in the **same job** — fine, since they share the runner. Must stay in one job (no artifact upload/download needed).
- The release path is exercised only on real releases; the unit test covers the new script's logic, but the end-to-end attest+upload is first verified on the next version bump.
