# Remove Companion-File Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `target` field and companion-file pattern from `dawn test` scenarios, inferring mode from the route's `index.ts` export via `loadRouteKind`.

**Architecture:** The `loadScenarioFile` function gains a pre-resolution step that locates the sibling `index.ts` and calls `loadRouteKind` to derive mode. The `validateScenario` function drops all `target`-related validation. Companion files (`graph.ts` / `workflow.ts`) are deleted from all test fixtures. The generated runtime harness drops its `writeCompanionScenarioEntry` helper and the `target` field from `RuntimeFixtureSpec`.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo, `@dawnai.org/core` discovery, `@dawnai.org/cli` runtime

---

### Task 1: Rewrite `load-run-scenarios.ts` to infer mode from `index.ts`

**Files:**
- Modify: `packages/cli/src/lib/runtime/load-run-scenarios.ts`

- [ ] **Step 1: Add `loadRouteKind` import**

At the top of `packages/cli/src/lib/runtime/load-run-scenarios.ts`, add the import:

```typescript
import { loadRouteKind } from "./load-route-kind.js"
```

- [ ] **Step 2: Rewrite `loadScenarioFile` to resolve route context once**

Replace the current `loadScenarioFile` function (lines 148–175) with:

```typescript
async function loadScenarioFile(options: {
  readonly appRoot: string
  readonly routesDir: string
  readonly scenarioFile: string
}): Promise<readonly LoadedRunScenario[]> {
  const scenarioModule = (await import(pathToFileURL(options.scenarioFile).href)) as {
    readonly default?: unknown
  }

  if (!Array.isArray(scenarioModule.default)) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} must default export an array of scenario objects`,
    )
  }

  const indexFile = resolve(dirname(options.scenarioFile), "index.ts")

  if (!(await pathExists(indexFile))) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} has no sibling index.ts — run.test.ts must be colocated with a route entry point`,
    )
  }

  const mode = await loadRouteKindSafe(options.scenarioFile, indexFile)

  const routeIdentity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile: indexFile,
    routesDir: options.routesDir,
  })

  if (!routeIdentity.ok) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} sibling index.ts is outside the configured appDir`,
    )
  }

  const routeContext = {
    appRoot: options.appRoot,
    mode,
    routeFile: indexFile,
    routeId: routeIdentity.routeId,
    routePath: routeIdentity.routePath,
  }

  return await Promise.all(
    scenarioModule.default.map(
      async (rawScenario, index) =>
        await validateScenario({
          rawScenario,
          routeContext,
          scenarioFile: options.scenarioFile,
          scenarioIndex: index,
        }),
    ),
  )
}
```

- [ ] **Step 3: Add `loadRouteKindSafe` helper**

Add this function after `loadScenarioFile`:

```typescript
async function loadRouteKindSafe(
  scenarioFile: string,
  indexFile: string,
): Promise<"graph" | "workflow"> {
  try {
    return await loadRouteKind(indexFile)
  } catch {
    throw new RunScenarioLoadError(
      `Scenario file ${scenarioFile} sibling index.ts exports neither "workflow" nor "graph"`,
    )
  }
}
```

- [ ] **Step 4: Rewrite `validateScenario` to drop `target` and accept route context**

Replace the `validateScenario` function (lines 177–309) with:

```typescript
async function validateScenario(options: {
  readonly rawScenario: unknown
  readonly routeContext: {
    readonly appRoot: string
    readonly mode: "graph" | "workflow"
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
  }
  readonly scenarioFile: string
  readonly scenarioIndex: number
}): Promise<LoadedRunScenario> {
  if (!isRecord(options.rawScenario)) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} contains a non-object scenario at index ${options.scenarioIndex}`,
    )
  }

  const name = options.rawScenario.name
  const hasInput = Object.hasOwn(options.rawScenario, "input")
  const input = options.rawScenario.input
  const expectation = options.rawScenario.expect
  const expectationRecord = isRecord(expectation) ? expectation : null
  const assert = options.rawScenario.assert
  const runOptions = options.rawScenario.run

  if (typeof name !== "string" || name.length === 0) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} contains a scenario with a missing name at index ${options.scenarioIndex}`,
    )
  }

  if (!hasInput) {
    throw new RunScenarioLoadError(`Scenario "${name}" must define input`)
  }

  if (typeof expectation !== "undefined" && !expectationRecord) {
    throw new RunScenarioLoadError(`Scenario "${name}" expect must be an object when provided`)
  }

  if (!expectationRecord && typeof assert !== "function") {
    throw new RunScenarioLoadError(
      `Scenario "${name}" must define at least one of expect or assert`,
    )
  }

  if (expectationRecord && !isRunScenarioStatus(expectationRecord.status)) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" must define expect.status as "passed" or "failed"`,
    )
  }

  if (typeof assert !== "undefined" && !isScenarioAssert(assert)) {
    throw new RunScenarioLoadError(`Scenario "${name}" assert must be a function when provided`)
  }

  if (typeof runOptions !== "undefined" && !isRecord(runOptions)) {
    throw new RunScenarioLoadError(`Scenario "${name}" run must be an object when provided`)
  }

  if (
    isRecord(runOptions) &&
    typeof runOptions.url !== "undefined" &&
    typeof runOptions.url !== "string"
  ) {
    throw new RunScenarioLoadError(`Scenario "${name}" run.url must be a string when provided`)
  }

  if (isRecord(expectationRecord?.error) && !isValidErrorExpectation(expectationRecord.error)) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" expect.error must use kind and message strings or { includes: string }`,
    )
  }

  if (
    typeof expectationRecord?.meta !== "undefined" &&
    !isValidMetaExpectation(expectationRecord.meta)
  ) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" expect.meta must use string fields for mode, routeId, routePath, and executionSource`,
    )
  }

  return {
    appRoot: options.routeContext.appRoot,
    ...(isScenarioAssert(assert) ? { assert } : {}),
    ...(expectationRecord
      ? {
          expect: {
            ...(isRecord(expectationRecord.error) ? { error: expectationRecord.error } : {}),
            ...(isRecord(expectationRecord.meta) ? { meta: expectationRecord.meta } : {}),
            ...(Object.hasOwn(expectationRecord, "output")
              ? { output: expectationRecord.output }
              : {}),
            status: expectationRecord.status as RunScenarioExpectation["status"],
          },
        }
      : {}),
    input,
    mode: options.routeContext.mode,
    name,
    routeId: options.routeContext.routeId,
    routeFile: options.routeContext.routeFile,
    routePath: options.routeContext.routePath,
    ...(isRecord(runOptions) && typeof runOptions.url === "string"
      ? { run: { url: runOptions.url } }
      : {}),
    scenarioFile: options.scenarioFile,
  }
}
```

- [ ] **Step 5: Remove companion-file narrowing rejection**

In `discoverScenarioFiles` (lines 85–121), remove lines 104–108:

```typescript
  const targetName = basename(narrowingTarget)

  if (targetName === "graph.ts" || targetName === "workflow.ts") {
    throw new RunScenarioLoadError("Route-file narrowing is not supported in v1")
  }
