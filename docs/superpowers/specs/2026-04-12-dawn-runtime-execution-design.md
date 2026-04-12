# Dawn Runtime Execution Design

Date: 2026-04-12
Status: Proposed
Owner: Dawn

## Summary

Dawn now has structural harness coverage for filesystem contracts, generated apps, and minimal runtime smoke. The next gap is execution semantics: Dawn still needs a stable way to execute one route invocation, assert route behavior, and build test scenarios without conflating those concerns with server lifecycle.

This design introduces three related pieces:

- `dawn run` as the primitive execution command
- `dawn test` as the scenario/assertion layer built on top of `dawn run`
- a new runtime-contract harness lane separate from the existing smoke lane

The first version should stay intentionally narrow:

- app discovery from current working directory by default
- filesystem-path route targeting first
- JSON stdin/stdout execution contract
- in-process execution first
- minimal structural execution results rather than full traces

## Problem

The current harness proves that Dawn can:

1. interpret the filesystem contract
2. scaffold and wire generated apps
3. compile and start a minimal runtime path

It does not yet prove that Dawn can execute a route through a stable public command boundary and produce a normalized execution result that can support local development, scenario testing, and future richer runtime tooling.

Without that next layer, Dawn risks:

- runtime regressions that startup smoke does not catch
- an unclear boundary between execution, testing, and serving
- ad hoc scenario semantics when `dawn test` eventually lands
- duplicated execution logic across harness lanes and future CLI surfaces

## Goals

- Define a clean semantic split between serving, single execution, and scenario testing.
- Add a stable primitive execution surface through `dawn run`.
- Add a narrow `dawn test` surface that builds on the execution primitive.
- Introduce a runtime-contract lane that proves route execution behavior separately from startup smoke.
- Support both `graph.ts` and `workflow.ts` authoring paths equally in the first design.
- Keep the first execution contract small, hermetic, and deterministic.

## Non-Goals

- Full trace-level execution results in v1.
- Tool-call, state-transition, or event-stream tracing in the first contract.
- Server-backed execution as the default path.
- Live model or network-backed execution coverage.
- A broad public testing DSL in the first iteration.

## Design Principles

- One command, one concern:
  - `dawn dev` or `dawn serve` owns the long-lived local runtime
  - `dawn run` owns one route invocation
  - `dawn test` owns assertions and scenarios
- Execution before framework flourish:
  - prove one route invocation cleanly before adding traces, evals, or richer metadata
- Hermetic by default:
  - no network, real model calls, or live wall-clock assumptions in the first runtime contract
- Separate runtime semantics from startup wiring:
  - keep smoke and execution-contract lanes distinct
- Keep the public contract boring:
  - JSON in, JSON out, stable exit codes, stable error classification

## Public Command Model

### `dawn dev` or `dawn serve`

This command family owns the local long-lived runtime. It should compile, watch, and host the local server boundary.

It should not be overloaded as the primary way to execute one invocation. Requiring a daemon to run a single route would make the local developer and CI story slower and more fragile than necessary.

### `dawn run`

`dawn run` is the primitive execution command.

V1 command contract:

- app root discovered from the current working directory by default
- optional `--cwd` override for explicit app targeting
- route selected by filesystem path first
- JSON input read from stdin by default
- JSON result written to stdout by default
- nonzero exit on failure
- in-process execution by default

Example:

```bash
echo '{"tenant":"acme","message":"hello"}' | dawn run src/app/support/[tenant]/graph.ts
```

This should mean:

1. find the Dawn app by walking upward from `cwd`
2. resolve the requested route path relative to that app root
3. execute the route boundary in-process
4. print a normalized JSON result

V1 does not require file-based input/output flags, route ids, or server-backed transport, though those are reasonable next extensions.

### `dawn test`

`dawn test` is the scenario/assertion layer over `dawn run`.

V1 behavior:

- discover colocated TypeScript scenario files such as `run.test.ts`
- execute those scenarios through the same execution primitive as `dawn run`
- print concise pass/fail output for developer use

This keeps the semantic split clear:

- `dawn run`: execute once
- `dawn test`: assert behavior across one or more scenarios

## App Discovery And Route Targeting

### App Discovery

App root discovery should match the existing Dawn CLI pattern:

- use current working directory by default
- walk upward until the Dawn app root is found
- allow `--cwd` override when needed

This keeps `dawn run`, `dawn test`, and `dawn verify` aligned.

### Route Targeting

V1 should target routes by filesystem path first.

Reasons:

- it matches how Dawn authors reason about route boundaries today
- it avoids inventing route-id ergonomics before execution semantics stabilize
- it is easy to support from both local app development and harness fixtures

Examples:

- `dawn run src/app/support/[tenant]/graph.ts`
- `dawn run src/app/support/[tenant]/workflow.ts`
- potentially `dawn run ./graph.ts` from inside a route directory

Normalized route ids can come later once Dawn has a stable execution layer.

## Execution Modes

Three possible execution models were considered:

1. in-process only
2. server-required only
3. both, with one default

Recommended direction:

- support both eventually
- make in-process execution the default in v1
- defer server-backed execution to a later iteration

Why:

- in-process execution is faster, more hermetic, and easier to use in CI and harness lanes
- server-backed execution is useful later for transport realism, but too expensive and noisy as the first contract

The design should still leave room for a future shape like:

- `dawn run <route-path>`
- `dawn run <route-path> --server`
- `dawn run <route-path> --url http://localhost:...`

But v1 should not depend on that path.

## Runtime Result Contract

The first execution contract should be minimal structural output, not a trace model.

### Success Result

V1 success results should include:

- app root
- requested route path
- resolved execution mode: `graph` or `workflow`
- execution status: `passed`
- JSON output payload

### Failure Result

V1 failure results should include:

- app root
- requested route path
- resolved execution mode when available
- execution status: `failed`
- stable error kind
- stable error message

### Deferred Fields

Not part of the first public contract:

- tool call traces
- state transition streams
- event timelines
- model usage details
- approvals or memory traces

Those may come later, but the first result contract should stay small enough to harden quickly.

## Scenario Authoring Model

### Canonical File Shape

V1 scenario files should be separate TypeScript files colocated with the route they cover.

Recommended shape:

```txt
src/app/support/[tenant]/
  graph.ts
  workflow.ts
  run.test.ts
```

This preserves locality without mixing runtime code and scenario code inside the same module.

### Why TypeScript Scenarios

The first scenario format should be code-based rather than JSON/YAML.

Reasons:

- assertions are easier to express in TypeScript
- scenario setup can stay explicit and readable
- the shape can evolve without inventing a DSL too early

### Scope Of V1 Scenarios

V1 should only require enough expressive power to define:

- input payload
- expected success or expected failure
- minimal output assertions
- optional expected error kind/message assertions

That is enough to prove the model without prematurely designing a rich test framework.

## Harness Architecture

### Existing Smoke Lane

`test/smoke/` should remain the startup and wiring lane.

Its purpose remains:

- route compilation
- minimal route boot verification
- minimal startup execution sanity checks

It should not expand into the canonical route-behavior contract lane.

### New Runtime-Contract Lane

Add a new lane under `test/runtime/`.

Its purpose:

- prove execution semantics separately from startup
- prove both `graph.ts` and `workflow.ts`
- prove both direct module execution and CLI-driven execution
- assert minimal structural results only

This separation matters because startup failures and behavior failures are different classes of regressions and require different debugging paths.

### Direct And CLI Surfaces

The framework harness should use two execution surfaces:

1. direct module execution
2. CLI execution through `dawn run`

Both are valuable:

- direct execution is faster and isolates runtime-contract failures from CLI parsing and process concerns
- CLI execution proves the public command shape actually works

`dawn test` should build on the same underlying execution primitive, not invent a second runtime path.

## Recommended Repo Shape

Recommended additions:

```txt
packages/
  cli/
    src/commands/run.ts
    src/commands/test.ts
    src/lib/runtime/
      resolve-route-target.ts
      run-route.ts
      load-run-scenarios.ts
test/
  runtime/
    fixtures/
      graph-basic/
      graph-failure/
      workflow-basic/
      workflow-failure/
    run-runtime-contract.test.ts
```

Scenario files for app-level authoring should live with the route directories they cover, while framework-owned runtime fixtures can live under `test/runtime/fixtures/`.

## Error Handling

### `dawn run`

`dawn run` should distinguish at least three failure classes in v1:

- app discovery failure
- route resolution or unsupported route boundary failure
- execution failure

These should map to:

- stable nonzero exits
- stable error kind/message fields in JSON output
- concise human-readable stderr or stdout behavior, depending on mode

### `dawn test`

`dawn test` failures should distinguish:

- scenario load failure
- route execution failure
- assertion failure

This matters because “the route crashed” and “the route returned the wrong shape” are different classes of failure and should not be flattened together.

## Testing Strategy

The next implementation should add coverage in this order:

1. direct runtime-contract fixtures for `graph.ts` and `workflow.ts`
2. CLI coverage for `dawn run`
3. scenario discovery and execution coverage for `dawn test`
4. integration of the runtime-contract lane into root harness reporting and CI

The first contract should explicitly include:

- one passing graph fixture
- one failing graph fixture
- one passing workflow fixture
- one failing workflow fixture

This is enough to establish the shape without building too much policy too early.

## Risks

- If `dawn run` starts owning server lifecycle, the command boundary will become muddy again.
- If `dawn test` grows a DSL too early, Dawn will overbuild the scenario layer before the execution contract is stable.
- If direct execution and CLI execution drift, the runtime harness will become confusing and failures will be harder to diagnose.
- If the runtime-contract lane absorbs startup/wiring concerns from smoke, the harness will lose clarity.

## Recommendation

Dawn should adopt this next-step design:

- keep `dawn dev` or `dawn serve` as the long-lived runtime boundary
- add `dawn run` as the primitive execution surface
- add `dawn test` as a thin scenario/assertion layer over `dawn run`
- add a new `test/runtime/` lane for execution-contract coverage
- keep v1 execution results minimal and structural
- defer server-backed execution, trace results, and richer scenario semantics until the primitive runtime contract is stable

This gives Dawn a clean execution model that can support developer workflows, harness hardening, and later richer runtime tooling without overcommitting too early.
