# Subagent Delegation Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add type-safe, parent-owned subagent delegation policies with resumable approval, fail-closed constraints, and native LangGraph subgraph execution.

**Architecture:** The SDK exposes a keyed registry and discriminated delegation rules. Core resolves one canonical registry and evaluates policy at a guarded dispatch boundary; CLI supplies lazily prepared child graphs; LangChain invokes them as per-invocation subgraphs with the live parent `RunnableConfig`, allowing LangGraph to own checkpoint namespaces and interrupt replay. The ordinary HTTP endpoint, AG-UI adapter, testing harness, and web examples all use one ID-addressed multi-interrupt resume contract.

**Tech Stack:** TypeScript 5, pnpm workspaces, Turbo, Vitest, Biome, Zod, LangChain/LangGraph 1.x, AG-UI core.

---

## Implementation Map

- `packages/sdk/src/agent.ts`: author-facing keyed subagent and delegation types.
- `packages/sdk/src/errors.ts`: stable delegation validation, denial, and dispatch error codes.
- `packages/permissions/src/types.ts`: discriminated permission request union including `subagent`.
- `packages/permissions/src/pattern-matching.ts`: exact edge matching for the reserved `subagent` key.
- `packages/core/src/subagents/registry.ts`: canonical convention/explicit registry resolution and validation.
- `packages/core/src/subagents/policy.ts`: generic fail-closed policy evaluator and approval gate.
- `packages/core/src/capabilities/built-in/subagents.ts`: prompt and `task` schema generated only from the canonical registry.
- `packages/cli/src/lib/runtime/descriptor-route-index.ts`: deterministic descriptor identity multimap.
- `packages/cli/src/lib/runtime/collect-delegation-errors.ts`: `dawn check` diagnostics.
- `packages/cli/src/lib/runtime/execute-route.ts`: route-preparation validation, guarded lazy child materialization, sandbox/depth propagation.
- `packages/langchain/src/subagent-tool-bridge.ts`: dedicated full-`RunnableConfig` task tool and native child invocation.
- `packages/langchain/src/agent-adapter.ts`: per-invocation child graph support and namespaced event projection.
- `packages/langchain/src/tool-converter.ts`: capability transformer events emitted from the actual tool invocation.
- `packages/cli/src/lib/dev/pending-interrupts.ts`: transport-neutral exact-set resume resolver.
- `packages/cli/src/lib/dev/runtime-server.ts`: breaking multi-entry ordinary resume endpoint.
- `packages/ag-ui`, `packages/testing`, and example web clients: contract forwarding, test ergonomics, and presentation.

Do not add a server or runtime ownership to `@dawn-ai/ag-ui`. Do not retain the array API, scalar resume body, or any `tools.*.task` compatibility path.

### Task 1: Publish The Keyed SDK Contract And Error Codes

**Files:**
- Modify: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/errors.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/test/agent-config.test.ts`
- Modify: `packages/sdk/test/errors.test.ts`

- [ ] **Step 1: Replace the old array tests with failing keyed-registry type tests**

Add runtime assertions plus `@ts-expect-error` checks covering exact key inference, absent-registry named rules, arrays, malformed multi-action rules, and typed predicate context:

```ts
const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
const coordinator = agent({
  model: "gpt-5-mini",
  systemPrompt: "Coordinate.",
  subagents: { researcher },
  delegation: {
    default: "deny",
    rules: {
      researcher: {
        action: "constrain",
        predicate: async (request, context) => {
          expectTypeOf(request.input).toEqualTypeOf<string>()
          expectTypeOf(context.subagentName).toEqualTypeOf<string>()
          return context.signal.aborted ? "cancelled" : true
        },
      },
    },
  },
})

expect(coordinator.subagents?.researcher).toBe(researcher)

agent({
  model: "gpt-5-mini",
  systemPrompt: "Invalid.",
  subagents: { researcher },
  delegation: {
    rules: {
      // @ts-expect-error writer is not a registered key
      writer: { action: "allow" },
    },
  },
})

agent({
  model: "gpt-5-mini",
  systemPrompt: "Invalid.",
  delegation: {
    rules: {
      // @ts-expect-error named rules require an explicit keyed registry
      researcher: { action: "allow" },
    },
  },
})

agent({
  model: "gpt-5-mini",
  systemPrompt: "Invalid.",
  // @ts-expect-error arrays are not supported
  subagents: [researcher],
})
```

Add assertions for `DAWN_E1004`, `DAWN_E3002`, and `DAWN_E5003` titles and docs links.

- [ ] **Step 2: Run the SDK tests and confirm the type/runtime failures**

Run: `pnpm --filter @dawn-ai/sdk test -- agent-config.test.ts errors.test.ts && pnpm --filter @dawn-ai/sdk typecheck`

Expected: FAIL because keyed registries, delegation types, and error codes do not exist.

- [ ] **Step 3: Implement the narrow public types without compatibility overloads**

Use these definitions in `agent.ts` and thread the generic through both `AgentConfig` and `DawnAgent`:

```ts
export type SubagentMap = Readonly<Record<string, DawnAgent>>

export interface DelegationRequest {
  readonly input: string
}

export interface DelegationContext {
  readonly parentRouteId: string
  readonly subagentName: string
  readonly subagentRouteId: string
  readonly threadId?: string
  readonly params?: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

export type DelegationVerdict =
  | true
  | string
  | { readonly approve: true; readonly reason?: string }

export type DelegationConstraintPredicate = (
  request: DelegationRequest,
  context: DelegationContext,
) => DelegationVerdict | Promise<DelegationVerdict>

export type DelegationRule =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "approve"; readonly reason?: string }
  | { readonly action: "constrain"; readonly predicate: DelegationConstraintPredicate }

export type DelegationRules<Name extends string> = [Name] extends [never]
  ? Readonly<Record<string, never>>
  : Partial<Record<Name, DelegationRule>>

export interface DelegationConfig<Name extends string> {
  readonly default?: "allow" | "deny" | "approve"
  readonly rules?: DelegationRules<Name>
}

export interface DawnAgent<Subagents extends SubagentMap = SubagentMap> {
  // Preserve existing fields and brand.
  readonly subagents?: Subagents
  readonly delegation?: DelegationConfig<Extract<keyof Subagents, string>>
}

export interface AgentConfig<Subagents extends SubagentMap = {}> {
  // Preserve existing fields.
  readonly subagents?: Subagents
  readonly delegation?: DelegationConfig<NoInfer<Extract<keyof Subagents, string>>>
}

