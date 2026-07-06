# Per-Tool Approval Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent({ tools: { approve: ["deployProd"] } })` makes any named tool (authored or capability) require a HITL permission prompt per call, with Once/Always/Deny decisions persisted name-level to `.dawn/permissions.json` under a reserved `"tool"` key.

**Architecture:** A generic gate (`gateToolOp`) + wrapper (`wrapToolWithApproval`) in `@dawn-ai/core`'s existing `permission-gate.ts`, applied at the #261 tool-scoping seam in `execute-route.ts`. The LangGraph `interrupt()` → SSE → `POST /threads/:id/resume` plumbing is reused verbatim with a new `kind: "tool"` payload. The existing bash/path gates are untouched; `dawn check` warns on redundant overlap.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), vitest, biome (via repo lint script only — NEVER bare `biome check --write`), `@dawn-ai/{sdk,permissions,core,cli,testing}`, aimock deterministic e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-tool-approval-gating-design.md`

**Conventions that apply to every task:**
- Tests resolve against **built dist** for cross-package imports: after changing a package's `src/`, run `npx turbo run build --filter=@dawn-ai/<pkg>` before running a *dependent* package's tests. Same-package tests import from `src/` and don't need it.
- Commit after each green task. Do NOT push until the final task.
- Run lint per file with `pnpm exec biome check --config-path packages/config-biome/biome.json <files>` (no `--write` unless it's only your new files).

---

### Task 1: `ToolScope.approve` in `@dawn-ai/sdk`

**Files:**
- Modify: `packages/sdk/src/agent.ts:13-16` (ToolScope interface)
- Test: `packages/sdk/test/agent.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/test/agent.test.ts`:

```ts
it("passes tools.approve through to the descriptor", () => {
  const a = agent({
    model: "gpt-5-mini",
    systemPrompt: "x",
    tools: { approve: ["deployProd"], deny: ["runBash"] },
  })
  expect(a.tools?.approve).toEqual(["deployProd"])
  expect(a.tools?.deny).toEqual(["runBash"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && npx vitest run test/agent.test.ts`
Expected: FAIL — TS error: `approve` does not exist on type `ToolScope` (vitest surfaces it as a transform/type error).

- [ ] **Step 3: Add the field**

In `packages/sdk/src/agent.ts`, change:

```ts
export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}
```

to:

```ts
export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  /**
   * Tools that require human approval per call (HITL interrupt) unless
   * pre-approved via permissions allow.tool or a persisted "always" decision.
   * Name-level: the prompt shows the call's args, but the decision covers the
   * tool name. See docs/permissions.
   */
  readonly approve?: readonly string[]
}
```

No `agent()` body change needed — `tools` is already spread through (`...(config.tools !== undefined ? { tools: config.tools } : {})`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && npx vitest run test/agent.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/agent.ts packages/sdk/test/agent.test.ts
git commit -m "feat(sdk): ToolScope.approve — tools requiring HITL approval per call"
```

---

### Task 2: `kind: "tool"` types + exact-match `"tool"` key in `@dawn-ai/permissions`

**Files:**
- Modify: `packages/permissions/src/types.ts`
- Modify: `packages/permissions/src/pattern-matching.ts`
- Modify: `packages/permissions/src/index.ts` (export `ToolDetail`)
- Test: `packages/permissions/test/pattern-matching.test.ts`

**Why the matcher change:** `matchPermission` is prefix-based (`candidate.startsWith(pattern)`) — right for commands/paths, wrong for tool names (`deploy` would match `deployProd`). The reserved `"tool"` key uses exact equality.

- [ ] **Step 1: Write the failing tests**

Append to `packages/permissions/test/pattern-matching.test.ts`:

```ts
describe('reserved "tool" key uses exact matching', () => {
  it("does not prefix-match tool names", () => {
    expect(matchPermission("tool", "deployProd", { tool: ["deploy"] }, {})).toBe("unknown")
  })
  it("matches an exact tool name", () => {
    expect(matchPermission("tool", "deployProd", { tool: ["deployProd"] }, {})).toBe("allow")
  })
  it("deny wins for an exact tool name", () => {
    expect(
      matchPermission("tool", "deployProd", { tool: ["deployProd"] }, { tool: ["deployProd"] }),
    ).toBe("deny")
  })
  it("commands keep prefix matching", () => {
    expect(matchPermission("bash", "ls -la", { bash: ["ls"] }, {})).toBe("allow")
  })
})
```

(If the file's existing tests use bare `test(...)` instead of `describe/it`, match the existing style — import whichever of `describe/it/test` the file already imports.)

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `cd packages/permissions && npx vitest run test/pattern-matching.test.ts`
Expected: FAIL — `does not prefix-match tool names` gets `"allow"`, expected `"unknown"`.

- [ ] **Step 3: Implement exact matching for the "tool" key**

Replace the body of `matchPermission` in `packages/permissions/src/pattern-matching.ts`:

```ts
type PatternMap = Readonly<Record<string, readonly string[]>>

/**
 * Match a tool+candidate against allow + deny pattern maps.
 *
 * Semantics:
 *   - deny wins over allow
 *   - prefix matching: `candidate.startsWith(pattern)` — for commands/paths
 *   - EXCEPT the reserved "tool" key (per-tool approval gating), which uses
 *     exact equality: tool names must not prefix-match ("deploy" must not
 *     match "deployProd")
 *   - no entries for tool → "unknown"
 */
export function matchPermission(
  tool: string,
  candidate: string,
  allow: PatternMap,
  deny: PatternMap,
): "allow" | "deny" | "unknown" {
  const matches = (pattern: string) =>
    tool === "tool" ? candidate === pattern : candidate.startsWith(pattern)
  const denyList = deny[tool] ?? []
  for (const pattern of denyList) {
    if (matches(pattern)) return "deny"
  }
  const allowList = allow[tool] ?? []
  for (const pattern of allowList) {
    if (matches(pattern)) return "allow"
  }
  return "unknown"
}
```

- [ ] **Step 4: Add the `ToolDetail` type and widen `kind`**

In `packages/permissions/src/types.ts`, after `PathDetail` (line 28-32), add:

```ts
export interface ToolDetail {
  readonly toolName: string
  /** JSON.stringify(input) truncated (~500 chars). Shown in the prompt; never matched or persisted. */
  readonly argsPreview: string
  /** The tool name — approval decisions persist name-level under the reserved "tool" key. */
  readonly suggestedPattern: string
}
```

and change `PermissionRequest`:

```ts
export interface PermissionRequest {
  readonly interruptId: string
  readonly kind: "command" | "path" | "tool"
  readonly detail: CommandDetail | PathDetail | ToolDetail
  readonly threadId: string
  readonly callId?: string
}
```

In `packages/permissions/src/index.ts`, add `ToolDetail` to the type re-exports (alongside `CommandDetail`/`PathDetail`).

- [ ] **Step 5: Run the package tests**

Run: `cd packages/permissions && npx vitest run`
Expected: PASS (all files — store tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/permissions/src packages/permissions/test/pattern-matching.test.ts
git commit -m "feat(permissions): kind 'tool' + ToolDetail; exact matching for the reserved tool key"
```

---

### Task 3: `resolveToolScope` validates `approve` names (`@dawn-ai/core`)

**Files:**
- Modify: `packages/core/src/tool-scope.ts`
- Test: `packages/core/test/tool-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/tool-scope.test.ts` (match the file's existing helper style — it builds `ScopeInput[]` inline):

```ts
it("throws on an unknown approve name (typos fail loud like allow/deny)", () => {
  expect(() =>
    resolveToolScope(
      [{ name: "deployProd", origin: "authored" }],
      { approve: ["deployPord"] },
      { isSubagent: false, routeId: "/ops" },
    ),
  ).toThrow(/unknown tool.*deployPord/s)
})

it("a known approve name does not affect which tools survive scoping", () => {
  const kept = resolveToolScope(
    [
      { name: "deployProd", origin: "authored" },
      { name: "runBash", origin: "capability" },
    ],
    { approve: ["deployProd"] },
    { isSubagent: false, routeId: "/ops" },
  )
  expect([...kept].sort()).toEqual(["deployProd", "runBash"])
})
```

- [ ] **Step 2: Run to verify the first fails**

Run: `cd packages/core && npx vitest run test/tool-scope.test.ts`
Expected: FAIL — no throw (approve is not validated yet). Note: TS may error first on `approve` not in core's scope param type — that also counts as the expected failure if `tool-scope.ts` re-declares the type; it imports `ToolScope` from `@dawn-ai/sdk`, so **build sdk first**: `npx turbo run build --filter=@dawn-ai/sdk`.

- [ ] **Step 3: Include `approve` in the unknown-name validation**

In `packages/core/src/tool-scope.ts`, change the `unknown` computation inside `resolveToolScope`:

```ts
  const available = new Set(tools.map((t) => t.name))
  const unknown = [
    ...(scope?.allow ?? []),
    ...(scope?.deny ?? []),
    ...(scope?.approve ?? []),
  ].filter((n) => !available.has(n))
```

(The rest of the function is unchanged — `approve` does not alter the kept set; it only marks tools for gating.) Update the doc comment's last sentence to: `Unknown names in allow/deny/approve (absent from the full available set) throw so authoring typos fail loud at composition time.`

- [ ] **Step 4: Run to verify pass**

Run: `npx turbo run build --filter=@dawn-ai/sdk && cd packages/core && npx vitest run test/tool-scope.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-scope.ts packages/core/test/tool-scope.test.ts
git commit -m "feat(core): validate tools.approve names in resolveToolScope"
```

---

### Task 4: `gateToolOp` in `@dawn-ai/core`

**Files:**
- Modify: `packages/core/src/capabilities/permission-gate.ts`
- Test: `packages/core/test/capabilities/permission-gate.test.ts`

The interactive `interrupt()` branch cannot be unit-tested (LangGraph's `interrupt()` throws outside a graph) — the existing tests cover the other branches and the e2e (Task 8) covers interactive. Follow that pattern.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/capabilities/permission-gate.test.ts` (reuse the file's existing `mkdtempSync` appRoot + `createPermissionsStore` setup style):

```ts
import { gatePathOp, gateToolOp } from "../../src/capabilities/permission-gate.js"
// (adjust the existing import line to add gateToolOp)

describe("gateToolOp", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-tool-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function store(mode: "interactive" | "non-interactive" | "bypass", config?: {
    allow?: Record<string, readonly string[]>
    deny?: Record<string, readonly string[]>
  }) {
    const permissions = createPermissionsStore({
      appRoot,
      config: config ? { version: 1, allow: config.allow ?? {}, deny: config.deny ?? {} } : undefined,
      mode,
    })
    await permissions.load()
    return permissions
  }

  it("allows when no permissions store is present", async () => {
    expect((await gateToolOp(undefined, "deployProd", "{}")).allowed).toBe(true)
  })

  it("allows in bypass mode without consulting the store", async () => {
    const permissions = await store("bypass")
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("allows a config-pre-approved tool (allow.tool exact name)", async () => {
    const permissions = await store("interactive", { allow: { tool: ["deployProd"] } })
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("blocks a config-denied tool with a reason", async () => {
    const permissions = await store("interactive", { deny: { tool: ["deployProd"] } })
    const result = await gateToolOp(permissions, "deployProd", "{}")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/denied.*deployProd/i)
  })

  it("fails closed on unknown in non-interactive mode", async () => {
    const permissions = await store("non-interactive")
    const result = await gateToolOp(permissions, "deployProd", "{}")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/fail-closed/)
  })

  it("fails closed with guidance when interactive but interrupts unavailable", async () => {
    const permissions = await store("interactive")
    const result = await gateToolOp(permissions, "deployProd", "{}", { interruptCapable: false })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run test/capabilities/permission-gate.test.ts`
Expected: FAIL — `gateToolOp` is not exported.

- [ ] **Step 3: Implement `gateToolOp` and extend the interrupt emitter**

In `packages/core/src/capabilities/permission-gate.ts`, add after `gateBashOp`:

```ts
/**
 * Generic per-tool approval gate (tools.approve). Name-level: the decision
 * covers the tool name; argsPreview is display-only. Persisted decisions live
 * under the reserved "tool" key in .dawn/permissions.json (exact-name match —
 * see @dawn-ai/permissions pattern-matching).
 */
export async function gateToolOp(
  permissions: PermissionsStore | undefined,
  toolName: string,
  argsPreview: string,
  opts?: { readonly interruptCapable?: boolean },
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const decision = permissions.match("tool", toolName)
  if (decision === "allow") return { allowed: true }
  if (decision === "deny") {
    return { allowed: false, reason: `Permission denied by user: tool ${toolName}` }
  }
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): tool ${toolName}` }
  }
  if (opts?.interruptCapable === false) {
    return {
      allowed: false,
      reason:
        `Permission denied: tool "${toolName}" requires approval and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "tool" to the permissions config in dawn.config.ts.`,
    }
  }
  const result = await emitPermissionInterrupt({
    kind: "tool",
    toolName,
    argsPreview,
    permissions,
  })
  if (result === "deny") {
    return { allowed: false, reason: `Permission denied by user: tool ${toolName}` }
  }
  return { allowed: true }
}
```

Extend `InterruptArgs` and `emitPermissionInterrupt` (bottom of the file):

```ts
interface InterruptArgs {
  kind: "command" | "path" | "tool"
  command?: string
  operation?: PathOperation
  path?: string
  toolName?: string
  argsPreview?: string
  permissions: PermissionsStore
}

