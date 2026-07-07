# Argument-level Tool Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent({ tools: { constrain: { deployProd: (args, ctx) => args.env === "prod" ? { approve: true } : args.env === "staging" ? true : "staging/prod only" } } })` — a per-tool predicate evaluated against the model's arguments at call time, returning allow / deny-with-reason / escalate-to-HITL.

**Architecture:** A runtime wrapper (`wrapToolWithConstraint`) on the tool's `run`, applied at the same `execute-route.ts` compose seam as slice 2's `approve` wrap. The predicate's `{approve}` verdict reuses the shipped `gateToolOp` interrupt/resume path. Because the wrapper is baked into a per-descriptor-cached agent (the `materializedAgents` WeakMap), all per-call data (args, signal, threadId, params) is read from the **live run context**, never closed over at compose time — so nothing goes stale across invokes. This requires the langchain tool-converter to forward `thread_id` + route params from `config.configurable` into the tool run context (a small, additive widening that also benefits any tool wanting its thread id).

**Tech Stack:** TypeScript monorepo (pnpm + turbo), vitest, biome (repo lint script only — NEVER bare `biome check --write` on dirs), `@dawn-ai/{sdk,core,langchain,cli,testing}`, aimock deterministic e2e.

**Spec:** `docs/superpowers/specs/2026-07-06-arg-constraints-design.md`

**Conventions for every task:**
- Cross-package tests resolve against built `dist`: after changing a package's `src/`, `npx turbo run build --filter=@dawn-ai/<pkg>` before running a *dependent* package's tests. Same-package tests import from `src/` and don't need it.
- Verify `git branch --show-current` before each commit (should be the feature branch). Commit after each green task; do NOT push until the final task.
- Lint per file: `pnpm exec biome check --config-path packages/config-biome/biome.json <files>`.

---

### Task 1: `ConstraintPredicate` types + `ToolScope.constrain` (`@dawn-ai/sdk`)

**Files:**
- Modify: `packages/sdk/src/agent.ts` (the `ToolScope` interface + new exported types)
- Modify: `packages/sdk/src/index.ts` (export the new types if the file re-exports agent types — grep first)
- Test: `packages/sdk/test/agent.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/sdk/test/agent.test.ts`:

```ts
it("passes tools.constrain predicates through to the descriptor", () => {
  const predicate = (args: unknown) =>
    (args as { env?: string }).env === "prod" ? ({ approve: true } as const) : true
  const a = agent({
    model: "gpt-5-mini",
    systemPrompt: "x",
    tools: { constrain: { deployProd: predicate } },
  })
  expect(a.tools?.constrain?.deployProd).toBe(predicate)
})
```

- [ ] **Step 2: Run to verify it fails.** `cd packages/sdk && npx vitest run test/agent.test.ts` — FAIL: `constrain` not on `ToolScope`.

- [ ] **Step 3: Add the types.** In `packages/sdk/src/agent.ts`, immediately above `export interface ToolScope`:

```ts
export interface ConstraintContext {
  readonly toolName: string
  readonly routeId: string
  readonly threadId?: string
  readonly signal: AbortSignal
  /** Route params in scope (e.g. tenant) when the route is parameterized. */
  readonly params?: Readonly<Record<string, string>>
}

export type ConstraintVerdict = true | string | { readonly approve: true; readonly reason?: string }

export type ConstraintPredicate = (
  args: unknown,
  ctx: ConstraintContext,
) => ConstraintVerdict | Promise<ConstraintVerdict>
```

Then add to `ToolScope` (after `approve`):

```ts
  /**
   * Per-call argument constraints: a predicate per tool name, run at call time
   * against the model's arguments. Return `true` to allow, a string to deny
   * (returned as the tool result), or `{ approve: true }` to escalate to a HITL
   * approval prompt. Predicate bodies are not statically validated — only the
   * tool names are. See docs/permissions.
   */
  readonly constrain?: Readonly<Record<string, ConstraintPredicate>>
```

