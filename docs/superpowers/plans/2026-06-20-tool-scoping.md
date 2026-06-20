# Tool Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a route's agent descriptor scope which tools its agent may call — `agent({ tools: { allow?, deny? } })` — and make subagents least-privilege by default (their own route-local tools only; ambient capability tools withheld unless granted).

**Architecture:** A pure `resolveToolScope()` filter in `@dawn-ai/core` runs at the route's tool-composition seam in `execute-route.ts`, after capability + authored tools merge and before the agent/graph is materialized. Tool origin (authored vs capability) is derived from the existing `filePath` marker (`<capability:NAME>`). An `isSubagent` flag threaded through the route-prep path makes the subagent default least-privilege. Enforcement is compose-time (a withheld tool is never offered to the model).

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, ESM `.js` import specifiers), pnpm 10.33, Vitest, Biome, changesets. Deterministic agent e2e via `@copilotkit/aimock` (`@dawn-ai/testing`).

**Spec:** `docs/superpowers/specs/2026-06-20-tool-scoping-design.md`

**Conventions:** `pnpm -r build` once at the start. Run `pnpm -r --if-present typecheck` before declaring a task done. `pyenv: cannot rehash` output is harmless. Never run a bare `biome check --write` (mass-reformats) — scope biome to changed files with `--config-path packages/config-biome/biome.json <files>`. Branch `feat/tool-scoping` is already checked out.

**Semantics recap (from the spec):**
- Base tool set per route: **top route** → all (authored + capability); **subagent** → authored only (capability withheld).
- `allow` GRANTS named tools into the set (how a subagent opts into a capability tool). `deny` REVOKES named tools. **deny wins.**
- Unknown names (not in the full available set) throw at composition time so typos fail loud.
- This scopes the tool *surface*, not execution — not a sandbox.

---

### Task 1: `ToolScope` type on the agent descriptor (`@dawn-ai/sdk`)

**Files:**
- Modify: `packages/sdk/src/agent.ts`
- Test: `packages/sdk/test/agent.test.ts` (create if absent; else add a test)

- [ ] **Step 1: Write the failing test.**

