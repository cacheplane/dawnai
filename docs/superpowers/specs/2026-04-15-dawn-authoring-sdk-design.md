# Dawn Authoring SDK Design

## Goal

Extract Dawn's author-facing contract from `@dawnai.org/langgraph` into a new backend-neutral package `@dawnai.org/sdk`, and replace the `route.ts` + `workflow.ts`/`graph.ts` convention with a single `index.ts` per route whose kind is inferred from its named exports.

This milestone moves Dawn from:

- a LangGraph-first repo with a LangGraph-owned authoring surface

to:

- a backend-neutral authoring surface that LangGraph (and future LangChain, Deep Agents) implement

without yet introducing a pluggable backend adapter runtime.

## Why This Exists

The current authoring surface lives entirely in `@dawnai.org/langgraph`:

- `defineRoute`, `defineTool`, `RouteDefinition`, `RuntimeContext`, `ToolDefinition` are all exported from a backend-specific package
- The template imports from `@dawnai.org/langgraph` even though nothing it uses is LangGraph-specific
- Future backends (`@dawnai.org/langchain`, `@dawnai.org/deepagents`) have no shared contract surface to implement

The route authoring model also carries a layer of indirection:

- `route.ts` is a companion file that declares metadata about a sibling `workflow.ts` or `graph.ts`
- The kind-to-entry binding is enforced in two places (the `defineRoute` helper and the discovery validator)
- Authors maintain two files per route to express one concept

This milestone resolves both problems at once.

## Scope

This milestone covers:

- create `@dawnai.org/sdk` package with the backend-neutral author-facing contract
- strip the author-facing types out of `@dawnai.org/langgraph`, keep only the LangGraph execution adapter
- have `@dawnai.org/langgraph` re-export `@dawnai.org/sdk` types for author convenience
- replace `route.ts` + `workflow.ts`/`graph.ts` convention with a single `index.ts` per route
- infer route kind from the named exports of `index.ts` (`workflow` or `graph`)
- replace route `config` companion with an optional `config` export in `index.ts`
- update CLI to accept route directory targets in addition to `index.ts` paths
- update the starter template to the new convention
- migrate all tests to the new contract
- update contributor docs and README

This milestone does not cover:

- pluggable backend adapter runtime
- a honored `backend` field in `dawn.config.ts` (reserved in the shape, not read)
- a LangChain-native authoring package
- a Deep Agents authoring package
- schema-first tool validation
- tool permission/policy metadata
- memory, approvals, evals
- deprecation shims for the old convention — this is an explicit atomic break

## Success Definition

This milestone is complete when:

- `@dawnai.org/sdk` is a published workspace package with the backend-neutral contract
- `@dawnai.org/langgraph` no longer exports `defineRoute` or route-definition types
- `@dawnai.org/langgraph` re-exports `@dawnai.org/sdk` types so single-backend authors have one import source
- route discovery identifies routes by scanning for `index.ts` files and inspecting their named exports
- route kind is inferred from whether `index.ts` exports `workflow` or `graph`
- the starter template uses a single `index.ts` per route with no `route.ts`
- `dawn run`, `dawn test`, `dawn check`, `dawn verify`, `dawn dev`, `dawn routes` all work against the new convention
- no `route.ts` files exist anywhere in the repo
- `pnpm ci:validate` and `node scripts/publish-smoke.mjs` pass green

## Package Structure

### `@dawnai.org/sdk` (new)

Author-facing, backend-neutral contract.

Exports:

- `defineTool` — tool definition helper
- `ToolDefinition` — tool shape type
- `ToolContext` — tool handler context (`signal` only)
- `RuntimeContext` — route handler context (`signal` + `tools`)
- `RuntimeTool` — callable tool type from the route's perspective
- `ToolRegistry` — record of resolved callable tools
- `RouteConfig` — optional per-route config (`runtime`, `streaming`, `tags`)
- `RouteKind` — `"graph" | "workflow"`

The SDK does not export a route-definition helper. There is no `defineRoute` in the new model. Routes are defined by the presence of a `workflow` or `graph` export in `index.ts`, not by wrapping a definition object.

### `@dawnai.org/langgraph` (slimmed)

LangGraph-specific execution adapter.

Stays:

- `normalizeRouteModule` — used by the CLI to normalize the imported `index.ts` module
- `RouteModule`, `GraphRouteModule`, `WorkflowRouteModule`, `NormalizedRouteModule` — LangGraph-execution-lane module types
- `defineEntry` — stays, unchanged

`RouteEntryKind` (previously defined in `@dawnai.org/langgraph`) is removed. Both `@dawnai.org/langgraph` and `@dawnai.org/core` import `RouteKind` from `@dawnai.org/sdk` as the single canonical name.

Removed:

- `defineRoute`, `RouteDefinition`
- `defineTool`, `ToolDefinition` (moved to `@dawnai.org/sdk`)
- `RuntimeContext`, `RuntimeTool`, `ToolContext` (moved to `@dawnai.org/sdk`)
- `RouteConfig` (moved to `@dawnai.org/sdk`)

