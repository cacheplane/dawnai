# First-Class Subagent Delegation Policies

**Date:** 2026-08-05
**Status:** Approved design

## Summary

Dawn will add a first-class, parent-owned policy boundary for subagent dispatch.
The public `agent()` API will replace its untyped `subagents: DawnAgent[]` list
with a keyed subagent registry and add a `delegation` policy whose named rules
are restricted to those keys by TypeScript. Filesystem-convention children
remain available without registration and receive the policy's default rule.

Delegation policy is enforced at the final guarded resolution boundary before a
child route starts. It is not implemented as policy on the internal `task` tool.
Approval uses a dedicated `kind: "subagent"` permission interrupt and persists
an exact parent-to-child registration identity, so approving one subagent never
approves every dispatch or an identically named child under another parent.

This is a pre-1.0 breaking change. Dawn will not retain the array API or support
`tools.*.task` as a compatibility surface.

## Goals

- Give each parent agent explicit control over dispatch to each direct child.
- Support static allow, deny, and approval rules plus dynamic input constraints.
- Persist "Always" approval per parent-to-child registration edge.
- Make explicit rule names narrow and typo-resistant in TypeScript.
- Preserve convention-only subagents and their zero-configuration workflow.
- Enforce policy independently at every level of nested delegation.
- Fail closed when policy is invalid or cannot be evaluated.
- Keep `task` an internal model-facing mechanism rather than a public policy
  identity.
- Preserve transport independence: HTTP and AG-UI carry interrupts and resume
  decisions but do not own delegation policy.

## Non-Goals

- A `SUBAGENT.md` metadata format or YAML policy language.
- Request rewriting from a constraint predicate.
- Per-dispatch token, time, cost, concurrency, or depth budgets.
- Compatibility with `subagents: DawnAgent[]`.
- Compatibility with `tools.allow.task`, `tools.deny.task`,
  `tools.approve.task`, or `tools.constrain.task`.
- Migrating persisted `allow.tool: ["task"]` entries.
- Moving production runtime ownership into `@dawn-ai/ag-ui`.

## Policy Ownership

Delegation policy belongs to the parent and governs only its direct outbound
edges. If `/coordinator` dispatches `/coordinator/subagents/researcher`, the
coordinator's policy decides whether that dispatch may begin. If the researcher
later dispatches one of its own children, the researcher's policy is evaluated
separately. Approval at one level never authorizes a deeper level.

Registration makes a child dispatchable by default. Omitting `delegation` is
equivalent to:

```ts
delegation: {
  default: "allow",
  rules: {},
}
```

Applications that want an allowlist use `default: "deny"` and explicit `allow`
rules. This default behavior must be stated prominently in the subagent and API
documentation.

## Public TypeScript API

### Keyed subagent registration

The existing array is replaced by a keyed object:

```ts
import { agent } from "@dawn-ai/sdk"
import researcher from "./subagents/researcher/index.js"
import writer from "./subagents/writer/index.js"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Coordinate the work.",
  subagents: {
    researcher,
    writer,
  },
  delegation: {
    default: "deny",
    rules: {
      researcher: { action: "allow" },
      writer: {
        action: "approve",
        reason: "Draft generation requires review.",
      },
    },
  },
})
```

The object key is the parent-local model-facing name and permission identity.
This permits a shared child descriptor to have different meaningful names under
different parents without changing the child itself.

Registration names must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, the same grammar
Dawn uses for other model-facing filesystem capability names. The rule applies
to explicit keys and convention leaf directories. Dawn does not trim,
normalize, or case-fold names; the exact key is used in the task schema, prompt,
diagnostics, and permission identity. No otherwise-valid name, including
`task`, is reserved in the subagent value namespace.

The SDK types are shaped along these lines:

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
  | {
      readonly action: "constrain"
      readonly predicate: DelegationConstraintPredicate
    }

export type DelegationRules<Name extends string> = [Name] extends [never]
  ? Readonly<Record<string, never>>
  : Partial<Record<Name, DelegationRule>>

