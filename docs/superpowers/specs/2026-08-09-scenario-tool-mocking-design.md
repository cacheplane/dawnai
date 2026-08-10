# Scenario Tool Mocking Design

**Status:** Approved 2026-08-09

## Summary

Replace the plain-array `run.test.ts` authoring format with a route-scoped,
fluent scenario builder and add typed, invocation-local tool mocks for
in-process scenarios. The builder makes the scenario surface discoverable
through IntelliSense, while generated route metadata narrows tool names, mock
inputs and returns, and call expectations.

Tool mocks replace only explicitly named application tools. Unlisted tools run
their real implementations. The mocks do not apply to built-in capability
tools or propagate into subagent routes. Server-backed scenarios remain an
unmocked integration boundary: combining `.server()` and `.mockTool()` is a
compile-time error where possible and always a scenario-load error.

There is no backwards-compatibility path for default-exported scenario arrays.

## Goals

- Make the complete scenario API discoverable from the route-scoped builder.
- Type mock names and implementations against generated route tool types.
- Replace selected route-local or shared tool implementations for one
  in-process scenario invocation.
- Record mock calls and provide first-class count and argument assertions.
- Preserve real tool metadata and all unmocked route behavior.
- Fail configuration mistakes before route execution.
- Keep server-backed scenarios free of a production runtime mocking protocol.

## Non-Goals

- Sending executable or declarative tool mocks to `run.url` servers.
- Mocking built-in planning, workspace, memory, skill, or subagent capability
  tools.
- Propagating a parent route's mocks to child subagent routes.
- Replacing every route tool when any mock is present.
- Tool-call ordering or mock return-value assertions in v1.
- A scripted `mockTool().when().returns()` response language.
- Inferring scenario input or route output types from `state.ts`.
- Preserving the plain default-exported array format.

## Authoring API

`@dawn-ai/sdk/testing` exports `scenarios()`. A route's `run.test.ts` default
exports the resulting branded suite:

```ts
import { scenarios } from "@dawn-ai/sdk/testing"

export default scenarios("/research")
  .scenario("summarizes controlled results", (s) =>
    s
      .input({
        messages: [{ role: "user", content: "Research Dawn" }],
      })
      .mockTool("searchWeb", async ({ query }) => ({
        results: [{ title: `Result for ${query}` }],
      }))
      .expectPassed()
      .expectOutput({
        answer: "Result for Dawn",
      })
      .expectTool("searchWeb", (call) =>
        call.calledOnce().withArgs({ query: "Dawn" }),
      ),
  )
  .scenario("reports search failure", (s) =>
    s
      .input({
        messages: [{ role: "user", content: "Research Dawn" }],
      })
      .mockTool("searchWeb", async () => {
        throw new Error("search unavailable")
      })
      .expectFailed()
      .expectError({
        message: { includes: "search unavailable" },
      }),
  )
```

The suite builder exposes `.scenario(name, configure)`. The scenario builder
exposes:

- `.input(value)`
- `.mockTool(name, implementation)`
- `.server(url)`
- `.expectPassed()`
- `.expectFailed()`
- `.expectOutput(partial)`
- `.expectMeta(partial)`
- `.expectError(expectation)`
- `.expectTool(name, configure)`
- `.assert(callback)`

The call-expectation builder passed to `.expectTool()` exposes:

- `.called()`
- `.calledOnce()`
- `.calledTimes(count)`
- `.notCalled()`
- `.withArgs(partial)`

The `.expectTool()` callback keeps the nested call builder scoped and returns
the scenario builder, so the main fluent chain remains readable.

## Generated Route Types

The `@dawn-ai/sdk/testing` entry point directly owns an open
`RouteScenarioMap` interface. Dawn typegen augments that exact public module
with every discovered route. Declaring the interface at the subpath, rather
than re-exporting it from another SDK module, ensures TypeScript module
augmentation merges with the symbol used by `scenarios()`. A generated entry
has this conceptual shape:

```ts
declare module "@dawn-ai/sdk/testing" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly searchWeb: (
          input: { readonly query: string },
        ) => Promise<SearchResult>
      }
    }
  }
}
```

The package augmentation is emitted as a separate external declaration file,
`.dawn/scenarios.generated.d.ts`. It starts with a side-effect import of
`@dawn-ai/sdk/testing` before the `declare module` block, which makes the block
an augmentation of the real package rather than a new ambient module that
would hide the package's existing exports. The existing
`.dawn/dawn.generated.d.ts` remains a global declaration file for the virtual
`dawn:routes` module and references the sibling scenario declaration with a
triple-slash path directive. CLI and Vite typegen both write the pair.
The tracked `.dawn` declarations shipped by the basic and research scaffold
templates are regenerated as the same pair so a newly created app has the
correct testing types before its first explicit typegen run.