export function agent<const Subagents extends SubagentMap = {}>(
  config: AgentConfig<Subagents>,
): DawnAgent<Subagents> {
  return {
    // Preserve existing conditional fields.
    ...(config.subagents !== undefined ? { subagents: config.subagents } : {}),
    ...(config.delegation !== undefined ? { delegation: config.delegation } : {}),
  } as unknown as DawnAgent<Subagents>
}
```

Keep `isDawnAgent(value): value is DawnAgent` broad. Export all new public types from `packages/sdk/src/index.ts`. Add the three registry entries to `DAWN_ERRORS` with paths `/docs/subagents#delegation-policy` for E1004/E3002 and `/docs/subagents#dispatch-failures` for E5003.

- [ ] **Step 4: Run SDK verification**

Run: `pnpm --filter @dawn-ai/sdk build && pnpm --filter @dawn-ai/sdk typecheck && pnpm --filter @dawn-ai/sdk lint && pnpm --filter @dawn-ai/sdk test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): add subagent delegation policy types"
```

### Task 2: Add First-Class Subagent Permission Identity

**Files:**
- Modify: `packages/permissions/src/types.ts`
- Modify: `packages/permissions/src/pattern-matching.ts`
- Modify: `packages/permissions/src/index.ts`
- Modify: `packages/permissions/test/pattern-matching.test.ts`
- Modify: `packages/permissions/test/permissions-store.test.ts`

- [ ] **Step 1: Write failing permission contract tests**

Add tests proving exact tuple matching, parent scoping, deny-wins, and persisted reload:

```ts
const supportResearcher = JSON.stringify(["/support", "researcher"])
const financeResearcher = JSON.stringify(["/finance", "researcher"])

expect(
  matchPermission("subagent", supportResearcher, { subagent: [supportResearcher] }, {}),
).toBe("allow")
expect(
  matchPermission("subagent", financeResearcher, { subagent: [supportResearcher] }, {}),
).toBe("unknown")
expect(
  matchPermission(
    "subagent",
    supportResearcher,
    { subagent: [supportResearcher] },
    { subagent: [supportResearcher] },
  ),
).toBe("deny")
```

Type-check a `PermissionRequest` with `kind: "subagent"` and all required detail fields.

- [ ] **Step 2: Run focused permissions tests and confirm failure**

Run: `pnpm --filter @dawn-ai/permissions test -- pattern-matching.test.ts permissions-store.test.ts && pnpm --filter @dawn-ai/permissions typecheck`

Expected: FAIL because `subagent` is not a discriminated request kind and prefix matching is used.

- [ ] **Step 3: Add the detail type and exact matcher**

Use a genuinely discriminated public union rather than the current cross-product interface:

```ts
export interface SubagentDetail {
  readonly parentRouteId: string
  readonly subagentName: string
  readonly subagentRouteId: string
  readonly inputPreview: string
  readonly reason?: string
  readonly suggestedPattern: string
}

interface PermissionRequestBase {
  readonly interruptId: string
  readonly threadId: string
  readonly callId?: string
}

export type PermissionRequest = PermissionRequestBase &
  (
    | { readonly kind: "command"; readonly detail: CommandDetail }
    | { readonly kind: "path"; readonly detail: PathDetail }
    | { readonly kind: "tool"; readonly detail: ToolDetail }
    | { readonly kind: "memory"; readonly detail: MemoryDetail }
    | { readonly kind: "subagent"; readonly detail: SubagentDetail }
  )

export function subagentPermissionPattern(parentRouteId: string, subagentName: string): string {
  return JSON.stringify([parentRouteId, subagentName])
}
```

In `matchPermission`, use exact equality when `tool === "tool" || tool === "subagent"`. Export `SubagentDetail` and `subagentPermissionPattern`.

- [ ] **Step 4: Run package verification**

Run: `pnpm --filter @dawn-ai/permissions build && pnpm --filter @dawn-ai/permissions typecheck && pnpm --filter @dawn-ai/permissions lint && pnpm --filter @dawn-ai/permissions test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/permissions
git commit -m "feat(permissions): add subagent approval identity"
```

### Task 3: Build The Canonical Subagent Registry

**Files:**
- Create: `packages/core/src/subagents/registry.ts`
- Create: `packages/core/src/subagents/types.ts`
- Modify: `packages/core/src/capabilities/types.ts`
- Modify: `packages/core/src/capabilities/built-in/subagents.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/subagents/registry.test.ts`
- Modify: `packages/core/test/capabilities/subagents.test.ts`
- Modify: `packages/core/test/capabilities/registry.test.ts`

- [ ] **Step 1: Write failing canonical-registry tests**

Cover convention discovery, omitted/default policy, explicit aliases replacing convention identities, static-deny omission, invalid names, unknown rule names, unresolved and ambiguous descriptors, duplicate explicit route values, and collisions. Build route fixtures with deterministic descriptor-index entries:

```ts
const index = new Map<DawnAgent, readonly string[]>([
  [researcher, ["/parent/subagents/research"]],
])
const result = await resolveSubagentRegistry({
  descriptor: agent({
    model: "gpt-5-mini",
    systemPrompt: "Parent.",
    subagents: { analyst: researcher },
    delegation: { default: "deny", rules: { analyst: { action: "allow" } } },
  }),
  descriptorRouteIndex: index,
  parentRouteDir: "/app/src/app/parent",
  parentRouteId: "/parent",
  routeManifest: manifest,
  loadDescription: async () => "Research deeply.",
})

expect(result).toEqual([
  {
    description: "Research deeply.",
    name: "analyst",
    routeId: "/parent/subagents/research",
    source: "explicit",
    rule: { action: "allow" },
  },
])
```

Assert validation errors contain `[DAWN_E1004]`, parent route, candidate route ids for ambiguity, and available explicit names for unknown rules.

Replace the marker's array/discovery tests in the same red step. Assert that a
canonical registry containing allow, approve, constrain, and deny entries
produces a sorted task enum/prompt without the denied entry; an all-deny
registry contributes no task or prompt. Assert `applyCapabilities` passes the
same registry object through without recomputing descriptor identity.

- [ ] **Step 2: Run the new core test and confirm failure**

Run: `pnpm --filter @dawn-ai/core test -- subagents/registry.test.ts capabilities/subagents.test.ts capabilities/registry.test.ts`

Expected: FAIL because the resolver modules and canonical marker input do not exist.

- [ ] **Step 3: Implement one resolver with one returned shape**

Define:

```ts
export type DescriptorRouteIndex = ReadonlyMap<DawnAgent, readonly string[]>

export type ResolvedDelegationRule =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "approve"; readonly reason?: string }
  | { readonly action: "constrain"; readonly predicate: DelegationConstraintPredicate }

export interface ResolvedSubagent {
  readonly name: string
  readonly routeId: string
  readonly source: "convention" | "explicit"
  readonly description: string
  readonly rule: ResolvedDelegationRule
}
```