async function emitPermissionInterrupt(args: InterruptArgs): Promise<"allow" | "deny"> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command ?? "")
      : args.kind === "tool"
        ? (args.toolName ?? "")
        : suggestedPathPattern(args.path ?? "")
  const payload = {
    interruptId,
    type: "permission-request" as const,
    kind: args.kind,
    detail:
      args.kind === "command"
        ? { command: args.command ?? "", suggestedPattern }
        : args.kind === "tool"
          ? { toolName: args.toolName ?? "", argsPreview: args.argsPreview ?? "", suggestedPattern }
          : {
              operation: args.operation ?? "readFile",
              path: args.path ?? "",
              suggestedPattern,
            },
  }
  const decision = interrupt(payload) as "once" | "always" | "deny"
  if (decision === "deny") return "deny"
  if (decision === "always") {
    const tool =
      args.kind === "command" ? "bash" : args.kind === "tool" ? "tool" : (args.operation ?? "readFile")
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return "allow"
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/core && npx vitest run test/capabilities/permission-gate.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/permission-gate.ts packages/core/test/capabilities/permission-gate.test.ts
git commit -m "feat(core): gateToolOp — generic per-tool approval gate with kind:'tool' interrupt"
```

---

### Task 5: `wrapToolWithApproval` + `buildArgsPreview` (`@dawn-ai/core`)

**Files:**
- Modify: `packages/core/src/capabilities/permission-gate.ts`
- Modify: `packages/core/src/index.ts` (export `gateToolOp`, `wrapToolWithApproval`)
- Test: `packages/core/test/capabilities/permission-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `gateToolOp` describe block's sibling level in `packages/core/test/capabilities/permission-gate.test.ts`:

```ts
describe("wrapToolWithApproval", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-wrap-tool-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  const signal = new AbortController().signal

  it("delegates untouched when the tool is pre-approved", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { tool: ["deployProd"] }, deny: {} },
      mode: "interactive",
    })
    await permissions.load()
    const tool = {
      name: "deployProd",
      description: "deploys",
      filePath: "/app/src/app/ops/tools/deployProd.ts",
      run: async (input: unknown) => `deployed:${JSON.stringify(input)}`,
    }
    const wrapped = wrapToolWithApproval(tool, permissions)
    expect(wrapped.name).toBe("deployProd")
    expect(wrapped.description).toBe("deploys")
    expect(wrapped.filePath).toBe(tool.filePath)
    expect(await wrapped.run({ env: "prod" }, { signal })).toBe('deployed:{"env":"prod"}')
  })

  it("blocks with the denial reason as the tool result when denied", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { tool: ["deployProd"] } },
      mode: "interactive",
    })
    await permissions.load()
    let ran = false
    const wrapped = wrapToolWithApproval(
      {
        name: "deployProd",
        run: async () => {
          ran = true
          return "deployed"
        },
      },
      permissions,
    )
    const result = await wrapped.run({}, { signal })
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/denied.*deployProd/i)
  })

  it("fails closed (as a result string) in non-interactive mode", async () => {
    const permissions = createPermissionsStore({ appRoot, config: undefined, mode: "non-interactive" })
    await permissions.load()
    const wrapped = wrapToolWithApproval({ name: "x", run: async () => "ran" }, permissions)
    expect(String(await wrapped.run({}, { signal }))).toMatch(/fail-closed/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run test/capabilities/permission-gate.test.ts`
Expected: FAIL — `wrapToolWithApproval` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/core/src/capabilities/permission-gate.ts`:

```ts
/** Best-effort display preview of a tool call's args. Never matched or persisted. */
function buildArgsPreview(input: unknown): string {
  try {
    const s = JSON.stringify(input)
    return s === undefined ? String(input) : s.length > 500 ? `${s.slice(0, 500)}…` : s
  } catch {
    return String(input)
  }
}

/**
 * Wrap a tool so each call passes gateToolOp first (tools.approve). A blocked
 * call returns the denial reason AS THE TOOL RESULT — the model sees it and
 * can adapt, matching the bash-gate contract. Generic over the tool shape so
 * DiscoveredToolDefinition (cli) and DawnToolDefinition (core) both survive
 * wrapping with their extra fields (filePath, schema, scope, …) intact.
 */
export function wrapToolWithApproval<
  C,
  T extends {
    readonly name: string
    readonly run: (input: unknown, context: C) => Promise<unknown> | unknown
  },
>(tool: T, permissions: PermissionsStore): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input))
      if (!gate.allowed) return gate.reason
      return tool.run(input, context)
    },
  }
}
```

In `packages/core/src/index.ts`, find the existing `resolveToolScope`/`toolOrigin` export block and add nearby:

```ts
export { gateToolOp, wrapToolWithApproval } from "./capabilities/permission-gate.js"
```

(Check first whether `permission-gate.js` already has an export line in index.ts — `gatePathOp`/`gateBashOp` may or may not be exported; extend the existing line if present.)

- [ ] **Step 4: Run to verify pass, then the whole core suite**

Run: `cd packages/core && npx vitest run test/capabilities/permission-gate.test.ts && npx vitest run`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/permission-gate.ts packages/core/src/index.ts packages/core/test/capabilities/permission-gate.test.ts
git commit -m "feat(core): wrapToolWithApproval — gate any tool's run behind HITL approval"
```