The route argument to `scenarios("/research")` indexes this map. It provides:

- the valid route-path union;
- application tool names after shared and route-local precedence is resolved;
- each mock's parameter tuple and awaited return type;
- each call expectation's argument type.

`.input()` and `.expectOutput()` accept `unknown` for every route in v1. Dawn's
current state typegen emits one approximate state shape from parsed defaults;
it does not distinguish schema input from output, add the agent message state,
or compose dynamic route parameters. Treating that shape as the scenario input
or output would reject valid scenarios and incorrectly require some defaulted
fields. State-aware scenario typing therefore requires a separate design.

Tool mocks remain narrow and fully typed because current tool typegen already
extracts each discovered tool's parameter tuple and return type. The generated
scenario map must contain every route, including routes with no application
tools, so route-path completion never depends on optional route features. A
route with no application tools has a tool map whose key type is `never`, which
makes `.mockTool()` unusable for that route at compile time.

Scenario typegen receives the resolved route-local and shared application-tool
list before planning, skills, subagent, workspace, or memory capability tools
are appended to the ordinary `dawn:routes` tool surface. This keeps capability
tools out of `.mockTool()` completion as well as runtime override validation.

## Builder Type States

The TypeScript surface makes invalid combinations unavailable where practical:

- `.input()` is required exactly once.
- `.expectPassed()` or `.expectFailed()` is required exactly once.
- `.expectOutput()` is available only for a passing scenario.
- `.expectError()` is available only for a failing scenario.
- Calling `.mockTool()` removes `.server()` from subsequent states.
- Calling `.server()` removes `.mockTool()` and `.expectTool()`.
- `.expectTool()` accepts only tool names mocked earlier in the chain.
- A tool name already passed to `.mockTool()` is excluded from later
  `.mockTool()` calls.
- The `.expectTool()` callback must add at least one count or argument
  assertion before returning.
- A call expectation accepts at most one of `.called()`, `.calledOnce()`,
  `.calledTimes()`, or `.notCalled()`.

Runtime validation remains authoritative for JavaScript callers, type casts,
and manually forged values. The configure callback must return a completed
builder state with input and expected status set.

## Suite Descriptor

The SDK builders produce a branded suite descriptor. They do not register
global state and do not import CLI or filesystem modules. The CLI uses an SDK
exported `isScenarioSuite()` guard and normalizes the descriptor into its
internal loaded-scenario shape.

The descriptor contains one record per scenario with these concepts:

```ts
interface ScenarioDescriptor {
  readonly name: string
  readonly input: unknown
  readonly execution: "in-process" | { readonly serverUrl: string }
  readonly toolMocks: ReadonlyMap<string, ScenarioToolMock>
  readonly expectations: readonly ScenarioExpectation[]
  readonly assert?: ScenarioAssertion
}
```

This shape is internal. Authors interact only with the fluent builders.

## Loading And Validation

The CLI keeps the existing recursive `run.test.ts` discovery and path
narrowing. For each file it:

1. Imports the module.
2. Requires the default export to pass `isScenarioSuite()`.
3. Resolves the sibling route entry and inferred route identity.
4. Confirms the suite's declared route equals the inferred route ID.
5. Normalizes every scenario descriptor.
6. Resolves the route's application tool names once for runtime validation.
7. Rejects invalid suite configuration before invoking any route.

Configuration failures are scenario-load failures and exit with code `2`:

- a non-suite default export, including a plain array;
- a declared route that does not match the file location;
- a missing input or expected status;
- duplicate scenario names within one suite;
- duplicate tool mocks;
- a mock for an unknown application tool;
- a tool mock combined with server execution; or
- malformed builder output from an untyped caller.

The plain-array error names the required `scenarios("/route")` API directly.
No legacy array normalization is retained.

## Runtime Tool Replacement

The CLI adds an internal invocation option carrying tool overrides and a fresh
call journal. The option is threaded into route preparation explicitly; it is
not global boot state.

For an in-process mocked scenario:

1. Route preparation obtains the cached, discovered route modules and real
   application tool definitions.
2. It validates each override against the resolved tool set.
3. It creates a new tool array for the invocation.
4. Each overridden definition preserves its real name, schema, description,
   scope, and source path.
5. Only the definition's `run` function is replaced with a journaled wrapper.
6. Capability contributions are applied through the normal preparation path.
7. The normal route adapter executes with the resulting tools.

The cached prepared-module payload is never mutated. This prevents one
scenario's mocks from leaking into another scenario, an ordinary CLI run, or a
later server request in the same process.

