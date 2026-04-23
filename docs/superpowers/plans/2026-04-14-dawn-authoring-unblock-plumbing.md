# Dawn Authoring-Unblock Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the Dawn app/project plumbing required to unblock real authoring work by stabilizing scaffold/install behavior and the config/discovery contract.

**Architecture:** This milestone hardens two narrow lanes. First, make both the public scaffold path and the contributor-local scaffold path deterministic and verifiable. Second, treat the current `dawn.config.ts` subset and route discovery semantics as explicit contract, backed by focused fixtures and tests, so the next authoring layer can build on a stable project shape instead of reopening foundational questions.

**Tech Stack:** TypeScript, pnpm, Vitest, Commander-based CLI, Dawn scaffold/devkit packages, contract fixtures, generated-app harness

---

## File Structure

### Primary Files

- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
  - Internal vs external scaffolding behavior, local package specifier generation, contributor-local bootstrap invariants.
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
  - Unit/integration coverage for scaffold modes and package-specifier behavior.
- Modify: `/Users/blove/repos/dawn/test/generated/harness.ts`
  - Canonical generated-app runtime/scaffold support paths.
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
  - Generated-app contract assertions for the scaffold/install lane.
- Modify: `/Users/blove/repos/dawn/packages/core/src/config.ts`
  - Supported `dawn.config.ts` subset parser behavior.
- Modify: `/Users/blove/repos/dawn/packages/core/src/discovery/find-dawn-app.ts`
  - Frozen Dawn app discovery semantics.
- Modify: `/Users/blove/repos/dawn/packages/core/src/discovery/discover-routes.ts`
  - Frozen route discovery, route identity, and invalid-shape semantics.
- Modify: `/Users/blove/repos/dawn/packages/core/test/config.test.ts`
  - Config-subset contract coverage.
- Modify: `/Users/blove/repos/dawn/packages/core/test/discover-routes.test.ts`
  - Discovery/identity/collision contract coverage.

### Fixture Files

- Modify or Create: `/Users/blove/repos/dawn/test/fixtures/contracts/*`
  - Add or refine fixture apps only where the config/discovery contract is still ambiguous.
- Modify or Create: `/Users/blove/repos/dawn/test/generated/fixtures/*.expected.json`
  - Freeze generated-app expectations only where scaffold/install behavior changes.

### Verification / Docs Files

- Modify if needed: `/Users/blove/repos/dawn/README.md`
  - Only if the canonical public scaffold path needs wording changes after Task 1.
- Modify if needed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`
  - Only if the canonical contributor-local scaffold path needs wording changes after Task 1.

---

### Task 1: Freeze Scaffold And Install Shape

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/src/index.ts`
- Modify: `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/harness.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
- Modify if needed: `/Users/blove/repos/dawn/test/generated/fixtures/basic.expected.json`
- Modify if needed: `/Users/blove/repos/dawn/test/generated/fixtures/custom-app-dir.expected.json`
- Modify if needed: `/Users/blove/repos/dawn/README.md`
- Modify if needed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`

- [ ] **Step 1: Write a failing test for the contributor-local scaffold path**

Add a failing test that proves the canonical contributor-local path the next authoring layer will use, not just the current unit-level “file specifier exists” check.

The failing coverage should prove:
- local/internal scaffold can be created from a Dawn checkout
- the generated app can install in the intended contributor-local shape
- the generated app exposes a runnable `dawn` command
- the generated app can run `dawn verify`, `dawn run`, `dawn test`, and `dawn dev` without ad hoc shims

Target tests:
- `/Users/blove/repos/dawn/packages/create-dawn-app/test/create-app.test.ts`
- or `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts` if that is the better integration boundary

The implementation must add explicit generated-app acceptance cases with stable names, at minimum:
- `supports contributor-local verify lifecycle`
- `supports contributor-local runtime lifecycle`

- [ ] **Step 2: Run the new scaffold/install test to verify it fails**