```

Replace with just:

```typescript
  const targetName = basename(narrowingTarget)
```

The existing logic after this (checking for `RUN_TEST_FILE`, then falling through to directory handling) remains unchanged. The `basename` import is already used elsewhere and stays.

- [ ] **Step 6: Run typecheck**

Run: `pnpm --filter @dawnai.org/cli exec tsc -p tsconfig.json --noEmit`
Expected: Clean (0 errors)

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/runtime/load-run-scenarios.ts
git commit -m "refactor(cli): infer scenario mode from index.ts, remove target field"
```

---

### Task 2: Update all CLI test fixtures and test cases

**Files:**
- Modify: `packages/cli/test/test-command.test.ts`

Every test fixture needs three changes:
1. Companion files (`graph.ts` / `workflow.ts`) become `index.ts`
2. `target` field removed from scenario definitions
3. `routePath` in meta assertions changes to `index.ts`

Four tests are deleted:
- "honors explicit local targets when both graph.ts and workflow.ts exist in the same route directory"
- "rejects route-file narrowing input in v1"
- "rejects missing or invalid targets"
- "rejects cross-directory targets"

Two tests are added:
- "rejects scenarios when sibling index.ts is missing"
- "rejects scenarios when index.ts exports neither workflow nor graph"

- [ ] **Step 1: Update test fixtures — companion files to index.ts**