- [ ] **Step 4: Export the types.** In `packages/sdk/src/index.ts`, grep for how `ToolScope` is exported (`grep -n "ToolScope" packages/sdk/src/index.ts`). If types are re-exported there, add `ConstraintContext`, `ConstraintVerdict`, `ConstraintPredicate` to that export block. If `agent.ts`'s types are exported via `export * from "./agent.js"`, nothing to do.

- [ ] **Step 5: Run to verify pass.** `cd packages/sdk && npx vitest run` — all pass.

- [ ] **Step 6: Lint + commit.**
```bash
pnpm exec biome check --config-path packages/config-biome/biome.json packages/sdk/src/agent.ts packages/sdk/test/agent.test.ts
git add packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/agent.test.ts
git commit -m "feat(sdk): ToolScope.constrain — per-tool argument-constraint predicates"
```

---

### Task 2: widen the tool run context with `threadId` + `params` (`@dawn-ai/core`)

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (the `DawnToolDefinition.run` context object type, ~lines 72-87)
- Test: none (a type-only widening; exercised by Task 3's converter test and Task 4's wrapper).

- [ ] **Step 1: Add the optional fields.** In `packages/core/src/capabilities/types.ts`, the `DawnToolDefinition.run`'s `context` object currently is:

```ts
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      readonly fs?: WorkspaceFs
    },
```

Change it to:

```ts
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      readonly fs?: WorkspaceFs
      // Live per-call runtime identity, forwarded by the langchain tool-converter
      // from config.configurable. Optional because pre-wrap/legacy invokers omit
      // it. Read by the argument-constraint wrapper to build ConstraintContext.
      readonly threadId?: string
      readonly params?: Readonly<Record<string, string>>
    },
```

- [ ] **Step 2: Build to verify it typechecks.** `npx turbo run build --filter=@dawn-ai/core` — success.

- [ ] **Step 3: Commit.**
```bash
git add packages/core/src/capabilities/types.ts
git commit -m "feat(core): tool run context carries optional live threadId + route params"
```

---

### Task 3: forward `thread_id` + route params in the tool-converter (`@dawn-ai/langchain`)

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts` (the `func` that calls `tool.run`, ~lines 34-39)
- Test: `packages/langchain/test/tool-converter.test.ts`

The langchain `config` (3rd arg of the tool `func`) is a `RunnableConfig`; `config.configurable` holds `thread_id` and the route params (set by the agent-adapter's `prepareAgentCall`). Forward them into the run context so the constraint wrapper reads live values.

- [ ] **Step 1: Write the failing test.** Read `packages/langchain/test/tool-converter.test.ts` first to match its style. Append a test that a converted tool's `run` receives `threadId`/`params` from `config.configurable`:

```ts
it("forwards thread_id and route params from config.configurable into the tool run context", async () => {
  let seen: { threadId?: string; params?: Record<string, string> } | undefined
  const tool = {
    name: "probe",
    run: (_input: unknown, ctx: { threadId?: string; params?: Record<string, string> }) => {
      seen = { threadId: ctx.threadId, params: ctx.params }
      return "ok"
    },
  }
  const lc = convertToolToLangChain(tool)
  await lc.invoke(
    {},
    { configurable: { thread_id: "t-123", tenant: "acme" } },
  )
  expect(seen?.threadId).toBe("t-123")
  expect(seen?.params).toEqual({ tenant: "acme" })
})
```

(If `convertToolToLangChain`'s signature/invoke differs, mirror the existing tests in the file — they already invoke converted tools.)

- [ ] **Step 2: Run to verify fail.** `cd packages/langchain && npx vitest run test/tool-converter.test.ts` — FAIL: `seen.threadId`/`seen.params` undefined.

- [ ] **Step 3: Implement.** In `packages/langchain/src/tool-converter.ts`, the `func` (~line 34) currently:

```ts
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const rawResult = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
      })
