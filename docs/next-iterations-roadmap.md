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
- a Dawn-owned backend-neutral authoring contract (`@dawn/sdk`)
- `@dawn/langgraph` as the first backend adapter implementing the `@dawn/sdk` contract
- filesystem-driven tool registration and discovery

Dawn does not yet have:

- a LangChain-native authoring path
- a Deep Agents composition layer
- a mature higher-level model for tools, workflows, approvals, memory, evals, or traces

That means the next work should focus on authoring breadth, not more generic plumbing.

The following should be treated as already stabilized enough for the roadmap phases below:

- app/project plumbing
- route discovery and route identity
- `verify` / `run` / `test` / `dev` command boundaries
- local dev runtime ownership
- first-generation route authoring and filesystem tool discovery

The following should be treated as still provisional and subject to new design work:

- backend-neutral authoring semantics
- cross-backend package structure
- higher-level tool composition
- LangChain-native and Deep Agents authoring models

## Phase 1: Dawn-Owned Authoring Contract (Complete)

### Goal

Define a Dawn authoring contract that is semantically owned by Dawn rather than inherited from LangGraph implementation details.

### Status

This phase is complete as of the authoring-sdk milestone.

`@dawn/sdk` is the Dawn-owned backend-neutral package containing the full author-facing contract: route types, runtime context types (`RuntimeContext`, `RuntimeTool`), and the `index.ts`-per-route convention. Tools are plain default-exported functions with names inferred from filenames. `@dawn/langgraph` is now an adapter that implements the `@dawn/sdk` contract and wires it to LangGraph execution.

Authors depend on `@dawn/sdk` for type annotations only. `@dawn/langgraph` remains available for backwards compatibility but is no longer the canonical author surface.

## Phase 2: LangChain-Native Authoring

### Goal

Prove that the Dawn-owned authoring contract can support a real LangChain-native path instead of only the current LangGraph-thin surface.

### Why This Comes Second

This is the first real proof that Dawn is becoming a meta-framework instead of a LangGraph-first runtime shell.

If the same Dawn contract can drive a LangChain-native authoring path without warping the contract, Dawn’s core thesis becomes materially stronger.

### Scope

This phase should introduce:

- a LangChain-native authoring surface or adapter package
- clear mapping from Dawn authoring concepts to LangChain execution semantics
- examples that show the same Dawn authoring model applied in a LangChain-native lane

The work should remain focused on authoring, not deployment/runtime reinvention.

### Deliverables

- a package or integration layer for LangChain-native authoring, likely under a package name such as `@dawn/langchain`
- at least one meaningful example app or route proving the path
- runtime and test coverage for the new backend lane
- docs explaining the relationship between Dawn authoring and LangChain-native execution

Concrete likely outputs:

- a minimal but real LangChain-native route or workflow example
- one generated or fixture app that proves the LangChain lane in `dawn run`, `dawn test`, and `dawn dev`
- package-level tests that prove the LangChain lane implements the Dawn contract instead of bypassing it

### Success Criteria

- Dawn can demonstrate one real authoring flow that is not LangGraph-thin
- the Dawn contract remains coherent across the existing and new lanes
- users can understand where Dawn ends and LangChain begins

### What To Defer

- Deep Agents composition
- generalized plugin ecosystems
- deployment/runtime management work

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

- a design for Deep Agents integration on top of the Dawn contract, likely expressed through a package such as `@dawn/deepagents`
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

Phase 1 is now complete. The next thread should aim to leave the repo with these outcomes:

1. A written design for LangChain-native authoring on top of the `@dawn/sdk` contract (Phase 2)
2. A decision on the adapter package structure for `@dawn/langchain`
3. A concrete implementation plan for the first real cross-backend authoring proof
4. At least one proving example that demonstrates Dawn is not solely a LangGraph-oriented shell

If those outcomes are not reached, the next thread risks circling back to plumbing work instead of closing the actual product gap.

## Suggested Questions For The Next Thread

The next thread should probably resolve these questions in order:

1. What is the minimal LangChain-native route or workflow example that proves the `@dawn/sdk` contract is not LangGraph-specific?
2. What does the `@dawn/langchain` adapter package look like at its interface boundary with `@dawn/sdk`?
3. What runtime and discovery changes (if any) are needed to support a second backend adapter in `dawn run` and `dawn test`?
4. What should Phase 2 explicitly refuse to own yet?

## Related Documents

- [`docs/thread-handoff.md`](./thread-handoff.md)
- [`docs/superpowers/specs/2026-04-15-dawn-route-authoring-design.md`](./superpowers/specs/2026-04-15-dawn-route-authoring-design.md)
- [`docs/superpowers/plans/2026-04-15-dawn-route-authoring.md`](./superpowers/plans/2026-04-15-dawn-route-authoring.md)