Add to `packages/sdk/test/agent.test.ts` (create the file with this content if it doesn't exist):

```ts
import { describe, expect, test } from "vitest"

import { agent } from "../src/agent.js"

describe("agent() tool scope", () => {
  test("carries a tools scope through to the descriptor", () => {
    const a = agent({
      model: "gpt-5",
      systemPrompt: "x",
      tools: { allow: ["readFile"], deny: ["runBash"] },
    })
    expect(a.tools).toEqual({ allow: ["readFile"], deny: ["runBash"] })
  })

  test("omits tools when not provided", () => {
    const a = agent({ model: "gpt-5", systemPrompt: "x" })
    expect("tools" in a).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @dawn-ai/sdk exec vitest run test/agent.test.ts`
Expected: FAIL — `tools` is not on the descriptor (type error / `a.tools` undefined and `"tools" in a` already false makes test 2 pass but test 1 fails).

- [ ] **Step 3: Add the type + wire the factory.**

In `packages/sdk/src/agent.ts`, add the `ToolScope` interface (near the other config interfaces, e.g. after `ReasoningConfig`):

```ts
export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}
```

Add `readonly tools?: ToolScope` to BOTH `DawnAgent` (after `subagents`) and `AgentConfig` (after `subagents`). Then in the `agent()` factory, add the spread alongside the existing optional spreads (e.g. after the `subagents` line):

```ts
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
```

Export `ToolScope` from `packages/sdk/src/index.ts` next to the existing `agent`/`isDawnAgent` export:

```ts
export type { ToolScope } from "./agent.js"
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm --filter @dawn-ai/sdk exec vitest run test/agent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/agent.test.ts
git commit -m "feat(sdk): tools scope on the agent descriptor"
```

---

### Task 2: `resolveToolScope` pure function + origin helper (`@dawn-ai/core`, TDD)

**Files:**
- Create: `packages/core/src/tool-scope.ts`
- Create: `packages/core/test/tool-scope.test.ts`
- Modify: `packages/core/src/index.ts` (export)

- [ ] **Step 1: Write the failing tests.**

Create `packages/core/test/tool-scope.test.ts`:

```ts
import { describe, expect, test } from "vitest"

import { resolveToolScope, toolOrigin } from "../src/tool-scope.js"

const A = (name: string) => ({ name, origin: "authored" as const })
const C = (name: string) => ({ name, origin: "capability" as const })

describe("toolOrigin", () => {
  test("capability filePath marker → capability", () => {
    expect(toolOrigin({ filePath: "<capability:runBash>" })).toBe("capability")
  })
  test("real path → authored", () => {
    expect(toolOrigin({ filePath: "/app/src/app/research/tools/search.ts" })).toBe("authored")
  })
})

describe("resolveToolScope", () => {
  const tools = [A("search"), A("writeNote"), C("readFile"), C("writeFile"), C("runBash"), C("task")]

  test("top route, no scope → all tools", () => {
    const keep = resolveToolScope(tools, undefined, { isSubagent: false, routeId: "/r" })
    expect([...keep].sort()).toEqual(["readFile", "runBash", "search", "task", "writeFile", "writeNote"])
  })

  test("subagent, no scope → authored only (capabilities withheld)", () => {
    const keep = resolveToolScope(tools, undefined, { isSubagent: true, routeId: "/r" })
    expect([...keep].sort()).toEqual(["search", "writeNote"])
  })

  test("subagent allow grants a capability tool, keeps authored", () => {
    const keep = resolveToolScope(tools, { allow: ["readFile"] }, { isSubagent: true, routeId: "/r" })
    expect([...keep].sort()).toEqual(["readFile", "search", "writeNote"])
  })

  test("top route deny revokes", () => {
    const keep = resolveToolScope(tools, { deny: ["runBash"] }, { isSubagent: false, routeId: "/r" })
    expect(keep.has("runBash")).toBe(false)
    expect(keep.has("readFile")).toBe(true)
  })

  test("deny wins over allow", () => {
    const keep = resolveToolScope(
      tools,
      { allow: ["readFile"], deny: ["readFile"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect(keep.has("readFile")).toBe(false)
  })

  test("subagent deny can drop an authored tool", () => {
    const keep = resolveToolScope(tools, { deny: ["writeNote"] }, { isSubagent: true, routeId: "/r" })
    expect([...keep].sort()).toEqual(["search"])
  })

  test("unknown name throws with available list", () => {
    expect(() =>
      resolveToolScope(tools, { allow: ["serch"] }, { isSubagent: true, routeId: "/research" }),
    ).toThrow(/unknown tool\(s\): serch/)
  })
})
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @dawn-ai/core exec vitest run test/tool-scope.test.ts`
Expected: FAIL — module `../src/tool-scope.js` does not exist.

- [ ] **Step 3: Implement `tool-scope.ts`.**

Create `packages/core/src/tool-scope.ts`:

```ts
import type { ToolScope } from "@dawn-ai/sdk"

export type ToolOrigin = "authored" | "capability"

/**
 * Capability-contributed tools are tagged with a synthetic filePath
 * `<capability:NAME>` at composition (see execute-route.ts). Everything else
 * is authored from the route's tools/*.ts.
 */
export function toolOrigin(tool: { readonly filePath: string }): ToolOrigin {
  return tool.filePath.startsWith("<capability:") ? "capability" : "authored"
}

export interface ScopeInput {
  readonly name: string
  readonly origin: ToolOrigin
}

/**
 * Resolve which tool names survive a route's scope.
 *
 * Base set: top route → all tools; subagent → authored only (capability
 * tools withheld). Then `allow` GRANTS named tools into the set, `deny`
 * REVOKES named tools, and deny wins. Unknown names (absent from the full
 * available set) throw so authoring typos fail loud at composition time.
 */
export function resolveToolScope(
  tools: readonly ScopeInput[],
  scope: ToolScope | undefined,
  context: { readonly isSubagent: boolean; readonly routeId: string },
): ReadonlySet<string> {
  const available = new Set(tools.map((t) => t.name))
  const unknown = [...(scope?.allow ?? []), ...(scope?.deny ?? [])].filter((n) => !available.has(n))
  if (unknown.length > 0) {
    throw new Error(
      `Route "${context.routeId}" tool scope references unknown tool(s): ${unknown.join(", ")}. ` +
        `Available: ${[...available].sort().join(", ")}.`,
    )
  }

  const allow = new Set(scope?.allow ?? [])
  const deny = new Set(scope?.deny ?? [])

  const keep = new Set<string>()
  for (const t of tools) {
    const inBase = context.isSubagent ? t.origin === "authored" : true
    if (inBase || allow.has(t.name)) keep.add(t.name)
  }
  for (const name of deny) keep.delete(name)
  return keep
}
```

Add to `packages/core/src/index.ts` (with the other exports):

```ts
export { resolveToolScope, toolOrigin } from "./tool-scope.js"
export type { ScopeInput, ToolOrigin } from "./tool-scope.js"
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core exec vitest run test/tool-scope.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/tool-scope.ts packages/core/src/index.ts packages/core/test/tool-scope.test.ts
git commit -m "feat(core): resolveToolScope pure filter + tool origin helper"
```

---

### Task 3: Thread `isSubagent` through the route-prep path (plumbing, no behavior change)

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

Goal: make `prepareRouteExecution` know whether the route is being materialized as a subagent. No filtering yet — pure plumbing, all existing tests stay green.

- [ ] **Step 1: Read the current signatures.**

Read `packages/cli/src/lib/runtime/execute-route.ts`. Locate the option types/signatures of `executeResolvedRoute` (~245), `streamResolvedRoute` (~675), and the internal `prepareRouteExecution` (the function containing the `applyCapabilities` call ~538 and the `tools = [...tools, ...filteredCapTools]` merge ~613). Note their exact option-object shapes.

- [ ] **Step 2: Add an optional `isSubagent` field to each.**

Add `readonly isSubagent?: boolean` to the options interfaces of `executeResolvedRoute`, `streamResolvedRoute`, and `prepareRouteExecution`. Thread it:
- `executeResolvedRoute` passes `isSubagent: options.isSubagent ?? false` into its `prepareRouteExecution(...)` call.
- `streamResolvedRoute` does the same.
- `prepareRouteExecution` receives it (default `false`) and holds it in scope near the tool merge (used in Task 4). For now it is unused — that is expected.

- [ ] **Step 3: Set the flag at the subagent dispatch site.**

In `buildSubagentResolver`, the `graph.invoke` calls `executeResolvedRoute({...})` and `graph.dawnStream` calls `streamResolvedRoute({...})`. Add `isSubagent: true` to BOTH option objects:

```ts
const result = await executeResolvedRoute({
  appRoot,
  input,
  isSubagent: true,
  routeFile: route.entryFile,
  routeId: route.id,
  routePath: route.pathname,
})
```
```ts
for await (const chunk of streamResolvedRoute({
  appRoot,
  input,
  isSubagent: true,
  routeFile: route.entryFile,
  routeId: route.id,
  routePath: route.pathname,
})) {
```

- [ ] **Step 4: Verify build + existing tests unaffected.**

Run: `pnpm --filter @dawn-ai/cli build && pnpm -r --if-present typecheck`
Then: `pnpm --filter @dawn-ai/cli exec vitest run test/execute-route*.test.ts test/dev-command.test.ts 2>&1 | tail -5` (or the nearest existing route/runtime tests)
Expected: build + typecheck clean; existing tests still pass (no behavior change yet).

- [ ] **Step 5: Commit.**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "refactor(cli): thread isSubagent through route prep (no behavior change)"
```

---

### Task 4: Apply scoping at the composition seam + subagent-scoping e2e (the keystone)

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (apply the filter after the tool merge ~613)
- Modify: `packages/testing/src/aimock-runner.ts` (surface offered tool names in `getRequests()`)
- Create: `test/runtime/fixtures/tool-scope-app/` (fixture app with a scoped subagent) — mirror an existing `test/runtime/fixtures/*` app
- Create/Modify: `test/runtime/run-tool-scope.test.ts` (aimock e2e)

- [ ] **Step 1: Apply the scope filter in `prepareRouteExecution`.**

Immediately AFTER the line `tools = [...tools, ...filteredCapTools]` (~613), insert:

```ts
// Scope the final tool surface by the route descriptor's tools: { allow, deny }.
// Subagents are least-privilege by default (authored tools only; capability
// tools withheld unless granted). Throws on unknown names (typos fail loud).
const scopeInputs = tools.map((t) => ({ name: t.name, origin: toolOrigin(t) }))
const keptToolNames = resolveToolScope(scopeInputs, descriptor?.tools, {
  isSubagent: isSubagent ?? false,
  routeId,
})
tools = tools.filter((t) => keptToolNames.has(t.name))
```

Add the import at the top of the file (with the other `@dawn-ai/core` imports):

```ts
import { resolveToolScope, toolOrigin } from "@dawn-ai/core"
```

Notes: `descriptor` is the loaded `DawnAgent | undefined` already in scope (~500). `routeId` is in scope (~381). `isSubagent` comes from Task 3. `tools` entries are `DiscoveredToolDefinition` (have `filePath`), so `toolOrigin(t)` works directly. The `resolveToolScope` throw will surface through the existing `prepareRouteExecution` error handling (it returns `{ ok: false, message }` on thrown errors, OR — verify the surrounding try/catch; if there is none around this block, wrap the three lines in try/catch and `return { ok: false, message: formatErrorMessage(e) }` to match the capability-error pattern at ~548).

- [ ] **Step 2: Surface offered tool names in the aimock journal type.**

In `packages/testing/src/aimock-runner.ts`, widen the `getRequests()` return type so tests can read the tools offered to the model. Change the body type from `{ messages?: ... } | null` to also include `tools`:

```ts
getRequests(): ReadonlyArray<{
  body: {
    messages?: Array<{ role: string; content: unknown }>
    tools?: Array<{ type?: string; function?: { name?: string } }>
  } | null
}>
```

(The underlying LLMock journal already records the full OpenAI request body including `tools`; this only widens the TS type — no runtime change. Verify the wrapped object actually returns `body.tools` by logging once during Step 5; if the wrapper strips it, return the raw journal entry's body instead.)

- [ ] **Step 3: Create the fixture app.**

Create `test/runtime/fixtures/tool-scope-app/` mirroring the structure of an existing runtime fixture (copy `dawn.config.ts`, `package.json`, `tsconfig.json` from a sibling under `test/runtime/fixtures/`). It needs:
- A `workspace/` directory (so the workspace capability activates and contributes `readFile/writeFile/listDir/runBash`).
- A top route `src/app/research/index.ts`:
```ts
import { agent } from "@dawn-ai/sdk"
import researcher from "./subagents/researcher/index.js"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "Research coordinator.",
  subagents: [researcher],
})
```
- A subagent `src/app/research/subagents/researcher/index.ts`:
```ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "RESEARCHER_SUBAGENT_MARKER read-only researcher.",
  tools: { allow: ["readFile"] },
})
```
- A route-local tool for the subagent `src/app/research/subagents/researcher/tools/search.ts` (mirror an existing `tools/*.ts` default-export tool with a zod schema).

- [ ] **Step 4: Write the e2e test.**

Create `test/runtime/run-tool-scope.test.ts`. Model the setup on the existing aimock e2e (`test/runtime/run-aimock-e2e.test.ts`) — start aimock, point the app at `OPENAI_BASE_URL`, script a parent turn that calls `task({ subagent: "researcher", input: "find X" })` and a subagent turn that replies. Then assert on the subagent's offered tools:

```ts
test("subagent is offered only its route-local tools + allowed readFile", async () => {
  // ...drive the run via the harness so the parent dispatches the researcher subagent...
  const reqs = aimock.getRequests()
  // The subagent's request is identifiable by its system prompt marker.
  const subReq = reqs.find((r) =>
    r.body?.messages?.some(
      (m) => m.role === "system" && String(m.content).includes("RESEARCHER_SUBAGENT_MARKER"),
    ),
  )
  expect(subReq).toBeDefined()
  const offered = (subReq?.body?.tools ?? []).map((t) => t.function?.name).filter(Boolean).sort()
  expect(offered).toEqual(["readFile", "search"])
  // The dangerous ambient tools are NOT offered to the least-privilege subagent:
  expect(offered).not.toContain("writeFile")
  expect(offered).not.toContain("runBash")
  expect(offered).not.toContain("task")
})
```

If reading offered tools from the journal proves brittle, fall back to asserting behavior: script the subagent to attempt a `writeFile` tool call and assert the run does not execute a write (the tool isn't in its registry) — but prefer the offered-tools assertion above.

- [ ] **Step 5: Build + run the e2e.**

Run: `pnpm -r build && pnpm exec vitest run --config test/runtime/vitest.config.ts test/runtime/run-tool-scope.test.ts`
Expected: PASS — the researcher is offered exactly `["readFile", "search"]`; `writeFile`/`runBash`/`task` absent. (This proves both the compose-time filter AND the `isSubagent` plumbing end-to-end.) Also run the existing runtime lane to confirm no regression: `pnpm exec vitest run --config test/runtime/vitest.config.ts test/runtime/run-agent-protocol.test.ts 2>&1 | tail -5`.

- [ ] **Step 6: Commit.**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts packages/testing/src/aimock-runner.ts test/runtime/fixtures/tool-scope-app test/runtime/run-tool-scope.test.ts
git commit -m "feat(cli): scope tools at composition; least-privilege subagents + e2e"
```

---

### Task 5: `dawn check` build-time validation of scope names

**Files:**
- Create: `packages/core/src/capabilities/built-in-tool-names.ts` (static registry of built-in tool names)
- Modify: `packages/core/src/index.ts` (export it)
- Create: `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`
- Modify: `packages/cli/src/commands/check.ts` (wire it in)
- Test: `packages/cli/test/check-tool-scope.test.ts`

- [ ] **Step 1: Add the built-in tool-name registry.**

Create `packages/core/src/capabilities/built-in-tool-names.ts`:

```ts
/**
 * Names of tools any built-in capability may contribute. Used by `dawn check`
 * to validate a route's tools scope against the universe of names it could
 * reference (route-local tools + these). Keep in sync with the built-in
 * capability markers under capabilities/built-in/.
 */
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "readFile",
  "writeFile",
  "listDir",
  "runBash",
  "task",
  "write_todos",
  "readSkill",
  "remember",
  "recall",
]
```

(Read the built-in marker files under `packages/core/src/capabilities/built-in/` first and make this list exact — add any tool name a marker contributes that's missing.)

Export from `packages/core/src/index.ts`:

```ts
export { BUILT_IN_TOOL_NAMES } from "./capabilities/built-in-tool-names.js"
```

- [ ] **Step 2: Write the failing test.**

Create `packages/cli/test/check-tool-scope.test.ts`:

```ts
import { describe, expect, test } from "vitest"