---

### Task 6: Wire wrapping at the scoping seam (`@dawn-ai/cli`)

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts:640` (right after the `keptToolNames` filter)

No new unit test here — the seam is exercised end-to-end by Task 8's aimock e2e (interactive path can only be proven in-graph).

- [ ] **Step 1: Add the import**

In the `@dawn-ai/core` import block at the top of `packages/cli/src/lib/runtime/execute-route.ts` (lines 20-27), add `wrapToolWithApproval`:

```ts
import {
  // …existing imports…
  resolveToolScope,
  toolOrigin,
  wrapToolWithApproval,
} from "@dawn-ai/core"
```

- [ ] **Step 2: Wrap after the scope filter**

Directly after `tools = tools.filter((t) => keptToolNames.has(t.name))` (line ~640), add:

```ts
    // Per-tool approval gating (tools.approve): wrap surviving tools so each
    // call consults the permissions store; on "unknown" in interactive mode
    // the wrapper interrupts for a human decision (kind: "tool"). Bash/path
    // gates inside the workspace tools are separate (pattern-aware) and
    // unaffected; `dawn check` warns on redundant overlap.
    const approveSet = new Set(descriptor?.tools?.approve ?? [])
    if (approveSet.size > 0) {
      tools = tools.map((t) =>
        approveSet.has(t.name) ? wrapToolWithApproval(t, permissionsStore) : t,
      )
    }