Implement `resolveSubagentRegistry(args): Promise<readonly ResolvedSubagent[]>` in this exact order:

1. Validate untyped `delegation.default`, `rules`, action, reason, predicate, registry object shape, and every explicit/convention name against `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
2. Discover immediate convention routes only.
3. Resolve every explicit descriptor through the multimap; zero or more than one route is E1004.
4. Reject a route used by two explicit keys.
5. Remove a convention entry when an explicit entry targets that same route.
6. Reject remaining name collisions.
7. Apply named rules only to explicit keys and default (`allow` when omitted) to convention entries.
8. Keep denied entries in the canonical result for runtime validation, but expose `dispatchableSubagents(registry)` that filters static `deny` for prompt/schema generation.
9. Sort by `name` for deterministic prompts and diagnostics.

Use one `invalidDelegationPolicy(message)` helper that prefixes `[DAWN_E1004]`. Do not warn and continue on security-relevant errors.

In the same implementation step, migrate the built-in marker away from the
removed array API so core remains buildable after Task 1. Extend capability
context/contribution with:

```ts
export interface CapabilityMarkerContext {
  readonly subagentRegistry?: readonly ResolvedSubagent[]
  // Remove descriptorRouteMap.
}

export interface CapabilityContribution {
  readonly subagentRegistry?: readonly ResolvedSubagent[]
  // Preserve existing fields.
}
```

The marker detects from `context.subagentRegistry?.length`, filters with
`dispatchableSubagents`, creates the task placeholder/Zod enum only when the
filtered list is non-empty, and returns the same canonical registry. Remove
route-module importing and descriptor resolution from the marker entirely.

- [ ] **Step 4: Run core verification**

Run: `pnpm --filter @dawn-ai/core test -- subagents/registry.test.ts capabilities/subagents.test.ts capabilities/registry.test.ts && pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/core lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): resolve canonical subagent registries"
```

### Task 4: Enforce Delegation At A Generic Guarded Boundary

**Files:**
- Create: `packages/core/src/subagents/policy.ts`
- Modify: `packages/core/src/capabilities/permission-gate.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/subagents/policy.test.ts`
- Modify: `packages/core/test/capabilities/permission-gate.test.ts`

- [ ] **Step 1: Write failing policy tests**

Test allow, static deny, approval once/always/deny, exact persistence, bypass behavior, default approval without a thread id, string denial, constraint approval with reason, malformed verdict, throw, debug logging, abort, unknown name, and resolve-after-gate ordering. The child factory spy must remain untouched on denied calls.

```ts
const result = await resolveGuardedSubagent({
  callId: "task-1",
  input: "write a draft",
  name: "writer",
  registry,
  runtime: {
    parentRouteId: "/parent",
    params: { tenant: "acme" },
    signal: AbortSignal.timeout(1000),
    threadId: "thread-1",
  },
  permissions,
  interruptCapable: true,
  resolve: vi.fn(async (entry) => ({ entry, graph: childGraph })),
})
```

Expected denied result shape:

```ts
{ ok: false, code: "DAWN_E3002", message: "[DAWN_E3002] Drafts are disabled." }
```

Expected stale identity shape:

```ts
{ ok: false, code: "DAWN_E5003", message: "[DAWN_E5003] No subagent named 'writer' is available." }
```

- [ ] **Step 2: Run the new tests and confirm failure**

Run: `pnpm --filter @dawn-ai/core test -- subagents/policy.test.ts capabilities/permission-gate.test.ts`

Expected: FAIL because no subagent gate exists.

- [ ] **Step 3: Add reusable approval interrupt plumbing**

Export a narrow `gateSubagentOp` from `permission-gate.ts`. Build the exact candidate with `subagentPermissionPattern`, bound previews to 500 characters, preserve `reason`, and extend the private interrupt discriminant with:

```ts
{
  kind: "subagent"
  parentRouteId: string
  subagentName: string
  subagentRouteId: string
  inputPreview: string
  reason?: string
  callId: string
  permissions: PermissionsStore
}
```

Include `callId` on the emitted permission envelope before calling
`interrupt()`, because delegation approval happens before a child config or
subagent metadata stack exists. Persist `always` with
`permissions.addAllow("subagent", suggestedPattern)`. Require a resumable
`threadId` and `interruptCapable: true` before calling `interrupt()`; otherwise
return E3002 guidance. `permissions.mode === "bypass"` skips approval only,
never static or constraint denial.

- [ ] **Step 4: Implement the generic guarded resolver**

Use a discriminated result so LangChain cannot receive a child handle before policy allows it:

```ts
export type GuardedSubagentResult<T> =
  | { readonly ok: true; readonly entry: ResolvedSubagent; readonly value: T }
  | { readonly ok: false; readonly code: "DAWN_E3002" | "DAWN_E5003"; readonly message: string }

export async function resolveGuardedSubagent<T>(args: {
  readonly callId: string
  readonly name: string
  readonly input: string
  readonly registry: readonly ResolvedSubagent[]
  readonly runtime: Omit<DelegationContext, "subagentName" | "subagentRouteId">
  readonly permissions?: PermissionsStore
  readonly interruptCapable: boolean
  readonly resolve: (entry: ResolvedSubagent) => Promise<T>
}): Promise<GuardedSubagentResult<T>>
```

For `constrain`, pass `{ input }` and a fully populated `DelegationContext`. Only `true`, string, or an object whose own `approve` is exactly `true` is valid. Preserve a valid optional string reason. Return generic E3002 on throws/invalid values; only log the underlying value/error when `DAWN_DEBUG_CONSTRAINTS === "1"`. Check `signal.aborted` before and after awaited predicate/gate work and fail closed.

- [ ] **Step 5: Run core package verification**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): enforce guarded subagent delegation"
```

### Task 5: Migrate CLI Route Preparation To The Canonical Registry

**Files:**
- Create: `packages/cli/src/lib/runtime/descriptor-route-index.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/cli/test/descriptor-route-map-cache.test.ts`
- Create: `packages/cli/test/subagent-registry-runtime.test.ts`

- [ ] **Step 1: Write failing CLI consumer-migration tests**

Assert that:

- descriptor identity stores every candidate route in a stable sorted array;
- route preparation resolves the canonical registry before applying capabilities;
- a keyed explicit alias reaches the existing dispatcher under its explicit name;
- the replaced convention leaf is not left as a dispatch alias;
- invalid policy fails route preparation with E1004;
- convention-only default allow still dispatches through the current bridge.