export interface DelegationConfig<Name extends string> {
  readonly default?: "allow" | "deny" | "approve"
  readonly rules?: DelegationRules<Name>
}
```

`AgentConfig` and `DawnAgent` become generic over the explicit registry. The
`delegation` field uses `NoInfer` around the explicit key union so names in
`rules` cannot widen the registry inferred from `subagents`:

```ts
export interface AgentConfig<Subagents extends SubagentMap = {}> {
  // Existing fields omitted.
  readonly subagents?: Subagents
  readonly delegation?: DelegationConfig<NoInfer<Extract<keyof Subagents, string>>>
}

export function agent<const Subagents extends SubagentMap = {}>(
  config: AgentConfig<Subagents>,
): DawnAgent<Subagents>
```

Inline unknown rule keys are TypeScript errors. When there is no explicit
registry, the `Record<string, never>` branch rejects every named rule rather
than collapsing to TypeScript's permissive `{}` type. Runtime and `dawn check`
validation remain mandatory because JavaScript consumers, widened variables,
casts, and filesystem convention entries are outside that compile-time proof.

### Conflict-free rules

Each explicit child has at most one discriminated rule, so contradictory
`deny`/`approve`/`constrain` states cannot be represented. `default` supplies a
single fallback action. A constraint is itself the complete dynamic rule for
that child and may allow, deny, or escalate the current invocation.

Constraint results have these meanings:

- `true`: dispatch.
- A string: deny and preserve that string as the reason in the coded internal
  task result: `[DAWN_E3002] <reason>`.
- `{ approve: true, reason? }`: evaluate the subagent approval gate and preserve
  the optional reason in the interrupt.
- Throwing or returning any other value: fail closed.

Predicates inspect `{ input }` plus live route, thread, parameter, target, and
cancellation context. They cannot rewrite the input in v1.

## Convention And Explicit Discovery

Immediate route children at `<parent>/subagents/<leaf>/index.ts` continue to be
discovered automatically.

Resolution follows these rules:

1. Discover all immediate convention children.
2. Resolve each keyed descriptor to exactly one route id through a
   descriptor-route identity index.
3. If an explicit descriptor resolves to a convention child's route id, remove
   the convention registration and replace it with the explicit registration.
4. Reject any model-facing name collision.
5. Reject a route registered explicitly more than once under the same parent.
6. Apply a named rule to each explicit registration and the default rule to all
   remaining convention-only registrations.

The descriptor identity index is a multimap, not the current last-write-wins
`Map<DawnAgent, string>`. If the same descriptor object is exported as the
default entry by more than one route, explicit registration is ambiguous and
fails with `DAWN_E1004`, listing the candidate route ids. Authors must export a
distinct descriptor object for each route they want to register. This removes
the nondeterminism currently caused by concurrent manifest imports.

Convention-only children therefore remain zero-configuration, but they can
receive only the default policy. To give one a named exception, the parent
imports it and includes it in the keyed `subagents` object. This is the explicit
trade-off that makes named rules type-safe without requiring generated route
name parameters in every `agent()` call.

The explicit key replaces the convention leaf as that parent's dispatch
identity. The old convention identity must not remain as an alias because that
would create a policy bypass.

## Canonical Registry

Today, subagent discovery is duplicated between the core capability marker and
the CLI resolver. The implementation will introduce one canonical registry
resolution path that produces entries equivalent to:

```ts
interface ResolvedSubagent {
  readonly name: string
  readonly routeId: string
  readonly source: "convention" | "explicit"
  readonly rule: ResolvedDelegationRule
}
```

The same resolved registry drives:

- the `# Subagents` prompt fragment;
- the internal task tool's name enum;
- `dawn check` diagnostics;
- route preparation validation;
- runtime guarded resolution and dispatch.

Statically denied children are omitted from both the prompt and schema. Allowed,
approval-gated, and constrained children remain visible because a valid call may
dispatch them. If no child is dispatchable, Dawn contributes neither the prompt
fragment nor the task tool.

## Runtime Enforcement Boundary

The current implementation wraps the placeholder `task.run` during CLI route
preparation, then the LangChain adapter replaces that function with the real
bridge. This is why tool approval and constraints cannot protect dispatch.

