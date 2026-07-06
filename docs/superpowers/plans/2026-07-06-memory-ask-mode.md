# Memory `ask` Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `memory.writes: "ask"` — a supervision mode where memory SUPERSEDEs (belief contradictions) prompt a HITL Once/Always/Deny interrupt, while ADDs and idempotent UPDATEs flow silently; headless behaves exactly as `auto`.

**Architecture:** A new `gateMemorySupersede` in core's permission-gate (sibling of `gateToolOp`), called from *inside* the memory capability's `remember` tool at the supersede branch — the only place the old record is in hand. A new interrupt `kind: "memory"` with an old-vs-new `MemoryDetail` payload. Persistence uses a reserved `"memory"` key with native prefix matching made collision-safe by a `|` terminator on the candidate. Spec: `docs/superpowers/specs/2026-07-06-memory-ask-mode-design.md`.

**Tech Stack:** TypeScript, vitest, LangGraph `interrupt()`, `@dawn-ai/permissions`, aimock e2e harness (`@dawn-ai/testing`), pnpm monorepo.

**Conventions:** Run all commands from the repo root. Use the repo lint script (`pnpm lint`) — NEVER bare `biome check --write`. All new code follows the exact patterns of the #291 per-tool-approval implementation.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/capabilities/types.ts` | Modify | `MemoryWritesMode` alias; widen `MemoryContext.writes` |
| `packages/core/src/types.ts` | Modify | Widen `DawnConfig.memory.writes` |
| `packages/cli/src/lib/runtime/resolve-memory.ts` | Modify | Widen `resolveMemoryWrites` + `buildMemoryContext` |
| `packages/permissions/src/types.ts` | Modify | `MemoryDetail`; widen `PermissionRequest` |
| `packages/permissions/src/suggested-pattern.ts` | Modify | `suggestedMemoryPattern()` |
| `packages/permissions/src/index.ts` | Modify | Export both |
| `packages/permissions/test/suggested-pattern.test.ts` | Modify | Pattern unit tests |
| `packages/permissions/test/pattern-matching.test.ts` | Modify | Terminator collision-safety tests |
| `packages/core/src/capabilities/permission-gate.ts` | Modify | `gateMemorySupersede` + `InterruptArgs` + emit cases |
| `packages/core/src/capabilities/built-in/memory.ts` | Modify | `ask` semantics + gate call at supersede branch |
| `packages/core/test/capabilities/permission-gate.test.ts` | Modify | Gate ladder tests |
| `packages/core/test/capabilities/memory.test.ts` | Modify | ask-mode capability tests |
| `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts` | Modify | ask+approve overlap warning |
| `packages/cli/src/commands/check.ts` | Modify | Pass memoryWrites to validation |
| `examples/chat/web/app/page.tsx` | Modify | Render `kind: "memory"` interrupts |
| `packages/testing/test/fixtures/probe-app-memory-ask/**` | Create | e2e fixture app (`writes: "ask"`) |
| `packages/testing/test/memory-ask.e2e.test.ts` | Create | aimock e2e (4 scenarios) |
| `apps/web/content/docs/{memory,permissions,configuration}.mdx` | Modify | Docs |
| `.changeset/memory-ask-mode.md` | Create | Patch changeset |

---

### Task 1: Widen the writes-mode types to include `"ask"`

Type-only change; verified by typecheck. `"ask"` must be accepted everywhere `"auto"` is.

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (~line 36-39)
- Modify: `packages/core/src/types.ts` (~line 72)
- Modify: `packages/cli/src/lib/runtime/resolve-memory.ts` (lines 58, 71)

- [ ] **Step 1: Add the `MemoryWritesMode` alias and widen `MemoryContext.writes`**

In `packages/core/src/capabilities/types.ts`, directly above `export interface MemoryContext {`:

```ts
/**
 * Memory write-governance mode. "ask" = auto's exact write semantics, except
 * SUPERSEDEs (same identity, different value) pass a HITL gate first — a
 * supervision affordance, not a security boundary (headless ≡ auto).
 */
export type MemoryWritesMode = "off" | "candidate" | "auto" | "ask"
```

Change `MemoryContext`'s field `readonly writes: "off" | "candidate" | "auto"` to:

```ts
  readonly writes: MemoryWritesMode
```

- [ ] **Step 2: Widen `DawnConfig.memory.writes`**

In `packages/core/src/types.ts` (~line 72), replace the `writes` line and its doc comment:

```ts
  /** Write-governance mode. "off" — never write; "candidate" — write as candidate (default); "auto" — write and auto-promote; "ask" — auto, but supersedes require HITL approval when interactive. */
  readonly writes?: "off" | "candidate" | "auto" | "ask"
```

- [ ] **Step 3: Widen the CLI resolver and builder**

In `packages/cli/src/lib/runtime/resolve-memory.ts`:
- Line 58: change the return type of `resolveMemoryWrites` from `Promise<"off" | "candidate" | "auto">` to `Promise<import("@dawn-ai/core").MemoryWritesMode>` (or add `MemoryWritesMode` to the existing `@dawn-ai/core` import at line 2 and use it directly).
- Line 71 (`buildMemoryContext` args): change `writes: "off" | "candidate" | "auto"` to `writes: MemoryWritesMode`.