In every test that has a fixture like `"src/app/.../graph.ts": "export const graph = ..."` or `"src/app/.../workflow.ts": "export const workflow = ..."`, rename the file to `"src/app/.../index.ts"`.

Affected tests and their fixture key changes:

1. Line 21 test: `"src/app/hello/[tenant]/workflow.ts"` → `"src/app/hello/[tenant]/index.ts"` (keep the content unchanged)
2. Line 82 test: `"src/app/alpha/graph.ts"` → `"src/app/alpha/index.ts"`, `"src/app/beta/workflow.ts"` → `"src/app/beta/index.ts"`
3. Line 125 test: same as #2
4. Line 159 test: `"src/app/docs/graph.ts"` → `"src/app/docs/index.ts"`, `"src/app/docs/guides/workflow.ts"` → `"src/app/docs/guides/index.ts"`, `"src/app/marketing/graph.ts"` → `"src/app/marketing/index.ts"`
5. Line 202 test: `"src/app/docs/graph.ts"` → `"src/app/docs/index.ts"`
6. Line 225 test: same pattern
7. Line 351 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
8. Line 379 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
9. Line 402 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
10. Line 429 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
11. Line 458 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
12. Line 488 test: `"src/app/support/[tenant]/workflow.ts"` → `"src/app/support/[tenant]/index.ts"`
13. Line 523 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
14. Line 552 test: `"src/app/support/[tenant]/graph.ts"` → `"src/app/support/[tenant]/index.ts"`
15. Line 604 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
16. Line 637 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
17. Line 671 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
18. Line 700 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
19. Line 729 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
20. Line 751 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"` (no scenario file)
21. Line 765 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
22. Line 787 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`
23. Line 815 test: `"src/app/support/graph.ts"` → `"src/app/support/index.ts"`

- [ ] **Step 2: Remove `target` from all scenario definitions**

Remove every `target: "./graph.ts"` and `target: "./workflow.ts"` from all `scenarioModule([...])` calls and `scenarioModuleSource(...)` template strings in the test file.

- [ ] **Step 3: Update `routePath` in meta assertions**

In the first test (line 21), the meta assertion has:
```typescript
routePath: "src/app/hello/[tenant]/workflow.ts",
```
Change to:
```typescript
routePath: "src/app/hello/[tenant]/index.ts",
```

In the meta assertions test (line 488), change:
```typescript
routePath: "src/app/support/[tenant]/workflow.ts",
```
to:
```typescript
routePath: "src/app/support/[tenant]/index.ts",
```

In the server-backed test (line 552), change:
```typescript
routePath: "src/app/support/[tenant]/graph.ts",
```
to:
```typescript
routePath: "src/app/support/[tenant]/index.ts",
```

- [ ] **Step 4: Delete four tests**

Delete the following test blocks entirely:

1. "honors explicit local targets when both graph.ts and workflow.ts exist in the same route directory" (lines 246–274)
2. "rejects route-file narrowing input in v1" (lines 276–299)
3. "rejects missing or invalid targets" (lines 301–324)
4. "rejects cross-directory targets" (lines 326–349)

- [ ] **Step 5: Add new test — rejects when sibling index.ts is missing**

Add this test after the "returns exit 1 when no scenarios are found" test:

```typescript
  test("rejects scenarios when sibling index.ts is missing", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { status: "passed" },
          input: {},
          name: "orphaned scenario",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain("has no sibling index.ts")
  })
```

- [ ] **Step 6: Add new test — rejects when index.ts exports neither workflow nor graph**

```typescript
  test("rejects scenarios when index.ts exports neither workflow nor graph", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const helper = () => ({});\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { status: "passed" },
          input: {},
          name: "bad export scenario",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain('exports neither "workflow" nor "graph"')
  })
```

- [ ] **Step 7: Run tests**

Run: `cd packages/cli && pnpm vitest run test/test-command.test.ts`
Expected: All tests pass (the count will decrease by 4 deleted + increase by 2 added = net -2)

- [ ] **Step 8: Commit**

```bash
git add packages/cli/test/test-command.test.ts
git commit -m "test(cli): update dawn test fixtures for index.ts mode inference"
```

---

### Task 3: Update generated runtime harness and handwritten fixture

**Files:**
- Modify: `test/generated/harness.ts`
- Modify: `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts`
- Delete: `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/graph.ts`

- [ ] **Step 1: Remove `target` from `RuntimeFixtureSpec`**

In `test/generated/harness.ts`, remove the `target` field from the `RuntimeFixtureSpec` interface (line 59):

```typescript
  readonly target: "./graph.ts" | "./workflow.ts"
