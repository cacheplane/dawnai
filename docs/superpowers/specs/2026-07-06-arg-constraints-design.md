# Argument-level tool constraints (Design)

**Status:** Approved for planning
**Date:** 2026-07-06
**Roadmap:** Phase 4 (Richer Authoring Systems) — *richer tool policies*, slice 3: **argument-level constraints**. Follows slice 1 (tool scoping, PR #261) and slice 2 (per-tool approval gating, PR #291). Rate/usage limits and MCP/connection filtering remain later slices.

## Problem

Slices 1–2 police tools by **name**: `tools.allow`/`deny` control *which* tools the model may call, and `tools.approve` gates a call for HITL approval — but unconditionally, regardless of *how* the tool is called. Neither can express "this tool is fine with these arguments but not those":

- `runBash` is allowed, but `rm -rf /` should be blocked while `ls` runs freely.
- `deployProd` is available, but `env: "staging"` should run, `env: "prod"` should require a human.
- `writeFile` inside the workspace is fine, but a path outside a per-tenant prefix should be denied.

The Phase-3 bash/path gates already do a hardcoded, pattern-matched version of this for `runBash`/`readFile`/`writeFile`/`listDir` (`gateBashOp`/`gatePathOp` in `permission-gate.ts`). Slice 3 generalizes it to **any** tool, author-defined.

## Decisions (from brainstorming)

1. **Constraint form: predicate functions** (not declarative field patterns). Dawn is code-first (tsx-evaluated `dawn.config.ts`, callable backends, tools-as-functions), so a JS predicate fits the grain and is maximally expressive. The tradeoff — predicate bodies are opaque to static validation — is accepted.
2. **Declared on the descriptor**, extending slices 1–2's `ToolScope`: `agent({ tools: { constrain: { <toolName>: predicate } } })`. Uniform across top routes and subagents.
3. **Outcome vocabulary** (composes all three slices): a predicate returns
   - `true` → **allow** (proceed to the tool),
   - `string` → **deny**; the string is the reason returned *as the tool result* (model-visible; deliberately return-not-throw, matching `wrapToolWithApproval`),
   - `{ approve: true; reason?: string }` → **escalate to HITL**, reusing the shipped `gateToolOp` interrupt/resume path.
4. **Predicate signature**: `predicate(args, ctx)`, sync or async. `ctx` is a curated, read-only *policy* view — `{ toolName, routeId, threadId?, signal, params? }` — not the full runtime `DawnToolContext` (keeps the contract stable, testable, side-effect-discouraged).
5. **Enforcement at the compose seam** (approach A): a runtime wrapper on the tool's `run`, applied where slice 2 already wraps `approve` tools in `execute-route.ts`. Constraints must run at call time (args are only known then).
6. **Additive, not breaking.** `constrain` is optional; omitting it changes nothing. No migration.

## Approaches considered

- **A. Compose-seam runtime wrapper (chosen).** New `wrapToolWithConstraint(tool, predicate, permissions)` in `permission-gate.ts`, applied at the `execute-route.ts` seam right after the `approve` wrap. Reuses the exact, proven slice-2 pattern; one enforcement point; authored + capability tools uniform; the `{approve}` outcome delegates to the already-shipped `gateToolOp` so the interrupt/resume/persistence plumbing is reused verbatim.
- **B. A new "policies" capability marker.** Rejected: capabilities contribute tools, they don't transform peers' tools — same reason slice 2 rejected its option C.
- **C. Gate inside the langchain tool-converter.** Rejected: drags policy into `@dawn-ai/langchain` (policy lives in core) and needs duplicating for the legacy runnable path.

## Design

### 1. Authoring surface (`@dawn-ai/sdk`, `packages/sdk/src/agent.ts`)

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

export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly approve?: readonly string[]
  /**
   * Per-call argument constraints: a predicate per tool name. Runs at call time
   * against the model's arguments. Return `true` to allow, a string to deny
   * (the string is returned as the tool result), or `{ approve: true }` to
   * escalate to a HITL approval prompt. Predicate bodies are not statically
   * validated (only the tool names are). See docs/permissions.
   */
  readonly constrain?: Readonly<Record<string, ConstraintPredicate>>
}
```

`agent()` passes `tools` through unchanged (already does). Applies to subagent descriptors identically.

### 2. Enforcement (`@dawn-ai/core`, `packages/core/src/capabilities/permission-gate.ts`)

New sibling of `wrapToolWithApproval`, generic over the tool shape (so `DiscoveredToolDefinition` survives with its extra fields, matching the slice-2 wrapper):

```ts
export function wrapToolWithConstraint<C, T extends { readonly name: string; readonly run: (input: unknown, context: C) => Promise<unknown> | unknown }>(
  tool: T,
  predicate: ConstraintPredicate,
  permissions: PermissionsStore | undefined,
  makeCtx: (input: unknown) => ConstraintContext,
): T
```

The wrapped `run(input, context)`:
1. `ctx = makeCtx(input)` (the wiring layer supplies `toolName`/`routeId`/`threadId`/`signal`/`params`).
2. `let verdict; try { verdict = await predicate(input, ctx) } catch (e) { return DENY_REASON }` — **a throwing predicate fails closed** (returns a generic "constraint check failed" reason as the tool result; debug-gated warn). A broken policy never silently allows.
3. Dispatch:
   - `verdict === true` → `return tool.run(input, context)`.
   - `typeof verdict === "string"` → `return verdict` (deny; model-visible result).
   - `verdict && verdict.approve === true` → `const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input)); if (!gate.allowed) return gate.reason; return tool.run(input, context)`. (The predicate's optional `reason` is surfaced in the approval prompt.)

Reuses `buildArgsPreview` and `gateToolOp` unchanged. The `{approve}` branch inherits every mode behavior (bypass/non-interactive/interruptCapable) and the Once/Always/Deny persistence from slice 2.

### 3. Wiring (`@dawn-ai/cli`, `packages/cli/src/lib/runtime/execute-route.ts`)

At the existing compose seam, **after** the `approve` wrap (so precedence is well-defined):

```ts
const constrain = descriptor?.tools?.constrain
if (constrain) {
  tools = tools.map((t) =>
    constrain[t.name]
      ? wrapToolWithConstraint(t, constrain[t.name], permissionsStore, (input) => ({
          toolName: t.name,
          routeId: options.routeId,
          ...(threadId ? { threadId } : {}),
          signal,
          ...(routeParams ? { params: routeParams } : {}),
        }))
      : t,
  )
}
```

(The exact in-scope names for `threadId`/`signal`/`routeParams` are verified during planning; `permissionsStore`/`descriptor`/`options.routeId` are the same ones slice 2 uses.)

**Precedence when a tool is in both `approve` and `constrain`:** `constrain` is authoritative and a constrained tool is wrapped **only** by `constrain` (the wiring excludes `constrain` keys from the `approve` set: `approveSet = approve.filter(n => !constrain[n])`). This avoids a double-gate — wrapping both would make the predicate's `true` verdict still hit the inner name-level prompt. `constrain` can itself escalate via `{approve}`, so nothing is lost; `dawn check` warns the `approve` entry is redundant (see §4).

**"Always" is name-level (documented limitation).** When a constraint's `{approve}` escalation is answered "Always", `gateToolOp` persists the **tool name** under the reserved `tool` key (slice 2's mechanism) — so *future* `{approve}` escalations of that same tool auto-pass, regardless of args. The predicate still runs first on every call (it can `deny` outright), but the escalation's persistence is coarser than the args that triggered it. Args-level persistence is explicitly out of scope; authors who need per-args durability should `deny` the disallowed case outright rather than escalate it.

### 4. Validation (`dawn check`, `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`)

- Each `constrain` key must be a real **post-scope** tool name → **error** (same shape/report as unknown `allow`/`deny`/`approve` names). Predicate *bodies* are opaque and not checked — stated plainly in docs.
- A tool in **both** `approve` and `constrain` → **warning**: the `approve` entry is redundant (constrain can escalate); constrain wins.
- (No `task` special-case needed beyond the existing one — a `constrain` on `task` has the same bridge caveat as `approve` on `task`; warn identically if the effort is cheap, else document.)

`ToolScopeShape` in the check module gains `constrain?: Record<string, unknown>` (only the keys matter for validation; values are opaque).

### 5. Error handling / edge cases

- **Throwing predicate** → fail closed (deny result), never allow. Debug-gated warn (`DAWN_DEBUG_CONSTRAINTS=1`).
- **Async predicate** → awaited; honors the call's `AbortSignal` via `ctx.signal` (author's responsibility to respect it for long checks).
- **`constrain` names a tool not present** → build-time error + runtime no-op (the wrap map only wraps tools that exist post-scope, exactly like slice 2).
- **`{approve}` in a non-interactive / non-interrupt-capable context** → inherits `gateToolOp`'s fail-closed-with-guidance behavior (no new path).
- **Determinism** — the wrapper adds no `Date.now()`/rand; `gateToolOp` already owns the only non-deterministic bits (interruptId), unchanged.

### 6. Testing

- **Unit (`@dawn-ai/core`):** `wrapToolWithConstraint` verdict ladder — allow proceeds to real run; string denies with that result; `{approve}` reaches `gateToolOp` (allow→proceed, deny→reason); throwing predicate fails closed; async predicate awaited; tool metadata preserved.
- **Unit (`@dawn-ai/cli`):** `dawn check` — unknown `constrain` key errors; `approve`∩`constrain` warns.
- **aimock e2e (`@dawn-ai/testing`) — headline:** a probe route whose `deployProd` has a `constrain` predicate (`env==="staging"`→allow, `env==="prod"`→`{approve}`, else deny). Assert: staging call runs; prod call raises the `kind:"tool"` interrupt → resume(once) runs; a bad value returns the deny reason. Reuse the `approval-chat` fixture shape.
- **Gated live smoke:** a real model driven to call the constrained tool with an allowed vs escalating arg, mirroring `tool-approval-live.smoke.test.ts`.

### 7. Documentation & website

- **tools.mdx** — `constrain` as the **fourth** scoping knob; predicate example (staging vs prod); the "predicate bodies aren't statically validated" note; cross-link to permissions for the `{approve}` flow.
- **permissions.mdx** — a short subsection: how a constraint's `{approve}` verdict reuses the per-tool approval prompt/persistence.
- **api.mdx** — `ConstraintPredicate`/`ConstraintVerdict`/`ConstraintContext` types if the file lists `ToolScope` (it currently doesn't — skip if still absent).
- **Changeset** — patch across `@dawn-ai/sdk`, `@dawn-ai/core`, `@dawn-ai/cli` (fixed group → stays pre-1.0).

## Out of scope (later slices / other features)

- Declarative (data) constraint DSL — predicates cover it; a serializable form is a possible future addition, not now.
- Transforming/sanitizing args (return-modified-args) — explicitly rejected in brainstorming (surprising, blurs policy vs implementation).
- Rate / usage limits, per-tool concurrency.
- Static analysis of predicate bodies.
- Refactoring the built-in bash/path gates onto this mechanism (they stay pattern-aware and independent).

## Risks

- **Opaque predicates** — no static safety on the logic; a buggy predicate that throws fails closed (safe default) but blocks the tool. Mitigated by the fail-closed + debug warn + docs.
- **Precedence confusion** with `approve` — mitigated by the `dawn check` warning and clear docs (constrain wins; it can escalate).
- **Predicate side effects / latency** — a slow or effectful predicate delays every gated call; docs steer authors toward pure, fast checks and honoring `ctx.signal`.