The new architecture does not wrap `task`. The CLI builds a guarded subagent
resolver from the canonical registry, resolved policy, permissions store, and
raw route resolver. The LangChain bridge receives only the guarded interface.
For each request, it supplies live thread, params, signal, writer, and stream
context. The guarded resolver evaluates policy before it returns a runnable
child. The bridge cannot resolve or invoke a child through an unguarded path.

The sequence is:

1. Parse the internal `{ subagent, input }` task payload.
2. Resolve the requested parent-local identity in the canonical registry.
3. Recheck the resolved policy at the guarded runtime boundary.
4. Evaluate a constraint predicate when configured.
5. Consult or emit subagent approval when required.
6. Return a runnable child only after the gate allows the request.
7. Invoke the child as a LangGraph per-invocation subgraph and preserve Dawn's
   `subagent.*` streaming projection.

The guarded registry and policy evaluator in core remain generic over the child
handle. They do not import CLI or LangChain runtime types. CLI code supplies the
route-specific child handle, while LangChain owns graph invocation and parent
interrupt replay.

The internal task tool uses a dedicated LangChain conversion path so its bridge
receives the complete live `RunnableConfig` required for subgraph inheritance.
That opaque framework config is not added to the public Dawn tool context or
delegation predicate types; those continue to receive only the sanitized fields
defined by the SDK.

This final-boundary check protects stale schemas, direct bridge calls, and
malformed model output. It also avoids coupling public policy to LangChain's
placeholder replacement mechanics.

### Native subgraph checkpoint and resume

Nested approval requires more than event forwarding. Today child runs re-enter
the CLI as independent uncheckpointed executions and child interrupts are
reduced to `subagent.interrupt`, leaving no state the parent can resume. Dawn
will replace that invocation path with LangGraph's native per-invocation
subgraph model.

The CLI still prepares each child route lazily with its own descriptor, tools,
capabilities, state fields, policy, sandbox-backed tools, and recursive
subagents. Instead of starting that prepared child through
`executeResolvedRoute` or `streamResolvedRoute`, it exposes a compiled child
graph whose compile-time checkpointer is omitted. The internal task tool invokes
that graph as a function from inside the parent graph's tool node and forwards
the live parent `RunnableConfig`.

In this mode LangGraph assigns a checkpoint namespace to each subgraph
invocation and inherits the parent's checkpointer. It therefore owns all replay
ordering and resume identity:

- the parent remains the only public `thread_id`;
- each child invocation starts with fresh state but is durable within that call;
- parallel calls receive independent checkpoint namespaces;
- nested and simultaneous interrupts propagate to the root graph with their
  native interrupt ids;
- the existing ID-addressed resume map can resolve several pending interrupts
  in one `Command({ resume })`;
- nested subgraphs repeat the same behavior without Dawn-managed thread ids,
  replay journals, or scalar resume forwarding.

This follows LangGraph's documented per-invocation subgraph mode for subagents
called as tools: <https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs>.
Dawn must not implement a parallel checkpoint protocol around it. Child graphs
are materialized lazily rather than by recursively walking the entire delegation
graph, so explicit cycles do not recurse during route preparation; the existing
runtime depth limit remains the cycle boundary.

The dispatcher must allow LangGraph interrupt control flow to propagate. It
must not catch an interrupt and convert it to `subagent_failed`, an empty final
message, or a plain `subagent.interrupt` capability event. Ordinary child errors
retain the existing failure mapping.

Child depth, parent dispatch call id, route params, cancellation, and the root
sandbox key remain Dawn metadata on the inherited runtime config. Depth must be
carried into recursively prepared routes, fixing the current loss of the nested
depth guard. Checkpoint namespaces and sandbox identities remain separate.

Subgraph events naturally appear in the parent's LangGraph event stream. The
adapter classifies those namespaced events into Dawn's existing
`subagent.start`, `subagent.message`, `subagent.tool_call`,
`subagent.tool_result`, capability, and `subagent.end` projections. It must not
also emit the same child token as a parent token. This replaces the custom child
`dawnStream` queue as the source of nested event ordering.

If the root execution has no resumable parent thread id, any approval rule or
constraint escalation fails closed with actionable non-interactive guidance.
Dawn must not emit an interrupt that cannot be resumed.

### Internal `task` behavior

