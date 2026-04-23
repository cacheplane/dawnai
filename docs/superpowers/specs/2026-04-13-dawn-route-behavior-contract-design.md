# Dawn Route Behavior Contract Design

Date: 2026-04-13
Status: Proposed
Owner: Dawn

## Summary

Dawn now has a first runtime execution layer:

- `dawn run` executes one route in-process
- `dawn test` runs colocated `run.test.ts` scenarios
- the runtime harness proves minimal structural behavior

The next gap is contract hardening. Dawn still needs one normalized route-behavior contract that works across:

- in-process execution
- server-backed execution
- `dawn test`
- framework runtime harnesses
- downstream generated apps

This design extends the current runtime model in four directions:

1. formalize a richer normalized execution result
2. add server-backed `dawn run --url`
3. expand `dawn test` assertions beyond flat equality checks
4. validate the same runtime behavior in external Dawn apps, not only inside the framework repo

## Problem

The current runtime contract is intentionally minimal. That was the correct first step, but it now creates four constraints:

1. `dawn run` cannot yet validate the served runtime boundary
2. `dawn test` has only a narrow assertion surface, which will calcify if left alone
3. the framework harness proves mostly structural runtime behavior, not richer route-behavior metadata
4. Dawn still has limited proof that the same runtime behavior holds in downstream-generated apps

Without a stronger route-behavior contract, Dawn risks:

- drift between in-process and served execution
- ad hoc assertion semantics in `run.test.ts`
- duplicated behavior checks across harnesses and external-app tests
- transport details leaking into the public contract
- premature reinvention of tracing that should live in LangSmith

## Goals

- Define one normalized execution result for Dawn route behavior.
- Support both in-process and server-backed execution without splitting the result contract.
- Keep `dawn run` as the primitive execution command.
- Keep `dawn test` as the scenario/assertion layer over `dawn run`.
- Improve `dawn test` with nested output matching, route metadata assertions, and better failure diffs.
- Extend the framework harness to validate the richer behavior contract.
- Add downstream-generated app runtime verification for the same contract.
- Keep Dawn’s transport and observability boundaries aligned with LangGraph, LangChain, and LangSmith.

## Non-Goals

- Defining a Dawn-specific trace model in v1.1.
- Replacing the underlying LangChain or LangGraph server contract.
- Making `dawn run` responsible for server lifecycle.
- Building a broad public testing DSL.
- Adding live network/model integration coverage to the default runtime lane.

## Design Principles

- One result contract, many execution surfaces.
- `dawn run` executes once; `dawn test` asserts behavior; `dawn serve` owns lifecycle.
- Use the LangChain/LangGraph server contract as the server transport baseline.
- Normalize transport differences into Dawn’s result envelope rather than exposing them as separate public modes.
- Keep traces and observability on top of LangSmith rather than duplicating them inside Dawn.
- Prefer the simple path by default and keep diagnostics opt-in.

## Runtime Boundary

Dawn remains a meta framework. It should not replace the runtime substrate underneath LangGraph or LangChain.

For server-backed execution, the baseline transport contract should be the LangChain/LangGraph server contract. Dawn can extend this later through adapters or metadata negotiation, but v1.1 should not fork it.

This creates a clean layering:

- LangChain/LangGraph server contract: transport baseline
- Dawn execution result: normalized developer-facing contract
- LangSmith: traces, observability, deployment-time runtime visibility

When deployed, a Dawn app should fit naturally into a LangSmith-centered runtime story. Dawn should normalize execution and testing semantics, not own tracing.

## Normalized Execution Result

The next version of the Dawn execution result should include:

- `routePath`
- `routeId`
- `mode`
- `status`
- `output`
- `error`
- `appRoot`
- `executionSource`
- `startedAt`
- `finishedAt`
- `durationMs`
- `diagnostics`

Conceptually:

```ts
type DawnExecutionResult =
  | {
      appRoot: string | null;
      diagnostics?: Record<string, unknown>;
      durationMs: number;
      executionSource: "in-process" | "server";
      finishedAt: string;
      mode: "graph" | "workflow";
      output: unknown;
      routeId: string;
      routePath: string;
      startedAt: string;
      status: "passed";
    }
  | {
      appRoot: string | null;
      diagnostics?: Record<string, unknown>;
      durationMs: number;
      error: {
        details?: Record<string, unknown>;
        kind:
          | "app_discovery_error"
          | "route_resolution_error"
          | "unsupported_route_boundary"
          | "execution_error"
          | "server_transport_error";
        message: string;
      };
      executionSource: "in-process" | "server";
      finishedAt: string;
      mode: "graph" | "workflow";
      routeId: string;
      routePath: string;
      startedAt: string;
      status: "failed";
    };
```

### Field Definitions

#### Route identity

- `routePath`: the app-root-relative route path Dawn executed
- `routeId`: Dawn’s normalized route identity derived from the resolved route path

`routePath` preserves author ergonomics. It is always app-root-relative, for example `src/app/support/[tenant]/graph.ts`.

`routeId` gives Dawn a stable identity for reporting and future runtime surfaces. In v1.1 it is derived from the route directory relative to the configured `appDir`, normalized to a leading-slash route form with no executable filename:

- `src/app/support/[tenant]/graph.ts` -> `/support/[tenant]`
- `src/custom-app/docs/workflow.ts` -> `/docs`

`graph.ts` and `workflow.ts` in the same route directory therefore share the same `routeId`.

#### Mode

`mode` remains `graph` or `workflow`.

#### Status

`status` remains `passed` or `failed`.

#### Output and Error

- `output` is present on `passed`
- `error` is present on `failed`

The error shape should keep Dawn’s normalized classification rather than exposing raw transport or exception internals as the primary contract.

`error.kind` should stay in Dawn’s normalized namespace:

- `app_discovery_error`
- `route_resolution_error`
- `unsupported_route_boundary`
- `execution_error`
- `server_transport_error`

`error.message` is always a human-readable string. `error.details` is optional diagnostic context and should not be required for assertions.

#### App context

`appRoot` remains part of the result so CLI output and harness artifacts can be tied back to the resolved Dawn app.

#### Execution source

`executionSource` should be one of:

- `in-process`
- `server`

This is important for `dawn test`, harness reporting, and downstream verification.

#### Timing

The result should include:

- `startedAt`
- `finishedAt`
- `durationMs`

These fields should support assertion and reporting, but Dawn should not pretend they are precise trace events.

#### Diagnostics

`diagnostics` is optional and should be used only for explicit verbose/debug paths. It can contain raw transport payloads, HTTP status details, or other implementation-specific context. It should not be required for normal assertions.

### Example

```json
{
  "appRoot": "/workspace/my-app",
  "durationMs": 18,
  "executionSource": "server",
  "finishedAt": "2026-04-13T18:05:11.712Z",
  "mode": "graph",
  "output": {
    "greeting": "hello",
    "profile": {
      "tenant": "acme"
    }
  },
  "routeId": "/support/[tenant]",
  "routePath": "src/app/support/[tenant]/graph.ts",
  "startedAt": "2026-04-13T18:05:11.694Z",
  "status": "passed"
}
```

## `dawn run`

### Command Boundary

`dawn run` remains the primitive execution command. It should keep:

- current working directory app discovery by default
- optional `--cwd`
- filesystem-path route targeting first
- JSON stdin/stdout contract

The new addition is opt-in server-backed execution:

```bash
echo '{"tenant":"acme","message":"hello"}' | dawn run src/app/support/[tenant]/graph.ts
echo '{"tenant":"acme","message":"hello"}' | dawn run src/app/support/[tenant]/graph.ts --url http://localhost:2024
```

### Server Mode

`--url` should target an already-running runtime. Dawn should:

1. discover the app from `cwd`
2. resolve the local filesystem route path
3. derive the normalized route identity
4. invoke the server using the baseline LangChain/LangGraph transport contract
5. normalize the response into the same Dawn result shape used by in-process execution

### Transport Mapping

V1.1 should use the documented stateless wait flow:

- HTTP method: `POST`
- endpoint: `/runs/wait`
- request body:
  - `assistant_id`: the Dawn server execution identifier
  - `input`: the stdin JSON payload
  - `metadata.dawn.route_path`: the resolved `routePath`
  - `metadata.dawn.route_id`: the normalized `routeId`
  - `metadata.dawn.mode`: the resolved execution `mode`
  - `on_completion`: `"delete"`

The server execution identifier must be mode-qualified so server mode can disambiguate `graph.ts` vs `workflow.ts` in the same route directory. V1.1 should use:

- `${routeId}#graph`
- `${routeId}#workflow`

Conceptually:

```json
{
  "assistant_id": "/support/[tenant]#graph",
  "input": {
    "tenant": "acme",
    "message": "hello"
  },
  "metadata": {
    "dawn": {
      "mode": "graph",
      "route_id": "/support/[tenant]",
      "route_path": "src/app/support/[tenant]/graph.ts"
    }
  },
  "on_completion": "delete"
}
```

Response normalization rules:

- `200` with JSON response body:
  - treat the response body as the raw route output
  - normalize into a Dawn success result with `executionSource: "server"`
- non-`200` response with server error payload:
  - normalize to `status: "failed"`
  - use `error.kind: "server_transport_error"` unless Dawn can confidently classify it as a normalized execution error
  - preserve raw HTTP status and payload under `diagnostics` in debug paths

This keeps Dawn transport-compatible with Agent Server while still preserving Dawn’s own result contract.

### Compatibility Guardrails

V1.1 server mode is intentionally narrow:

- it is supported only against Dawn-served runtimes built on the current Agent Server stateless run contract
- Dawn should not silently fall back to another endpoint or protocol
- if `/runs/wait` is missing, the response shape is unrecognized, or the server cannot execute the requested mode-qualified assistant id, Dawn should surface a normalized `server_transport_error`
- capability negotiation and broader adapter discovery are deferred to a later design

### What `dawn run` Must Not Do

`dawn run` should not:

- build the server
- watch files
- boot or manage a daemon
- invent a second transport contract
- expose raw transport output as the default result

That separation remains:

- `dawn serve` or `dawn dev`: lifecycle
- `dawn run`: one invocation
- `dawn test`: assertions and scenarios

## `dawn test`

### Scenario Model

`run.test.ts` remains the canonical authoring model. It should stay code-based.

The next version should support both:

- declarative expectations for the common path
- helper assertions for more complex cases

This should not become a broad DSL. It should stay a small TypeScript contract over Dawn’s normalized execution result.

### Scenario Interface

Each `run.test.ts` file exports a default array of scenario objects.

Each scenario must include:

- `name: string`
- `target: "./graph.ts" | "./workflow.ts"`
- `input: unknown`

Each scenario must include at least one of:

- `expect`
- `assert(result)`

Optional execution controls:

- `run.url?: string`

`target` remains strictly colocated-only in v1.1:

- it must be exactly `./graph.ts` or `./workflow.ts`
- cross-directory targets remain invalid
- scenario files continue to apply to the route directory they are colocated with

### Helper API

The first helper surface should stay intentionally small:

- `expectOutput(result, expected)`
- `expectError(result, expected)`
- `expectMeta(result, expected)`

These helpers should use the same matching semantics as declarative `expect` and should fail with Dawn-owned diff messages rather than exposing raw assertion-library output as the primary UX.

### Declarative `expect`

The declarative shape should support:

```ts
type ScenarioExpectation = {
  status: "passed" | "failed";
  output?: unknown;
  error?: {
    kind?:
      | "app_discovery_error"
      | "route_resolution_error"
      | "unsupported_route_boundary"
      | "execution_error"
      | "server_transport_error";
    message?: string | { includes: string };
  };
  meta?: {
    executionSource?: "in-process" | "server";
    mode?: "graph" | "workflow";
    routeId?: string;
    routePath?: string;
  };
};
```

Matching rules:

- `status` matches exactly
- object `output` matching is deep-partial subset matching
- primitive `output` matching is exact
- array `output` matching is exact in v1.1
- `error.kind` matches exactly when provided
- `error.message` matches exactly for string values and substring containment for `{ includes: string }`
- `meta` fields match exactly when provided

### Imperative `assert(result)`