```

(The variable holding the store at this point is `permissionsStore` — declared once per `prepareRouteExecution` around line 468. Verify the exact name in context before committing; if the local name differs, use that.)

- [ ] **Step 3: Build + typecheck**

Run: `npx turbo run build --filter=@dawn-ai/cli`
Expected: success (this builds sdk/permissions/core first).

- [ ] **Step 4: Run the cli test suite (regression check)**

Run: `cd packages/cli && npx vitest run`
Expected: PASS (all — behavior unchanged for routes without `approve`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): apply per-tool approval wrapping at the tool-scoping seam"
```

---

### Task 7: `dawn check` — validate `approve`, warn on overlap (`@dawn-ai/cli`)

**Files:**
- Modify: `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`
- Modify: `packages/cli/src/commands/check.ts:45-48`
- Test: `packages/cli/test/check-tool-scope.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/check-tool-scope.test.ts`:

```ts
test("flags an unknown tool name in approve", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["deployPord"] }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors.join("\n")).toMatch(/\/research.*unknown tool.*deployPord/s)
})

test("warns when approve names an internally-gated workspace tool", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["runBash"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(/\/research.*runBash.*already gated/s)
})

test("warns when approve intersects deny (dead entry)", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ deny: ["deployProd"], approve: ["deployProd"] }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(/\/research.*deployProd.*deny/s)
})

test("clean approve produces no issues", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["deployProd"] }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
})
```