```

Change the `tool.run` context to extract thread_id + params from `config.configurable`:

```ts
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      // config.configurable carries thread_id + the route params (set by the
      // agent-adapter's prepareAgentCall). Forward them so tools — and the
      // argument-constraint wrapper — can read live per-call identity.
      const configurable = (config?.configurable ?? {}) as Record<string, unknown>
      const threadId =
        typeof configurable.thread_id === "string" ? configurable.thread_id : undefined
      const params: Record<string, string> = {}
      for (const [key, value] of Object.entries(configurable)) {
        if (key !== "thread_id" && typeof value === "string") params[key] = value
      }
      const rawResult = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
        ...(threadId ? { threadId } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
      })
```

- [ ] **Step 4: Run to verify pass + full package.** `cd packages/langchain && npx vitest run test/tool-converter.test.ts && npx vitest run` — all pass (existing tools unaffected — the new context fields are additive/optional).

- [ ] **Step 5: Lint + commit.**
```bash
pnpm exec biome check --config-path packages/config-biome/biome.json packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): forward thread_id + route params into the tool run context"
```

---

### Task 4: `wrapToolWithConstraint` (`@dawn-ai/core`)

**Files:**
- Modify: `packages/core/src/capabilities/permission-gate.ts` (new wrapper + a small fail-closed constant)
- Modify: `packages/core/src/index.ts` (export `wrapToolWithConstraint`)
- Test: `packages/core/test/capabilities/permission-gate.test.ts`

The wrapper closes over `routeId` + `predicate` (both stable per descriptor); it reads `signal`/`threadId`/`params` from the **live** run context. `ConstraintPredicate`/`ConstraintContext`/`ConstraintVerdict` are imported from `@dawn-ai/sdk` (build sdk first).

- [ ] **Step 1: Write the failing tests.** Append to `packages/core/test/capabilities/permission-gate.test.ts` (reuse its `mkdtempSync` appRoot + `createPermissionsStore` helpers; add `wrapToolWithConstraint` to the import from `../../src/capabilities/permission-gate.js`):

```ts
describe("wrapToolWithConstraint", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-constrain-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const runCtx = { signal }

  it("allows (runs the real tool) when the predicate returns true", async () => {
    const tool = { name: "deployProd", run: async (i: unknown) => `ran:${JSON.stringify(i)}` }
    const wrapped = wrapToolWithConstraint(tool, () => true, undefined, "/ops#agent")
    expect(await wrapped.run({ env: "staging" }, runCtx)).toBe('ran:{"env":"staging"}')
  })

  it("denies with the reason string as the tool result", async () => {
    let ran = false
    const tool = {
      name: "deployProd",
      run: async () => {
        ran = true
        return "ran"
      },
    }
    const wrapped = wrapToolWithConstraint(tool, () => "prod not allowed here", undefined, "/ops#agent")
    const result = await wrapped.run({ env: "prod" }, runCtx)
    expect(ran).toBe(false)
    expect(String(result)).toBe("prod not allowed here")
  })

  it("passes toolName/routeId and live threadId/params to the predicate", async () => {
    let seen: { toolName?: string; routeId?: string; threadId?: string; params?: unknown } = {}
    const tool = { name: "deployProd", run: async () => "ran" }
    const wrapped = wrapToolWithConstraint(
      tool,
      (_args, ctx) => {
        seen = { toolName: ctx.toolName, routeId: ctx.routeId, threadId: ctx.threadId, params: ctx.params }
        return true
      },
      undefined,
      "/ops#agent",
    )
    await wrapped.run({}, { signal, threadId: "t-9", params: { tenant: "acme" } })
    expect(seen).toEqual({ toolName: "deployProd", routeId: "/ops#agent", threadId: "t-9", params: { tenant: "acme" } })
  })

  it("fails closed (deny result) when the predicate throws", async () => {
    let ran = false
    const tool = {
      name: "deployProd",
      run: async () => {
        ran = true
        return "ran"
      },
    }
    const wrapped = wrapToolWithConstraint(
      tool,
      () => {
        throw new Error("boom")
      },
      undefined,
      "/ops#agent",
    )
    const result = await wrapped.run({}, runCtx)
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/constraint check failed/i)
  })

  it("awaits an async predicate", async () => {
    const tool = { name: "deployProd", run: async () => "ran" }
    const wrapped = wrapToolWithConstraint(
      tool,
      async () => await Promise.resolve("async denied"),
      undefined,
      "/ops#agent",
    )
    expect(String(await wrapped.run({}, runCtx))).toBe("async denied")
  })

  it("{approve} escalates through gateToolOp — pre-approved tool runs", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { tool: ["deployProd"] }, deny: {} },
      mode: "interactive",
    })
    await permissions.load()
    const tool = { name: "deployProd", run: async () => "deployed" }
    const wrapped = wrapToolWithConstraint(tool, () => ({ approve: true }), permissions, "/ops#agent")
    expect(await wrapped.run({ env: "prod" }, runCtx)).toBe("deployed")
  })

  it("{approve} escalates through gateToolOp — denied tool returns the gate reason", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { tool: ["deployProd"] } },
      mode: "interactive",
    })
    await permissions.load()
    let ran = false
    const tool = {
      name: "deployProd",
      run: async () => {
        ran = true
        return "deployed"
      },
    }
    const wrapped = wrapToolWithConstraint(tool, () => ({ approve: true }), permissions, "/ops#agent")
    const result = await wrapped.run({ env: "prod" }, runCtx)
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/denied.*deployProd/i)
  })
})
```

- [ ] **Step 2: Run to verify fail.** `npx turbo run build --filter=@dawn-ai/sdk && cd packages/core && npx vitest run test/capabilities/permission-gate.test.ts` — FAIL: `wrapToolWithConstraint` not exported.

- [ ] **Step 3: Implement.** In `packages/core/src/capabilities/permission-gate.ts`, add the import at the top (with the other `@dawn-ai/sdk`/type imports — check what's already imported):

```ts
import type { ConstraintContext, ConstraintPredicate } from "@dawn-ai/sdk"
```

Then add after `wrapToolWithApproval`:

```ts
const CONSTRAINT_FAILED_REASON =
  "Blocked: the tool's argument constraint check failed (the policy predicate threw). Not run."