Verify `MemoryWritesMode` is exported from `@dawn-ai/core`'s barrel (`packages/core/src/index.ts`) — capabilities/types.ts types are re-exported there; if the barrel uses named exports, add `MemoryWritesMode`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @dawn-ai/core --filter @dawn-ai/cli build && pnpm typecheck`
Expected: clean (no behavior change anywhere — `"ask"` currently falls into the candidate else-branch in memory.ts, which Task 4 fixes).

Note: typegen needs NO change — `run-typegen.ts` has no writes-mode conditioning (`remember`/`recall` are always emitted when `memory.ts` exists), verified 2026-07-06.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/types.ts packages/core/src/types.ts packages/cli/src/lib/runtime/resolve-memory.ts packages/core/src/index.ts
git commit -m "feat(core,cli): widen memory writes union with \"ask\" mode (types only)"
```

---

### Task 2: `@dawn-ai/permissions` — `MemoryDetail`, `suggestedMemoryPattern`, terminator semantics

**Files:**
- Modify: `packages/permissions/src/types.ts`
- Modify: `packages/permissions/src/suggested-pattern.ts`
- Modify: `packages/permissions/src/index.ts`
- Test: `packages/permissions/test/suggested-pattern.test.ts`, `packages/permissions/test/pattern-matching.test.ts`

- [ ] **Step 1: Write failing tests for `suggestedMemoryPattern`**

Append to `packages/permissions/test/suggested-pattern.test.ts` (match the file's existing describe/it style and imports — add `suggestedMemoryPattern` to the import from `../src/suggested-pattern.js`):

```ts
describe("suggestedMemoryPattern", () => {
  it("returns the workspace+route prefix with a trailing terminator", () => {
    expect(suggestedMemoryPattern("workspace=app|route=/support|tenant=acme")).toBe(
      "workspace=app|route=/support|",
    )
  })

  it("handles a namespace with no dims after route", () => {
    expect(suggestedMemoryPattern("workspace=app|route=/support")).toBe(
      "workspace=app|route=/support|",
    )
  })

  it("falls back to the whole namespace when route is absent", () => {
    expect(suggestedMemoryPattern("workspace=app")).toBe("workspace=app|")
  })
})
```

- [ ] **Step 2: Write failing tests for terminator collision-safety**

Append to `packages/permissions/test/pattern-matching.test.ts` (uses the existing `matchPermission(tool, candidate, allow, deny)` import):

```ts
describe("memory key (prefix + terminator convention)", () => {
  // Callers match memory candidates as `namespace + "|"` so a /a rule can
  // never prefix-match a /ab namespace. matchPermission itself is unchanged.
  const allow = { memory: ["workspace=app|route=/a|"] }

  it("allows the exact route (terminated candidate)", () => {
    expect(matchPermission("memory", "workspace=app|route=/a|", allow, {})).toBe("allow")
  })

  it("allows deeper namespaces under the route", () => {
    expect(
      matchPermission("memory", "workspace=app|route=/a|tenant=acme|", allow, {}),
    ).toBe("allow")
  })

  it("does NOT match a sibling route sharing the prefix", () => {
    expect(matchPermission("memory", "workspace=app|route=/ab|", allow, {})).toBe("unknown")
  })

  it("deny wins over allow for the memory key", () => {
    const deny = { memory: ["workspace=app|route=/a|"] }
    expect(matchPermission("memory", "workspace=app|route=/a|", allow, deny)).toBe("deny")
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/permissions test`
Expected: FAIL — `suggestedMemoryPattern` is not exported (the pattern-matching tests may already pass since `matchPermission` is generic; that's fine — they pin the convention).

- [ ] **Step 4: Implement**

Append to `packages/permissions/src/suggested-pattern.ts`:

```ts
/**
 * Default suggested pattern for a memory-write approval: the namespace's
 * workspace+route prefix, with a trailing "|" terminator so prefix matching
 * cannot collide across sibling routes (route=/a vs route=/ab). Callers match
 * candidates as `namespace + "|"` for the same reason.
 */
export function suggestedMemoryPattern(namespace: string): string {
  const parts = namespace.split("|")
  const routeIdx = parts.findIndex((p) => p.startsWith("route="))
  const prefix = routeIdx >= 0 ? parts.slice(0, routeIdx + 1) : parts
  return `${prefix.join("|")}|`
}
```

In `packages/permissions/src/types.ts`, add after `ToolDetail` (line 40):

```ts
export interface MemoryDetail {
  /** Full memory namespace of the write (e.g. "workspace=app|route=/support"). */
  readonly namespace: string
  /** Rendered identity key of the contradicted fact, e.g. "acme / payment-terms". */
  readonly identity: string
  /** Id of the active record that would be superseded. */
  readonly oldId: string
  /** Content of the record being overwritten. */
  readonly oldContent: string
  /** Content of the replacement. */
  readonly newContent: string
  /** Workspace+route namespace prefix (terminator included) — persisted on "always" under the reserved "memory" key. */
  readonly suggestedPattern: string
}
```

Widen `PermissionRequest` (lines 42-48):

```ts
export interface PermissionRequest {
  readonly interruptId: string
  readonly kind: "command" | "path" | "tool" | "memory"
  readonly detail: CommandDetail | PathDetail | ToolDetail | MemoryDetail
  readonly threadId: string
  readonly callId?: string
}
```

In `packages/permissions/src/index.ts`: add `suggestedMemoryPattern` to the `./suggested-pattern.js` export line, and `MemoryDetail` to the type exports from `./types.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/permissions test`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add packages/permissions/src packages/permissions/test
git commit -m "feat(permissions): MemoryDetail + suggestedMemoryPattern for kind:\"memory\" interrupts"
```

---

### Task 3: `gateMemorySupersede` in core's permission-gate

**Files:**
- Modify: `packages/core/src/capabilities/permission-gate.ts`
- Modify: `packages/core/src/index.ts` (export alongside `gateToolOp` — find where `gateToolOp`/`wrapToolWithApproval` are exported and mirror)
- Test: `packages/core/test/capabilities/permission-gate.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/test/capabilities/permission-gate.test.ts`. It already has a `store(mode, config?)` helper building a real `PermissionsStore` (lines 68-84) — reuse it. Add `gateMemorySupersede` to the import from `../../src/capabilities/permission-gate.js`.

```ts
describe("gateMemorySupersede", () => {
  const detail = {
    namespace: "workspace=app|route=/support",
    identity: "acme / payment-terms",
    oldId: "memory_abc123",
    oldContent: "acme prefers net-30",
    newContent: "acme prefers net-45",
  }

  it("allows when no permissions store is present (legacy context ≡ auto)", async () => {
    expect((await gateMemorySupersede(undefined, detail)).allowed).toBe(true)
  })

  it("allows in bypass mode", async () => {
    const permissions = await store("bypass")
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("allows a config-pre-approved route prefix (terminated)", async () => {
    const permissions = await store("interactive", {
      allow: { memory: ["workspace=app|route=/support|"] },
    })
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("does not let a sibling-route rule leak (route=/s vs route=/support)", async () => {
    // /s is a string prefix of /support; the terminator must prevent the match.
    // "unknown" in non-interactive mode → allow-through, so use the deny list
    // to make leakage observable.
    const permissions = await store("non-interactive", {
      deny: { memory: ["workspace=app|route=/s|"] },
    })
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("blocks an explicitly denied route prefix with a reason (honored headless)", async () => {
    const permissions = await store("non-interactive", {
      deny: { memory: ["workspace=app|route=/support|"] },
    })
    const result = await gateMemorySupersede(permissions, detail)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/denied/i)
  })

  it("allows through on unknown in non-interactive mode (ask ≡ auto headless)", async () => {
    const permissions = await store("non-interactive")
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/core test -- permission-gate`
Expected: FAIL with `gateMemorySupersede is not a function` (or import error).

- [ ] **Step 3: Implement the gate**

In `packages/core/src/capabilities/permission-gate.ts`:

Add `suggestedMemoryPattern` to the import from `@dawn-ai/permissions` (line 3).

Insert after `gateToolOp` (after line 126):

```ts
export interface MemorySupersedeDetail {
  readonly namespace: string
  readonly identity: string
  readonly oldId: string
  readonly oldContent: string
  readonly newContent: string
}

/**
 * Memory supersede gate (memory.writes: "ask"). Prompts ONLY when the agent
 * contradicts an existing active memory — ADDs and idempotent UPDATEs never
 * reach this gate. Persisted decisions live under the reserved "memory" key
 * as workspace+route namespace prefixes; candidates are matched with a "|"
 * terminator so sibling routes cannot prefix-collide.
 *
 * DELIBERATE DIVERGENCE from gateToolOp: on "unknown" with no interactive
 * human (non-interactive mode), this gate ALLOWS the supersede — ask is a
 * supervision affordance, not a security boundary; headless it behaves
 * exactly as writes:"auto". Explicit deny rules are still honored headless.
 * Only called from inside the memory capability's remember tool, which only
 * exists on agent routes (in-graph), so interrupt() is safe here.
 */
export async function gateMemorySupersede(
  permissions: PermissionsStore | undefined,
  detail: MemorySupersedeDetail,
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const decision = permissions.match("memory", `${detail.namespace}|`)
  if (decision === "allow") return { allowed: true }
  if (decision === "deny") {
    return { allowed: false, reason: `approval denied for this route's memory overwrites` }
  }
  // unknown + headless → allow through (ask ≡ auto without a human).
  if (permissions.mode === "non-interactive") return { allowed: true }

  const result = await emitPermissionInterrupt({
    kind: "memory",
    ...detail,
    permissions,
  })
  if (result === "deny") {
    return { allowed: false, reason: `approval denied` }
  }
  return { allowed: true }
}
```

Extend `InterruptArgs` (line 176-179) with a fourth arm:

```ts
  | {
      kind: "memory"
      namespace: string
      identity: string
      oldId: string
      oldContent: string
      newContent: string
      permissions: PermissionsStore
    }
```

In `emitPermissionInterrupt` (lines 181-211), extend the two chained ternaries and the persistence switch. Replace the `suggestedPattern` initializer:

```ts
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command)
      : args.kind === "tool"
        ? args.toolName
        : args.kind === "memory"
          ? suggestedMemoryPattern(args.namespace)
          : suggestedPathPattern(args.path)
```

Replace the `detail` initializer:

```ts
    detail:
      args.kind === "command"
        ? { command: args.command, suggestedPattern }
        : args.kind === "tool"
          ? { toolName: args.toolName, argsPreview: args.argsPreview, suggestedPattern }
          : args.kind === "memory"
            ? {
                namespace: args.namespace,
                identity: args.identity,
                oldId: args.oldId,
                oldContent: args.oldContent,
                newContent: args.newContent,
                suggestedPattern,
              }
            : { operation: args.operation, path: args.path, suggestedPattern },
```

Replace the persistence key line (207):

```ts
    const tool =
      args.kind === "command"
        ? "bash"
        : args.kind === "tool"
          ? "tool"
          : args.kind === "memory"
            ? "memory"
            : args.operation
```

- [ ] **Step 4: Export from the core barrel**

In `packages/core/src/index.ts`, find the existing export of `gateToolOp`/`wrapToolWithApproval` from `./capabilities/permission-gate.js` and add `gateMemorySupersede` and the `MemorySupersedeDetail` type to it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/core test -- permission-gate`
Expected: PASS (all, including pre-existing).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/permission-gate.ts packages/core/src/index.ts packages/core/test/capabilities/permission-gate.test.ts
git commit -m "feat(core): gateMemorySupersede — kind:\"memory\" interrupt with old-vs-new detail"
```

---

### Task 4: `ask` mode in the memory capability

**Files:**
- Modify: `packages/core/src/capabilities/built-in/memory.ts`
- Test: `packages/core/test/capabilities/memory.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/test/capabilities/memory.test.ts`. The file has `fakeStore()` and `ctxWith(store, writes)` helpers (lines 5-52); `ctxWith`'s second param is typed `"auto" | "candidate" | "off"` — widen it to `"auto" | "candidate" | "off" | "ask"`. Tests inject a minimal fake `PermissionsStore` via `context.permissions`:

```ts
function fakePermissions(
  mode: "interactive" | "non-interactive" | "bypass",
  matchResult: "allow" | "deny" | "unknown" = "unknown",
) {
  const added: Array<{ tool: string; pattern: string }> = []
  return {
    added,
    async load() {},
    match: () => matchResult,
    async addAllow(tool: string, pattern: string) {
      added.push({ tool, pattern })
    },
    mode,
  }
}

function askCtx(store: any, permissions?: any) {
  const ctx = ctxWith(store, "ask" as any) as any
  if (permissions) ctx.permissions = permissions
  return ctx
}

describe("ask mode", () => {
  const first = { subject: "billing", predicate: "escalate", value: "500" }
  const second = { subject: "billing", predicate: "escalate", value: "750" }
  const run = (tool: any, data: any, content: string) =>
    tool.run({ data, content }, { signal: new AbortController().signal })

  it("ADD lands active with no gate consulted", async () => {
    const store = fakeStore()
    const permissions = fakePermissions("non-interactive", "deny") // would block if consulted
    const c = await createMemoryMarker().load("/r", askCtx(store, permissions))
    const remember = c.tools!.find((t) => t.name === "remember")!
    const result = await run(remember, first, "v1")
    expect(String(result)).toContain("Stored memory")
    expect(store.rows.filter((r: any) => r.status === "active")).toHaveLength(1)
  })

  it("idempotent UPDATE refreshes with no gate consulted", async () => {
    const store = fakeStore()
    const permissions = fakePermissions("non-interactive", "deny")
    const c = await createMemoryMarker().load("/r", askCtx(store, permissions))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await run(remember, first, "v1")
    const result = await run(remember, first, "v1 refreshed")
    expect(String(result)).toContain("Updated memory")
  })

  it("SUPERSEDE with explicit deny keeps the old value active and reports it", async () => {
    const store = fakeStore()
    const permissions = fakePermissions("non-interactive", "deny")
    const c = await createMemoryMarker().load("/r", askCtx(store, permissions))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await run(remember, first, "v1")
    const result = await run(remember, second, "v2")
    expect(String(result)).toContain("Kept existing memory")
    const active = store.rows.filter((r: any) => r.status === "active")
    expect(active).toHaveLength(1)
    expect(active[0].data.value).toBe("500")
    expect(store.rows.filter((r: any) => r.status === "superseded")).toHaveLength(0)
  })

  it("SUPERSEDE proceeds headless on unknown (ask ≡ auto non-interactive)", async () => {
    const store = fakeStore()
    const permissions = fakePermissions("non-interactive", "unknown")
    const c = await createMemoryMarker().load("/r", askCtx(store, permissions))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await run(remember, first, "v1")
    const result = await run(remember, second, "v2")
    expect(String(result)).toContain("Superseded")
    const active = store.rows.filter((r: any) => r.status === "active")
    expect(active).toHaveLength(1)
    expect(active[0].data.value).toBe("750")
  })

  it("SUPERSEDE proceeds when no permissions store is in context (ask ≡ auto)", async () => {
    const store = fakeStore()
    const c = await createMemoryMarker().load("/r", askCtx(store))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await run(remember, first, "v1")
    const result = await run(remember, second, "v2")
    expect(String(result)).toContain("Superseded")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/core test -- capabilities/memory`
Expected: FAIL — in `ask` mode writes currently fall into the candidate branch (`Stored memory candidate …`), so the first test's `"Stored memory"`/active assertions fail.

- [ ] **Step 3: Implement `ask` in the capability**

In `packages/core/src/capabilities/built-in/memory.ts`:

Add the import (after line 3):

```ts
import { gateMemorySupersede } from "../permission-gate.js"
```

In `load` (line 27-29), capture permissions alongside memory:

```ts
    load: async (_routeDir, context) => {
      const mem = context.memory
      if (!mem) return {}
      const permissions = context.permissions
```

Replace line 105 (`const status = mem.writes === "auto" ? "active" : "candidate"`):

```ts
          // "ask" shares auto's write semantics; only its SUPERSEDE branch gates.
          const autoLike = mem.writes === "auto" || mem.writes === "ask"
          const status = autoLike ? "active" : "candidate"
```

Replace line 127 (`if (mem.writes === "auto") {`):

```ts
          if (autoLike) {
```

Replace the supersede branch (lines 150-153) with the gated version:

```ts
              // Same identity but different value — supersede. In "ask" mode this
              // is the one write that gates: the agent is contradicting a prior
              // belief. ADDs/idempotent UPDATEs above never reach the gate.
              if (mem.writes === "ask") {
                const gate = await gateMemorySupersede(permissions, {
                  namespace: mem.namespace,
                  identity: identityKeys.map((k) => String(data[k] ?? "")).join(" / "),
                  oldId: target.id,
                  oldContent: target.content,
                  newContent: content,
                })
                if (!gate.allowed) {
                  return (
                    `Kept existing memory ${target.id} ("${target.content}"); ` +
                    `your contradicting value was not stored (${gate.reason}).`
                  )
                }
              }
              await mem.store.put(record)
              await mem.store.supersede(target.id, id)
              return `Superseded ${target.id} with ${id}.`
```

Note: `target.content` exists on `MemoryRecordLike` (the index fragment already reads `r.content`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/core test -- capabilities/memory`
Expected: PASS (all, including pre-existing auto/candidate tests).

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/core build`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/built-in/memory.ts packages/core/test/capabilities/memory.test.ts
git commit -m "feat(core): memory writes:\"ask\" — supersede-gated writes in the remember tool"
```

---

### Task 5: Validation warning — `ask` + `approve: ["remember"]` overlap

**Files:**
- Modify: `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`
- Modify: `packages/cli/src/commands/check.ts` (~line 46)
- Test: the existing test file for `collectToolScopeIssues` (find it: `grep -rl collectToolScopeIssues packages/cli/test`)

- [ ] **Step 1: Write the failing test**

In the existing `collectToolScopeIssues` test file, mirror an existing warning test (e.g. the deny-overlap one) with a route whose descriptor has `tools: { approve: ["remember"] }`, passing the new options param:

```ts
it("warns when approve lists remember while memory writes mode is ask", async () => {
  // Build manifest + deps exactly as the sibling warning tests do, with a
  // route descriptor of tools: { approve: ["remember"] }.
  const issues = await collectToolScopeIssues(manifest, deps, { memoryWrites: "ask" })
  expect(issues.warnings.some((w) => w.includes('approve lists "remember"'))).toBe(true)
})

it("does not warn about remember when writes mode is not ask", async () => {
  const issues = await collectToolScopeIssues(manifest, deps, { memoryWrites: "auto" })
  expect(issues.warnings.some((w) => w.includes('approve lists "remember"'))).toBe(false)
})
```

(Adapt `manifest`/`deps` construction verbatim from the sibling tests in that file — do not invent a new harness.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dawn-ai/cli test -- collect-tool-scope`
Expected: FAIL — third parameter doesn't exist.

- [ ] **Step 3: Implement**

In `collect-tool-scope-errors.ts`, extend the signature (lines 58-61) with a backward-compatible third param:

```ts
export async function collectToolScopeIssues(
  manifest: RouteManifest,
  deps: Deps = defaultDeps,
  opts?: { readonly memoryWrites?: "off" | "candidate" | "auto" | "ask" },
): Promise<ToolScopeIssues> {
```

In the `approve` validation loop, alongside the `INTERNALLY_GATED` warning (lines 87-91), add:

```ts
        if (opts?.memoryWrites === "ask" && name === "remember") {
          warnings.push(
            `⚠ ${route.pathname}: approve lists "remember" but memory writes mode is "ask" — ` +
              `the supersede-level memory gate already prompts; combining both double-prompts.`,
          )
        }
```

In `packages/cli/src/commands/check.ts` (line 46), resolve the mode and pass it (import `resolveMemoryWrites` from `../lib/runtime/resolve-memory.js`; the appRoot variable used elsewhere in the command is in scope):

```ts
  const memoryWrites = await resolveMemoryWrites(appRoot)
  const scopeIssues = await collectToolScopeIssues(manifest, undefined, { memoryWrites })
```

(Passing `undefined` for `deps` engages the default — matches TS default-param semantics.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli test -- collect-tool-scope`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/collect-tool-scope-errors.ts packages/cli/src/commands/check.ts packages/cli/test
git commit -m "feat(cli): warn on writes:\"ask\" + approve:[\"remember\"] double-gate overlap"
```

---

### Task 6: Chat example — render `kind: "memory"` interrupts

**Files:**
- Modify: `examples/chat/web/app/page.tsx` (type at lines 11-23; JSX at lines 191-240)

- [ ] **Step 1: Widen `PendingInterrupt`**

```ts
type PendingInterrupt = {
  interruptId: string
  type: string
  kind: "command" | "path" | "tool" | "memory"
  detail: {
    command?: string
    operation?: string
    path?: string
    toolName?: string
    argsPreview?: string
    identity?: string
    oldContent?: string
    newContent?: string
    suggestedPattern: string
  }
}
```

- [ ] **Step 2: Add the render branch**

In the `<p>` message ternary chain (lines 203-208), insert a memory arm before the path fallback:

```tsx
      {pendingInterrupt.kind === "command"
        ? "The agent wants to run command:"
        : pendingInterrupt.kind === "tool"
          ? `The agent wants to call tool ${pendingInterrupt.detail.toolName ?? "(unknown)"}:`
          : pendingInterrupt.kind === "memory"
            ? `The agent wants to overwrite a memory (${pendingInterrupt.detail.identity ?? "(unknown)"}):`
            : `The agent wants to ${pendingInterrupt.detail.operation}:`}
```

In the `<code>` block ternary (lines 220-224), insert the old-vs-new display:

```tsx
      {pendingInterrupt.kind === "command"
        ? pendingInterrupt.detail.command
        : pendingInterrupt.kind === "tool"
          ? (pendingInterrupt.detail.argsPreview ?? "")
          : pendingInterrupt.kind === "memory"
            ? `was: ${pendingInterrupt.detail.oldContent ?? ""}\nnow: ${pendingInterrupt.detail.newContent ?? ""}`
            : pendingInterrupt.detail.path}
```

Add `whiteSpace: "pre-wrap"` to the `<code>` style object so the two-line was/now renders on separate lines. The Once/Always/Deny buttons need no changes (`suggestedPattern` is already rendered generically).

- [ ] **Step 3: Typecheck the example**

Run: `pnpm --filter chat-web typecheck 2>/dev/null || pnpm typecheck`
Expected: clean. (Use whichever target exists for the example; fall back to the workspace-wide typecheck.)

- [ ] **Step 4: Commit**

```bash
git add examples/chat/web/app/page.tsx
git commit -m "feat(examples/chat): render kind:\"memory\" permission interrupts (old vs new)"
```

---

### Task 7: aimock e2e — fixture + four scenarios

**Files:**
- Create: `packages/testing/test/fixtures/probe-app-memory-ask/dawn.config.ts`
- Create: `packages/testing/test/fixtures/probe-app-memory-ask/package.json` (copy `probe-app-memory-candidate`'s verbatim, changing only the `name` field to `probe-app-memory-ask`)
- Create: `packages/testing/test/fixtures/probe-app-memory-ask/src/app/notes/index.ts`
- Create: `packages/testing/test/fixtures/probe-app-memory-ask/src/app/notes/memory.ts`
- Create: `packages/testing/test/memory-ask.e2e.test.ts`

- [ ] **Step 1: Create the fixture app**

`dawn.config.ts`:

```ts
export default { memory: { writes: "ask" } }
```

`src/app/notes/index.ts`:

```ts
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a note-taking test agent. Use remember to store facts.",
})
```

`src/app/notes/memory.ts`:

```ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
})
```

Check `probe-app-memory-candidate` for any other files (e.g. tsconfig) and mirror them.

- [ ] **Step 2: Write the e2e tests**

Create `packages/testing/test/memory-ask.e2e.test.ts` (modeled verbatim on `tool-approval.e2e.test.ts` — imports, harness, matchers, 60s timeouts). The route's namespace is `workspace=probe-app-memory-ask|route=/notes` (workspace = fixture dir basename), so the persisted "always" pattern is `workspace=probe-app-memory-ask|route=/notes|`.

```ts
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectNoInterrupt, expectToolCalled } from "../src/matchers.js"

const askRoot = fileURLToPath(new URL("./fixtures/probe-app-memory-ask", import.meta.url))
const permissionsPath = join(askRoot, ".dawn", "permissions.json")

const NET30 = { subject: "acme", predicate: "payment-terms", value: "net-30" }
const NET45 = { subject: "acme", predicate: "payment-terms", value: "net-45" }
const NET60 = { subject: "acme", predicate: "payment-terms", value: "net-60" }

// Fresh store + permissions per test: memory.sqlite and permissions.json both
// live under the fixture's .dawn/.
beforeEach(() => {
  rmSync(join(askRoot, ".dawn"), { recursive: true, force: true })
})

const rememberScript = (data: Record<string, string>, content: string, reply: string) =>
  script().user(`remember: ${content}`).callsTool("remember", { data, content }).replies(reply)

it("ADD never interrupts; a contradicting write interrupts with old-vs-new; resume(once) supersedes", async () => {
  const h = await createAgentHarness({ appRoot: askRoot, route: "/notes#agent" })
  try {
    const run1 = await h.run({
      input: "remember: acme prefers net-30",
      fixtures: rememberScript(NET30, "acme prefers net-30", "Noted."),
    })
    expectNoInterrupt(run1)
    expectToolCalled(run1, "remember")

    h.reset()
    const run2 = await h.run({
      input: "remember: acme prefers net-45",
      fixtures: rememberScript(NET45, "acme prefers net-45", "Updated."),
    })
    expectInterrupt(run2).ofKind("memory").withDetail({
      identity: "acme / payment-terms",
      oldContent: "acme prefers net-30",
      newContent: "acme prefers net-45",
    })

    const resumed = await h.resume({ decision: "once" })
    expect(JSON.stringify(resumed)).toContain("Superseded")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(deny) keeps the old value and reports it to the agent", async () => {
  const h = await createAgentHarness({ appRoot: askRoot, route: "/notes#agent" })
  try {
    await h.run({
      input: "remember: acme prefers net-30",
      fixtures: rememberScript(NET30, "acme prefers net-30", "Noted."),
    })
    h.reset()
    const run = await h.run({
      input: "remember: acme prefers net-45",
      fixtures: rememberScript(NET45, "acme prefers net-45", "Updated."),
    })
    expectInterrupt(run).ofKind("memory")

    const resumed = await h.resume({ decision: "deny" })
    expect(JSON.stringify(resumed)).toContain("Kept existing memory")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(always) persists the route prefix; a fresh contradiction does not prompt", async () => {
  const h = await createAgentHarness({ appRoot: askRoot, route: "/notes#agent" })
  try {
    await h.run({
      input: "remember: acme prefers net-30",
      fixtures: rememberScript(NET30, "acme prefers net-30", "Noted."),
    })
    h.reset()
    const run = await h.run({
      input: "remember: acme prefers net-45",
      fixtures: rememberScript(NET45, "acme prefers net-45", "Updated."),
    })
    expectInterrupt(run).ofKind("memory")
    await h.resume({ decision: "always" })

    const persisted = JSON.parse(readFileSync(permissionsPath, "utf8")) as {
      allow?: Record<string, string[]>
    }
    expect(persisted.allow?.memory).toContain("workspace=probe-app-memory-ask|route=/notes|")

    h.reset()
    const run3 = await h.run({
      input: "remember: acme prefers net-60",
      fixtures: rememberScript(NET60, "acme prefers net-60", "Updated again."),
    })
    expectNoInterrupt(run3)
    expect(JSON.stringify(run3)).toContain("Superseded")
  } finally {
    await h.close()
  }
}, 60_000)
```

Note for the implementer: if `expectInterrupt(...).withDetail(...)` only supports flat equality on given keys (see `packages/testing/src/matchers.ts`), the detail assertions above work as-is; if it requires the full detail object, assert the three keys individually via `run2.interrupts[0].detail`.

- [ ] **Step 3: Run the e2e**

Run: `pnpm --filter @dawn-ai/testing test -- memory-ask`
Expected: PASS (3 tests). Debug notes: an interrupt that never fires usually means the fixture's writes mode didn't resolve (check `dawn.config.ts` loads) or the first write superseded instead of ADDing (check `beforeEach` cleared `.dawn`).

- [ ] **Step 4: Run the full testing suite (no regressions)**

Run: `pnpm --filter @dawn-ai/testing test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/test/fixtures/probe-app-memory-ask packages/testing/test/memory-ask.e2e.test.ts
git commit -m "test(testing): aimock e2e for memory writes:\"ask\" — interrupt/once/deny/always"
```

---

### Task 8: Docs + changeset + spec annotation

**Files:**
- Modify: `apps/web/content/docs/memory.mdx`
- Modify: `apps/web/content/docs/permissions.mdx`
- Modify: `apps/web/content/docs/configuration.mdx`
- Modify: `docs/superpowers/specs/2026-06-18-long-term-memory-design.md`
- Create: `.changeset/memory-ask-mode.md`

- [ ] **Step 1: memory.mdx — replace the stale callout, add the `ask` row and section**

Replace the entire `<Callout type="warn" title="auto writes are not gated by permissions">…</Callout>` block (~line 139) with:

```mdx
<Callout type="info" title="Gating writes: ask mode vs tools.approve">
  Two gates exist, at different granularities. `writes: "ask"` (below) prompts **only when the agent contradicts an existing memory** — a supersede-level gate inside `remember`. `tools: { approve: ["remember"] }` (see [per-tool approval](/docs/permissions)) prompts on **every** `remember` call. Prefer `ask` for memory; combining both draws a `dawn check` warning (double prompt). `auto` remains fully trusting.
</Callout>
```

Update the write-governance table (~line 123) to four rows:

```mdx
| Mode | `remember` tool | Where writes land | Reconciliation |
|---|---|---|---|
| `off` | Not generated (recall-only) | — | — |
| `candidate` *(default)* | Generated | `candidate` — hidden from `recall` until approved | None |
| `auto` | Generated | `active` immediately | Inline (see below) |
| `ask` | Generated | `active` immediately | Inline — supersedes prompt first |
```

After the existing `auto` reconciliation bullets (~line 133), add:

```mdx
### `ask` mode

`ask` shares `auto`'s write semantics exactly — same reconciliation, same statuses — with one difference: a **SUPERSEDE** (same identity, different value) asks a human first. The prompt shows the old and new values with Once / Always / Deny; **Always** persists a rule for the whole route, so future overwrites in that route proceed silently. ADDs and idempotent updates never prompt.

- **Deny** keeps the old record active; nothing is written; the agent is told which memory was kept.
- **Headless** (non-interactive mode, CI, evals, deployed servers): `ask` behaves exactly as `auto` — the supersede proceeds. `ask` is a *supervision affordance for interactive development*, not a security boundary. Explicit `deny` rules in the permissions config are still honored headless.
- Decisions persist under the `memory` key in `.dawn/permissions.json` as namespace prefixes, e.g. `{ "allow": { "memory": ["workspace=app|route=/support|"] } }` (keep the trailing `|` — it prevents sibling-route prefix collisions).
```

In the "What's deferred" list (~line 232), delete the line `- Permissions HITL gating for `auto` writes (see the warning above).`

- [ ] **Step 2: permissions.mdx — add a "Memory write approval" section**

After the per-tool approval section (added by #291), insert:

```mdx
## Memory write approval (`writes: "ask"`)

Routes with [long-term memory](/docs/memory) can gate belief *changes*: with `memory: { writes: "ask" }` in `dawn.config.ts`, a `remember` call that would **supersede** an existing active memory interrupts with the old and new values. New facts and idempotent refreshes never prompt.

- **Once** — this supersede proceeds.
- **Always** — persists the route's namespace prefix under the `memory` key; all future overwrites in the route proceed silently.
- **Deny** — the old memory stays active; the agent is told which memory was kept.

Unlike bash/path/tool gates, `ask` **allows through** when no human can answer (non-interactive mode): headless, `ask` ≡ `auto`. It is a supervision affordance, not a security boundary. Explicit `deny` entries are honored in every mode except `bypass`.

Hand-authored patterns should keep the trailing `|` terminator: `"workspace=app|route=/a|"` cannot collide with `route=/ab`.
```

- [ ] **Step 3: configuration.mdx — update the writes line**

Find the `memory` block documentation and update the `writes` union and comment to include `"ask"` (mirror the Task 1 doc comment).

- [ ] **Step 4: Annotate the 2026-06-18 spec**

In `docs/superpowers/specs/2026-06-18-long-term-memory-design.md`, in the Write governance section's `auto` bullet (~line 118), append: `(2026-07-06: the HITL gate shipped as the separate "ask" mode — see docs/superpowers/specs/2026-07-06-memory-ask-mode-design.md.)`

- [ ] **Step 5: Changeset**

Create `.changeset/memory-ask-mode.md` (**patch** — fixed 0.x group; a minor would force 1.0.0):

```md
---
"@dawn-ai/core": patch
"@dawn-ai/permissions": patch
"@dawn-ai/cli": patch
---

New memory write-governance mode `writes: "ask"`: memory supersedes (belief contradictions) prompt a HITL Once/Always/Deny interrupt with old-vs-new detail; ADDs and idempotent updates flow silently; headless behaves as `auto`. New `kind: "memory"` permission interrupt, `gateMemorySupersede`, `suggestedMemoryPattern`, and a `dawn check` warning for the `ask` + `approve: ["remember"]` double-gate overlap.
```

- [ ] **Step 6: Docs build check + commit**

Run: `pnpm --filter web build 2>/dev/null || pnpm build`
Expected: clean (mdx compiles).

```bash
git add apps/web/content/docs docs/superpowers/specs/2026-06-18-long-term-memory-design.md .changeset/memory-ask-mode.md
git commit -m "docs: memory writes:\"ask\" — supersede gating, permissions section, changeset"
```

---

### Task 9: Final verification + issue update

- [ ] **Step 1: Full verification**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. Fix anything that isn't before proceeding (report failures honestly).

- [ ] **Step 2: Update issue #260**

```bash
gh issue comment 260 --body "Implemented as \`memory.writes: \"ask\"\` (supersede-gated writes) per docs/superpowers/specs/2026-07-06-memory-ask-mode-design.md — re-scoped after #291 shipped generic per-tool approval: the memory gate prompts only on belief contradictions (outcome-sensitive, not expressible via tools.approve). Closing when the implementation PR merges."
gh issue edit 260 --title "Memory: supersede-gated writes (writes: \"ask\") — HITL for belief contradictions"
```

- [ ] **Step 3: Commit any stragglers**

```bash
git status --short   # should be clean; commit anything intentional that remains
```