import { collectToolScopeErrors } from "../src/lib/runtime/collect-tool-scope-errors.js"

// Minimal fake manifest + descriptor-loader injection (mirror the model-id test's style).
test("flags an unknown tool name in a route's scope", async () => {
  const errors = await collectToolScopeErrors(
    {
      appRoot: "/app",
      routes: [{ kind: "agent", pathname: "/research", entryFile: "/app/.../index.ts", routeDir: "/app/src/app/research" }],
    } as never,
    {
      loadDescriptor: async () => ({ tools: { allow: ["serch"] } }) as never,
      routeLocalToolNames: async () => ["search"],
    },
  )
  expect(errors.join("\n")).toMatch(/\/research.*unknown tool.*serch/)
})

test("accepts a built-in capability tool name", async () => {
  const errors = await collectToolScopeErrors(
    {
      appRoot: "/app",
      routes: [{ kind: "agent", pathname: "/research", entryFile: "/app/.../index.ts", routeDir: "/app/src/app/research" }],
    } as never,
    {
      loadDescriptor: async () => ({ tools: { allow: ["readFile"] } }) as never,
      routeLocalToolNames: async () => ["search"],
    },
  )
  expect(errors).toEqual([])
})
```

- [ ] **Step 3: Run to verify failure.**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/check-tool-scope.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `collect-tool-scope-errors.ts`.**

Create `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`. Use the injected-dependency shape above so it's unit-testable (mirror how `collectUnknownModelIdWarnings` loads descriptors via `normalizeRouteModule`, but accept `loadDescriptor`/`routeLocalToolNames` injectors with real defaults):

```ts
import { BUILT_IN_TOOL_NAMES } from "@dawn-ai/core"
import { isDawnAgent } from "@dawn-ai/sdk"
import type { RouteManifest } from "@dawn-ai/core"

