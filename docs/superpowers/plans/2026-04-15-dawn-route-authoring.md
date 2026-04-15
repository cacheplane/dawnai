# Dawn Route Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first real Dawn authoring layer by making `route.ts` the Dawn-owned route contract, auto-discovering tools from folder structure, and injecting a Dawn-specific runtime context into route handlers.

**Architecture:** The implementation should keep Dawn’s public execution boundary stable while adding a new authoring lane on top. `@dawn/langgraph` will own the new authoring primitives, `@dawn/cli` will resolve and execute the new route definition and tool registry, and the starter template plus harness suites will prove the full flow end-to-end. Legacy native-first graph/workflow execution stays supported while the new authoring lane narrows to function-style handlers bound through `route.ts`.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, Commander CLI, existing Dawn runtime/dev server harnesses

---

## File Structure

### Primary Authoring Files

- Create: `/Users/blove/repos/dawn/packages/langgraph/src/define-route.ts`
  - Dawn-owned `route.ts` definition helper and route-definition validation.
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/define-tool.ts`
  - Dawn-owned tool definition helper and normalized tool-definition types.
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/runtime-context.ts`
  - Dawn route-context and tool-callable type surface exported to authoring code.
- Modify: `/Users/blove/repos/dawn/packages/langgraph/src/index.ts`
  - Export new route/tool/context primitives.
- Modify: `/Users/blove/repos/dawn/packages/langgraph/src/route-module.ts`
  - Add authoring-lane normalization helpers or shared validation only if needed for the new route-definition runtime bridge.
- Create: `/Users/blove/repos/dawn/packages/langgraph/test/define-route.test.ts`
  - Unit coverage for route definitions and contract failures.
- Create: `/Users/blove/repos/dawn/packages/langgraph/test/define-tool.test.ts`
  - Unit coverage for tool definitions and contract failures.

### Runtime And CLI Integration Files

- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-definition.ts`
  - Load and validate `route.ts`, preserve legacy fallback behavior, and expose normalized authoring definitions to runtime code.
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/tool-discovery.ts`
  - Discover route-local and shared tools, resolve collisions deterministically, and build the per-route tool registry.
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/dawn-context.ts`
  - Build the Dawn runtime context with `signal` and callable `tools`.
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
  - Route execution through `route.ts` when present and inject Dawn context into callable handlers.
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
  - Preserve filesystem-path-first target semantics while resolving sibling `route.ts` for the authoring lane.
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-registry.ts`
  - Keep dev-server registry aligned with the resolved route definition and executable binding.
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/src/commands/check.ts`
  - Validate the new route-definition/tool-discovery contract during `dawn check`.
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/src/commands/verify.ts`
  - Ensure verify covers the new route-definition contract without changing the outer result model.
- Modify: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
  - Validation coverage for authoring-lane errors.
- Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
  - Execution coverage for route.ts resolution and Dawn context.
- Modify: `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts`
  - Scenario coverage for the new route authoring lane.
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts`
  - Local runtime parity for the authoring lane.
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/test/verify-command.test.ts`
  - Verify output/behavior coverage for new authoring validation.

### Template And End-To-End Coverage Files

- Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
  - Replace the loose re-export/config shape with the Dawn route-definition helper.
- Create: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`
  - Route-local tool proving filesystem discovery and context injection.
- Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`
  - Use the Dawn runtime context and discovered tool.
- Modify if needed: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`
  - Match the new authoring example output shape if required.
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
  - Prove the generated template uses the new authoring lane and still verifies cleanly.
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts`
  - Prove `dawn run`, `dawn test`, and `dawn dev` through the generated authoring lane.
- Modify if needed: `/Users/blove/repos/dawn/test/generated/harness.ts`
  - Support any generated-app expectations needed for the route-definition/tool-discovery lane.
- Modify if needed: `/Users/blove/repos/dawn/test/generated/fixtures/basic.expected.json`
  - Freeze the new generated template contract.
- Modify if needed: `/Users/blove/repos/dawn/test/generated/fixtures/basic-runtime.expected.json`
  - Freeze the new runtime output contract for the generated template.
- Modify: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
  - Add direct and CLI runtime parity coverage for the route authoring lane.

### Optional Docs Files

- Modify if needed: `/Users/blove/repos/dawn/README.md`
  - Only if the documented route authoring example needs to change to stay accurate for current behavior.
- Modify if needed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`
  - Only if the contributor-local app example needs an updated route authoring snippet.

---

### Task 1: Add Authoring Primitives To `@dawn/langgraph`

**Files:**
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/define-route.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/define-tool.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/src/runtime-context.ts`
- Modify: `/Users/blove/repos/dawn/packages/langgraph/src/index.ts`
- Modify if needed: `/Users/blove/repos/dawn/packages/langgraph/src/route-module.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/test/define-route.test.ts`
- Create: `/Users/blove/repos/dawn/packages/langgraph/test/define-tool.test.ts`