/**
 * Wrap a tool so each call is first evaluated by an argument-constraint predicate
 * (tools.constrain). The predicate returns `true` (allow), a string (deny — the
 * string is returned as the tool result, matching wrapToolWithApproval's
 * return-not-throw contract), or `{ approve: true }` (escalate to the HITL gate
 * via gateToolOp). A predicate that THROWS fails closed (deny) — a broken policy
 * never silently allows. Per-call identity (signal/threadId/params) is read from
 * the LIVE run context, never closed over, so the wrapper is safe inside the
 * per-descriptor-cached agent. `routeId` and `predicate` are stable per descriptor
 * and closed over.
 */
export function wrapToolWithConstraint<
  C extends { readonly signal: AbortSignal; readonly threadId?: string; readonly params?: Readonly<Record<string, string>> },
  T extends { readonly name: string; readonly run: (input: unknown, context: C) => Promise<unknown> | unknown },
>(tool: T, predicate: ConstraintPredicate, permissions: PermissionsStore | undefined, routeId: string): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const ctx: ConstraintContext = {
        toolName: tool.name,
        routeId,
        signal: context.signal,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(context.params ? { params: context.params } : {}),
      }
      let verdict: Awaited<ReturnType<ConstraintPredicate>>
      try {
        verdict = await predicate(input, ctx)
      } catch {
        return CONSTRAINT_FAILED_REASON
      }
      if (verdict === true) return tool.run(input, context)
      if (typeof verdict === "string") return verdict
      // verdict is { approve: true, reason? } — escalate to the HITL gate.
      const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input))
      if (!gate.allowed) return gate.reason
      return tool.run(input, context)
    },
  }
}
```

In `packages/core/src/index.ts`, extend the existing `permission-gate.js` export line to include `wrapToolWithConstraint`.

- [ ] **Step 4: Run to verify pass + full core suite + build.** `cd packages/core && npx vitest run test/capabilities/permission-gate.test.ts && npx vitest run` then `npx turbo run build --filter=@dawn-ai/core` — all green.

- [ ] **Step 5: Lint + commit.**
```bash
pnpm exec biome check --config-path packages/config-biome/biome.json packages/core/src/capabilities/permission-gate.ts packages/core/src/index.ts packages/core/test/capabilities/permission-gate.test.ts
git add packages/core/src/capabilities/permission-gate.ts packages/core/src/index.ts packages/core/test/capabilities/permission-gate.test.ts
git commit -m "feat(core): wrapToolWithConstraint — per-call argument-constraint gate"
```

---

### Task 5: wire constraint wrapping at the compose seam (`@dawn-ai/cli`)

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (import + the block right after the `approve` wrap, ~line 707)

- [ ] **Step 1: Add the import.** Add `wrapToolWithConstraint` to the existing `@dawn-ai/core` import block (alphabetical, next to `wrapToolWithApproval`).

- [ ] **Step 2: Exclude constrain keys from the approve set + add the constrain wrap.** Replace the existing `approveSet` block (currently `const approveSet = new Set(descriptor?.tools?.approve ?? [])` … through its `.map`) with:

```ts
    // Per-tool approval gating (tools.approve). A tool that ALSO has a
    // constraint predicate is excluded here — `constrain` is authoritative and
    // can itself escalate via `{ approve }`, so wrapping both would double-gate.
    const constrain = descriptor?.tools?.constrain
    const approveSet = new Set(
      (descriptor?.tools?.approve ?? []).filter((n) => !constrain?.[n]),
    )
    if (approveSet.size > 0) {
      tools = tools.map((t) =>
        approveSet.has(t.name)
          ? wrapToolWithApproval<
              Parameters<DiscoveredToolDefinition["run"]>[1],
              DiscoveredToolDefinition
            >(t, permissionsStore)
          : t,
      )
    }

    // Per-tool argument constraints (tools.constrain): wrap surviving tools so
    // each call is evaluated by the author's predicate against the model's args
    // before the tool runs. Runs at call time; reads live identity (signal/
    // threadId/params) from the run context. `{ approve }` verdicts reuse the
    // same HITL gate as tools.approve.
    if (constrain) {
      tools = tools.map((t) => {
        // Local const: TS does not narrow a repeated indexed access across the
        // ternary, so bind once.
        const predicate = constrain[t.name]
        return predicate
          ? wrapToolWithConstraint<
              Parameters<DiscoveredToolDefinition["run"]>[1],
              DiscoveredToolDefinition
            >(t, predicate, permissionsStore, options.routeId)
          : t
      })
    }