import { discoverToolDefinitions } from "./tool-discovery.js"
import { normalizeRouteModule } from "./warn-unknown-model-ids.js" // or wherever it's exported

interface Deps {
  loadDescriptor: (entryFile: string, appRoot: string) => Promise<{ tools?: { allow?: readonly string[]; deny?: readonly string[] } } | undefined>
  routeLocalToolNames: (appRoot: string, routeDir: string) => Promise<readonly string[]>
}

const defaultDeps: Deps = {
  loadDescriptor: async (entryFile, appRoot) => {
    try {
      const m = await normalizeRouteModule(entryFile, appRoot)
      return isDawnAgent(m.entry) ? (m.entry as { tools?: never }) : undefined
    } catch {
      return undefined
    }
  },
  routeLocalToolNames: async (appRoot, routeDir) => {
    const defs = await discoverToolDefinitions({ appRoot, routeDir })
    return defs.map((d) => d.name)
  },
}

export async function collectToolScopeErrors(
  manifest: RouteManifest,
  deps: Deps = defaultDeps,
): Promise<readonly string[]> {
  const errors: string[] = []
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    const descriptor = await deps.loadDescriptor(route.entryFile, manifest.appRoot)
    const scope = descriptor?.tools
    if (!scope || (!scope.allow && !scope.deny)) continue
    const available = new Set([
      ...(await deps.routeLocalToolNames(manifest.appRoot, route.routeDir)),
      ...BUILT_IN_TOOL_NAMES,
    ])
    const unknown = [...(scope.allow ?? []), ...(scope.deny ?? [])].filter((n) => !available.has(n))
    if (unknown.length > 0) {
      errors.push(
        `✗ ${route.pathname}: tool scope references unknown tool(s): ${unknown.join(", ")}.\n` +
          `    available: ${[...available].sort().join(", ")}`,
      )
    }
  }
  return errors
}
```

(Adjust imports to the actual export locations — verify `normalizeRouteModule`/`RouteManifest` paths.)

- [ ] **Step 5: Wire into `dawn check` and make it fail the command.**

In `packages/cli/src/commands/check.ts`, after the model-id warnings loop, add:

```ts
const scopeErrors = await collectToolScopeErrors(manifest)
if (scopeErrors.length > 0) {
  throw new CliError(`Invalid tool scope:\n${scopeErrors.join("\n")}`)
}
```

Import `collectToolScopeErrors` at the top.

- [ ] **Step 6: Run tests.**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli exec vitest run test/check-tool-scope.test.ts && pnpm -r --if-present typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 7: Commit.**

```bash
git add packages/core/src/capabilities/built-in-tool-names.ts packages/core/src/index.ts packages/cli/src/lib/runtime/collect-tool-scope-errors.ts packages/cli/src/commands/check.ts packages/cli/test/check-tool-scope.test.ts
git commit -m "feat(cli): dawn check validates tool scope names"
```

---

### Task 6: Docs + changeset + full verification + PR

**Files:**
- Modify: `apps/web/content/docs/tools.mdx` (or the nearest tools/subagents doc) — add a "Tool scoping" section
- Create: `.changeset/tool-scoping.md`

- [ ] **Step 1: Document the feature.**

Add a "Scoping a route's tools" section to `apps/web/content/docs/tools.mdx` (and a cross-link from the subagents doc). Cover: `agent({ tools: { allow, deny } })`; `deny` revokes, `allow` grants withheld capability tools, deny wins; the **subagent least-privilege default** (route-local tools only; `writeFile`/`runBash`/`task` withheld unless allowed); and a plain caveat that this scopes the tool *surface*, not execution (not a sandbox). Include the two authoring examples from the spec. Build docs: `pnpm --filter @dawn-ai/web build` (revert any `apps/web/next-env.d.ts` churn).

- [ ] **Step 2: Changeset (flag the breaking subagent behavior).**

Create `.changeset/tool-scoping.md`:

```md
---
"@dawn-ai/sdk": minor
"@dawn-ai/core": minor
"@dawn-ai/cli": minor
"@dawn-ai/testing": minor
---