- [ ] **Step 1: Write failing tests for the new route and tool contracts**

Add focused unit tests that prove:
- `defineRoute` accepts exactly one explicit `kind`
- `defineRoute` requires a relative `entry` pointing at `./graph.ts` or `./workflow.ts`
- `defineTool` requires an explicit `name`
- tool definitions normalize to one-tool-per-file semantics
- the runtime-context types are exported from the package root

At minimum, add named test cases for:
- `accepts an explicit workflow route definition`
- `rejects non-relative route entry paths`
- `accepts a named tool definition`
- `rejects unnamed tools`

- [ ] **Step 2: Run the new `@dawn/langgraph` tests to verify they fail**

Run:

```bash
pnpm --filter @dawn/langgraph test
```

Expected:
- FAIL on the new route/tool authoring cases before implementation

- [ ] **Step 3: Implement the minimal authoring primitives**

Implement:
- `defineRoute(...)`
- `defineTool(...)`
- Dawn runtime-context exported types

Keep the contracts narrow:
- route definition: `kind`, `entry`, `config`
- tool definition: `name`, optional `description`, `run`
- context types: `signal`, `tools`

Do not add schema/policy/memory abstractions.

- [ ] **Step 4: Run `@dawn/langgraph` verification**

Run:

```bash
pnpm --filter @dawn/langgraph test
pnpm --filter @dawn/langgraph typecheck
```

Expected:
- PASS

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add packages/langgraph
git commit -m "feat: add Dawn route authoring primitives"
```

Only stage files actually changed.

---

### Task 2: Resolve Route Definitions And Tool Discovery In The Runtime

**Files:**
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/route-definition.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/tool-discovery.ts`
- Create: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/dawn-context.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/runtime/resolve-route-target.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-registry.ts`
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/src/commands/check.ts`
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/src/commands/verify.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/check-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/run-command.test.ts`
- Modify: `/Users/blove/repos/dawn/packages/cli/test/test-command.test.ts`
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/test/dev-command.test.ts`
- Modify if needed: `/Users/blove/repos/dawn/packages/cli/test/verify-command.test.ts`

- [ ] **Step 1: Write failing tests for the authoring-lane runtime contract**

Add failing CLI/runtime tests that prove:
- `dawn run src/app/.../workflow.ts` resolves sibling `route.ts` when present
- bound route handlers receive a Dawn context with callable discovered tools
- shared `src/tools/*.ts` and route-local `tools/*.ts` are both discovered
- route-local tool names shadow shared tool names
- same-scope tool collisions fail clearly during validation/execution
- legacy graph/workflow routes without the new authoring lane still work

At minimum, add named cases for:
- `executes a route definition through workflow.ts and Dawn context`
- `prefers route-local tools over shared tools with the same name`
- `fails when shared tools collide within the same scope`
- `keeps legacy workflow execution unchanged`

- [ ] **Step 2: Run the targeted CLI tests to verify they fail**

Run:

```bash
pnpm --filter @dawn/cli exec vitest --run --config vitest.config.ts test/run-command.test.ts test/test-command.test.ts test/check-command.test.ts
```

Expected:
- FAIL on the new route-definition/tool-discovery cases before implementation

- [ ] **Step 3: Implement route-definition loading, tool discovery, and Dawn context injection**

Implement the runtime bridge so:
- CLI targets stay filesystem-path-first
- execution resolves `route.ts` from the same route directory when present
- the new authoring lane narrows bound entries to callable handlers
- Dawn context includes `signal` and callable `tools`
- route-local tool names shadow shared names
- same-scope collisions produce stable errors
- legacy native-first execution still works for existing routes

If `dawn check` / `dawn verify` need explicit validation for the new lane, add the smallest possible authoring validation there instead of widening `@dawn/core`.

- [ ] **Step 4: Run CLI/runtime verification**

Run:

```bash
pnpm --filter @dawn/cli test
pnpm --filter @dawn/cli typecheck
pnpm exec vitest --run --config test/runtime/vitest.config.ts
```

Expected:
- PASS
- runtime parity remains intact

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add packages/cli
git commit -m "feat: resolve Dawn route authoring at runtime"
```

Only stage files actually changed.

---

### Task 3: Update The Starter Template And End-To-End Harness

**Files:**
- Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/route.ts`
- Create: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`
- Modify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/workflow.ts`
- Modify if needed: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-app.test.ts`
- Modify: `/Users/blove/repos/dawn/test/generated/run-generated-runtime-contract.test.ts`
- Modify if needed: `/Users/blove/repos/dawn/test/generated/harness.ts`
- Modify if needed: `/Users/blove/repos/dawn/test/generated/fixtures/basic.expected.json`
- Modify if needed: `/Users/blove/repos/dawn/test/generated/fixtures/basic-runtime.expected.json`
- Modify if needed: `/Users/blove/repos/dawn/test/runtime/run-runtime-contract.test.ts`
- Modify if needed: `/Users/blove/repos/dawn/README.md`
- Modify if needed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`