```

(`options.routeId` is the stable per-descriptor route id already used for `keptToolNames`/scope validation; confirm it's in scope at this point — it is, it's used a few lines above.)

- [ ] **Step 3: Build + full cli suite.** `npx turbo run build --filter=@dawn-ai/cli` then `cd packages/cli && npx vitest run` — all pass (behavior unchanged for routes without `constrain`; `approve`-only routes unaffected since `constrain?.[n]` is undefined).

- [ ] **Step 4: Commit.**
```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): apply argument-constraint wrapping at the tool-scoping seam"
```

---

### Task 6: `dawn check` validates `constrain` + warns on `approve`∩`constrain` (`@dawn-ai/cli`)

**Files:**
- Modify: `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`
- Test: `packages/cli/test/check-tool-scope.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `packages/cli/test/check-tool-scope.test.ts`:

```ts
test("flags an unknown tool name in constrain", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ constrain: { deployPord: () => true } }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors.join("\n")).toMatch(/\/research.*unknown tool.*deployPord/s)
})

test("warns when a tool is in both approve and constrain (constrain wins)", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["deployProd"], constrain: { deployProd: () => true } }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(/\/research.*deployProd.*constrain/s)
})

test("clean constrain produces no issues", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ constrain: { deployProd: () => true } }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
})
```

- [ ] **Step 2: Run to verify fail.** `cd packages/cli && npx vitest run test/check-tool-scope.test.ts` — FAIL (constrain not handled).