Tool scoping: `agent({ tools: { allow, deny } })` restricts which tools a route's agent may call. `deny` revokes a tool; `allow` grants a withheld capability tool; deny wins.

**Behavior change (pre-1.0):** subagents are now least-privilege by default — a subagent gets only its own route-local `tools/*.ts`; ambient capability tools (`writeFile`, `runBash`, `task`, `write_todos`, `remember`/`recall`, …) are withheld unless named in `tools.allow`. A subagent that relied on inheriting these must add `tools: { allow: [...] }`. `dawn check` validates scope names. This scopes the tool surface, not execution (not a sandbox).
```

- [ ] **Step 3: Full verification.**

Run, and report each:
```
pnpm -r build
pnpm -r --if-present typecheck
pnpm lint
pnpm test
pnpm verify:harness
```
Expected: all green. (`pnpm test` includes the new sdk/core/cli unit tests; `verify:harness` exercises the generated-app lanes — the new `@dawn-ai/core`/`@dawn-ai/sdk` changes publish to Verdaccio automatically, no harness edits needed.) Fix anything red before proceeding.

- [ ] **Step 4: Commit, push, PR.**

```bash
git add apps/web/content/docs/tools.mdx .changeset/tool-scoping.md
git commit -m "docs: tool scoping + changeset"
git push -u origin feat/tool-scoping
gh pr create --base main --title "feat: per-route/per-subagent tool scoping" --body "$(cat <<'EOF'
Adds `agent({ tools: { allow, deny } })` to scope a route's tool surface, and makes **subagents least-privilege by default** (route-local tools only; ambient capability tools withheld unless granted). Compose-time enforcement via a pure `resolveToolScope` filter; `dawn check` validates scope names. Tool-surface scoping, not an execution sandbox.