Also update the three existing tests in the file: they call `collectToolScopeErrors(...)` and assert on a `string[]`. Rename the import to `collectToolScopeIssues` and assert on `.errors` (e.g. `expect(result.errors.join("\n")).toMatch(...)`, `expect(result.errors).toEqual([])`).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/cli && npx vitest run test/check-tool-scope.test.ts`
Expected: FAIL — `collectToolScopeIssues` is not exported.

- [ ] **Step 3: Implement — rename to issues, add approve checks**

Rewrite `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts` body (keep `Deps`/`defaultDeps` as they are, but widen `ToolScopeShape`):

```ts
interface ToolScopeShape {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly approve?: readonly string[]
}

export interface ToolScopeIssues {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** Workspace tools with their own pattern-aware internal gates (bash/path). */
const INTERNALLY_GATED = new Set(["runBash", "readFile", "writeFile", "listDir"])

export async function collectToolScopeIssues(
  manifest: RouteManifest,
  deps: Deps = defaultDeps,
): Promise<ToolScopeIssues> {
  const errors: string[] = []
  const warnings: string[] = []
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    const scope = await deps.loadScope(route.entryFile, manifest.appRoot)
    if (!scope || (!scope.allow && !scope.deny && !scope.approve)) continue
    const available = new Set([
      ...(await deps.routeLocalToolNames(manifest.appRoot, route.routeDir)),
      ...BUILT_IN_TOOL_NAMES,
    ])
    const unknown = [
      ...(scope.allow ?? []),
      ...(scope.deny ?? []),
      ...(scope.approve ?? []),
    ].filter((n) => !available.has(n))
    if (unknown.length > 0) {
      errors.push(
        `✗ ${route.pathname}: unknown tool name(s) in scope: ${unknown.join(", ")}.\n` +
          `    available: ${[...available].sort().join(", ")}`,
      )
    }
    const deny = new Set(scope.deny ?? [])
    for (const name of scope.approve ?? []) {
      if (INTERNALLY_GATED.has(name)) {
        warnings.push(
          `⚠ ${route.pathname}: approve lists "${name}", which is already gated ` +
            `(pattern-aware bash/path permissions). The approve entry is redundant and would double-prompt.`,
        )
      }
      if (deny.has(name)) {
        warnings.push(
          `⚠ ${route.pathname}: approve lists "${name}" but deny revokes it — deny wins; the approve entry is dead.`,
        )
      }
    }
  }
  return { errors, warnings }
}
```

Keep a deprecated alias so nothing else breaks (check callers first — only `check.ts` imports it):

There is exactly one caller (`packages/cli/src/commands/check.ts:45`); update it instead of aliasing:

```ts
    const scopeIssues = await collectToolScopeIssues(manifest)
    for (const warning of scopeIssues.warnings) {
      writeLine(io.stdout, `\n${warning}`)
    }
    if (scopeIssues.errors.length > 0) {
      throw new CliError(`Invalid tool scope:\n${scopeIssues.errors.join("\n")}`)
    }