- [ ] **Step 3: Implement.** In `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`:

(a) Widen `ToolScopeShape`:
```ts
interface ToolScopeShape {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly approve?: readonly string[]
  readonly constrain?: Readonly<Record<string, unknown>>
}
```

(b) Update the skip guard to include constrain:
```ts
    if (!scope || (!scope.allow && !scope.deny && !scope.approve && !scope.constrain)) continue
```

(c) Include constrain keys in the unknown-name check:
```ts
    const constrainNames = Object.keys(scope.constrain ?? {})
    const unknown = [
      ...(scope.allow ?? []),
      ...(scope.deny ?? []),
      ...(scope.approve ?? []),
      ...constrainNames,
    ].filter((n) => !available.has(n))
```

(d) After the existing `for (const name of scope.approve ?? [])` loop, add the overlap warning:
```ts
    const approveSet = new Set(scope.approve ?? [])
    for (const name of constrainNames) {
      if (approveSet.has(name)) {
        warnings.push(
          `⚠ ${route.pathname}: "${name}" is in both approve and constrain — constrain wins (it can escalate via { approve }); the approve entry is redundant.`,
        )
      }
    }
```

- [ ] **Step 4: Run to verify pass + full cli suite.** `cd packages/cli && npx vitest run test/check-tool-scope.test.ts && npx vitest run` — all pass.

- [ ] **Step 5: Lint + commit.**
```bash
pnpm exec biome check --config-path packages/config-biome/biome.json packages/cli/src/lib/runtime/collect-tool-scope-errors.ts packages/cli/test/check-tool-scope.test.ts
git add packages/cli/src/lib/runtime/collect-tool-scope-errors.ts packages/cli/test/check-tool-scope.test.ts
git commit -m "feat(cli): dawn check validates tools.constrain names and warns on approve overlap"
```

---

### Task 7: deterministic aimock e2e (`@dawn-ai/testing`)

**Files:**
- Create: `packages/testing/test/fixtures/probe-app/src/app/constrain-chat/index.ts`
- Create: `packages/testing/test/fixtures/probe-app/src/app/constrain-chat/tools/deployProd.ts`
- Create: `packages/testing/test/tool-constrain.e2e.test.ts`

- [ ] **Step 1: Create the fixture route.**

`packages/testing/test/fixtures/probe-app/src/app/constrain-chat/index.ts`:
```ts
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent. Use deployProd when asked to deploy.",
  tools: {
    constrain: {
      deployProd: (args) => {
        const env = (args as { env?: string }).env
        if (env === "staging") return true
        if (env === "prod") return { approve: true }
        return "Only staging or prod are valid environments."
      },
    },
  },
})
```

`packages/testing/test/fixtures/probe-app/src/app/constrain-chat/tools/deployProd.ts`:
```ts
export default async function deployProd(input: { env: string }): Promise<string> {
  return `deployed to ${input.env}`
}
```

- [ ] **Step 2: Write the e2e.** `packages/testing/test/tool-constrain.e2e.test.ts` (mirror `tool-approval.e2e.test.ts` — read it first for the harness/permissions-cleanup idiom):