Run a narrow test command for the new failing case, for example:

```bash
pnpm --filter create-dawn-app test -- --run test/create-app.test.ts
```

or the equivalent Vitest invocation for the generated-app lane.

Expected:
- FAIL because the contributor-local scaffold/install path is not yet deterministic enough

- [ ] **Step 3: Implement the minimal scaffold/install fix**

Modify the scaffolder and/or generated-app harness so Dawn has two explicit stable paths:

1. external canonical path
2. contributor-local canonical path

The implementation must remove known ambiguity around:
- internal mode package specifiers
- workspace topology assumptions
- temp path / local path portability issues in the contributor-local flow
- command availability inside the generated app

Do not broaden template scope or add unrelated scaffolding features.

- [ ] **Step 4: Update docs only if the canonical path changes materially**

If Task 1 changes the documented contributor-local or public scaffold path in a user-visible way, update:
- `/Users/blove/repos/dawn/README.md`
- `/Users/blove/repos/dawn/CONTRIBUTORS.md`

If the implementation only makes the current documented paths actually true, do not add documentation churn.

- [ ] **Step 5: Run scaffold/install verification**

Run the relevant narrow verification commands, including:

```bash
pnpm --filter create-dawn-app test
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts -t "supports contributor-local verify lifecycle"
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-runtime-contract.test.ts -t "supports contributor-local runtime lifecycle"
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-runtime-contract.test.ts
```

Use those tests to prove these exact generated-app responsibilities:
- `test/generated/run-generated-app.test.ts`
  - canonical public scaffold path still works
  - canonical contributor-local path now works without undocumented patch-up steps
  - generated app can execute `dawn verify`
- `test/generated/run-generated-runtime-contract.test.ts`
  - generated app can execute `dawn run`
  - generated app can execute `dawn test`
  - generated app can execute `dawn dev`

Expected:
- PASS with the new contributor-local scaffold/install contract proven

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add packages/create-dawn-app test/generated README.md CONTRIBUTORS.md
git commit -m "fix: stabilize dawn scaffold install paths"
```

Only stage files actually changed.

---

### Task 2: Freeze Config And Discovery Contract

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/core/src/config.ts`
- Modify: `/Users/blove/repos/dawn/packages/core/src/discovery/find-dawn-app.ts`
- Modify: `/Users/blove/repos/dawn/packages/core/src/discovery/discover-routes.ts`
- Modify: `/Users/blove/repos/dawn/packages/core/test/config.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/core/test/discover-routes.test.ts`
- Modify or Create: `/Users/blove/repos/dawn/test/fixtures/contracts/*`
- Modify if needed: `/Users/blove/repos/dawn/README.md`
- Modify if needed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`

- [ ] **Step 1: Write failing tests for the remaining config/discovery ambiguities**

Add failing contract tests around the exact subset the next authoring layer should rely on:
- supported `dawn.config.ts` forms for `appDir`
- unsupported config expressions that must fail clearly
- route groups/private segments/pathname identity
- invalid route directory shapes
- stable collision and invalid-layout errors

Prefer fixture-backed tests over ad hoc assertions when the behavior is truly part of the contract.

- [ ] **Step 2: Run the new config/discovery tests to verify they fail**

Run:

```bash
pnpm --filter @dawnai.org/core test
```

Expected:
- FAIL on the new contract cases before implementation

- [ ] **Step 3: Implement the minimal config/discovery freeze**

Modify the core parser/discovery implementation so the supported subset is explicit and stable.

The result should:
- keep `appDir` narrow and intentional
- reject unsupported config shapes with stable errors
- preserve stable route identity/pathname outputs
- preserve stable collision and invalid-layout behavior

Do not widen config expressiveness unless a failing test proves the current supported subset is too weak for the intended contract.

- [ ] **Step 4: Update root docs only where the frozen contract becomes clearer**

If Task 2 clarifies a user-facing contract detail that the docs currently describe too loosely, update:
- `/Users/blove/repos/dawn/README.md`
- `/Users/blove/repos/dawn/CONTRIBUTORS.md`

Examples:
- exact `dawn.config.ts` subset wording
- exact contributor expectations around route discovery

- [ ] **Step 5: Run config/discovery verification**

Run:

```bash
pnpm --filter @dawnai.org/core test
pnpm --filter @dawnai.org/cli test
```

Expected:
- PASS
- CLI surfaces depending on discovery continue to work against the frozen contract

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add packages/core packages/cli test/fixtures/contracts README.md CONTRIBUTORS.md
git commit -m "test: freeze dawn config and discovery contract"
```