These tests intentionally retain the current independent child execution for
now; Task 10 replaces that execution mechanism after LangChain supports native
subgraphs.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @dawn-ai/cli test -- descriptor-route-map-cache.test.ts subagent-registry-runtime.test.ts`

Expected: FAIL because CLI still assumes array-form descriptors and a single-value map.

- [ ] **Step 3: Extract a deterministic descriptor multimap**

Move cache/index construction from `execute-route.ts` into
`descriptor-route-index.ts`. Import `DescriptorRouteIndex` from
`@dawn-ai/core` and implement:

```ts
export async function buildDescriptorRouteIndex(
  manifest: RouteManifest,
): Promise<DescriptorRouteIndex> {
  const imported = await Promise.all(
    manifest.routes.map(async (route) => {
      try {
        const mod = (await import(pathToFileURL(route.entryFile).href)) as { default?: unknown }
        return isDawnAgent(mod.default) ? ([mod.default, route.id] as const) : undefined
      } catch {
        return undefined
      }
    }),
  )
  const mutable = new Map<DawnAgent, string[]>()
  for (const entry of imported) {
    if (!entry) continue
    const [descriptor, routeId] = entry
    mutable.set(descriptor, [...(mutable.get(descriptor) ?? []), routeId])
  }
  return new Map([...mutable].map(([descriptor, ids]) => [descriptor, ids.sort()]))
}
```

Retain the WeakMap cache and test reset in the extracted module.

- [ ] **Step 4: Resolve once and adapt the temporary resolver**

Before `applyCapabilities`, call `resolveSubagentRegistry` with the index and
pass `subagentRegistry` into capability context. Reuse that exact result when
building the temporary `SubagentResolver`; iterate resolved entries by `name`
and `routeId` instead of reading `descriptor.subagents`. Keep static-denied
entries unavailable. Route preparation must return the E1004 error rather than
falling back to an empty registry.

Do not add policy gating or change child checkpoint behavior in this task; the
guard is Task 10 after the core policy and native bridge exist.

- [ ] **Step 5: Run CLI package verification**

Run: `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/cli test -- descriptor-route-map-cache.test.ts subagent-registry-runtime.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "refactor(cli): consume canonical subagent registries"
```

### Task 6: Add Deterministic CLI Validation And Reserve `task`

**Files:**
- Create: `packages/cli/src/lib/runtime/collect-delegation-errors.ts`
- Modify: `packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`
- Modify: `packages/cli/src/commands/check.ts`
- Modify: `packages/cli/test/check-tool-scope.test.ts`
- Create: `packages/cli/test/check-delegation.test.ts`
- Modify: `packages/cli/test/check-error-codes.test.ts`

- [ ] **Step 1: Write failing delegation and reserved-task validation tests**

Add table tests for every E1004 case in the spec, including table tests proving all four references below are E1004 errors, not warnings:

```ts
tools: { allow: ["task"] }
tools: { deny: ["task"] }
tools: { approve: ["task"] }
tools: { constrain: { task: async () => true } }
```

Also assert an ordinary authored tool named `task` remains rejected by reserved-name conflict handling.

- [ ] **Step 2: Run CLI tests and confirm failure**

Run: `pnpm --filter @dawn-ai/cli test -- check-delegation.test.ts check-tool-scope.test.ts`

Expected: FAIL because `dawn check` has no delegation validation and `task` policy is only warned about.

- [ ] **Step 3: Implement shared validation collectors**

`collectDelegationErrors` imports agent descriptors, builds the index once,
calls `resolveSubagentRegistry` for each agent route, and records every thrown
E1004 diagnostic. It also inspects the untyped descriptor tool scope and reports
every `task` occurrence in allow/deny/approve/constrain as E1004 with an
actionable message directing authors to `delegation`. `runCheckCommand` emits
that E1004 group independently from ordinary E1001 tool-scope errors.
`collectToolScopeIssues` excludes `task` from unknown/redundancy warnings so
each invalid entry is reported exactly once by delegation validation.

- [ ] **Step 4: Run CLI verification**

Run: `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/cli test -- check-delegation.test.ts check-tool-scope.test.ts check-error-codes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): validate subagent delegation policies"
```

### Task 7: Emit Capability Events At Tool Invocation Time

This is a prerequisite for native child graphs. A child graph no longer owns a separate Dawn stream adapter, so capability transformers must emit trace events while the tool actually runs.

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/test/tool-converter.test.ts`
- Modify: `packages/langchain/test/planning.test.ts`
- Modify: `packages/langchain/test/agent-adapter.test.ts`

- [ ] **Step 1: Write failing custom-event tests**

Mock `dispatchCustomEvent` and prove every transformer output is emitted as `dawn.capability` with `{ event, data }`, including when the tool returns a `Command`. Add stream-adapter tests mapping root custom events to their ordinary type and a child-tagged custom event to `subagent.<type>`.

- [ ] **Step 2: Run focused LangChain tests and confirm failure**

Run: `pnpm --filter @dawn-ai/langchain test -- tool-converter.test.ts planning.test.ts agent-adapter.test.ts`

Expected: FAIL because transformers currently run only on the outer `on_tool_end` branch.

- [ ] **Step 3: Move transformation into `convertToolToLangChain`**

Add `streamTransformers?: readonly StreamTransformer[]` to conversion options. After `tool.run` returns and before returning the final string/`Command`, iterate matching transformers and call:

```ts
await dispatchCustomEvent(
  "dawn.capability",
  { event: output.event, data: output.data },
  config,
)
```

Pass transformers through every materialization/conversion call. In `streamFromRunnable`, handle `on_custom_event` named `dawn.capability`, validate the payload, and project it according to subagent metadata. Remove the old `on_tool_end` transformer loop to prevent duplicate events.

- [ ] **Step 4: Run LangChain verification**

Run: `pnpm --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain test -- tool-converter.test.ts planning.test.ts agent-adapter.test.ts`

Expected: PASS with planning events emitted once.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain
git commit -m "refactor(langchain): emit capability events from tools"
```

### Task 8: Replace The Custom Dispatcher With Native Subgraph Invocation

**Files:**
- Modify: `packages/langchain/src/subagent-tool-bridge.ts`
- Delete: `packages/langchain/src/subagent-dispatcher.ts`
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/src/index.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/cli/test/subagent-registry-runtime.test.ts`
- Replace: `packages/langchain/test/subagent-dispatcher.test.ts`
- Create: `packages/langchain/test/subagent-tool-bridge.test.ts`
- Modify: `packages/langchain/test/agent-adapter-interrupt.test.ts`

- [ ] **Step 1: Write failing native-subgraph tests using real LangGraph primitives**

Use `StateGraph`, `MemorySaver`, `interrupt`, and `Command` to prove:

- a child graph compiled with no checkpointer inherits the parent checkpointer;
- the bridge passes the exact live `RunnableConfig` plus Dawn metadata;
- a child `GraphInterrupt` propagates and resumes from the root thread;
- two parallel child calls receive distinct checkpoint namespaces and interrupt ids;
- depth > 3 returns a coded E5003 tool result without invoking the child;
- ordinary child errors still become `subagent_failed` and emit `subagent.end`.

Do not mock LangGraph checkpoint behavior in these tests.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @dawn-ai/langchain test -- subagent-tool-bridge.test.ts agent-adapter-interrupt.test.ts`

Expected: FAIL because the current bridge strips live config and catches child interrupts.

- [ ] **Step 3: Define the guarded resolver contract and dedicated task converter**

Replace synchronous `SubagentResolver` with:

```ts
export interface ResolvedSubagentGraph {
  readonly routeId: string
  readonly graph: {
    invoke(input: unknown, config: RunnableConfig): Promise<unknown>
  }
}

export type SubagentResolver = (request: {
  readonly callId: string
  readonly name: string
  readonly input: string
  readonly config: RunnableConfig
}) => Promise<
  | { readonly ok: true; readonly child: ResolvedSubagentGraph }
  | { readonly ok: false; readonly message: string }
>
```

Create `convertSubagentTaskToLangChain(tool, resolver)` in
`subagent-tool-bridge.ts` using `DynamicStructuredTool` and the placeholder
tool's schema. Its `func(input, _manager, config)` must generate/read the task
tool call id first, pass that exact `callId` to the guarded resolver, and invoke
the allowed child with:

```ts
const childConfig = {
  ...config,
  metadata: {
    ...(config.metadata ?? {}),
    dawn: {
      ...parentDawn,
      subagent_depth: nextDepth,
      subagent_stack: [
        ...parentStack,
        { callId, name, routeId: child.routeId },
      ],
    },
  },
}
```

Call `dispatchCustomEvent("dawn.subagent", { phase: "start", ... }, childConfig)` before invocation and an `end` event after success/failure. Catch only ordinary errors. If `isGraphInterrupt(error)`, rethrow it unchanged. Extract the final AI text from child state as the task result.

- [ ] **Step 4: Remove queue/counter dispatch machinery**

Delete `subagent-dispatcher.ts`, `SubagentStreamContext`, `activeChildRuns`, `dawnStream`, and queue draining. `materializeAgent` accepts `checkpointer?: BaseCheckpointSaver`; root calls pass the existing checkpointer, child materialization passes `undefined`. Replace the placeholder task with the dedicated converter during materialization, not by replacing a public Dawn `run` callback.

Update the temporary CLI resolver from Task 5 to the new async request/result
signature in this same step so the workspace remains type-compatible. It may
still wrap `executeResolvedRoute` until Task 10, but it must accept the live
config argument and return `{ ok: true, child }`/`{ ok: false, message }`.
Extend `subagent-registry-runtime.test.ts` to assert this adapter shape. This is
an internal migration bridge only; it does not retain an author-facing API.

- [ ] **Step 5: Run LangChain package verification**

Run: `pnpm --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli test -- subagent-registry-runtime.test.ts`

Expected: PASS; no exports or references to the deleted custom dispatcher remain.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain packages/cli/src/lib/runtime/execute-route.ts packages/cli/test/subagent-registry-runtime.test.ts
git commit -m "refactor(langchain): invoke subagents as native subgraphs"
```

### Task 9: Project Namespaced Child Events Without Duplication

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/test/agent-adapter.test.ts`
- Modify: `packages/langchain/test/subagent-tool-bridge.test.ts`
- Modify: `packages/testing/test/run-result.test.ts`

- [ ] **Step 1: Write failing event-projection tests**

Build a parent/child stream with a tagged `metadata.dawn.subagent_stack` and assert exact projection:

| LangChain event | Dawn event |
|---|---|
| child chat token | `subagent.message` |
| child tool start/end | `subagent.tool_call` / `subagent.tool_result` |
| child `dawn.capability` custom event | `subagent.<capability>` |
| `dawn.subagent` start/end | `subagent.start` / `subagent.end` |

Every child event includes the top stack entry's `call_id`; tool events retain upstream `run_id`. Assert child tokens never also emit root `token`, and parent task start/end remain ordinary `tool_call`/`tool_result` correlation events.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @dawn-ai/langchain test -- agent-adapter.test.ts subagent-tool-bridge.test.ts && pnpm --filter @dawn-ai/testing test -- run-result.test.ts`

Expected: FAIL because stream classification does not inspect namespaced metadata.

- [ ] **Step 3: Add one event classifier**

Widen the local event type to include `metadata?: Record<string, unknown>` and `parent_ids?: string[]`. Parse only well-formed Dawn stack entries. When a stack is present:

- map chat/tool/custom events to the `subagent.*` forms;
- attach `call_id`, subagent name, route id, and depth where relevant;
- do not emit raw token/tool events for that child event;
- ignore nested graph bookkeeping events;
- surface interrupts as top-level `interrupt` chunks without replacing the
  native interrupt id. Delegation approval already contains the resolver's
  exact `callId`; for tool/path/command/memory interrupts raised after child
  invocation starts, attach the current stack entry's `callId` when absent.

Keep root event behavior unchanged.

- [ ] **Step 4: Run package tests**

Run: `pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/testing test -- run-result.test.ts && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint`

