# Per-tool approval gating (Design)

**Status:** Approved for planning
**Date:** 2026-07-05
**Roadmap:** Phase 4 (Richer Authoring Systems) — *richer tool policies*, slice 2: **per-tool approval gating**. Follows slice 1 (tool scoping, PR #261). Also closes the Phase-4 "approvals" basket item (the rest shipped as Phase-3 HITL permissions). Argument-level constraints, rate limits, and execution sandboxing remain later slices (see the #261 design's out-of-scope ledger).

## Problem

Phase-3 HITL permissions gate exactly two things: `runBash` commands and path-jail escapes on `readFile`/`writeFile`/`listDir`. Both gates are hand-rolled inside the workspace capability (`packages/core/src/capabilities/built-in/workspace.ts` calling `gateBashOp`/`gatePathOp` in `packages/core/src/capabilities/permission-gate.ts`). No other tool can require approval:

- An **authored tool** with side effects (`deployProd`, `sendEmail`, `chargeCustomer`) runs the moment the model calls it.
- A **capability tool** outside the workspace set (`task`, `remember`, …) likewise cannot be gated.

Tool scoping (#261) controls *which tools the model may call*; this slice adds the orthogonal knob: *which calls need a human in the loop*.

## Decisions (from brainstorming)

1. **Declared on the agent descriptor**, extending #261's `ToolScope`: `agent({ tools: { allow?, deny?, approve? } })`. Uniform across top routes and subagents (each descriptor scopes itself).
2. **Granularity: per tool name.** An "Always allow" decision persists the tool *name*; the approval prompt *shows* the call's args (`argsPreview`) so the user knows what they are approving right now, but args are never matched or persisted. Args-pattern matching is exactly the deferred "argument-level constraints" slice — we do not half-build it here.
3. **Coexist with the existing bash/path gates; warn on overlap.** `gateBashOp`/`gatePathOp` stay as they are (pattern-aware — strictly richer than name-level). Naming an internally-gated workspace tool in `approve` draws a build-time warning (redundant; avoids double prompts).
4. **Enforcement at the composition seam** (approach A below): the gate wraps the tool's `run` where #261 already filters the merged tool set. No changes to the langchain tool-converter or to individual capabilities.
5. **Additive, not breaking.** `approve` is optional; omitting it keeps today's behavior exactly. No migration.

## Approaches considered

- **A. Compose-time wrapper at the scoping seam (chosen).** After `resolveToolScope` filters the merged set in `execute-route.ts`, wrap each surviving tool named in `approve` with a generic gate. One enforcement point; authored and capability tools uniform; the interrupt/resume plumbing (SSE envelope, `Command({resume})`, permissions store persistence) is reused verbatim; modes inherit existing semantics.
- **B. Gate inside the langchain tool-converter.** Rejected: drags permissions concepts into `@dawn-ai/langchain` (gates live in core) and needs duplicating for the legacy runnable path.
- **C. A "policies" capability marker.** Rejected: capabilities contribute tools; they do not transform other capabilities' tools. Would need a new contribution kind — over-engineered.

## Design

### 1. Authoring surface (`@dawn-ai/sdk`, `packages/sdk/src/agent.ts`)

```ts
export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  /** Tools that require human approval per call (HITL interrupt) unless pre-approved. */
  readonly approve?: readonly string[]
}
```

```ts
// src/app/ops/index.ts
export default agent({
  model: "gpt-5",
  tools: { deny: ["runBash"], approve: ["deployProd", "sendEmail"] },
})
```

`agent()` passes `tools` through unchanged. Applies to subagent descriptors identically.

### 2. Types (`@dawn-ai/permissions`, `packages/permissions/src/types.ts`)

`PermissionRequest.kind` widens to `"command" | "path" | "tool"`, with:

```ts
export interface ToolDetail {
  readonly toolName: string
  /** JSON.stringify(input) truncated (~500 chars). Shown in the prompt; never matched or persisted. */
  readonly argsPreview: string
  /** The tool name — name-level persistence. */
  readonly suggestedPattern: string
}
```

**Store and file format unchanged**, with one documented semantic carve-out: `matchPermission` is prefix-based (`candidate.startsWith(pattern)`), which is wrong for tool names (`deploy` would match `deployProd`). The reserved `"tool"` key therefore uses **exact equality** — a one-line, well-commented special case in `pattern-matching.ts`. A reserved `"tool"` key in the existing `PermissionsFile` maps carries tool names:

```jsonc
// .dawn/permissions.json
{ "version": 1, "allow": { "tool": ["deployProd"] }, "deny": {} }
```

"Always" → `addAllow("tool", toolName)`. Config-seeded pre-approval works with zero new store code:

```ts
// dawn.config.ts
export default { permissions: { allow: { tool: ["deployProd"] } } }
```

### 3. The gate (`@dawn-ai/core`, `packages/core/src/capabilities/permission-gate.ts`)

New `gateToolOp(permissions, toolName, argsPreview, opts?)` — a sibling of `gateBashOp` with the same decision ladder:

1. No store, or `mode === "bypass"` → allow.
2. `match("tool", toolName)` → `allow` passes; `deny` blocks with reason.
3. `unknown` + `mode === "non-interactive"` → fail closed (`Permission denied (fail-closed): tool <name>`).
4. `unknown` + `interruptCapable: false` → fail closed with an actionable message (add an allow rule for `"tool"` in `dawn.config.ts`).
5. Otherwise → `interrupt()` with the `kind: "tool"` payload (`{ interruptId, type: "permission-request", kind: "tool", detail: ToolDetail }`); `deny` blocks, `always` persists via `addAllow("tool", toolName)`, then allow.

Plus a wrapper factory:

```ts
export function wrapToolWithApproval(
  tool: DawnToolDefinition,
  permissions: PermissionsStore,
): DawnToolDefinition
```

The wrapped `run` gates first; a blocked call returns the denial reason **as the tool result** (the model sees it and can adapt — deliberately return-not-throw, unlike the workspace gates, which throw from inside their own `run`: the denial flows as a normal tool result through `on_tool_end`). The wrapper preserves `name`, `description`, `schema`, and the original `run`'s context.

### 4. Wiring (`@dawn-ai/cli`, `packages/cli/src/lib/runtime/execute-route.ts`)

At the existing #261 seam — after `resolveToolScope` returns `keptToolNames` and the tool set is filtered — map the surviving tools: if `descriptor.tools?.approve` contains the tool's name, replace it with `wrapToolWithApproval(tool, permissionsStore)`. The permissions store already exists at this point (it is constructed for every route kind). Subagent-dispatch preparation (`buildSubagentResolver` path) flows through the same seam, so a subagent's own `approve` list gates its tools with no extra plumbing.

The interrupt rides the proven path unchanged: `interrupt()` → `GraphInterrupt` → `on_tool_error` in the agent-adapter → SSE `interrupt` envelope → `POST /threads/:id/resume` → `Command({resume: decision})`.

### 5. Validation (`dawn check`, extending #261's pass in `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`)

- `approve` name not present in the route's **post-scope** tool surface → **error** (same throw/report shape as unknown `allow`/`deny` names; typos fail loud).
- `approve` naming an internally-gated workspace tool (`runBash`, `readFile`, `writeFile`, `listDir`) → **warning**: redundant — already gated pattern-aware; double prompts would result.
- `approve` ∩ `deny` → **warning**: deny wins at scoping; the approve entry is dead.

## Error handling / edge cases

- **Denied call** → tool returns the denial reason string as its result; the run continues (no crash). Deliberately return-not-throw, unlike the workspace gates (which throw from inside their own `run`): the denial flows as a normal tool result through `on_tool_end`.
- **`approve` on a tool the route doesn't have** → build-time error (above) AND a runtime throw: `resolveToolScope` validates `approve` names alongside `allow`/`deny`, so typos fail loud even when `dawn check` was skipped.
- **Resume across restart** → state-based resume (Phase-3 design) already handles it; the `tool` kind adds no new state.
- **Non-serializable args** → `argsPreview` falls back to `String(input)` inside a try/catch; preview is best-effort display only.
- **Multiple gated calls in one turn** → each tool call interrupts independently (LangGraph parks one interrupt per tool node execution; sequential resume — existing behavior, unchanged).

## Testing

- **Unit (`@dawn-ai/core`):** `gateToolOp` ladder — bypass, allow, deny, unknown×non-interactive, unknown×interruptCapable:false; `wrapToolWithApproval` delegates untouched on allow, blocks with reason on deny, preserves tool metadata.
- **Unit (`@dawn-ai/permissions`):** `match("tool", name)` exact-name behavior through the existing pattern matcher.
- **Unit (`@dawn-ai/cli`):** validation — unknown `approve` name errors; workspace-tool overlap warns; approve∩deny warns.
- **aimock e2e (deterministic, `@dawn-ai/testing` — the headline; `harness.resume()` already exists):** a probe route with an authored `deployProd` tool and `tools: { approve: ["deployProd"] }`:
  1. run → assert `interrupt` envelope with `kind: "tool"`, `toolName: "deployProd"`, non-empty `argsPreview` → `resume("once")` → tool executes, final message reflects it.
  2. `resume("deny")` → tool result is the denial reason; run completes.
  3. `resume("always")` → `.dawn/permissions.json` gains `allow.tool: ["deployProd"]`; a **fresh run does not prompt**.
  4. a subagent with its own `approve` gates its tool through the dispatch path — asserts the `kind: "tool"` interrupt for the subagent's tool surfaces on the parent stream. (Resume *into* a child-graph prompt inherits the platform's existing nested-interrupt behavior — the same as bash gates inside subagents today — and is not asserted here.)

## Documentation & website (in scope, thorough)

- **`apps/web/content/docs/tools.mdx`** — extend the "Scoping a route's tools" section (#261) with `approve` as the third knob; example; cross-link to the permissions page for the prompt/persistence mechanics.
- **`apps/web/content/docs/permissions.mdx`** — new "Per-tool approval" section: prompt flow, Once/Always/Deny semantics, the `tool` key in `.dawn/permissions.json`, mode behavior (`non-interactive` fail-closed, `bypass` skips), coexistence with the bash/path gates, and the "shows args, persists name" rule.
- **`apps/web/content/docs/configuration.mdx`** — `permissions.allow.tool` pre-approval in `dawn.config.ts`.
- **`apps/web/content/docs/subagents.mdx`** — `approve` on subagent descriptors (mirrors #261's subagent note).
- **`apps/web/content/docs/api.mdx`** — `ToolScope.approve` in the type reference.
- **Generated CLI docs (`packages/cli/docs`)** — verify the `dawn check` topics regenerate with the new validation messages (they are build-generated; confirm, don't hand-edit).
- **Changeset** — patch (fixed group, pre-1.0), describing the new `approve` knob and the `tool` permissions key.

## Out of scope (later slices)

- Argument-level constraints (patterns over tool args) — the natural slice 3; `approve`'s name-level persistence is forward-compatible with it.
- Rate / usage limits, per-tool concurrency.
- Pattern/glob or category tokens in `approve` (exact names only, matching #261's v1 rule).
- Refactoring the bash/path gates onto the generic mechanism.
- Execution sandboxing.

## Risks

- **Double-prompt UX** if authors gate already-gated workspace tools — mitigated by the build-time warning.
- **Prompt fatigue** if authors over-gate — docs recommend gating side-effectful tools only; "Always" persistence caps repeat prompts.
- **Interrupt-payload consumers** (web client permission panel) must render the new `kind: "tool"` — the chat example's panel needs a small addition; covered in the plan.
