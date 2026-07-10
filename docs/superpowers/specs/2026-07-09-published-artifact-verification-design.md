# Published Artifact Verification Design

## Goal

Create a manual-only verification path that proves Dawn's published npm artifacts are installable, internally consistent, and operational outside the monorepo. The first version focuses on the highest-risk release surfaces: registry-installed `@dawn-ai/memory-pgvector`, `@dawn-ai/memory`, and `@dawn-ai/langchain`, plus npm metadata/provenance checks for public packages.

## Scope

This design covers two hardening tracks:

- **Published artifact smoke:** install selected packages from the real npm registry in a temporary directory outside the Dawn checkout, then run end-to-end pgvector memory checks against real Docker Postgres.
- **Published artifact verification:** inspect npm registry state and tarball contents for published packages, including README presence, `dist`/type files, dependency spec hygiene, package metadata, dist-tags, and provenance where npm exposes it.

The first workflow is manual-only. It does not run on every PR and does not automatically run after release publishing yet.

## Non-Goals

- Do not add a required PR check for registry/network/OpenAI work.
- Do not publish or mutate npm state.
- Do not add npm tokens or commit credentials.
- Do not require OpenAI by default.
- Do not replace `scripts/pack-check.mjs`; local pack validation remains useful before publishing.

## User-Facing Workflow

Add a manual GitHub Actions workflow with inputs:

- `version`: npm version or dist-tag to verify. Default: `latest`.
- `packageSet`: initial default `memory-pgvector-core`.
- `runPgvector`: default `true`.
- `runOpenAI`: default `false`.

The workflow checks out the repo only to run the verification scripts. Package installation happens in a temporary directory outside the checkout so npm must resolve packages from the real registry. The workflow requires Docker when `runPgvector=true`. If `runOpenAI=true`, the script requires `OPENAI_API_KEY` from repository secrets and fails clearly when it is missing.

## Script Structure

Create a small shared library for registry and tarball operations, then two runnable scripts:

- `scripts/lib/published-artifacts.mjs`
  - Reads public package manifests from `packages/*/package.json`.
  - Resolves package sets.
  - Runs `npm view`/`npm pack`/`npm install` commands.
  - Extracts tarballs into temp directories.
  - Validates package metadata and dependency spec hygiene.
  - Provides cleanup-safe command helpers.

- `scripts/published-artifact-verify.mjs`
  - Verifies public package registry state.
  - Confirms requested version exists for each package.
  - Confirms `latest` when `version=latest`.
  - Downloads published tarballs via `npm pack <pkg>@<version>`.
  - Checks package contents against expectations.
  - Checks dependency specs for `workspace:*`, `file:`, and repo-local leakage.
  - Checks README, `types`, `exports`, `bin`, license, engines, repository, homepage, bugs, and `publishConfig.access`.
  - Checks npm provenance when supported by the npm CLI/registry response; if unavailable, report `SKIP provenance unsupported` instead of pretending to verify it.

- `scripts/published-artifact-smoke.mjs`
  - Creates a temp project outside the repo.
  - Runs `npm init -y`, sets `"type":"module"`, and installs the requested packages from npm.
  - Verifies installed package versions.
  - Confirms `pg`/`pgvector` dependencies are pure JavaScript installs with no native build step surfaced during install.
  - When `runPgvector=true`, starts `pgvector/pgvector:pg16` on a non-default port, polls `pg_isready`, and always removes the container.
  - Runs no-key checks:
    - `pgvectorMemoryStore({ connectionString, dimensions: 1536 })`
    - `put()` and keyword `search()` recall a matching memory
    - repeated initialization is idempotent
    - `close()` lets the process exit cleanly
    - dimensions greater than 4000 throw a clear halfvec-ceiling config error
  - When `runOpenAI=true`, runs the real embedder hybrid check:
    - `openaiEmbedder().dims === 1536`
    - a probe embed returns a 1536-length `Float32Array`
    - store a "faster shipping" memory with embedding/model
    - search with "expedite delivery options" using `queryEmbedding + embedderId`
    - assert the stored fact is recalled across the vocabulary gap

## Reporting

Both scripts should emit compact tiered output:

- `T0 PASS/FAIL`: clean registry install and version confirmation
- `T1 PASS/FAIL`: no-key pgvector keyword/idempotency/close path
- `T2 PASS/FAIL/SKIP`: real OpenAI hybrid recall path
- `T3 PASS/FAIL`: dimension ceiling sanity
- `META PASS/FAIL`: registry/tarball/package metadata verification

Failures should identify the likely layer: npm registry/package metadata, tarball contents, Docker/Postgres environment, OpenAI environment, or package runtime behavior.

## Secret Handling

The scripts must never print `OPENAI_API_KEY`, must never write it to disk, and must only read it from the current process environment. Local documentation should continue to recommend loading local keys into a single shell only. The workflow should pass the secret only to the smoke step that needs it.

## Cleanup

Cleanup is mandatory:

- Remove the temp install directory.
- Remove extracted tarball directories.
- Remove the pgvector Docker container even on failure.
- Avoid fixed temp paths except for the Docker container name, which should include a run-specific suffix when possible.

## Testing Strategy

Unit tests should cover reusable logic without network:

- Package set resolution.
- Version/dist-tag resolution.
- Dependency spec rejection for `workspace:*` and `file:`.
- Tarball content expectation matching.
- Command failure reporting.
- OpenAI gating behavior.

Manual/local verification should cover:

- No-key smoke against real Docker.
- Metadata verification against real npm for the current `latest`.

OpenAI verification is explicit and opt-in.

## Rollout

1. Add scripts and tests.
2. Add the manual workflow.
3. Document the manual run command in release/runbook docs.
4. Run no-key local verification.
5. Run the manual workflow once with `runOpenAI=false`.
6. Run the manual workflow with `runOpenAI=true` only after confirming the repository secret is configured.

Post-release automation is deliberately deferred until the manual workflow has passed a few times and the signal/noise ratio is understood.