Expected: PASS with no duplicate child tokens or capability events.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain packages/testing/test/run-result.test.ts
git commit -m "feat(langchain): project native subagent stream events"
```

### Task 10: Integrate Canonical Policy With Lazy CLI Child Graphs

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/cli/src/runtime-exports.ts`
- Modify: `packages/cli/src/lib/build/targets/langsmith.ts`
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/cli/test/build-command.test.ts`
- Modify: `packages/cli/test/build-targets.test.ts`
- Create: `packages/cli/test/subagent-delegation.test.ts`
- Create: `packages/cli/test/subagent-runtime.test.ts`
- Create: `packages/cli/test/subagent-sandbox.test.ts`
- Create: `packages/cli/test/execute-route.test.ts`

- [ ] **Step 1: Write failing CLI integration tests**

Add app fixtures proving:

- convention-only children use default allow without explicit registration;
- explicit aliases replace convention names and the removed leaf cannot dispatch;
- denied calls never resolve/materialize the child and emit no `subagent.start`;
- route preparation rejects the same E1004 cases as `dawn check`;
- nested routes receive `task` automatically without `tools.allow: ["task"]`;
- the child graph is compiled lazily with no checkpointer;
- route params, signal, parent dispatch id, depth, and root sandbox key reach nested preparation;
- an explicit descriptor cycle does not recurse during preparation and stops at depth 3.
- a generated LangSmith entry calls the same policy-aware route graph
  materializer and does not bypass capabilities or subagent resolution.

- [ ] **Step 2: Run CLI subagent tests and confirm failure**

Run: `pnpm --filter @dawn-ai/cli test -- subagent-delegation.test.ts subagent-runtime.test.ts subagent-sandbox.test.ts execute-route.test.ts build-command.test.ts build-targets.test.ts`

Expected: FAIL because route preparation still builds a raw convention resolver and independent child streams.

- [ ] **Step 3: Resolve the registry before capability composition**

Inside agent preparation:

1. Build/get `DescriptorRouteIndex`.
2. Call `resolveSubagentRegistry` once.
3. Pass the result into `applyCapabilities` as `subagentRegistry`.
4. Reuse the contribution/registry for the guarded runtime resolver.
5. Treat E1004 as a route-preparation error, never as an empty registry.

Adjust tool scoping so `task` is automatically retained whenever `dispatchableSubagents(registry)` is non-empty, including nested routes. Reject any descriptor `tools.*.task` before scoping.

- [ ] **Step 4: Build a lazy guarded child graph resolver**

Replace `buildSubagentResolver` with an async resolver that calls `resolveGuardedSubagent` first. Its `resolve(entry)` callback then:

- finds the already-validated route by `entry.routeId`;
- calls a child-preparation helper with `isSubagent: true`, the inherited signal, route params, sandbox manager/root key, and incremented depth metadata;
- materializes a LangChain child graph with checkpointer omitted;
- memoizes only stable route preparation inputs, never per-call `RunnableConfig`, permissions decision, or sandbox-bound tools;
- returns E5003 for unavailable/setup failures while preserving E3002 denial results.

The root continues to pass its checkpointer to `streamAgent`; child graphs inherit it only through live invocation config.

- [ ] **Step 5: Route generated deployment graphs through the same preparation path**

Export `materializeResolvedRouteGraph` from `@dawn-ai/cli/runtime`. Refactor the
shared preparation code so this function can request an omitted root
checkpointer; LangGraph Platform then supplies the root checkpointer at runtime,
while native child invocations inherit it through `RunnableConfig`. The helper
must apply the same tools, state, capabilities, canonical registry, policy,
permissions, and lazy resolver as local execution.

Change `langsmith.ts` to emit entries equivalent to:

```ts
import { fileURLToPath } from "node:url"
import { materializeResolvedRouteGraph } from "@dawn-ai/cli/runtime"

const appRoot = fileURLToPath(new URL("../..", import.meta.url))