```ts
// Deterministic (aimock) e2e for argument-level tool constraints (tools.constrain).
// CI-safe (no real key). Cleans permissions.json between scenarios (the {approve}
// path persists there on "always").
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectNoInterrupt, expectToolCalled } from "../src/matchers.js"

const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const permissionsPath = join(probeRoot, ".dawn", "permissions.json")
beforeEach(() => rmSync(permissionsPath, { force: true }))
afterEach(() => rmSync(permissionsPath, { force: true }))

function toolResultText(run: { toolResults: ReadonlyArray<{ name: string; content: unknown }> }, name: string): string {
  const r = run.toolResults.find((t) => t.name === name)
  return typeof r?.content === "string" ? r.content : JSON.stringify(r?.content ?? "")
}

it("allowed arg (staging) runs the tool without an interrupt", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to staging",
      fixtures: script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).replies("Done."),
    })
    expectNoInterrupt(run)
    expectToolCalled(run, "deployProd")
    expect(toolResultText(run, "deployProd")).toContain("deployed to staging")
  } finally {
    await h.close()
  }
}, 60_000)

it("escalating arg (prod) raises the kind:'tool' interrupt, then resume(once) runs it", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to prod",
      fixtures: script().user("deploy to prod").callsTool("deployProd", { env: "prod" }).replies("Done."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })
    const resumed = await h.resume({ decision: "once" })
    expectToolCalled(resumed, "deployProd")
    expect(toolResultText(resumed, "deployProd")).toContain("deployed to prod")
  } finally {
    await h.close()
  }
}, 60_000)

it("disallowed arg returns the deny reason as the tool result", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to qa",
      fixtures: script().user("deploy to qa").callsTool("deployProd", { env: "qa" }).replies("Understood."),
    })
    expectNoInterrupt(run)
    expect(toolResultText(run, "deployProd")).toMatch(/staging or prod/i)
  } finally {
    await h.close()
  }
}, 60_000)
```

- [ ] **Step 3: Build + run the e2e.** `npx turbo run build --filter=@dawn-ai/cli --filter=@dawn-ai/testing` then `cd packages/testing && npx vitest run test/tool-constrain.e2e.test.ts` — iterate until all 3 pass. (If typegen for the new route is stale, the harness runs it at boot; a real failure to look for is the constraint not firing.)

