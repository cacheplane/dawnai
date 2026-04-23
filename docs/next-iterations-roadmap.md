# Next Iterations Roadmap

This roadmap is the recommended continuation path after the route-authoring milestone now merged on `main`.

Its purpose is to close the gap between Dawn’s current state and the original product hypothesis:

- a meta-framework for the LangChain / LangGraph / Deep Agents space

The roadmap is intentionally phased. The current repo has enough CLI/runtime/authoring foundation to support broader authoring work, but it should not jump straight into every ambition at once.

## Where Dawn Stands Now

Dawn currently has:

- stable app/project plumbing
- stable route discovery and route identity (`index.ts` per route convention)
- local route execution and local dev runtime
- scenario testing and generated-app parity coverage
- a Dawn-owned backend-neutral authoring contract (`@dawnai.org/sdk`)
- a formal `BackendAdapter` interface in `@dawnai.org/sdk` with `execute()` and `stream()` methods
- `@dawnai.org/langgraph` as the first backend adapter (`graph` and `workflow` route kinds)
- `@dawnai.org/langchain` as the second backend adapter (`chain` route kind for LCEL runnables)
- `@dawnai.org/vite-plugin` for build-time tool schema inference from TypeScript types and JSDoc
- CLI-owned route discovery and normalization (no backend-specific imports for discovery)
- filesystem-driven tool registration and discovery with optional Zod schema exports
- Dawn-owned ReAct tool execution loop for chain routes (no AgentExecutor dependency)
- NDJSON streaming for `dawn run` and SSE streaming for `dawn dev`

Dawn does not yet have:

- a Deep Agents composition layer
- a mature higher-level model for tools, workflows, approvals, memory, evals, or traces

That means the next work should focus on Deep Agents integration and richer authoring systems.

The following should be treated as already stabilized enough for the roadmap phases below:

- app/project plumbing
- route discovery and route identity
- `verify` / `run` / `test` / `dev` command boundaries
- local dev runtime ownership
- first-generation route authoring and filesystem tool discovery
- `BackendAdapter` interface and adapter dispatch pattern
- LangChain-native authoring path (`chain` routes)
- tool schema inference pipeline (Vite plugin)

The following should be treated as still provisional and subject to new design work:

- Deep Agents authoring model
- higher-level tool composition
- streaming event type extensions

## Phase 1: Dawn-Owned Authoring Contract (Complete)

### Goal

Define a Dawn authoring contract that is semantically owned by Dawn rather than inherited from LangGraph implementation details.

### Status

This phase is complete as of the authoring-sdk milestone.

`@dawnai.org/sdk` is the Dawn-owned backend-neutral package containing the full author-facing contract: route types, runtime context types (`RuntimeContext`, `RuntimeTool`), and the `index.ts`-per-route convention. Tools are plain default-exported functions with names inferred from filenames. `@dawnai.org/langgraph` is now an adapter that implements the `@dawnai.org/sdk` contract and wires it to LangGraph execution.

Authors depend on `@dawnai.org/sdk` for type annotations only. `@dawnai.org/langgraph` remains available for backwards compatibility but is no longer the canonical author surface.

## Phase 2: LangChain-Native Authoring (Complete)

### Goal

Prove that the Dawn-owned authoring contract can support a real LangChain-native path instead of only the current LangGraph-thin surface.

### Status

This phase is complete as of the langchain-native milestone.

**New packages:**

- `@dawnai.org/langchain` — `BackendAdapter` for `chain` route kind, tool converter (Dawn tools → LangChain `DynamicStructuredTool`), Dawn-owned ReAct tool execution loop
- `@dawnai.org/vite-plugin` — build-time Zod schema inference from TypeScript function signatures and JSDoc via the TypeScript Compiler API

**Key changes:**

- `@dawnai.org/sdk` gained a formal `BackendAdapter` interface with `execute()` and `stream()` methods, and `RouteKind` expanded to `"chain" | "graph" | "workflow"`
- CLI now owns all route discovery and normalization — no more `@dawnai.org/langgraph` import for `normalizeRouteModule()`
- `@dawnai.org/langgraph` refactored to export `graphAdapter` and `workflowAdapter` as `BackendAdapter` implementations
- Chain routes use LCEL `Runnable` exports; Dawn automatically binds tools, injects route params, and propagates abort signals
- NDJSON streaming for `dawn run`, SSE streaming for `dawn dev`
- Tool discovery supports optional `export const schema` (Zod) alongside the Vite plugin inference path

**Design spec:** [`docs/superpowers/specs/2026-04-20-langchain-native-authoring-design.md`](./superpowers/specs/2026-04-20-langchain-native-authoring-design.md)

### Why This Came Second

This is the first real proof that Dawn is becoming a meta-framework instead of a LangGraph-first runtime shell.

