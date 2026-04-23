# Dawn Testing Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-first testing harness that hardens Dawn’s filesystem contract, generated-app correctness, and minimal runtime startup through one layered internal system and the new app-local `dawn verify` command.

**Architecture:** Keep the public surface narrow and make the framework harness strong. The implementation should centralize shared testing primitives in `@dawnai.org/devkit`, add contract fixtures and generated-app lanes as explicit test layers, introduce `dawn verify` as an app-local integrity command, and wire root scripts and CI to compose these lanes with normalized reporting.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript, Vitest projects, Node child processes, packed tarball smoke tests, GitHub Actions

---

## Scope Guard

This plan covers one subsystem: the Dawn framework testing harness. It does not include release-channel local-registry verification, a shipped `dawn test` command, or dataset-driven eval infrastructure.

For generated-app verification in this first phase, the approved bootstrap proxy is the packaged initializer bin path, exercised through `pnpm exec create-dawn-app` after installing the packed tarball. Literal `pnpm create dawn-app` verification is deferred to the later local-registry release-hardening phase, because it requires install-by-name or dist-tag resolution that this plan intentionally does not add yet.

## File Structure Map

- Shared harness primitives:
  - Create: `/Users/blove/repos/dawn/packages/devkit/vitest.config.ts`
  - Modify: `/Users/blove/repos/dawn/packages/devkit/package.json`
  - Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/result-types.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/reporting.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/process.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/artifacts.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/generated-app.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/index.ts`
  - Modify: `/Users/blove/repos/dawn/packages/devkit/src/index.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/test/generated-app.test.ts`
  - Create: `/Users/blove/repos/dawn/packages/devkit/test/reporting.test.ts`
- Contract fixtures and core coverage:
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/dawn.config.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/route.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/workflow.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/state.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/dawn.config.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/route.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/graph.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/state.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/dawn.config.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/src/app/broken/[tenant]/route.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/src/app/broken/[tenant]/graph.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/src/app/broken/[tenant]/workflow.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-config/dawn.config.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-config/src/app/hello/route.ts`
  - Create: `/Users/blove/repos/dawn/test/fixtures/contracts/manifest.snap.json`
  - Modify: `/Users/blove/repos/dawn/packages/core/test/discover-routes.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/core/test/config.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/core/test/render-route-types.test.ts`
- Generated-app harness:
  - Create: `/Users/blove/repos/dawn/test/generated/vitest.config.ts`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/basic.expected.json`
  - Create: `/Users/blove/repos/dawn/test/generated/fixtures/custom-app-dir.expected.json`
  - Create: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
  - Modify: `/Users/blove/repos/dawn/scripts/publish-smoke.mjs`
- Execution smoke:
  - Create: `/Users/blove/repos/dawn/test/smoke/vitest.config.ts`
  - Create: `/Users/blove/repos/dawn/test/smoke/graph-basic.overlay.json`
  - Create: `/Users/blove/repos/dawn/test/smoke/workflow-basic.overlay.json`
  - Create: `/Users/blove/repos/dawn/test/smoke/run-smoke.test.ts`
- CLI verify command:
  - Create: `/Users/blove/repos/dawn/packages/cli/src/commands/verify.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
  - Create: `/Users/blove/repos/dawn/packages/cli/test/verify-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
  - Modify: `/Users/blove/repos/dawn/packages/cli/test/typegen-command.test.ts`
- Root orchestration and CI:
  - Create: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
  - Modify: `/Users/blove/repos/dawn/scripts/test.mjs`
  - Modify: `/Users/blove/repos/dawn/package.json`
  - Modify: `/Users/blove/repos/dawn/.github/workflows/ci.yml`
  - Modify: `/Users/blove/repos/dawn/vitest.workspace.ts`

### Task 1: Add Shared Harness Primitives

**Files:**
- Create: `/Users/blove/repos/dawn/packages/devkit/vitest.config.ts`
- Modify: `/Users/blove/repos/dawn/packages/devkit/package.json`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/result-types.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/reporting.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/process.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/artifacts.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/generated-app.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/src/testing/index.ts`
- Modify: `/Users/blove/repos/dawn/packages/devkit/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/test/generated-app.test.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/test/reporting.test.ts`

- [ ] **Step 1: Write the failing reporting contract test**