```

(and update the import at `check.ts:5` to `collectToolScopeIssues`).

- [ ] **Step 4: Run to verify pass, then the cli suite**

Run: `cd packages/cli && npx vitest run test/check-tool-scope.test.ts && npx vitest run`
Expected: PASS (all — check-command tests still green since warnings are non-fatal).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/collect-tool-scope-errors.ts packages/cli/src/commands/check.ts packages/cli/test/check-tool-scope.test.ts
git commit -m "feat(cli): dawn check validates tools.approve and warns on gated-tool/deny overlap"
```

---

### Task 8: Deterministic aimock e2e (`@dawn-ai/testing`) — the headline

**Files:**
- Create: `packages/testing/test/fixtures/probe-app/src/app/approval-chat/index.ts`
- Create: `packages/testing/test/fixtures/probe-app/src/app/approval-chat/tools/deployProd.ts`
- Create: `packages/testing/test/fixtures/probe-app/src/app/approval-chat/subagents/worker/index.ts`
- Create: `packages/testing/test/fixtures/probe-app/src/app/approval-chat/subagents/worker/tools/sendReport.ts`
- Create: `packages/testing/test/tool-approval.e2e.test.ts`

The probe-app has no `permissions` config → mode defaults to `interactive` (interrupts fire). Decisions persist to `<probe-app>/.dawn/permissions.json` — clean it in hooks.

- [ ] **Step 1: Create the fixture route**

`packages/testing/test/fixtures/probe-app/src/app/approval-chat/index.ts`:

```ts
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent. Use deployProd when asked to deploy.",
  tools: { approve: ["deployProd"] },
})
```

`packages/testing/test/fixtures/probe-app/src/app/approval-chat/tools/deployProd.ts`:

```ts
export default async function deployProd(input: { env: string }): Promise<string> {
  return `deployed to ${input.env}`
}
```

`packages/testing/test/fixtures/probe-app/src/app/approval-chat/subagents/worker/index.ts`:

```ts
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a worker. Use sendReport when asked.",
  tools: { approve: ["sendReport"] },
})
```

`packages/testing/test/fixtures/probe-app/src/app/approval-chat/subagents/worker/tools/sendReport.ts`:

```ts
export default async function sendReport(input: { to: string }): Promise<string> {
  return `report sent to ${input.to}`
}
```

(Note: `gpt-4o-mini` matches the existing probe-app routes — the gpt-5-only rule keeps gpt-4o in recorded fixtures/tests.)

- [ ] **Step 2: Write the e2e test**

`packages/testing/test/tool-approval.e2e.test.ts`:

```ts
// Deterministic (aimock) e2e for per-tool approval gating (tools.approve).
// Runs in CI — no real key. Decisions persist to .dawn/permissions.json, so
// hooks clean it to isolate scenarios.
import { readFileSync, rmSync } from "node:fs"
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

it("gated tool interrupts with kind 'tool' and runs after resume(once)", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })
    const resumed = await h.resume({ decision: "once" })
    expectToolCalled(resumed, "deployProd")
    const result = resumed.toolResults.find((t) => t.name === "deployProd")
    expect(String(result?.content ?? "")).toContain("deployed to staging")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(deny) blocks the call; the model sees the denial as the tool result", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    await h.run({
      input: "deploy to prod",
      fixtures: script()
        .user("deploy to prod")
        .callsTool("deployProd", { env: "prod" })
        .replies("Understood, not deploying."),
    })
    const resumed = await h.resume({ decision: "deny" })
    const result = resumed.toolResults.find((t) => t.name === "deployProd")
    expect(String(result?.content ?? "")).toMatch(/denied.*deployProd/i)
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(always) persists allow.tool and a fresh run does not prompt", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed."),
    })
    await h.resume({ decision: "always" })

    const file = JSON.parse(readFileSync(permissionsPath, "utf8")) as {
      allow: Record<string, string[]>
    }
    expect(file.allow.tool).toContain("deployProd")

    h.reset()
    const run2 = await h.run({
      input: "deploy to staging again",
      fixtures: script()
        .user("deploy to staging again")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed again."),
    })
    expectNoInterrupt(run2)
    expectToolCalled(run2, "deployProd")
  } finally {
    await h.close()
  }
}, 60_000)

// Scenario 4 — subagent dispatch. WRITE THIS ONE LAST, and read the existing
// subagent e2e pattern FIRST: the coordinator scenario in
// examples/chat/server/test/capabilities.e2e.test.ts (describe block at ~line
// 130) shows how child-model turns get their fixtures (the harness registers
// fixtures on one shared aimock instance, so the child's turn is served by
// its own fixture entry keyed on the child's user message). Mirror that
// wiring here: parent turn callsTool("task", { subagent: "worker", input:
// "send the report to ops" }); child turn callsTool("sendReport", { to:
// "ops" }). Then assert:
//
//   expectInterrupt(run).ofKind("tool").withDetail({ toolName: "sendReport" })
//
// (Resume into a child-graph prompt follows the platform's existing
// nested-interrupt behavior — same as bash gates inside subagents — and is
// NOT asserted.) If the child interrupt does not surface on the parent
// stream (pre-existing platform behavior for nested graphs), STOP and report
// the finding to the session driver instead of forcing the assertion —
// scenarios 1-3 are the merge-blocking coverage; scenario 4 is best-effort.
```