Overrides apply only to the root scenario route. The child preparation path
used by subagent dispatch does not receive them. Built-in capability tools are
added outside the application-tool override set and cannot be shadowed.

## Partial Override Semantics

`mockTool()` replaces only the named application tool. Other route-local and
shared tools keep their real implementations. This lets a scenario isolate an
external API while continuing to exercise deterministic application tools.

Shared and route-local name precedence is resolved before mocks are applied,
using the same final tool map as ordinary execution. A mock therefore targets
the tool the route would actually receive.

Requiring a complete mock map or failing when an unmocked application tool is
invoked is deferred. Those policies would make scenarios more isolated but
would also force tests to duplicate harmless tool behavior.

## Call Journal And Assertions

Each invocation owns a call journal. A mock wrapper records the tool name,
arguments, and monotonically increasing sequence before invoking the mock.
Calls that throw remain recorded. The exception follows the normal route tool
error path and is not treated as malformed test configuration.

Call assertions have these semantics:

- `.called()` requires at least one total call.
- `.calledOnce()` requires exactly one total call.
- `.calledTimes(n)` requires exactly `n` total calls.
- `.notCalled()` requires zero total calls.
- `.withArgs(partial)` requires at least one call whose arguments contain the
  supplied deep-partial object.
- Count and argument assertions are independent when combined.
- Primitive values and arrays match exactly.
- Zero-argument tools do not expose `.withArgs()` in their call-expectation
  type.
- `.notCalled()` does not expose `.withArgs()` because the constraints cannot
  both succeed.
- Multiple `.withArgs()` calls each require a matching invocation. The same
  invocation may satisfy more than one compatible argument matcher.

Only mocked tools can be used with `.expectTool()` in v1. Call ordering and
return-value assertions are deferred.

The CLI evaluates scenario expectations in this order:

1. Expected pass or fail status.
2. Runtime metadata.
3. Output or modeled error.
4. Mock tool-call expectations.
5. The custom assertion callback.

An unexpected route execution failure remains the primary failure rather than
being hidden by a secondary missing-call assertion.

Scenario assertion failures exit with code `1`. They include status, output,
metadata, error, call count, call arguments, and custom assertion mismatches.

## Server Boundary

Server-backed scenarios execute in a different process and communicate over
JSON. JavaScript mock functions cannot cross that boundary. Dawn will not add
a server test backdoor or a serializable mock interpreter in this feature.

`.server(url)` and `.mockTool()` are mutually exclusive in builder types and
runtime validation. Server-backed scenarios continue to test middleware,
route lookup, runtime boot wiring, protocol serialization, packaged static
modules, and deployed infrastructure using the server's configured tools.

External dependencies in server tests should be controlled at their real
boundary, such as a local fake HTTP service or a model proxy configured when
the server starts.

## Documentation

Update the testing guide to teach the builder as the only `run.test.ts`
authoring format. The guide must explain:

- route-scoped IntelliSense;
- partial application-tool replacement;
- call assertions;
- mock isolation;
- the capability and subagent boundaries;
- why server-backed scenarios cannot use tool mocks; and
- when server-backed scenarios are appropriate.

Update CLI documentation generation, generated runtime fixtures, examples,
and README snippets that currently default-export arrays.

## Testing

Implementation follows TDD and covers:

1. SDK contract tests for route paths, tool names, zero-argument and typed-input
   mock parameters, awaited returns, call arguments, builder completion, and
   invalid server/mock states. The contracts also prove scenario input and
   output remain `unknown` rather than reusing generated state defaults.
2. SDK unit tests for builder normalization, branding, duplicate detection,
   and malformed callback results.
3. Core typegen snapshots plus CLI and Vite emission tests for the complete,
   application-only `RouteScenarioMap` augmentation.
4. CLI loader tests for branded suites, route matching, duplicate names,
   unknown mocks, plain-array rejection, and configuration failure messages.
5. Runtime tests proving a named tool is replaced while unlisted tools remain
   real and metadata is preserved.
6. Agent and graph or workflow execution coverage.
7. Isolation tests proving overrides and journals do not mutate cached route
   modules or leak between scenarios.
8. A subagent test proving parent mocks do not propagate into child routes.
9. Server-backed regression coverage and explicit mock rejection.
10. Documentation generation and repository Definition of Done checks.

## Release

Add patch changesets for `@dawn-ai/sdk`, `@dawn-ai/core`, `@dawn-ai/cli`,
`@dawn-ai/vite-plugin`, and `@dawn-ai/devkit`. Core owns the new renderer, the
CLI and Vite plugin both emit the generated augmentation, and Devkit ships the
refreshed declaration pair in starter templates. Dawn's fixed 0.x release
group must remain on the 0.8.x line, so this feature does not use a minor
changeset.