Create `packages/devkit/test/reporting.test.ts` that asserts a run result object includes:
- `runId`
- `startedAt`
- `finishedAt`
- `requestedLanes`
- `executedLanes`
- `status`
- aggregate counts for `passed`, `failed`, `skipped`, and `errored`
- `artifactRoot`
- lane entries with `lane`, `name`, `status`, `durationMs`, `phases`, `failureReason`, `artifacts`, and `transcriptPath`
- JSON rendering that preserves the same contract for CI consumers

- [ ] **Step 2: Run the devkit test to verify it fails**

Run: `pnpm --filter @dawnai.org/devkit exec vitest --run test/reporting.test.ts`
Expected: FAIL because the testing primitives do not exist.

- [ ] **Step 3: Write the failing generated-app helper test**

Create `packages/devkit/test/generated-app.test.ts` that asserts a helper can:
- materialize the `basic` template into a temp directory
- return the generated app root path
- expose enough metadata to track artifact and transcript locations

- [ ] **Step 4: Run the generated-app helper test to verify it fails**

Run: `pnpm --filter @dawnai.org/devkit exec vitest --run test/generated-app.test.ts`
Expected: FAIL because no shared harness helpers exist.

- [ ] **Step 5: Add the missing devkit test runner prerequisites**

Create `packages/devkit/vitest.config.ts` and add a `test` script to `packages/devkit/package.json` so the package can run its own Vitest suite like the other publishable packages.

- [ ] **Step 6: Implement the minimal shared types and helpers**

Add:
- `result-types.ts` for run-level and lane-level result shapes
- `reporting.ts` for text and JSON summary rendering
- `process.ts` for `spawn` wrappers with captured stdout/stderr and exit status
- `artifacts.ts` for deterministic artifact-root creation
- `generated-app.ts` for temp app generation using the existing template writer
- `index.ts` re-exports

Keep these primitives framework-internal and small. Do not add registry or browser logic.

- [ ] **Step 7: Run the devkit tests to verify they pass**

Run: `pnpm --filter @dawnai.org/devkit test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/devkit/package.json packages/devkit/vitest.config.ts packages/devkit/src packages/devkit/test
git commit -m "test: add harness primitives"
```

### Task 2: Add Contract Fixtures And Core Fixture Coverage

**Files:**
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/dawn.config.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/route.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/workflow.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-basic/src/app/(public)/hello/[tenant]/state.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/dawn.config.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/route.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/graph.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/valid-custom-app-dir/src/dawn-app/support/[tenant]/state.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/dawn.config.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/src/app/broken/[tenant]/route.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/src/app/broken/[tenant]/graph.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-companion/src/app/broken/[tenant]/workflow.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-config/dawn.config.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/invalid-config/src/app/hello/route.ts`
- Create: `/Users/blove/repos/dawn/test/fixtures/contracts/manifest.snap.json`
- Modify: `/Users/blove/repos/dawn/packages/core/test/discover-routes.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/core/test/config.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/core/test/render-route-types.test.ts`

- [ ] **Step 1: Write the failing contract-fixture route discovery test**

Update `packages/core/test/discover-routes.test.ts` to load the checked-in fixtures and assert:
- valid fixtures discover the expected route paths and entry kinds
- invalid companion fixtures fail with a stable error message

- [ ] **Step 2: Run the route discovery test to verify it fails**

Run: `pnpm --filter @dawnai.org/core exec vitest --run test/discover-routes.test.ts`
Expected: FAIL because the checked-in fixture catalog does not exist yet.

- [ ] **Step 3: Write the failing config and typegen fixture tests**

Update:
- `packages/core/test/config.test.ts` to cover `appDir` with a checked-in custom-app-dir fixture and invalid config parsing
- `packages/core/test/render-route-types.test.ts` to compare a known manifest against generated type output or a checked-in manifest snapshot

- [ ] **Step 4: Run the config and typegen tests to verify they fail**

Run: `pnpm --filter @dawnai.org/core exec vitest --run test/config.test.ts test/render-route-types.test.ts`
Expected: FAIL because the new fixtures and expectations are not present.

- [ ] **Step 5: Create the checked-in fixture catalog**

Add the minimal contract fixtures under `test/fixtures/contracts/`:
- one valid default app
- one valid custom `appDir` app
- one invalid companion-file app with both `graph.ts` and `workflow.ts`
- one invalid config fixture

Keep these fixtures small and hand-authored.

- [ ] **Step 6: Update core tests to use the fixture catalog**

Replace ad hoc inline setup with reads from the checked-in fixture directories. Keep assertions focused on filesystem contract behavior, not scaffold policy.

- [ ] **Step 7: Run core tests to verify they pass**

Run: `pnpm --filter @dawnai.org/core test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/contracts packages/core/test
git commit -m "test: add contract fixture coverage"
```

### Task 3: Ship The App-Local `dawn verify` Command

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/src/commands/verify.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/index.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/test/verify-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/typegen-command.test.ts`