`task` remains the model-facing implementation mechanism, but it is no longer a
user-configurable tool-policy resource. A route with at least one dispatchable
child receives it automatically, including a nested subagent route. The route's
own `delegation` policy is the sole authority for its outbound dispatches.

The following become invalid configuration:

- `tools.allow: ["task"]`
- `tools.deny: ["task"]`
- `tools.approve: ["task"]`
- `tools.constrain: { task: ... }`

This removes the existing special case where a nested subagent had to grant the
internal capability through `tools.allow` before it could delegate.

## Permission Model

`@dawn-ai/permissions` gains a first-class subagent interrupt detail:

```ts
export interface SubagentDetail {
  readonly parentRouteId: string
  readonly subagentName: string
  readonly subagentRouteId: string
  readonly inputPreview: string
  readonly reason?: string
  readonly suggestedPattern: string
}

export interface PermissionRequest {
  readonly kind: "command" | "path" | "tool" | "memory" | "subagent"
  readonly detail:
    | CommandDetail
    | PathDetail
    | ToolDetail
    | MemoryDetail
    | SubagentDetail
  // Existing envelope fields unchanged.
}
```

The reserved permission key is `subagent`. Its candidate and suggested pattern
are `JSON.stringify([parentRouteId, subagentName])` and use exact equality, like
the reserved `tool` key. JSON tuple serialization avoids delimiter collisions
without introducing a parser-specific escaping scheme. The target route id is
included in the interrupt for display and audit context but not the persisted
identity. A registration name is treated like a tool name: changing the
implementation behind that reviewed name does not create a new permission
identity.

The decisions remain:

- `once`: allow only the resumed invocation.
- `always`: persist an allow entry for this exact parent registration.
- `deny`: return a coded denial to the parent model.

An approval for `researcher` under `/support` does not approve `researcher`
under `/finance`, nor does it approve another child of `/support`. Static
`default: "approve"` still persists and matches each concrete child identity
independently.

In non-interactive mode, unknown approval requirements fail closed. Explicit
permission deny entries override persisted or configured allow entries through
the existing deny-wins store semantics. Bypass mode retains its existing meaning
and skips the interactive permission gate, but it does not make statically
denied or constraint-denied children dispatchable.

## Interrupt And Transport Behavior

The core permission interrupt uses:

```ts
{
  type: "permission-request",
  kind: "subagent",
  detail: {
    parentRouteId,
    subagentName,
    subagentRouteId,
    inputPreview,
    reason,
    suggestedPattern,
  },
}
```

`inputPreview` is display-only, bounded, and never used for matching or
persistence. Static rule reasons and constraint escalation reasons are preserved
as the canonical user-facing explanation.

The CLI resume endpoint adopts Dawn's canonical multi-interrupt envelope. The
request body becomes:

```json
{
  "resume": [
    {
      "interruptId": "perm-abc123",
      "status": "resolved",
      "payload": "once"
    }
  ],
  "route": "/support#agent"
}
```

`resume` may contain one or many entries and must address the complete current
pending interrupt set exactly once. A resolved payload must be `once`, `always`,
or `deny`; `cancelled` maps to `deny`. The server resolves each public
`interruptId` to LangGraph's checkpoint resume key and passes the resulting
ID-addressed map through `Command({ resume })`. The existing scalar
`{ interrupt_id, decision }` body is removed without compatibility parsing.
The AG-UI handler and ordinary resume endpoint share this resolver rather than
maintaining separate semantics.

When a child route parks, its permission request is surfaced as a top-level
parent interrupt with the dispatch `callId` attached; it is not reduced to an
unresumable `subagent.interrupt` event. This applies to delegation approval and
also repairs existing tool, path, command, and memory approvals reached inside a
child. LangGraph routes each resumed decision to the appropriate child
checkpoint namespace through the root `Command({ resume })`; Dawn does not
address or resume the child separately.

`@dawn-ai/ag-ui` remains a pure adapter: it forwards the standard Dawn interrupt
and resume contract without evaluating delegation policy. The Dawn web example
adds a dedicated subagent approval presentation showing the parent, child,
bounded input preview, and reason.

## Validation

### TypeScript