export const graph = await materializeResolvedRouteGraph({
  appRoot,
  routeFile: fileURLToPath(new URL("../../src/app/support/index.js", import.meta.url)),
  routeId: "/support",
  routePath: "/support",
})
```

Compute the relative route URL per emitted entry; do not embed the build
machine's absolute path. Non-agent graph/workflow/chain entries keep their
existing direct exports. Update build tests to assert the policy-aware helper,
relative URLs, and absence of a direct agent-only `materializeAgentGraph` call.

- [ ] **Step 6: Run focused and package verification**

Run: `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/cli test -- subagent-delegation.test.ts subagent-runtime.test.ts subagent-sandbox.test.ts execute-route.test.ts build-command.test.ts build-targets.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/langchain
git commit -m "feat(cli): guard lazy subagent graph resolution"
```

### Task 11: Prove Nested And Parallel Interrupt Replay End To End

**Files:**
- Create: `packages/cli/test/subagent-interrupts.test.ts`
- Modify: `packages/langchain/test/agent-adapter-interrupt.test.ts`
- Modify: `packages/cli/test/pending-interrupts.test.ts`

- [ ] **Step 1: Write failing end-to-end checkpoint tests**

Use a real `MemorySaver` and deterministic model/tool fixtures to cover:

1. Parent delegation approval parks, `once` resumes exactly once, and a second call asks again.
2. `always` persists only `JSON.stringify([parentRouteId, subagentName])` and survives store reload.
3. Child-owned delegation policy is evaluated independently from the parent's policy.
4. A tool/path/memory approval inside a child surfaces at the root with child `callId` and resumes through the parent thread.
5. Two parallel child invocations park with distinct interrupt ids and resume keys.
6. A complete ID-addressed resume map resumes both; partial, duplicate, stale, or swapped sets fail.
7. Interrupt control flow emits no `subagent.end` error and does not restart the child invocation.
8. No root `thread_id` fails closed before emitting an unresumable interrupt.

- [ ] **Step 2: Run integration tests and confirm failure**

Run: `pnpm --filter @dawn-ai/cli test -- subagent-interrupts.test.ts pending-interrupts.test.ts && pnpm --filter @dawn-ai/langchain test -- agent-adapter-interrupt.test.ts`

Expected: FAIL until native replay and call-id projection are fully connected.

- [ ] **Step 3: Fix only the replay gaps exposed by the tests**

Keep LangGraph's outer interrupt resume keys untouched. Do not derive child thread ids, write a replay journal, address child checkpoints directly, or convert `GraphInterrupt` into a Dawn capability event. If a gap requires one of those, stop and reassess the native-subgraph integration instead.

- [ ] **Step 4: Run integration and package tests**

Run: `pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/cli test -- subagent-interrupts.test.ts pending-interrupts.test.ts subagent-delegation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/langchain
git commit -m "test: cover resumable nested subagent interrupts"
```

### Task 12: Make Multi-Entry Resume The Only HTTP And Harness Contract

**Files:**
- Modify: `packages/cli/src/lib/dev/pending-interrupts.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/src/runtime-exports.ts`
- Modify: `packages/cli/test/pending-interrupts.test.ts`
- Modify: `packages/cli/test/agui-endpoint.test.ts`
- Modify: `packages/cli/test/resume-endpoint.test.ts`
- Modify: `packages/testing/src/harness.ts`
- Modify: `packages/testing/test/harness-construct.test.ts`
- Modify: `packages/testing/test/harness-fixtures.test.ts`
- Modify: `packages/testing/test/tool-approval.e2e.test.ts`
- Modify: `packages/testing/test/tool-approval-live.smoke.test.ts`
- Modify: `packages/testing/test/tool-constrain.e2e.test.ts`
- Modify: `packages/testing/test/memory-ask.e2e.test.ts`
- Modify: `examples/chat/server/test/capabilities.e2e.test.ts`
- Modify: `examples/research/server/test/research.test.ts`
- Modify: `test/runtime/run-agent-protocol.test.ts`

- [ ] **Step 1: Replace scalar endpoint/harness tests with failing exact-set tests**

The accepted body is only:

```json
{
  "resume": [
    { "interruptId": "perm-1", "status": "resolved", "payload": "once" },
    { "interruptId": "perm-2", "status": "cancelled" }
  ],
  "route": "/support#agent"
}
```

Assert malformed entries are 400; stale, duplicate, partial, extra, and missing required sets are 409; cancelled maps to deny. Assert `{ "interrupt_id": "perm-1", "decision": "once" }` is rejected with no compatibility parsing. Update the harness contract to:

```ts
harness.resume({
  resume: [
    { interruptId: run.interrupts[0]!.interruptId, status: "resolved", payload: "once" },
  ],
  fixtures,
})
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @dawn-ai/cli test -- pending-interrupts.test.ts resume-endpoint.test.ts agui-endpoint.test.ts && pnpm --filter @dawn-ai/testing test -- harness-construct.test.ts harness-fixtures.test.ts`

Expected: FAIL because the ordinary endpoint and harness still accept scalar decisions.

- [ ] **Step 3: Generalize and share the resolver**

Rename `resolveAgUiResume` to `resolvePendingResume` and define/export a
transport-neutral `DawnResumeEntry` type from the CLI module; do not make
ordinary runtime semantics depend on AG-UI naming. Re-export
`readPendingInterrupts`, `resolvePendingResume`, and the input/result types from
`packages/cli/src/runtime-exports.ts` so `@dawn-ai/testing` can consume the same
logic through `@dawn-ai/cli/runtime`. Keep `DawnResumeRequest` structurally
identical in `@dawn-ai/ag-ui`.

`runtime-server.ts` validates `body.resume`, reads pending interrupts once, calls `resolvePendingResume`, and passes the returned map as `resume` to `streamResolvedRoute`. The AG-UI handler calls the same function. Delete scalar parsing and alias-only one-interrupt matching.

- [ ] **Step 4: Update the harness**

Replace `decision`/`resumeDecision` with `resume: readonly DawnResumeRequest[]`; have the in-process harness read the route checkpointer snapshot and resolve public ids to native keys through the same resolver before calling `streamResolvedRoute`.

Migrate every TypeScript caller in this task, with no compatibility overload:

```ts
const resumed = await harness.resume({
  resume: run.interrupts.map((entry) => ({
    interruptId: entry.interruptId,
    status: "resolved" as const,
    payload: "once",
  })),
  fixtures,
})
```

Use the desired payload (`once`, `always`, or `deny`) at each existing call
site. Update root runtime protocol tests to POST the same multi-entry envelope.

- [ ] **Step 5: Run package verification**

Run: `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/cli test -- pending-interrupts.test.ts resume-endpoint.test.ts agui-endpoint.test.ts && pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint && pnpm --filter @dawn-ai/testing test && pnpm --filter @dawn-example/chat-server typecheck && pnpm --filter @dawn-example/research-server typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli packages/testing examples/chat/server/test examples/research/server/test test/runtime
git commit -m "feat(cli): require multi-entry interrupt resume"
```

### Task 13: Forward And Present Subagent Approval Across Adapters

**Files:**
- Modify: `packages/ag-ui/test/interrupts.test.ts`
- Modify: `packages/ag-ui/test/inbound.test.ts`
- Modify: `packages/testing/src/run-result.ts`
- Modify: `packages/testing/test/run-result.test.ts`
- Modify: `examples/chat/web/app/components/PermissionInterrupt.tsx`
- Modify: `examples/research/web/app/components/PermissionInterrupt.tsx`

- [ ] **Step 1: Write failing adapter and harness tests**

Use this canonical envelope:

```ts
const envelope = {
  interruptId: "perm-1",
  type: "permission-request",
  kind: "subagent",
  callId: "task-1",
  detail: {
    parentRouteId: "/support",
    subagentName: "writer",
    subagentRouteId: "/support/subagents/writer",
    inputPreview: "Draft the response",
    reason: "Drafts require review.",
    suggestedPattern: JSON.stringify(["/support", "writer"]),
  },
}
```

Assert AG-UI preserves the entire envelope in metadata and forwards all three
decision payloads without policy logic. Assert `collectRunResult` retains typed
subagent detail and call id. The example packages have no component test lane,
so use their existing typecheck in Step 4 plus the Task 15 manual smoke to
verify the UI labels the parent/child, preview, reason, and Once/Always/Deny
actions without displaying the serialized pattern as primary content.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @dawn-ai/ag-ui test -- interrupts.test.ts inbound.test.ts && pnpm --filter @dawn-ai/testing test -- run-result.test.ts`

Expected: adapter round-trip may already pass structurally; the new narrow typing/harness/UI expectations fail. A test that unexpectedly passes is acceptable only when it proves the pure adapter already needs no runtime change.

- [ ] **Step 3: Make only additive transport/presentation changes**

Keep `@dawn-ai/ag-ui` pure. Narrow its envelope metadata typing where useful, but add no server, endpoint, policy evaluator, LangGraph import, or special subagent decision translation. Extend `InterruptInfo` with `callId?` and typed detail. Add a dedicated `kind === "subagent"` branch to both example clients using their existing permission component style and controls.

- [ ] **Step 4: Run adapter/testing/example verification**

Run: `pnpm --filter @dawn-ai/ag-ui build && pnpm --filter @dawn-ai/ag-ui typecheck && pnpm --filter @dawn-ai/ag-ui lint && pnpm --filter @dawn-ai/ag-ui test && pnpm --filter @dawn-ai/testing test && pnpm --filter @dawn-example/chat-web typecheck && pnpm --filter @dawn-example/research-web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui packages/testing examples/chat/web examples/research/web
git commit -m "feat: present subagent approval interrupts"
```

### Task 14: Migrate Docs, Examples, Fixtures, And Release Metadata