- [ ] **Step 1: Write failing template/generated-app tests for the new authoring lane**

Add failing generated-app/runtime tests that prove:
- the `basic` template uses `defineRoute(...)`
- the template has a discovered route-local tool
- the scaffolded app can run through `dawn run`, `dawn test`, and `dawn dev` using the new authoring lane
- the generated output snapshots match the new route/tool structure

At minimum, extend named cases around:
- `supports contributor-local verify lifecycle`
- `supports contributor-local runtime lifecycle`
- the packaged `basic` app runtime contract

- [ ] **Step 2: Run the generated/runtime tests to verify they fail**

Run:

```bash
pnpm exec vitest --run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts test/generated/run-generated-runtime-contract.test.ts
pnpm exec vitest --run --config test/runtime/vitest.config.ts
```

Expected:
- FAIL on the updated template/authoring expectations before implementation

- [ ] **Step 3: Implement the template and snapshot updates**

Update the `basic` template so it proves:
- route definition in `route.ts`
- route-local discovered tool under `tools/`
- workflow handler using the Dawn runtime context

Update generated/runtime expectations and harness support only as needed to make the new authoring lane verifiable and stable.

- [ ] **Step 4: Run end-to-end verification**

Run:

```bash
pnpm exec vitest --run --config test/generated/vitest.config.ts
pnpm exec vitest --run --config test/runtime/vitest.config.ts
pnpm --filter create-dawn-app test
```

Expected:
- PASS

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add packages/devkit test/generated test/runtime README.md CONTRIBUTORS.md
git commit -m "feat: add Dawn route authoring template flow"
```

Only stage files actually changed.

---

### Task 4: Final Milestone Verification And Merge Readiness

**Files:**
- Verify: `/Users/blove/repos/dawn/packages/langgraph/*`
- Verify: `/Users/blove/repos/dawn/packages/cli/*`
- Verify: `/Users/blove/repos/dawn/packages/devkit/templates/app-basic/*`
- Verify: `/Users/blove/repos/dawn/test/generated/*`
- Verify: `/Users/blove/repos/dawn/test/runtime/*`
- Verify if changed: `/Users/blove/repos/dawn/README.md`
- Verify if changed: `/Users/blove/repos/dawn/CONTRIBUTORS.md`

- [ ] **Step 1: Run the authoring acceptance suite**

Run:

```bash
pnpm --filter @dawn/langgraph test
pnpm --filter @dawn/langgraph typecheck
pnpm --filter @dawn/cli test
pnpm --filter @dawn/cli typecheck
pnpm --filter create-dawn-app test
pnpm exec vitest --run --config test/generated/vitest.config.ts
pnpm exec vitest --run --config test/runtime/vitest.config.ts
pnpm test
node scripts/check-docs.mjs
```

Expected:
- PASS
- no regressions in the broad repo suite

- [ ] **Step 2: Check final scope discipline**

Run:

```bash
git status --short
git diff --stat main..HEAD
```

Expected:
- only route authoring, tool discovery, runtime integration, template, and test/support changes are present
- no unrelated backend-abstraction or deployment work leaked in

- [ ] **Step 3: Add final cleanup commit only if needed**

If verification requires a final small cleanup:

```bash
git add .
git commit -m "test: finalize route authoring acceptance"
```

If no cleanup is needed, do not create an extra commit.

- [ ] **Step 4: Merge to local `main` after fresh merged-state verification**

After the branch is green, fast-forward merge into local `main`, rerun the acceptance evidence on merged `main`, then clean up the feature worktree and branch.

Required merged-state verification:

```bash
pnpm --filter @dawn/langgraph test
pnpm --filter @dawn/cli test
pnpm exec vitest --run --config test/generated/vitest.config.ts
pnpm exec vitest --run --config test/runtime/vitest.config.ts
pnpm test
node scripts/check-docs.mjs
```

Expected:
- PASS on merged `main`

---

## Notes For Implementers

- Keep the public CLI target contract stable in this milestone. Do not switch `dawn run` or `dawn test` to `route.ts` targets.
- The new authoring lane is allowed to be stricter than the legacy/native lane. That is intentional.
- Do not widen the tool abstraction into schemas, permissions, or memory yet.
- Prefer explicit validation failures over magical fallback when route definitions or discovered tools are invalid.
- If a validation concern can be solved in `@dawn/cli` without widening `@dawn/core`, keep it there for this milestone.