Re-exports from `@dawnai.org/sdk` (for author convenience):

- `defineTool`
- `ToolDefinition`
- `ToolContext`
- `RuntimeContext`
- `RuntimeTool`
- `RouteConfig`

This lets authors keep a single import source per backend (`@dawnai.org/langgraph`) without the SDK becoming a hidden implementation detail.

### `@dawnai.org/core` (updated)

Route discovery and app contract.

Changes:

- discovery scans for `index.ts` files inside `appDir`
- `loadAuthoringRouteDefinition` is removed
- the manifest `RouteDefinition` type (different from the removed `@dawnai.org/langgraph` `RouteDefinition`) no longer carries `boundEntryFile` / `boundEntryKind` — those fields are gone
- `RouteEntryKind` in `@dawnai.org/core` is replaced by `RouteKind` imported from `@dawnai.org/sdk`
- manifest `entryFile` now points to the route's `index.ts` rather than a `workflow.ts` / `graph.ts` sibling

### `@dawnai.org/cli` (simplified)

One execution path, no authoring-lane vs legacy-lane branching.

Removed:

- `lib/runtime/route-definition.ts` — no more `route.ts` loading
- `lib/runtime/validate-authoring-routes.ts` — rolled into the single execution path
- authoring-lane branching in `execute-route.ts`

Updated:

- `execute-route.ts` — single path: import `index.ts`, inspect exports, run handler
- `resolve-route-target.ts` — accepts directory targets and `index.ts` paths
- `tool-discovery.ts` — unchanged
- `dawn-context.ts` — unchanged
- `check.ts` / `verify.ts` — validate `index.ts` exports exactly one of `workflow` / `graph`

## Route Authoring Contract

### `index.ts` is the sole route entry file

Each route directory contains exactly one `index.ts`. That file is the route.

- route kind is inferred from named exports:
  - exports `workflow` → kind `"workflow"`
  - exports `graph` → kind `"graph"`
  - exports both → error
  - exports neither → not a Dawn route (skipped)
- route identity (pathname, route id) is derived from filesystem position — unchanged
- route groups `(group)/`, dynamic segments `[param]/`, private segments `_private/` — unchanged

### Handler shape

```ts
// Workflow route
import type { RuntimeContext, RuntimeTool } from "@dawnai.org/langgraph"
import type { HelloState } from "./state.js"

type HelloTools = {
  readonly greet: RuntimeTool<
    { readonly tenant: string },
    { readonly greeting: string }
  >
}

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<HelloTools>,
): Promise<HelloState> {
  const result = await ctx.tools.greet({ tenant: state.tenant })

  return {
    ...state,
    greeting: result.greeting,
  }
}
```

```ts
// Graph route — callable function form
export async function graph(state, ctx: RuntimeContext) { ... }

// Graph route — compiled graph form
import { StateGraph, Annotation } from "@langchain/langgraph"
export const graph = new StateGraph(...).compile()
```

### Optional per-route config

```ts
export const config = {
  runtime: "node",
  streaming: false,
  tags: ["hello"],
}
```

`config` is optional. Defaults:

- `runtime: "node"`
- `streaming: false`
- `tags: []`

Unknown keys in `config` are ignored (no warning, no error) — future backends may add fields.

### Tool authoring

Tool authoring is unchanged in shape. Authors keep using the same import path — `@dawnai.org/langgraph` now re-exports the tool types from `@dawnai.org/sdk`:

```ts
import { defineTool, type ToolDefinition } from "@dawnai.org/langgraph"
```

Multi-backend or backend-neutral code may import directly from `@dawnai.org/sdk`:

```ts
import { defineTool, type ToolDefinition } from "@dawnai.org/sdk"
```

Tool discovery rules are unchanged:

- shared `src/tools/*.ts`
- route-local `<routeDir>/tools/*.ts`
- route-local shadows shared by name
- same-scope collisions are errors

### Errors

Pinned error messages:

- `Route index.ts must export exactly one of "workflow" or "graph"`
- `Route index.ts at <path> exports neither "workflow" nor "graph"`
- `Route target must be a route directory or its index.ts: <path>`
- `Route directory has no index.ts: <path>`
- `Duplicate shared Dawn tool name "<name>" detected at <fileA> and <fileB>` (unchanged)
- `Duplicate route-local Dawn tool name "<name>" detected at <fileA> and <fileB>` (unchanged)

## Runtime Model

The CLI execution path becomes a single lane:

1. resolve target → `index.ts` absolute path (from directory or file target)
2. register tsx loader, import the module
3. inspect named exports → determine kind
4. read optional `config` export, merge with defaults
5. discover tools (shared + route-local)
6. build `RuntimeContext` with `signal` and callable tool registry
7. invoke the handler with `(input, context)` for workflow, `(input, context)` or `.invoke(input, context)` for graph

There is no fallback to a legacy lane. The previous distinction between "authoring routes" and "native routes" is gone.

## CLI Target Contract

`dawn run` and `dawn test` accept:

- absolute path to an `index.ts`
- relative path to an `index.ts` (resolved against cwd)
- app-relative path to an `index.ts` (resolved against appRoot)
- path to a route directory (resolves to its `index.ts`)

Paths that point at an old `workflow.ts` or `graph.ts` produce a clear error:

- `Route target must be a route directory or its index.ts: <path>`

No backwards compatibility for the old filename convention. Dawn is pre-1.0 with no external consumers.

`dawn dev`, `dawn check`, `dawn verify`, `dawn routes` need no target changes beyond the internal discovery/execution updates.

## Backend Extension Pattern

Backend packages extend `@dawnai.org/sdk` rather than replacing it.

Current:

- `@dawnai.org/langgraph` imports `RuntimeContext`, `ToolDefinition`, etc. from `@dawnai.org/sdk`
- `@dawnai.org/langgraph` re-exports those types for single-backend authors
- `@dawnai.org/langgraph` adds LangGraph-specific execution types (`RouteModule`, `normalizeRouteModule`)

Future (not in this milestone):

- `@dawnai.org/langchain` imports from `@dawnai.org/sdk`, re-exports for LangChain-native authors, adds LangChain-specific composition helpers
- `@dawnai.org/deepagents` imports from `@dawnai.org/sdk`, re-exports for Deep Agents authors, adds multi-agent orchestration primitives

The invariant: `@dawnai.org/sdk` is the source of truth for the backend-neutral contract. Backend packages may extend, never replace.

## Template Updates

Starter template before:

```
packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/
├── route.ts
├── workflow.ts
├── state.ts
└── tools/
    └── greet.ts
```

Starter template after:

```
packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/
├── index.ts
├── state.ts
└── tools/
    └── greet.ts
```

Template `index.ts` imports `RuntimeContext` and `RuntimeTool` from `@dawnai.org/langgraph` (which re-exports from `@dawnai.org/sdk`). No `config` export in the template — defaults are fine for the starter.

Contributor-local scaffold in `CONTRIBUTORS.md` updated to match.

## Testing and Verification

### SDK contract tests

New in `@dawnai.org/sdk`:

- `test/define-tool.test.ts` — tool authoring
- `test/tool-context.contract.ts` — tool context type freeze
- `test/runtime-context.contract.ts` — runtime context type freeze

### LangGraph package

Deleted:

- `test/define-route.test.ts`

Moved to `@dawnai.org/sdk`:

- `test/define-tool.test.ts`
- `test/tool-context.contract.ts`

Stays:

- tests for `normalizeRouteModule`, `assertExactlyOneEntry`

### Core discovery

`packages/core/test/discover-routes.test.ts` rewritten:

- discovers routes by scanning `index.ts`
- infers kind from exports
- reports errors for missing/multiple/invalid exports
- route groups and dynamic segments behavior unchanged

### CLI tests

Rewritten for new contract:

- `test/check-command.test.ts` — validation coverage
- `test/verify-command.test.ts` — integrity coverage
- `test/run-command.test.ts` — single-lane execution, directory targeting
- `test/test-command.test.ts` — scenario execution
- `test/routes-command.test.ts` — output reflects new discovery

### Generated app tests

- `test/generated/run-generated-app.test.ts` — template structure (no `route.ts`, has `index.ts`)
- `test/generated/run-generated-runtime-contract.test.ts` — full lifecycle
- `test/generated/fixtures/basic.expected.json` — updated
- `test/generated/fixtures/basic-runtime.expected.json` — updated

### Runtime contract

- `test/runtime/run-runtime-contract.test.ts` — in-process and server parity through new model

### Verification baseline

After implementation:

```bash
pnpm ci:validate
node scripts/publish-smoke.mjs
```

Both must pass green. No skipped tests.

## Migration Story

Dawn is pre-1.0. The only consumers are internal:

- the starter template (updated)
- contributor-local scaffold example (updated)
- test fixtures (updated)

No deprecation layer, no shim, no compat mode. The old convention disappears in one atomic change.

## Deferrals

This milestone intentionally defers:

- pluggable backend adapter runtime
- honored `backend` field in `dawn.config.ts`
- LangChain-native authoring package
- Deep Agents authoring package
- schema-first tool validation
- tool permission / policy metadata
- memory, approvals, evals
- richer tool composition primitives
- backend-specific runtime context extensions

This milestone establishes the neutral contract surface. Later phases extend it.

## Recommendation

Implement the extraction as a single atomic milestone:

1. create `@dawnai.org/sdk` with the backend-neutral contract
2. slim `@dawnai.org/langgraph` to the execution adapter, re-export SDK types
3. update discovery in `@dawnai.org/core` for `index.ts`-based route model
4. simplify execution in `@dawnai.org/cli` to a single lane
5. update the starter template and contributor-local scaffold
6. rewrite tests to pin the new contract

The result is a codebase where the author-facing contract is Dawn-owned and backend-neutral, the route authoring model is simpler (one file per route instead of two), and the CLI execution path has no legacy branching.

This is the foundation Phase 2 (LangChain-native authoring) and Phase 3 (Deep Agents integration) need in order to implement Dawn's contract rather than fork it.