```

Delete this line entirely.

- [ ] **Step 2: Remove `target` from fixture definitions**

Remove `target: "./workflow.ts"` from the `basic` fixture (line 109).
Remove `target: "./graph.ts"` from the `custom-app-dir` fixture (line 126).
Remove `target: "./graph.ts"` from the `handwritten` fixture (line 143).

- [ ] **Step 3: Remove `target` from generated `run.test.ts` template**

In `writeRunScenarioFile` (around lines 500–548), remove the two lines that emit `target`:

```typescript
      `    target: ${JSON.stringify(options.fixture.target)},`,
```

Remove both occurrences (one for the in-process scenario, one for the server scenario).

- [ ] **Step 4: Delete `writeCompanionScenarioEntry` and `companionFileNameFor`**

Delete the entire `companionFileNameFor` function (lines 550–552):
```typescript
function companionFileNameFor(target: RuntimeFixtureSpec["target"]): "graph.ts" | "workflow.ts" {
  return target === "./graph.ts" ? "graph.ts" : "workflow.ts"
}
```

Delete the entire `writeCompanionScenarioEntry` function (lines 554–566):
```typescript
async function writeCompanionScenarioEntry(options: {
  readonly fixture: RuntimeFixtureSpec
  readonly routeDir: string
}): Promise<void> {
  const companionFile = join(options.routeDir, companionFileNameFor(options.fixture.target))
  const exportName = options.fixture.mode

  await writeFile(
    companionFile,
    [`export { ${exportName} } from "./index.js"`, ""].join("\n"),
    "utf8",
  )
}
```

- [ ] **Step 5: Remove the `writeCompanionScenarioEntry` call**

In `writeRunScenarioFile`, remove lines 495–498:
```typescript
  await writeCompanionScenarioEntry({
    fixture: options.fixture,
    routeDir,
  })
```

- [ ] **Step 6: Update handwritten `run.test.ts` fixture**

Replace the content of `test/generated/fixtures/handwritten-runtime-app/src/app/(public)/hello/[tenant]/run.test.ts` with:

```typescript
import { expectMeta, expectOutput } from "@dawnai.org/cli/testing"

export default [
  {
    name: "handwritten in-process scenario",
    input: {
      tenant: "handwritten-tenant",
    },
    expect: {
      status: "passed",
      output: {
        greeting: "Hello, handwritten-tenant!",
        tenant: "handwritten-tenant",
      },
      meta: {
        executionSource: "in-process",
        mode: "graph",
        routeId: "/hello/[tenant]",
        routePath: "src/app/(public)/hello/[tenant]/index.ts",
      },
    },
  },
  {
    name: "handwritten server scenario",
    input: {
      tenant: "handwritten-tenant",
    },
    run: {
      url: "__SERVER_URL__",
    },
    expect: {
      status: "passed",
      output: {
        greeting: "Hello, handwritten-tenant!",
        tenant: "handwritten-tenant",
      },
      meta: {
        executionSource: "server",
        mode: "graph",
        routeId: "/hello/[tenant]",
        routePath: "src/app/(public)/hello/[tenant]/index.ts",
      },
    },
    assert(result) {
      expectMeta(result, { executionSource: "server", mode: "graph" })
      expectOutput(result, { tenant: "handwritten-tenant" })
    },
  },
]
```

- [ ] **Step 7: Delete companion file**

```bash
git rm test/generated/fixtures/handwritten-runtime-app/src/app/\(public\)/hello/\[tenant\]/graph.ts
```

- [ ] **Step 8: Run full ci:validate**

Run: `pnpm ci:validate`
Expected: All lanes pass (framework, runtime, smoke)

- [ ] **Step 9: Commit**

```bash
git add test/generated/harness.ts \
  test/generated/fixtures/handwritten-runtime-app/src/app/\(public\)/hello/\[tenant\]/run.test.ts
git commit -m "refactor: remove companion-file scaffolding from generated runtime harness"
```