Spec: docs/superpowers/specs/2026-06-20-tool-scoping-design.md
Plan: docs/superpowers/plans/2026-06-20-tool-scoping.md

**Breaking (pre-1.0):** subagents relying on inherited writeFile/runBash/task must add tools.allow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI to green.**

Run: `gh run watch <id> --exit-status` for the PR's CI run. Expected: `validate` green (incl. `verify:harness`). Investigate any failure; the per-merge Release run is unaffected (no publish without a Version PR).

---

## Self-review notes (author)

- **Spec coverage:** descriptor type (T1) ✓; pure filter + origin + semantics incl. deny-wins + unknown-throws (T2) ✓; subagent least-privilege default via `isSubagent` (T3+T4) ✓; compose-time enforcement at the merge seam (T4) ✓; build-time validation (T5) ✓; honest "not a sandbox" framing (T6 docs + changeset) ✓; migration note (T6 changeset + dawn-check) ✓; e2e subagent-scoping headline test (T4) ✓.
- **Out-of-scope** items (rate limits, approval, arg constraints, patterns/categories, MCP filtering, sandboxing) are intentionally absent.
- **Risk to watch during execution:** (1) `prepareRouteExecution`'s exact internal name/shape — Task 3 step 1 says read it first; (2) whether the aimock wrapper actually returns `body.tools` (Task 4 step 2 has a verify-and-fallback note); (3) the `normalizeRouteModule`/`RouteManifest` import paths in Task 5 — verify before relying.