- [ ] **Step 1: Write the failing `verify` command test**

Create `packages/cli/test/verify-command.test.ts` that asserts:
- `dawn verify` succeeds in a valid app fixture
- output includes a concise app integrity summary
- `--cwd` works from a child directory
- invalid fixtures return a nonzero exit code and a stable error prefix
- `--json` returns the normalized result model shape for a single app run

- [ ] **Step 2: Run the CLI verify test to verify it fails**

Run: `pnpm --filter @dawnai.org/cli exec vitest --run test/verify-command.test.ts`
Expected: FAIL because the command does not exist.

- [ ] **Step 3: Implement the `verify` command minimally**

Create `packages/cli/src/commands/verify.ts` that:
- finds the Dawn app root
- runs app-local checks in order
- reuses existing discovery and typegen primitives
- emits either concise human output or normalized JSON output

Register it in `packages/cli/src/index.ts`.

- [ ] **Step 4: Extend built-bin and external-app smoke coverage**

Update:
- `packages/cli/test/check-command.test.ts` to keep built executable coverage honest where the new command shares bin behavior
- `packages/cli/test/typegen-command.test.ts` or a shared helper to prove `dawn verify` works in a custom `appDir` app and generated external-style app

- [ ] **Step 5: Run CLI verification**

Run: `pnpm --filter @dawnai.org/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat: add dawn verify"
```

### Task 4: Add Generated-App Harness Coverage

**Files:**
- Create: `/Users/blove/repos/dawn/test/generated/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/test/generated/fixtures/basic.expected.json`
- Create: `/Users/blove/repos/dawn/test/generated/fixtures/custom-app-dir.expected.json`
- Create: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- Modify: `/Users/blove/repos/dawn/scripts/publish-smoke.mjs`

- [ ] **Step 1: Write the failing generated-app harness test**

Create `test/generated/run-generated-app.test.ts` that:
- packs the publishable Dawn packages
- creates a temp installer directory
- scaffolds an app through the packaged initializer bin path using `pnpm exec create-dawn-app`
- rewrites dependencies to tarballs if needed
- runs `pnpm install`, `dawn verify`, `dawn routes`, `dawn typegen`, `pnpm typecheck`, and `pnpm build`

- [ ] **Step 2: Run the generated-app harness test to verify it fails**

Run: `pnpm exec vitest --run test/generated/run-generated-app.test.ts`
Expected: FAIL because the shared generated-app harness and root test project are not wired yet.

- [ ] **Step 3: Tighten `create-dawn-app` test boundaries**

Refactor `packages/create-dawn-app/test/create-app.test.ts` so it stays focused on:
- CLI argument behavior
- internal vs external mode policy
- generated dependency specifiers

Do not leave full generated-app lifecycle coverage only inside the package test.

- [ ] **Step 4: Add the generated-app Vitest project**

Create `test/generated/vitest.config.ts` and register it in `vitest.workspace.ts` so root-level generated-app tests run through an explicit project instead of an implicit file path.

- [ ] **Step 5: Move tarball app-lifecycle checks into the new harness lane**

Use the shared devkit helpers and root-level generated-app test to own:
- temp-dir lifecycle
- tarball packing
- command transcripts
- artifact paths

Keep `scripts/publish-smoke.mjs` as a root entrypoint that calls the same harness path instead of duplicating logic.

- [ ] **Step 6: Add expected-output fixtures**

Add `basic.expected.json` and `custom-app-dir.expected.json` to define the generated-app assertions that should remain stable across scaffold runs.

- [ ] **Step 7: Run generated-app verification**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts`
Expected: PASS.

Run: `node scripts/publish-smoke.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add test/generated vitest.workspace.ts packages/create-dawn-app/test scripts/publish-smoke.mjs
git commit -m "test: add generated app harness coverage"
```

### Task 5: Add Limited Execution Smoke

**Files:**
- Create: `/Users/blove/repos/dawn/test/smoke/vitest.config.ts`
- Create: `/Users/blove/repos/dawn/test/smoke/graph-basic.overlay.json`
- Create: `/Users/blove/repos/dawn/test/smoke/workflow-basic.overlay.json`
- Create: `/Users/blove/repos/dawn/test/smoke/run-smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `test/smoke/run-smoke.test.ts` that:
- boots one graph fixture and one workflow fixture
- executes one canonical flow per fixture
- captures outputs and transcript paths in the shared result shape

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `pnpm exec vitest --run test/smoke/run-smoke.test.ts`
Expected: FAIL because no runtime smoke harness exists yet.