- [ ] **Step 3: Run the new e2e (expect fail first — nothing regenerated yet)**

Run: `npx turbo run build --filter=@dawn-ai/cli --filter=@dawn-ai/testing && cd packages/testing && npx vitest run test/tool-approval.e2e.test.ts`
Expected: first run may FAIL if the probe-app typegen is stale — the harness runs typegen at boot; a real failure to look for is the interrupt not firing. Iterate until scenarios 1-3 PASS.

- [ ] **Step 4: Run the full testing suite (fixture-isolation regression)**

Run: `cd packages/testing && npx vitest run`
Expected: PASS (all; live smokes skip).

- [ ] **Step 5: Commit**

```bash
git add packages/testing/test/fixtures/probe-app/src/app/approval-chat packages/testing/test/tool-approval.e2e.test.ts
git commit -m "test(testing): deterministic e2e for per-tool approval gating (once/deny/always/subagent)"
```

---

### Task 9: Chat example web panel renders `kind: "tool"`

**Files:**
- Modify: `examples/chat/web/app/page.tsx:199-225`

- [ ] **Step 1: Extend the permission banner**

In `examples/chat/web/app/page.tsx`, the banner at lines ~199-225 renders `kind === "command"` vs path. Change the two ternaries to handle `"tool"`:

```tsx
          <p style={{ margin: "0.5rem 0" }}>
            {pendingInterrupt.kind === "command"
              ? "The agent wants to run command:"
              : pendingInterrupt.kind === "tool"
                ? `The agent wants to call tool ${pendingInterrupt.detail.toolName}:`
                : `The agent wants to ${pendingInterrupt.detail.operation}:`}
          </p>
```

and

```tsx
            {pendingInterrupt.kind === "command"
              ? pendingInterrupt.detail.command
              : pendingInterrupt.kind === "tool"
                ? pendingInterrupt.detail.argsPreview
                : pendingInterrupt.detail.path}
```

The "Allow always for `{suggestedPattern}`" button already renders the tool name (suggestedPattern = toolName). If `pendingInterrupt` has a narrow TS type in this file, widen its `kind`/`detail` the same way as Task 2's types.

- [ ] **Step 2: Typecheck the example**

Run: `npx turbo run build --filter=@dawn-example/chat-web` — if no such build task exists, run `cd examples/chat/web && npx tsc --noEmit 2>/dev/null || true` and rely on the repo-root build in Task 11.
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/web/app/page.tsx
git commit -m "feat(example): render kind:'tool' permission requests in the chat web panel"
```

---

### Task 10: Docs, website, changeset

**Files:**
- Modify: `apps/web/content/docs/tools.mdx` (after the scoping section, ~line 65)
- Modify: `apps/web/content/docs/permissions.mdx` (new section after "Modes", ~line 50)
- Modify: `apps/web/content/docs/configuration.mdx` (`permissions` section, ~line 110)
- Modify: `apps/web/content/docs/subagents.mdx` (scoping note area)
- Modify: `apps/web/content/docs/api.mdx` (ToolScope reference — grep for `ToolScope`; add the `approve` line)
- Create: `.changeset/tool-approval-gating.md`

- [ ] **Step 1: tools.mdx — `approve` as the third knob**

After the `<Callout>` that closes the scoping section (~line 65), add:

```mdx
### Requiring approval per call

`approve` is the third scoping knob: tools listed there stay available to the model, but every call pauses for a human decision (a HITL interrupt) unless pre-approved.

```ts title="src/app/ops/index.ts"
export default agent({
  model: "gpt-5",
  systemPrompt: "…",
  tools: { deny: ["runBash"], approve: ["deployProd", "sendEmail"] },
})
```

