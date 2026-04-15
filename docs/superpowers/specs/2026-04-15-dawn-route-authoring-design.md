# Dawn Route Authoring Design

## Goal

Define the first real Dawn authoring layer on top of the now-stable app/project plumbing.

This milestone should move Dawn from:

- a well-tested route discovery and execution shell

to:

- a Dawn-owned route authoring contract with filesystem-driven tool composition and a Dawn-specific runtime context

without turning Dawn into a second execution runtime or a fork of LangChain/LangGraph semantics.

## Why This Exists

The current repository now has enough stable lower-layer contract to support real authoring work:

- scaffold/install shape is frozen for public and contributor-local flows
- config/discovery behavior is frozen
- route execution and local runtime behavior are verified

But the current authoring surface is still too thin:

- `route.ts` is effectively a re-export plus loose config object
- `graph.ts` and `workflow.ts` are still the de facto authoring contract
- tools are not part of Dawn’s route authoring story yet
- Dawn does not yet provide a stable authoring context above underlying runtime code

If Dawn is going to become a meta-framework around LangChain/LangGraph/Deep Agents, it needs to own a real authoring surface before it tries to own broader agent semantics.

## Scope

This authoring milestone covers:

- `route.ts` as the Dawn-owned route definition file
- explicit route binding from `route.ts` to `graph.ts` or `workflow.ts`
- filesystem-driven tool discovery
- route-local tool discovery
- app-level shared tool discovery
- Dawn-specific runtime context injection into route handlers
- runtime and harness support needed to execute the new contract
- one starter/template update that proves the model

This authoring milestone does not cover:

- memory abstractions
- approvals
- eval authoring
- prompt abstractions
- full backend-neutral agent composition
- LangSmith trace abstractions
- broader Deep Agents integration beyond preserving a path for it later

## Success Definition

This milestone is complete when Dawn can prove:

- a route is authoritatively defined by `route.ts`
- `route.ts` explicitly binds the route to `graph.ts` or `workflow.ts`
- tools are discovered from filesystem scope rather than hand-wired arrays
- route handlers receive a Dawn-specific runtime context
- the context exposes the resolved tool inventory for that route
- Dawn still preserves its current local execution and local dev runtime behavior

## Authoring Boundary

### `route.ts` is the canonical route contract

The first Dawn authoring layer should make `route.ts` the semantic center of a route directory.

That means:

- Dawn tooling reads `route.ts` first
- `route.ts` describes the route definition
- `graph.ts` and `workflow.ts` remain implementation files
- future authoring features grow from `route.ts`, not from ad hoc runtime-file inference

This is the key shift:

- before: runtime files are the authoring surface and `route.ts` is incidental
- after: `route.ts` is the authoring surface and runtime files are implementation details

### CLI and execution compatibility in v1

This milestone must preserve Dawn’s current filesystem-path-first CLI contract.

That means:

- `dawn run` continues to accept `graph.ts` and `workflow.ts` file paths
- `dawn test` scenario targets continue to point at `graph.ts` and `workflow.ts`
- execution resolves the bound `route.ts` definition from the same route directory when present

For this milestone, `route.ts` becomes authoritative for route definition, but the public CLI targeting contract does not switch to `route.ts`.

Later ergonomic work may allow route-directory or `route.ts` targets directly. That is out of scope here.

### V1 route definition shape

The first Dawn-owned route definition should stay narrow:

- explicit `kind`
- explicit relative `entry`
- route metadata/config

Conceptually:

```ts
import { defineRoute } from "@dawn/langgraph";

export const route = defineRoute({
  kind: "workflow",
  entry: "./workflow.ts",
  config: {
    runtime: "node",
    tags: ["hello"],
  },
});
```

This does not yet absorb:

- schemas
- tools DSL inside the route definition
- memory/evals/approvals
- backend-neutral execution semantics

It is a route-definition layer, not a second runtime.

## Tool Composition Model

### Tool discovery is filesystem-driven

The first Dawn tool composition layer should be based on filesystem registration and discovery, not route-local manual arrays.

The initial scope should be:

- route-local tools:
  - `<routeDir>/tools/*.ts`
- app-level shared tools:
  - `src/tools/*.ts`

This is the right fit for Dawn because it extends the framework’s strongest existing behavior:

- filesystem discovery
- explicit app structure
- static inventory for verification and tooling

### Tool module contract

The tool discovery model must be specific enough to implement.

For v1:

- each discovered tool file defines exactly one tool
- each tool file must default-export a Dawn tool definition
- Dawn tool definitions are created with a Dawn-owned helper such as `defineTool(...)`
- every tool definition must declare an explicit `name`
- tool names, not filenames, are the identity used for registry lookups and collision checks

Conceptually:

```ts
import { defineTool } from "@dawn/langgraph";

export default defineTool({
  name: "weather.get",
  description: "Look up the forecast for a city",
  run: async (input, ctx) => {
    return { forecast: `sunny in ${String(input.city)}` };
  },
});
```

Required static metadata in v1:

- `name`

Optional metadata in v1:

- `description`

Deferred metadata:

- schema-first validation
- permissions/policy declarations
- richer classification metadata

This keeps the first tool surface concrete without overcommitting the shape.

### Tool scope resolution

The route’s resolved tool inventory should be built from both scopes:

1. app-level shared tools from `src/tools`
2. route-local tools from the route directory

Resolution rules:

- route-local tools shadow shared tools by name
- collisions within the same scope are errors
- tool resolution order is deterministic

This keeps the default model automatic while still making collisions explicit.

### Dawn owns tool definition, but not a second execution runtime

Dawn should own a first-class tool authoring surface, but the value it owns first is:

- tool identity
- registration
- discovery
- static metadata
- future policy hooks

It should not introduce a second tool execution protocol in v1.

The intended model is:

- tools are authored through a Dawn API
- Dawn normalizes them into a route-scoped registry
- Dawn adapts them into underlying runtime-compatible behavior

This preserves Dawn’s meta-framework role instead of turning it into a replacement runtime.

## Runtime Context

### Dawn-specific runtime context

The first route authoring milestone should introduce a Dawn-owned runtime context passed explicitly into route handlers.

Conceptually:

```ts
export async function workflow(
  state: HelloState,
  ctx: DawnRouteContext,
): Promise<HelloState> {
  const weather = await ctx.tools["weather.get"]({ city: state.tenant });

  return {
    ...state,
    greeting: `Hello, ${state.tenant}!`,
    weather,
  };
}
```

This context is the stable Dawn authoring surface for execution-time capabilities.

V1 context responsibilities:

- resolved route metadata as needed for execution
- resolved tool registry for the route
- abort signal for the current execution

Deferred context responsibilities:

- memory
- approvals
- request/session abstractions beyond what is needed immediately
- trace abstractions

The v1 context should be explicit and small:

```ts
interface DawnRouteContext {
  readonly signal?: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
}
```

Tool handlers themselves may receive an internal tool context later, but the route-handler contract in this milestone only depends on `ctx.tools` and `ctx.signal`.

### Why explicit context is correct

Making the context Dawn-specific and explicit is important because Dawn is now defining an authoring layer, not just inference around native files.

That gives Dawn one stable surface for:

- tool injection
- future growth into memory and approvals
- route-level runtime services

while still allowing the implementation beneath that surface to stay compatible with the existing underlying execution model.

### Runtime compatibility rule

The runtime needs an explicit compatibility rule so the new authoring lane does not conflict with Dawn’s existing native-first behavior.

For this milestone:

- legacy/native route execution continues to support the current behavior
  - workflow functions called as `(input, { signal })`
  - graph functions called as `(input, { signal })`
  - graph objects exposing `.invoke(input, { signal })`
- the new `route.ts` authoring lane narrows the bound entry contract to function-style exports
  - `graph.ts` and `workflow.ts` bound through `route.ts` must export callable handlers
  - those handlers receive `(input, DawnRouteContext)`

This means:

- Dawn does not break existing routes in this milestone
- Dawn does define a stricter, Dawn-owned contract for the new authoring path

That is an acceptable tradeoff for the first authoring layer because it keeps migration and runtime compatibility contained.

## Runtime Integration

The runtime side should change as little as possible to support the new authoring layer.

Required runtime changes:

- route execution must resolve the route definition from `route.ts`
- route execution must load the bound `graph.ts` or `workflow.ts`
- tool discovery must happen relative to the discovered route/app roots
- the resolved Dawn context must be passed into the route handler

Non-goals:

- no change to `dawn run` JSON contract for this milestone
- no new HTTP protocol for `dawn dev`
- no deployment/runtime ownership changes

The route authoring layer changes what handlers receive and how routes are described. It does not change Dawn’s outer execution boundary in v1.

## Tooling And CLI Implications

The authoring layer should support Dawn’s existing tooling model.

That means:

- route validation should be able to confirm the `route.ts` binding
- route discovery should continue to produce stable route ids/pathnames
- the resolved tool inventory should be available for future CLI/debug output
- `dawn run`, `dawn test`, and `dawn dev` must continue to execute through the current normalized result contract

The CLI does not need to expose tool inventory in this milestone, but the runtime and discovery layers should be structured so that becomes straightforward later.

## Template Impact

The starter template should prove the new authoring model directly.

That means the first updated template should include:

- `route.ts` using the Dawn route-definition helper
- `workflow.ts` or `graph.ts` using the Dawn runtime context
- at least one discovered tool from the canonical filesystem path

The template should remain intentionally small. The purpose is to prove the authoring contract, not to demonstrate every future framework feature.

## Testing And Verification

This milestone needs both contract and runtime proof.

### Contract coverage

Add tests that prove:

- `route.ts` is required as the Dawn route definition boundary for the new authoring lane
- `entry` binding is explicit and validated
- tool discovery resolves shared and route-local tools deterministically
- same-scope tool-name collisions fail clearly
- route-local shadowing over shared tools is deterministic

### Runtime coverage

Add tests that prove:

- `dawn run` executes a route through the Dawn route definition
- handlers receive the Dawn runtime context
- discovered tools are usable from that context
- `dawn test` scenarios can execute routes using the new contract
- `dawn dev` preserves parity with in-process execution for the authoring slice

### Template/generated-app coverage

Generated-app coverage should prove:

- the updated template installs cleanly
- the generated app can execute `dawn run`, `dawn test`, and `dawn dev`
- the generated route can actually use a discovered tool through the Dawn context

## Deferrals

This milestone intentionally defers:

- memory model
- approvals model
- eval authoring
- prompt authoring
- broader agent composition
- backend portability beyond keeping room for it
- richer tool policy and permissions model

The goal is not to build the full Dawn framework surface in one pass. The goal is to establish a real Dawn-owned route authoring contract that future layers can extend safely.

## Recommendation

The first real authoring milestone should implement:

- `route.ts` as the canonical Dawn route definition
- explicit binding to `graph.ts` or `workflow.ts`
- filesystem-driven tool discovery from `src/tools` and route-local `tools/`
- Dawn-specific runtime context with resolved tools
- template/runtime/test coverage to prove that contract

That is the right next step because it gives Dawn a real authoring surface while staying aligned with the current repo’s strengths:

- filesystem contract
- deterministic discovery
- thin runtime ownership
- compatibility with the existing execution boundary