- [ ] **Step 3: Create minimal smoke fixtures**

Add one graph overlay and one workflow overlay under `test/smoke/`. The smoke runner should generate apps from the supported template by default, then apply the overlay only for runtime-specific differences that the template cannot express cleanly.

- [ ] **Step 4: Add the smoke Vitest project**

Create `test/smoke/vitest.config.ts` and register it in `vitest.workspace.ts` so the smoke lane is explicit and can stay opt-in from root orchestration.

- [ ] **Step 5: Implement the smoke runner**

Use the shared process and artifact helpers to:
- generate the base app fixture
- apply the graph or workflow overlay
- start the target app or entrypoint
- wait for the app to be ready if needed
- invoke one canonical path
- capture output and status

Keep this narrow. Do not add general scenario execution or browser automation.

- [ ] **Step 6: Run smoke verification**

Run: `pnpm exec vitest --run --config test/smoke/vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/smoke vitest.workspace.ts
git commit -m "test: add runtime smoke coverage"
```

### Task 6: Wire Root Scripts, Reporting, And CI Lanes

**Files:**
- Create: `/Users/blove/repos/dawn/scripts/harness-report.mjs`
- Modify: `/Users/blove/repos/dawn/scripts/test.mjs`
- Modify: `/Users/blove/repos/dawn/package.json`
- Modify: `/Users/blove/repos/dawn/.github/workflows/ci.yml`
- Modify: `/Users/blove/repos/dawn/vitest.workspace.ts`

- [ ] **Step 1: Write the failing root harness reporting test**

Add a small root-level test or script assertion that expects the root harness runner to:
- report `runId`, `startedAt`, `finishedAt`, `requestedLanes`, `executedLanes`, aggregate counts, and `artifactRoot`
- report lane names
- report per-lane phases, statuses, durations, failure reasons, and artifact paths
- emit the same contract in JSON mode
- return exit code `0` for all-pass
- return exit code `1` for assertion failures
- return exit code `2` for harness infrastructure failures

If a dedicated test file is unnecessary, encode this as a script-level self-check in `scripts/harness-report.mjs`.

- [ ] **Step 2: Run the root harness self-check to verify it fails**

Run: `node scripts/harness-report.mjs --self-test`
Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Replace bootstrap logic in `scripts/test.mjs`**

Make `scripts/test.mjs` a plain source-test lane. Remove the bootstrap fallback behavior once the package test surface is real.

- [ ] **Step 4: Add a root coordinator for lane composition**

Create `scripts/harness-report.mjs` and update `package.json` scripts so the root can run:
- source tests
- contract fixtures
- generated-app harness
- optional smoke

Keep `pnpm test` focused on source tests. Introduce the exact root coordinator command `pnpm verify:harness` for the full framework harness.

- [ ] **Step 5: Update CI to match the lane model**

Modify `.github/workflows/ci.yml` so CI clearly separates:
- source tests
- generated-app or framework verification
- optional smoke

Do not add local-registry verification yet.

- [ ] **Step 6: Run end-to-end verification**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm verify:harness`
Expected: PASS.

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts`
Expected: PASS.

Run: `pnpm exec vitest --run --config test/smoke/vitest.config.ts`
Expected: PASS.

Run: `pnpm ci:validate`
Expected: PASS, with the new harness lanes integrated cleanly.

- [ ] **Step 7: Commit**

```bash
git add scripts/test.mjs scripts/harness-report.mjs package.json .github/workflows/ci.yml
git commit -m "chore: wire testing harness lanes"
```

## Final Verification Gate

Before considering this plan fully implemented, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm verify:harness
pnpm exec vitest --run --config test/generated/vitest.config.ts
pnpm exec vitest --run --config test/smoke/vitest.config.ts
node scripts/publish-smoke.mjs
pnpm ci:validate
```

Expected:
- all commands pass
- `dawn verify` works inside a generated app
- contract fixtures catch invalid app shapes
- generated apps pass scaffold-to-build verification
- smoke runs produce inspectable artifacts and stable pass/fail reporting