- `subagents` accepts a keyed `Record<string, DawnAgent>` and rejects arrays.
- `rules` keys are narrowed to explicit registry keys.
- Each rule is exactly one discriminated action.
- Constraint predicates receive typed request and context objects.

### `dawn check`

`dawn check` reports `DAWN_E1004` for:

- an unknown explicit rule name at runtime;
- a registration name outside `^[A-Za-z0-9][A-Za-z0-9_-]*$`;
- a descriptor that cannot be resolved to a route;
- a descriptor that resolves ambiguously to multiple routes;
- duplicate explicit registration of one route;
- explicit/convention identity collisions that cannot be replaced safely;
- malformed defaults, actions, predicates, or reasons from untyped input;
- any `tools.*` reference to the reserved internal `task` tool.

The check should list available explicit names and the relevant route when that
makes the remediation clearer.

### Route preparation

Route preparation repeats all security-relevant checks. Invalid policy aborts
preparation; Dawn never ignores a policy and falls back to allow. This protects
production entrypoints that were built or started without a separate check.

## Failure Behavior And Diagnostics

- Static denial returns `[DAWN_E3002] <reason>` without starting a child stream.
- Constraint-string denial preserves the predicate's string as `<reason>` in
  the same coded result.
- User denial returns a coded task result without starting a child stream.
- An unknown or stale identity returns a coded unavailable result.
- Constraint exceptions and invalid verdicts return a generic fail-closed
  result; underlying error details are not exposed to the model.
- `DAWN_DEBUG_CONSTRAINTS=1` logs the underlying constraint failure with parent
  route and subagent identity for local diagnosis.
- Constraint evaluation and approval waiting honor the live `AbortSignal`.
- Once dispatch is allowed, existing child failures and `subagent_failed`
  behavior remain unchanged.

The error registry adds:

| Code | Title | Use |
|---|---|---|
| `DAWN_E1004` | Invalid delegation policy | Build/check/preparation validation |
| `DAWN_E3002` | Subagent dispatch denied | Static, constraint, permission, or non-interactive denial |
| `DAWN_E5003` | Subagent unavailable or dispatch failed | Unknown/stale identity or dispatch setup failure |

Existing `DAWN_E3001` behavior for tool, command, path, and memory permissions is
unchanged.

## Package Responsibilities

| Package | Responsibility |
|---|---|
| `@dawn-ai/sdk` | Generic keyed registry and public delegation types |
| `@dawn-ai/core` | Canonical registry resolution, policy evaluation, permission gate, prompt/schema contribution |
| `@dawn-ai/permissions` | `subagent` interrupt detail and exact persisted matching |
| `@dawn-ai/cli` | Route graph resolution, `dawn check`, guarded resolver construction, lazy child route preparation |
| `@dawn-ai/langchain` | Per-invocation subgraph materialization/invocation, interrupt propagation, namespaced event projection |
| `@dawn-ai/ag-ui` | Transport-neutral interrupt/resume forwarding tests |
| `@dawn-ai/testing` | Harness assertions and resume coverage for subagent approval |
| Dawn examples/web | Interactive presentation and end-to-end demonstration |

No HTTP server or production runtime is added to `@dawn-ai/ag-ui`.

## Test Strategy

### SDK type tests

- Infer the exact key union from an inline explicit registry.
- Accept rules for registered keys.
- Reject unknown rule keys with `@ts-expect-error`.
- Reject array-form `subagents`.
- Reject malformed and multi-action rule objects.
- Type the constraint request, context, and verdict narrowly.

### Core unit tests

- Discover convention-only children and apply default allow.
- Apply `default: "deny"` and omit denied children from prompt/schema.
- Apply `default: "approve"` independently to convention children.
- Replace a convention identity when its route is explicitly registered.
- Support a parent-local explicit alias without retaining the convention alias.
- Reject name collisions, duplicate route values, and unresolved descriptors.
- Evaluate allow, deny, approve, and every constraint verdict.
- Preserve static and predicate approval reasons.
- Fail closed on predicate throw or malformed return.
- Log diagnostic details only with `DAWN_DEBUG_CONSTRAINTS=1`.
- Honor cancellation and non-interactive behavior.

### Permissions tests

- Match subagent candidates exactly rather than by prefix.
- Scope equal child names under different parents independently.
- Persist and reload an `always` decision.
- Keep deny-wins semantics.