**Files:**
- Modify: `apps/web/content/docs/subagents.mdx`
- Modify: `apps/web/content/docs/permissions.mdx`
- Modify: `apps/web/content/docs/tools.mdx`
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/errors.mdx`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: any scaffold/example/test fixture found by the searches below
- Create: `.changeset/subagent-delegation-policies.md`

- [ ] **Step 1: Find every removed API reference**

Run:

```bash
rg -n -U 'agent\(\{[\s\S]{0,1600}?subagents\s*:\s*\[' apps packages examples test --glob '*.{ts,tsx,md,mdx}'
rg -n '(allow|deny|approve)\s*:\s*\[[^]]*"task"|constrain\s*:\s*\{[^}]*task' apps packages examples test --glob '*.{ts,tsx,md,mdx}'
rg -n 'interrupt_id|"decision"\s*:' apps packages examples test --glob '*.{ts,tsx,md,mdx}'
```

Expected: references remain in public docs/templates/tests/fixtures and must be
migrated or explicitly retained only as negative tests labeled as removed
syntax. These searches deliberately exclude `docs/superpowers`, including the
approved design, implementation plan, and historical records. Manually classify
unrelated domain fields before editing; do not rename result objects merely
because they contain a `subagents` array.

- [ ] **Step 2: Update examples and scaffolds first, then run their typechecks**

Migrate array registration directly to keyed objects. Remove all `tools.*.task` grants and rely on delegation. Update generated-template request examples to the multi-entry resume body.

Run: `pnpm -r --filter './examples/**' typecheck`

Expected: PASS.

- [ ] **Step 3: Rewrite the public documentation around the canonical model**

Document prominently:

- omitted delegation means default allow;
- `default: "deny"` creates an allowlist;
- convention-only children receive only the default;
- explicit registration supplies a parent-local identity and typed named rule;
- explicit aliases replace convention aliases;
- parent policy covers direct children only;
- constraints return allow/deny/approve and fail closed;
- `task` is internal and invalid in all tool policy fields;
- approval persistence uses exact parent/name identity;
- nested interrupts resume through the root thread;
- ordinary resume requires the complete multi-entry envelope;
- there is no array/scalar compatibility API.

Add all public SDK signatures and E1004/E3002/E5003 rows. Remove the obsolete warning that depth metadata is not preserved.

- [ ] **Step 4: Add a patch changeset**

Create this exact patch changeset (the fixed group will carry the release across
the remaining publishable packages):

```md
---
"@dawn-ai/sdk": patch
"@dawn-ai/core": patch
"@dawn-ai/permissions": patch
"@dawn-ai/langchain": patch
"@dawn-ai/cli": patch
"@dawn-ai/ag-ui": patch
"@dawn-ai/testing": patch
---

Add keyed, parent-owned subagent delegation policies with fail-closed
constraints and approval. Subagents now run as native resumable LangGraph
subgraphs, and interrupt resume uses one complete multi-entry request envelope.

This intentionally removes array-form subagent registration, tool policy on
the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
0.x patch release intent with Brian before release.
```

- [ ] **Step 5: Run documentation and package checks**

Run: `node scripts/check-docs.mjs && pnpm pack:check && node scripts/check-changesets.mjs`

Expected: PASS.

- [ ] **Step 6: Confirm removed syntax is absent**

Repeat the three `rg` commands from Step 1. Expected: no positive registration
examples or runtime compatibility parsers remain; every remaining match is an
intentional negative test or an unrelated domain field that has been inspected
and left unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/web examples packages test .changeset
git commit -m "docs: document subagent delegation policies"
```

### Task 15: Full Verification And Manual Smoke

**Files:**
- Modify only files required to fix failures caused by this feature.
- Use external smoke app: `~/tmp/dawn-app` (do not commit it).

- [ ] **Step 1: Run focused package gates**

Run:

```bash
pnpm --filter @dawn-ai/sdk build && pnpm --filter @dawn-ai/sdk typecheck && pnpm --filter @dawn-ai/sdk lint && pnpm --filter @dawn-ai/sdk test
pnpm --filter @dawn-ai/permissions build && pnpm --filter @dawn-ai/permissions typecheck && pnpm --filter @dawn-ai/permissions lint && pnpm --filter @dawn-ai/permissions test
pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core test
pnpm --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain test
pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/cli test
pnpm --filter @dawn-ai/ag-ui build && pnpm --filter @dawn-ai/ag-ui typecheck && pnpm --filter @dawn-ai/ag-ui lint && pnpm --filter @dawn-ai/ag-ui test
pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint && pnpm --filter @dawn-ai/testing test
```

Expected: PASS.

- [ ] **Step 2: Run the repository Definition of Done**

Run: `pnpm ci:validate`

Expected: lint, build-cache check, build, typecheck, tests, docs, pack, release-script tests, and all harness lanes PASS.

- [ ] **Step 3: Prepare the manual smoke app after the workspace build**

In `~/tmp/dawn-app`, create or update a coordinator with:

- one convention-only child governed by the default;
- explicit `allowed`, `reviewed`, and `constrained` keys;
- `default: "deny"` and named exceptions;
- one reviewed child that delegates to its own reviewed child.

Use workspace-linked packages or the repository's supported internal scaffold path. Do not test against stale `dist` output.

Run from the Dawn repository root, then the smoke app:

```bash
pnpm build
pnpm --dir ~/tmp/dawn-app install
pnpm --dir ~/tmp/dawn-app exec dawn check
pnpm --dir ~/tmp/dawn-app exec dawn dev --port 3031
```

Keep the dev server running in that terminal for Step 4.

- [ ] **Step 4: Exercise policy outcomes through `dawn run`/dev runtime**

Start an interactive run with a stable root thread id:

```bash
curl -N http://127.0.0.1:3031/threads/subagent-smoke/runs/stream \
  -H 'content-type: application/json' \
  -d '{"route":"/coordinator#agent","input":{"messages":[{"role":"user","content":"Dispatch the reviewed and constrained tasks."}]}}'
```

Copy the complete current interrupt set from the SSE output into one resume
request (one entry is shown here; include every pending id when several park):

```bash
printf 'Interrupt id from SSE: '
read -r INTERRUPT_ID
jq -nc --arg id "$INTERRUPT_ID" \
  '{route:"/coordinator#agent",resume:[{interruptId:$id,status:"resolved",payload:"once"}]}' \
  | curl -N http://127.0.0.1:3031/threads/subagent-smoke/resume \
      -H 'content-type: application/json' --data-binary @-
```

Use a fresh root thread id for independent deny/always/non-interactive cases.
The checked-in integration fixture from Task 11 supplies deterministic replay;
this smoke confirms the actual CLI/server/package wiring and presentation.

Verify:

1. Static deny returns `[DAWN_E3002]` and emits no `subagent.start`.
2. Allow dispatches and preserves tool-call/subagent correlation.
3. Constraint string denial preserves its reason.
4. Constraint approval preserves its reason and preview.
5. `once` resumes one invocation and asks again later.
6. `always` survives process restart and only approves the exact parent/name edge.
7. Non-interactive mode fails closed without producing a dead interrupt.
8. A nested approval resumes through the root parent thread.
9. Two simultaneous approvals are resumed with one complete multi-entry body.
10. `.dawn/permissions.json` contains `allow.subagent`, never a new `allow.tool: ["task"]` entry.

- [ ] **Step 5: Inspect final diff and repository state**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -20
```

Expected: no unstaged implementation changes, no whitespace errors, and one intentional commit per task. Do not push or open a PR until Brian explicitly asks.

- [ ] **Step 6: Commit any verification-only fixes**

If verification required code changes, rerun the affected focused gate and
`pnpm ci:validate`. Inspect `git status --short`, stage only the exact paths
changed to correct that failure, and commit them with
`fix: address delegation verification failures`.

If no files changed, do not create an empty commit.