`assert(result)` receives the full normalized Dawn result after declarative `expect` evaluation, if `expect` is present. It is an escape hatch for harder cases and should not replace the common declarative path.

When both are present:

1. Dawn evaluates declarative `expect` first
2. if declarative matching fails, the scenario fails and `assert(result)` does not run
3. if declarative matching passes, Dawn runs `assert(result)`
4. any thrown assertion error or failed helper assertion fails the scenario

### Recommended Shape

```ts
import { expectMeta, expectOutput } from "@dawnai.org/cli/testing";

export default [
  {
    name: "graph returns greeting",
    target: "./graph.ts",
    input: { tenant: "acme", message: "hello" },
    expect: {
      status: "passed",
      output: {
        greeting: "hello",
        profile: {
          tenant: "acme"
        }
      },
      meta: {
        mode: "graph",
        executionSource: "in-process"
      }
    }
  },
  {
    name: "server mode preserves route metadata",
    target: "./graph.ts",
    input: { tenant: "acme", message: "hello" },
    run: {
      url: "http://localhost:2024"
    },
    assert(result) {
      expectMeta(result, {
        executionSource: "server",
        mode: "graph"
      });
      expectOutput(result, {
        profile: {
          tenant: "acme"
        }
      });
    }
  }
];
```

### Assertion Rules

- Declarative `expect` remains the default path.
- `assert(result)` is the escape hatch.
- Assertion helpers should operate on Dawn’s normalized result, not on raw HTTP payloads.
- Nested object matching should be supported directly.
- Metadata assertions should be first-class.
- Failure output should produce useful diffs instead of flat “expected/received” strings where possible.

### Supported Assertion Areas

The next version of `dawn test` should support:

- nested output matching
- normalized error assertions
- route metadata assertions
- execution-source assertions
- basic timing assertions only where they are meaningful and stable

It should not yet support:

- trace-step assertions
- tool-call assertions
- LangSmith trace assertions

## Harness Strategy

The framework harness should expand in a layered way rather than collapsing runtime and smoke coverage together.

### Framework Runtime Lane

`test/runtime/` should validate:

- richer normalized result envelopes
- in-process execution
- server-backed `dawn run --url` execution against a controlled local runtime fixture
- route metadata parity between the two execution modes

### Smoke Lane

`test/smoke/` should remain focused on startup and wiring. It should not absorb route-behavior assertions that belong in `test/runtime/`.

### Downstream Runtime Verification

Dawn should add runtime verification for downstream apps in two forms:

1. generated external apps from `pnpm create dawn-app`
2. a small handwritten external app only where generated fixtures are too blunt

Generated external apps should be the primary path because they prove the actual user journey.

These downstream checks should validate:

- `dawn run` in-process
- `dawn run --url`
- `dawn test`

The important rule is reuse: the downstream checks should assert the same normalized behavior contract as the framework runtime lane.

## Reporting

Harness reporting should treat richer runtime behavior as structured data, not ad hoc console strings.

Per execution, Dawn should preserve:

- normalized result JSON
- command transcript
- artifact location
- execution source
- route identity

This supports both framework diagnosis and downstream-app diagnosis without requiring a second result model.

## Risks

- If Dawn exposes raw server transport details as the primary contract, in-process and server execution will drift.
- If `dawn run` starts managing server lifecycle, the command boundary will collapse.
- If `dawn test` becomes a custom DSL too early, the scenario layer will bloat before the behavior contract stabilizes.
- If Dawn invents a trace model now, it will overlap badly with LangSmith.
- If downstream verification is delayed, Dawn may harden only the monorepo path and miss real-consumer regressions.

## Recommendation

The next runtime-hardening phase should be one subproject:

- formalize the richer normalized route-behavior result
- add `dawn run --url` over the baseline LangChain/LangGraph server contract
- expand `dawn test` with nested output matching, metadata assertions, and helper-based escape hatches
- extend runtime verification to downstream-generated apps

This keeps Dawn’s role clear:

- a meta framework that normalizes execution and testing semantics
- not a replacement transport runtime
- not a replacement trace platform

The correct next artifact after this spec is a focused implementation plan for the route-behavior contract expansion.