### CLI and LangChain integration tests

- `dawn check` emits each delegation configuration diagnostic.
- Route preparation independently rejects invalid policy.
- The guarded resolver evaluates policy before resolving or starting a child.
- Denied calls produce no `subagent.start` event.
- Approval resume with `once` dispatches once.
- Approval resume with `always` persists only the exact edge.
- Nested child dispatch evaluates the child's policy independently.
- A nested child approval parks and resumes through the root parent thread.
- Parallel calls to the same subagent receive isolated per-invocation
  checkpoint namespaces.
- Multiple simultaneous child interrupts retain distinct ids and resume through
  the existing ID-addressed resume map.
- The ordinary resume endpoint accepts a complete multi-entry Dawn resume
  envelope and rejects stale, duplicate, partial, or malformed interrupt sets.
- Interrupt control flow is not converted into a child failure or capability
  event.
- Missing resumable identity fails closed instead of emitting a dead interrupt.
- Child depth metadata survives route re-entry and enforces the existing limit.
- Convention-only default behavior works without explicit registration.
- Existing subagent stream correlation and child failure behavior remain green.

### AG-UI, web, and harness tests

- A `kind: "subagent"` interrupt retains all canonical detail through AG-UI.
- AG-UI resume maps `once`, `always`, and `deny` without special runtime logic.
- The web approval UI renders subagent identity, preview, and reason.
- The testing harness captures and resumes subagent approvals.

### Manual smoke test

Use a small Dawn CLI app containing:

- one convention-only child governed by the default;
- one explicitly keyed allowed child;
- one approval-gated child;
- one constrained child;
- a nested child policy.

Verify deny, once, always, restart persistence, non-interactive fail-closed
behavior, and independent nested approval through the parent's ordinary resume
endpoint using a multi-entry resume body. Confirm that the persisted permission
entry uses `subagent`, not `tool: task`, and that nested and simultaneous child
approvals resume through the parent thread without starting a new child
invocation.

## Documentation And Repository Migration

Update:

- the subagent guide with keyed registration, defaults, convention-only trade-
  offs, rule actions, nesting, and examples;
- the permissions guide with `kind: "subagent"` and exact edge persistence;
- the tools guide to identify `task` as internal and reserved;
- the API reference with all new generic and predicate types;
- error-code documentation for `DAWN_E1004`, `DAWN_E3002`, and `DAWN_E5003`;
- dev-server and generated-template documentation for the canonical multi-entry
  resume request;
- scaffolds, examples, fixtures, and tests using the old array API or
  `tools.*.task`.

The migration is intentionally direct:

```ts
// Before
subagents: [researcher, writer]

// After
subagents: { researcher, writer }
```

Persisted `allow.tool: ["task"]` entries are ignored. No migration, warning-only
period, deprecated overload, or dual runtime parser is provided.

Add a patch changeset for the affected publishable packages. Dawn's fixed 0.x
release group means a minor changeset would incorrectly advance the group to
1.0.0.

## Verification

Run focused package build, typecheck, lint, and test lanes while implementing,
then run the repository Definition of Done through `pnpm ci:validate`. Also run
the manual interactive smoke test after building the workspace so consumers do
not exercise stale `dist/` output.

## Key Trade-Offs

- Convention-only children cannot have a named compile-time rule. Explicitly
  register one when it needs an exception to the default.
- Keyed registration duplicates a small amount of information already visible
  in the filesystem, but it is the only straightforward way for TypeScript to
  infer parent-local policy names without route-path generics or generated
  helper APIs.
- Persisted approval follows the parent-local registration identity rather than
  the target route id. Repointing a reviewed name preserves its approval, just
  as changing a tool implementation preserves name-level tool approval.
- Resumable nested approval requires replacing Dawn's independent child route
  re-entry and custom event queue with LangGraph per-invocation subgraphs and
  namespaced event projection. This is a larger internal refactor, but it uses
  LangGraph's supported replay, parallel-call, and multiple-interrupt semantics
  instead of creating a second checkpoint protocol.
- The internal task mechanism remains visible to the model and stream internals,
  but it is no longer exposed as Dawn's public authorization abstraction.