- [ ] **Step 4: Full testing suite.** `cd packages/testing && npx vitest run` — all green (live smokes skip; your cleanup hooks must not clobber other tests' state).

- [ ] **Step 5: Lint + commit.**
```bash
pnpm exec biome check --config-path packages/config-biome/biome.json packages/testing/test/tool-constrain.e2e.test.ts packages/testing/test/fixtures/probe-app/src/app/constrain-chat/index.ts packages/testing/test/fixtures/probe-app/src/app/constrain-chat/tools/deployProd.ts
git add packages/testing/test/fixtures/probe-app/src/app/constrain-chat packages/testing/test/tool-constrain.e2e.test.ts
git commit -m "test(testing): deterministic e2e for argument-level tool constraints (allow/deny/escalate)"
```

---

### Task 8: docs + changeset

**Files:**
- Modify: `apps/web/content/docs/tools.mdx` (after the `approve` "Requiring approval per call" subsection)
- Modify: `apps/web/content/docs/permissions.mdx` (short note under "Per-tool approval")
- Create: `.changeset/arg-constraints.md`

- [ ] **Step 1: tools.mdx — `constrain` as the fourth knob.** After the approval subsection's closing content, add:

```mdx
### Constraining arguments

`constrain` is the fourth scoping knob: a predicate per tool, run at call time against the model's arguments. It returns `true` (allow), a string (deny — returned to the model as the tool result), or `{ approve: true }` (escalate to the [approval prompt](/docs/permissions#per-tool-approval)).

```ts title="src/app/ops/index.ts"
export default agent({
  model: "gpt-5",
  systemPrompt: "…",
  tools: {
    constrain: {
      deployProd: (args, ctx) => {
        if (args.env === "prod") return { approve: true }   // human-in-the-loop
        if (args.env === "staging") return true             // allow
        return `Unknown environment "${args.env}".`         // deny, model sees this
      },
    },
  },
})
```

The predicate receives the parsed `args` and a read-only `ctx` (`{ toolName, routeId, threadId?, signal, params? }`); it may be async. A predicate that throws **fails closed** (the call is denied). Predicate bodies are not statically validated — `dawn check` validates only the tool names. Don't list a tool in both `approve` and `constrain`: `constrain` wins (it can escalate via `{ approve }`) and `dawn check` warns.
```

- [ ] **Step 2: permissions.mdx — the `{approve}` cross-reference.** Under the "Per-tool approval" section, add one paragraph:

```mdx
An argument [constraint](/docs/tools#constraining-arguments) can escalate a specific call to this same prompt by returning `{ approve: true }` — e.g. allow staging deploys silently but require approval for prod. The "Always" decision is still **name-level** (it persists the tool name), so it auto-approves future escalations of that tool; use an outright `deny` in the predicate if a case should never run.
```

- [ ] **Step 3: Changeset.** Create `.changeset/arg-constraints.md`:
```md
---
"@dawn-ai/sdk": patch
"@dawn-ai/core": patch
"@dawn-ai/langchain": patch
"@dawn-ai/cli": patch
---

Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.
```
(All `patch` — fixed group keeps it pre-1.0.)

- [ ] **Step 4: Docs check + commit.** `node scripts/check-docs.mjs` (avoid banned phrases). Then:
```bash
git add apps/web/content/docs/tools.mdx apps/web/content/docs/permissions.mdx .changeset/arg-constraints.md
git commit -m "docs: argument-level tool constraints — tools/permissions + changeset"
```

---

### Task 9: gated live smoke (`@dawn-ai/testing`)

**Files:**
- Create: `packages/testing/test/tool-constrain-live.smoke.test.ts`

- [ ] **Step 1: Write the gated live smoke.** Mirror `tool-approval-live.smoke.test.ts`:

```ts
// LIVE SMOKE — argument-level constraints (tools.constrain) against a real model.
// Gated on OPENAI_API_KEY: SKIPS in CI, runs only locally.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectNoInterrupt, expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const permissionsPath = join(probeRoot, ".dawn", "permissions.json")
beforeEach(() => rmSync(permissionsPath, { force: true }))
afterEach(() => rmSync(permissionsPath, { force: true }))

it.skipIf(!live)(
  "a real model deploying to staging is allowed; deploying to prod escalates to the HITL gate",
  async () => {
    const staging = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent", live: true })
    try {
      const run = await staging.run({ input: "Deploy the app to the staging environment." })
      expectNoInterrupt(run)
      expectToolCalled(run, "deployProd")
    } finally {
      await staging.close()
    }
    const prod = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent", live: true })
    try {
      const run = await prod.run({ input: "Deploy the app to the production (prod) environment." })
      expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })
    } finally {
      await prod.close()
    }
  },
  180_000,
)
```

- [ ] **Step 2: Verify locally with a key** (the runner has `OPENAI_API_KEY` in the repo `.env`): build, then run with the key exported. If no key is available in the execution environment, confirm it SKIPS cleanly (`it.skipIf`) and note that in the report — do not block on it.

- [ ] **Step 3: Lint + commit.**
```bash
pnpm exec biome check --config-path packages/config-biome/biome.json packages/testing/test/tool-constrain-live.smoke.test.ts
git add packages/testing/test/tool-constrain-live.smoke.test.ts
git commit -m "test(testing): gated live smoke for argument-level tool constraints"
```

---

### Task 10: full verification + final whole-implementation review

- [ ] **Step 1: Full build + test + lint.** From repo root:
```bash
npx turbo run build && npx turbo run test && pnpm lint
```
Expected: all green (gated live smokes skip without a key). If `create-dawn-ai-app`/generated-app lanes fail on registry versions, check whether it's the known publish-lifecycle artifact before assuming this change caused it.

- [ ] **Step 2: Spec conformance re-read.** Re-read `docs/superpowers/specs/2026-07-06-arg-constraints-design.md` section by section; confirm each requirement maps to landed code/tests/docs. In particular verify: throwing predicate fails closed; a tool in both approve+constrain is wrapped ONLY by constrain (not double-gated); `{approve}` reuses gateToolOp; threadId/params are read live (not stale across invokes).

- [ ] **Step 3: Cross-cutting check — no staleness.** Confirm `wrapToolWithConstraint` reads `signal`/`threadId`/`params` from the `context` argument (live), and only `routeId`/`predicate`/`tool.name` are closed over (stable per descriptor). A grep for `options.threadId`/`options.signal` inside the constraint wiring should find NONE closed into the wrapper.

- [ ] **Step 4: Commit any stragglers; do not push.** The session driver handles PR creation and merge.
```
