# Per-route / per-subagent tool scoping (Design)

**Status:** Approved for planning
**Date:** 2026-06-20
**Roadmap:** Phase 4 (Richer Authoring Systems) sub-project — *richer tool policies*, first slice: **tool scoping** (which tools a route/subagent may call). Rate limits, per-tool approval, and argument constraints are explicitly deferred to later slices.

## Problem

Dawn auto-wires capability tools by filesystem convention, and the wiring is **app-global, not per-route**. The workspace capability decides to contribute `readFile`/`writeFile`/`listDir`/`runBash` like this (`packages/core/src/capabilities/built-in/workspace.ts:118-124`):

```ts
detect: async (_routeDir, context) => existsSync(workspaceRoot(context.appRoot)),
//                ^^^^^^^^^^ route dir ignored — keyed on <appRoot>/workspace/
```

A **subagent is just another route** (`subagents/<name>/index.ts`). At runtime `applyCapabilities` runs **per route** over every discovered route, so a subagent independently re-detects the same app-global capabilities and ends up with the **full toolbelt** — `writeFile`, `runBash`, and `task` (it can spawn *more* subagents) — even when it's meant to be a focused, read-only worker. There is no way to give a route or subagent *less* than its conventions trigger.

This is a least-privilege gap: blast radius (a confused or prompt-injected subagent can write files / run bash / recurse) and prompt bloat (every unused tool is schema + description in that agent's context).

**Prior art (verified 2026-06-20 from `~/repos/eve`, `~/repos/flue`):** both leading filesystem-first agent frameworks make **subagents least-privilege by default**.
- **eve (vercel/eve)** auto-wires tools like Dawn, but a *declared subagent inherits nothing* — its `tools/` starts empty; you grant a capability by placing a file. eve's reader verdict: eve *lacks* an "inherit-minus-X" knob and "that's a gap worth filling explicitly in Dawn." eve's real execution least-privilege is a per-agent **sandbox** (network egress policy, `/workspace` fs namespace, no host env).
- **flue (withastro/flue)** passes tools explicitly (`createAgent(() => ({ tools: [...] }))`); a subagent profile gets **only** `profile.tools ?? []` — parent tools never flow (non-overridable harness rule).

Dawn is the outlier (max-privilege-by-default subagents). Neither competitor has a declarative allow/deny for authored tools — so a declarative scope is a Dawn differentiator, and the natural lever for an *auto-wiring* framework (you can't "pass fewer tools" when tools are ambient).

## Decisions (from brainstorming)

1. **Scope is declared on the route's own agent descriptor** (self-scoping): `agent({ tools: { allow?, deny? } })`. Subagents scope themselves in their own `index.ts`. Uniform across top routes and subagents.
2. **Model:** `tools: { allow?: readonly string[]; deny?: readonly string[] }`. `deny` **revokes** named tools; `allow` **grants** named capability tools the subagent default withholds; **deny wins** over allow.
3. **Referencing:** exact tool names only (Set membership). Build-time validation rejects names that don't match any tool available to the route.
4. **Default posture (the core change):**
   - **Top route** — unchanged: auto-wires all capability tools + its route-local `tools/*.ts`. `tools.deny` subtracts; `tools.allow` is rarely needed (everything is already granted) and warns if used.
   - **Subagent** — least-privilege by default: gets **only its own route-local `subagents/<name>/tools/*.ts`**. Ambient capability tools (`writeFile`, `runBash`, `listDir`, `readFile`, `task`, `write_todos`, `remember`/`recall`, …) are **withheld** unless named in `tools.allow`.
5. **Enforcement:** compose-time filtering — the disallowed tool is never materialized into the agent/graph, so the model is never offered it. No runtime gate.
6. **Honest scope:** this scopes the tool *surface* (what the model may name). It is **not** an execution sandbox — an allowed tool's actions (fs, network, exec) remain unbounded until Dawn ships a sandbox layer (the Phase-3 gap eve/flue both have). The spec and docs say this plainly; we do not market it as a security boundary.

## Design

### 1. Descriptor type (`@dawn-ai/sdk`, `packages/sdk/src/agent.ts`)

```ts
export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export interface DawnAgent {
  // …existing fields (model, systemPrompt, subagents, retry, …)…
  readonly tools?: ToolScope
}
```

`agent()` passes `tools` through unchanged; `isDawnAgent` is unaffected.

### 2. Tool origin

At composition we already hold two lists: route-local tools from discovery (`DiscoveredToolDefinition`, which carries `scope: "route-local" | "shared"`) and capability tools collected into `capTools` after `applyCapabilities` (`execute-route.ts` ~518). Tag each tool with an **origin**:
- `authored` — from the route's `tools/*.ts` (discovery; `scope` route-local or shared).
- `capability` — contributed by a capability marker (workspace, subagents/`task`, planning, memory, …).

Origin drives the subagent default (authored kept, capability withheld). We add the tag at the merge point rather than mutating the shared `DiscoveredToolDefinition` shape (a parallel `Map<name, origin>` or a thin wrapper is sufficient — the plan picks the least-invasive form).

### 3. The pure policy function (`@dawn-ai/core`, new `tool-scope.ts`)

```ts
export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export interface ScopeInput {
  readonly name: string
  readonly origin: "authored" | "capability"
}

/**
 * Filter an assembled tool set by a route's scope.
 *
 * Base set:
 *   - top route  → all tools (authored + capability)
 *   - subagent   → authored tools only; capability tools withheld
 * Then: allow GRANTS named (capability) tools into the set; deny REVOKES named
 * tools; deny wins. Unknown names (not in the full available set) throw so
 * authoring typos fail loud at build time.
 *
 * Returns the names to keep (the caller maps back to tool objects).
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

Pure, no LangChain, no IO — directly unit-testable. The caller filters the real tool objects by the returned name set.

### 4. Wiring (`packages/cli/src/lib/runtime/execute-route.ts`)

- After `applyCapabilities` and the existing name-uniqueness merge, build the `ScopeInput[]` (authored vs capability), call `resolveToolScope(..., { isSubagent, routeId })`, and keep only the surviving tools before they are materialized into the agent/graph.
- **`isSubagent`** is threaded through the route-prep path used by `buildSubagentResolver` (~583): a route prepared as a subagent-dispatch target gets `isSubagent: true`; a top-route prep gets `false`. (The same route file prepared as a top route vs as a subagent therefore differs — by design.)
- The filter sits *after* capability + user-override merge, so `overridable` user-tool overrides compose predictably with scoping.

### 5. Build-time validation (`dawn check` / typegen)

Extend the existing descriptor-validation pass (the model-id descriptor check is the template) to run the same name-check per route: assert every `allow`/`deny` name matches a tool available to that route, applying the subagent base rule so it validates against the real per-route surface. Report cleanly:

```
✗ /research/subagents/researcher: tool scope references unknown tool "reedDoc"
    available: readDoc, readFile, runBash, search, task, writeFile
```

Also surface, as a non-fatal **info during `dawn check`**, any subagent that newly loses capability tools under the default (migration aid — see below).

## Authoring examples

```ts
// src/app/research/index.ts — top route: everything except shell
export default agent({ model: "gpt-5", subagents: [researcher], tools: { deny: ["runBash"] } })
```

```ts
// src/app/research/subagents/researcher/index.ts — read-only worker
// default already withholds writeFile/runBash/task; it keeps its own tools/*.ts and we grant readFile
export default agent({ model: "gpt-5-mini", tools: { allow: ["readFile"] } })
```

## Error handling / edge cases

- **Unknown tool name** → build-time error (above); at runtime the same throw guards if validation is skipped.
- **`allow` on a top route** → no-op (base already includes everything); emit a build-time warning ("use `deny` to restrict a top route").
- **Empty result** (e.g. a subagent with no route-local tools and no `allow`) → a valid no-tools agent; the model simply has no tools.
- **Deny a tool a capability prompt references** (e.g. planning active but `deny: ["write_todos"]`) → allowed; debug-gated warning; a future lint may flag it.
- **`task` is a capability tool** → withheld from subagents by default (no recursive spawning unless `allow: ["task"]`). Intended safety property.

## Testing

- **Unit (`tool-scope.test.ts`):** top-route base = all; subagent base = authored-only; `allow` grants a capability into a subagent; `deny` revokes; deny-wins; unknown-name throws; empty-allow / empty-result.
- **Build validation:** a route with a typo'd scope name fails `dawn check`.
- **aimock e2e (deterministic, the established pattern) — the headline test:** a `/research` app where the `researcher` subagent has `tools: { allow: ["readFile"] }` — assert the tools offered to the researcher are exactly `{ its route-local tools, readFile }` and that `writeFile`/`runBash`/`task` are **absent**; assert the top route still has the full set minus any `deny`. Reuses the `getRequests()`/journal surface to read offered tools.

## Migration (breaking change)

Subagents that silently relied on inheriting `writeFile`/`runBash`/`task` will lose them and must add `tools: { allow: [...] }`. Dawn is pre-1.0 (AGENTS.md: prefer breaking changes), so this is acceptable. Mitigations: a changeset flagging the behavior change, a docs section, the example scaffold's subagent showing an explicit `allow`, and the `dawn check` info line listing subagents whose capability surface shrank.

## Out of scope (later slices / other features)

- Rate / usage limits, per-tool concurrency.
- Per-tool approval gating (generalizing the HITL bash gate).
- Argument-level constraints.
- Pattern/glob or category tokens in allow/deny (exact names only for v1).
- MCP/connection tool filtering.
- **Execution sandboxing** (network/fs/exec isolation) — the complementary least-privilege layer eve/flue have; a separate, larger effort.

## Risks

- **Per-materialization `isSubagent` plumbing** must be correct so a route behaves as a top route when invoked directly and as a subagent when dispatched. Covered by the e2e and by validating the `buildSubagentResolver` path.
- **Migration surprise** for existing apps with subagents — mitigated by the `dawn check` info line + changeset + docs.
- **Over-claiming** — must be framed as tool-surface scoping, not a security sandbox.