Only stage files actually changed.

---

### Task 3: Declare Plumbing V1 For Authoring With Final Verification

**Files:**
- Verify: `/Users/blove/repos/dawn/packages/create-dawn-app/*`
- Verify: `/Users/blove/repos/dawn/packages/core/*`
- Verify: `/Users/blove/repos/dawn/test/generated/*`
- Verify: `/Users/blove/repos/dawn/test/fixtures/contracts/*`
- Verify if changed: `/Users/blove/repos/dawn/README.md`
- Verify if changed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`

- [ ] **Step 1: Run the targeted plumbing acceptance commands**

Run the acceptance commands that prove the milestone’s declared stable surface:

```bash
pnpm --filter create-dawn-app test
pnpm --filter @dawnai.org/core test
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts -t "supports contributor-local verify lifecycle"
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-runtime-contract.test.ts -t "supports contributor-local runtime lifecycle"
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-runtime-contract.test.ts
pnpm exec vitest --run --config test/runtime/vitest.config.ts
```

The generated-app acceptance cases named above must collectively exercise, from the generated contributor-local app cwd:
- `dawn verify`
- `dawn run`
- `dawn test`
- `dawn dev`

against the canonical authoring-development app shape.

Expected:
- scaffold/install path is stable
- config/discovery contract is stable
- runtime confidence remains intact for the canonical authoring-development app shape
- the full contributor-local command surface required by the next authoring layer is proven

- [ ] **Step 2: Run the broader repo regression gate**

Run:

```bash
pnpm test
node scripts/check-docs.mjs
```

Expected:
- full repo tests pass
- docs completeness check still passes

- [ ] **Step 3: Check final scope discipline**

Run:

```bash
git status --short
git diff --stat HEAD~2..HEAD
```

Adjust the diff range if Task 3 required an additional cleanup commit.

Expected:
- only scaffold/install and config/discovery stabilization work is included
- no unrelated authoring or backend-abstraction work slipped in

- [ ] **Step 4: Commit any final cleanup if needed**

If verification required a final docs or fixture-only cleanup:

```bash
git add .
git commit -m "test: finalize plumbing v1 authoring acceptance"
```

If no cleanup was needed, do not create an extra commit.

- [ ] **Step 5: Prepare the handoff**

At completion, report this milestone as:
- plumbing v1 for authoring is ready
- scaffold/install shape is frozen
- config/discovery shape is frozen
- next step is a real authoring design plan

Back that claim with fresh evidence from:
- `pnpm --filter create-dawn-app test`
- `pnpm --filter @dawnai.org/core test`
- `pnpm exec vitest --run --config test/generated/vitest.config.ts`
- `pnpm exec vitest --run --config test/runtime/vitest.config.ts`
- `pnpm test`
- `node scripts/check-docs.mjs`

---

## Notes For Implementers

- Stay inside the two agreed lanes. Do not expand into backend-neutral authoring work yet.
- Treat the current starter template as contract input, not just sample content.
- Fix contributor-local scaffold/install determinism at the root cause, not with verification shims.
- Keep the config subset narrow on purpose. Stability matters more than flexibility at this stage.
- If you discover a public/internal path conflict, resolve it explicitly rather than letting the authoring layer inherit hidden assumptions.