The same Dawn contract drives a LangChain-native authoring path without warping the contract, which materially strengthens Dawn’s core thesis.

### What Was Deferred

- Deep Agents composition (Phase 3)
- Recursive type support in Vite plugin
- Better missing-dependency DX (`dawn verify` checks for `@langchain/core`)
- Custom SSE event types beyond the initial set

## Phase 3: Deep Agents Integration and Composition

### Goal

Extend the Dawn authoring contract into a composition model that can support Deep Agents without redefining Dawn’s core API yet again.

### Why This Comes Third

Deep Agents should validate that Dawn’s contract can scale to a richer orchestration layer, not define the contract from scratch.

If Deep Agents support forces a rewrite of the Dawn contract, Phase 1 was not strong enough.

### Scope

This phase should explore:

- how Deep Agents concepts map into Dawn authoring
- what composition primitives Dawn should own versus defer
- how multiple routes, tools, and execution layers compose within a Dawn app

This is where tool composition can start to move beyond simple discovery into richer orchestration, but only on top of the already-proven contract.

### Deliverables

- a design for Deep Agents integration on top of the Dawn contract, likely expressed through a package such as `@dawnai.org/deepagents`
- one or more proving examples
- execution and test coverage proving the integration path works
- explicit documentation of what Dawn owns versus what Deep Agents owns

Concrete likely outputs:

- a composition example that uses multiple Dawn-defined tools or routes
- proof that Deep Agents integration composes on top of the Dawn authoring contract instead of forking it
- one runtime or generated-app harness lane proving the Deep Agents path end to end

### Success Criteria

- Dawn can support a non-trivial composition path in the Deep Agents space
- the contract still feels Dawn-owned instead of backend-owned
- the package and docs story stays legible

### What To Defer

- broad deployment/runtime productization
- hosted workflow concepts
- LangSmith replacement ideas

## Phase 4: Richer Authoring Systems

This is a later phase, not the immediate next move.

Potential follow-on areas after the core meta-framework proof is stronger:

- approvals
- memory
- eval authoring
- richer tool policies
- more capable scenario authoring
- package and app upgrade guidance

These should only be pulled forward when the Dawn-owned authoring contract is strong enough that they can be added without destabilizing the foundation.

## Cross-Phase Constraints

These constraints should hold throughout the roadmap.

### Do Not Reopen The CLI/Runtime Boundary Without Cause

The current `verify` / `run` / `test` / `dev` split is good enough to support authoring work.

Do not restart plumbing churn unless a later phase exposes a real contract gap.

### Keep LangSmith As The Trace Layer

Dawn should not invent its own competing trace model.

If richer traces become necessary, they should layer on top of LangSmith semantics rather than fork them.

### Keep Dawn Out Of Deployment Runtime Ownership

Dawn should continue to own local lifecycle only.

Production deployment/runtime concerns should remain aligned with the Agent Server / LangSmith path.

### Preserve Filesystem Discovery As A Core Strength

Dawn’s strongest proven asset so far is filesystem-driven structure, discovery, and verification.

Future authoring systems should extend that strength rather than replace it with opaque registration patterns.

## Recommended Immediate Next Outcomes

Phases 1 and 2 are now complete. The next thread should aim to leave the repo with these outcomes:

1. A written design for Deep Agents integration on top of the `@dawnai.org/sdk` contract (Phase 3)
2. A decision on the `@dawnai.org/deepagents` adapter package structure and route kind
3. A concrete implementation plan for the first composition proof
4. At least one proving example that demonstrates Dawn can support a third execution backend without contract changes

If those outcomes are not reached, the next thread risks circling back to plumbing work instead of closing the actual product gap.

## Suggested Questions For The Next Thread

The next thread should probably resolve these questions in order:

1. What route kind and export name does Deep Agents use? Does `BackendAdapter` need changes to support it?
2. How do Deep Agents concepts (multi-agent orchestration, delegation) map into Dawn's route and tool model?
3. What does the `@dawnai.org/deepagents` adapter look like at its interface boundary with `@dawnai.org/sdk`?
4. What composition primitives does Dawn own versus delegate to Deep Agents?

## Related Documents

- [`docs/thread-handoff.md`](./thread-handoff.md)
- [`docs/superpowers/specs/2026-04-15-dawn-route-authoring-design.md`](./superpowers/specs/2026-04-15-dawn-route-authoring-design.md)
- [`docs/superpowers/specs/2026-04-20-langchain-native-authoring-design.md`](./superpowers/specs/2026-04-20-langchain-native-authoring-design.md)
- [`docs/superpowers/plans/2026-04-15-dawn-route-authoring.md`](./superpowers/plans/2026-04-15-dawn-route-authoring.md)
- [`docs/superpowers/plans/2026-04-20-langchain-native-authoring.md`](./superpowers/plans/2026-04-20-langchain-native-authoring.md)