The prompt shows the call's arguments; the decision covers the **tool name** — "Allow always" persists `deployProd` to `.dawn/permissions.json` and never prompts for it again. See [Permissions](/docs/permissions#per-tool-approval) for the prompt flow, persistence, and mode behavior. Don't list the workspace tools (`runBash`, `readFile`, `writeFile`, `listDir`) — they already have their own pattern-aware gates, and `dawn check` will warn.
```

- [ ] **Step 2: permissions.mdx — "Per-tool approval" section**

After the "Modes" section (~line 50), add:

```mdx
## Per-tool approval

Beyond the built-in bash/path gates, any tool can require approval per call via the route's descriptor:

```ts title="src/app/ops/index.ts"
export default agent({ model: "gpt-5", systemPrompt: "…", tools: { approve: ["deployProd"] } })
```

When the model calls a gated tool, the run interrupts with `kind: "tool"`:

```json
{ "interruptId": "perm-…", "type": "permission-request", "kind": "tool",
  "detail": { "toolName": "deployProd", "argsPreview": "{\"env\":\"prod\"}", "suggestedPattern": "deployProd" } }
```

Decisions resume the run exactly like command/path prompts:

- **Once** — this call runs; the next call prompts again.
- **Always** — persists the tool **name** under the reserved `tool` key in `.dawn/permissions.json` (`{ "allow": { "tool": ["deployProd"] } }`); never prompts for this tool again. The prompt *shows* the call's args, but the decision is name-level — argument-level rules are a planned later slice.
- **Deny** — the call is blocked; the model receives the denial reason as the tool result and can adapt.

Pre-approve in config with `permissions.allow.tool`. Mode behavior matches the other gates: `non-interactive` fails closed, `bypass` skips all gating. The `tool` key matches names **exactly** (no prefix matching). The workspace tools keep their own pattern-aware gates — listing them in `approve` is redundant and draws a `dawn check` warning.
```

- [ ] **Step 3: configuration.mdx — pre-approval**

In the `permissions` section (after the mode table, ~line 130), add:

```mdx
#### `permissions.allow.tool`

Pre-approves tools gated by a route's `tools.approve` so they never prompt. Names match exactly.

```ts title="dawn.config.ts"
export default { permissions: { allow: { tool: ["deployProd"] } } }
```
```

- [ ] **Step 4: subagents.mdx — approve applies to subagents**

Where #261 added its scoping note, append one paragraph:

```mdx
Subagents can also require approval for their own tools: `tools: { approve: ["sendReport"] }` on the subagent's descriptor gates its calls with the same HITL prompt. See [Permissions](/docs/permissions#per-tool-approval).
```

- [ ] **Step 5: api.mdx — ToolScope reference**

Grep `apps/web/content/docs/api.mdx` for `ToolScope`; if the type is listed, add the `approve?: readonly string[]` line with the one-sentence description from Task 1's doc comment. If `ToolScope` isn't in api.mdx, skip this file (do not invent a section).

- [ ] **Step 6: Changeset**

Create `.changeset/tool-approval-gating.md`:

```md
---
"@dawn-ai/sdk": patch
"@dawn-ai/permissions": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Per-tool approval gating: `agent({ tools: { approve: ["deployProd"] } })` makes any named tool require a HITL permission prompt per call (`kind: "tool"` interrupt). Decisions persist name-level under the reserved `tool` key in `.dawn/permissions.json` (exact-name matching); pre-approve via `permissions.allow.tool`. `dawn check` validates `approve` names and warns on overlap with the internally-gated workspace tools or `deny`.
```

(Keep every bump `patch` — the fixed group turns any `minor` into a 1.0.0.)

- [ ] **Step 7: Docs check + commit**

Run: `node scripts/check-docs.mjs` (the Docs Check lane greps for banned phrases — e.g. `byte-identical`; avoid them).
Expected: clean.

```bash
git add apps/web/content/docs .changeset/tool-approval-gating.md
git commit -m "docs: per-tool approval gating — tools/permissions/configuration/subagents/api + changeset"
```

---

### Task 11: Full verification

- [ ] **Step 1: Full build + test + lint**

Run from repo root:

```bash
npx turbo run build && npx turbo run test && pnpm lint
```

Expected: all green (live smokes skip without a key). If `create-dawn-ai-app`/generated-app lanes fail on registry versions, check whether it's the known publish-lifecycle artifact (npm registry vs local version bump) before assuming this change caused it.

- [ ] **Step 2: Spec conformance re-read**

Re-read `docs/superpowers/specs/2026-07-05-tool-approval-gating-design.md` section by section; confirm each requirement maps to landed code/tests/docs. Fix any gap found.

- [ ] **Step 3: Commit any stragglers; do not push**

The session driver handles PR creation and merge.
