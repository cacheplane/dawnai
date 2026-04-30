# LangChain-Native Authoring

## Goal

Prove that the Dawn-owned authoring contract can support a real LangChain-native path. Introduce `@dawn-ai/langchain` as the second backend adapter, a unified `BackendAdapter` interface in `@dawn-ai/sdk`, a Vite plugin for build-time tool schema inference, and SSE streaming in `dawn dev`.

## Background

Dawn currently supports two route kinds (`graph` and `workflow`) through a single backend adapter (`@dawn-ai/langgraph`). The authoring contract (`@dawn-ai/sdk`) is backend-neutral by design, but there is no second backend to prove it.

Phase 2 adds LangChain LCEL runnables as the second execution backend, with `chain` as the new route export name. This is the first real proof that Dawn is a meta-framework rather than a LangGraph-first runtime shell.

A third backend (`@dawn-ai/deepagents`) is planned for Phase 3, which validates investing in a formal adapter interface now.

## Design

### BackendAdapter interface

`@dawn-ai/sdk` gains a new type-only `BackendAdapter` interface:

```typescript
export interface BackendAdapter {
  readonly kind: RouteKind
  execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>
  stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): AsyncIterable<unknown>
}
```

- `kind` identifies which route kind(s) this adapter handles
- `execute()` runs to completion, returns final output
- `stream()` returns an async iterable of chunks
- Both `@dawn-ai/langgraph` and `@dawn-ai/langchain` export a constant or factory that satisfies `BackendAdapter`
- `@dawn-ai/sdk` remains a pure type layer — `BackendAdapter` is a type export only

`RouteKind` expands from `"graph" | "workflow"` to `"graph" | "workflow" | "chain"`.

Three known adapters will implement this interface:
- `@dawn-ai/langgraph` — handles `graph` and `workflow` (existing, refactored)
- `@dawn-ai/langchain` — handles `chain` (new)
- `@dawn-ai/deepagents` — Phase 3, future route kind TBD

### Route discovery and kind inference

The CLI owns all discovery. Changes:

- `inferRouteKind()` in `discover-routes.ts` adds `chain` to the list of recognized named exports
- `loadRouteKind()` in `load-route-kind.ts` replaces its current call to `normalizeRouteModule()` from `@dawn-ai/langgraph` with CLI-owned logic:
  1. Load the route module
  2. Check for `graph`, `workflow`, or `chain` named export
  3. Validate exactly one is present (same rule as today)
  4. Return the kind and entry reference
- `normalizeRouteModule()` in `@dawn-ai/langgraph` becomes internal or is removed — the CLI no longer imports it for discovery
- Existing validation rules carry over: exactly one recognized export, must be a function or object with `.invoke()`

Adding Deep Agents later means adding a fourth export name to the CLI's recognition list — no new package imports needed for discovery.

### Chain route authoring

What the author writes:

```typescript
// src/app/hello/[tenant]/index.ts
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { StringOutputParser } from "@langchain/core/output_parsers"

const prompt = ChatPromptTemplate.fromTemplate("Help {tenant} with: {input}")
const model = new ChatOpenAI({ model: "gpt-5-mini" })

export const chain = prompt.pipe(model).pipe(new StringOutputParser())
```

```
tools/
  lookup-customer.ts
  send-email.ts
```

The `chain` export is a LangChain `Runnable`. Dawn discovers it, the adapter handles execution.

### Automatic runtime integration

Dawn handles three things automatically at runtime — the author never wires these manually:

**1. Tool binding**

The adapter walks the LCEL chain's `RunnableSequence.steps`, finds the `BaseChatModel` node (from `@langchain/core/language_models/chat_models`), and calls `.bindTools()` with Dawn-discovered tools converted to LangChain `DynamicStructuredTool` format.

When tools are present, Dawn wraps the chain in a tool execution loop:
1. Invoke the chain
2. If the output contains tool calls, execute those Dawn tools, feed results back as `ToolMessage`s, re-invoke
3. Repeat until the model produces a final response (no tool calls)
4. In streaming mode, chunks flow through as they arrive

Dawn does NOT use `AgentExecutor` from the `langchain` package. The tool execution loop is Dawn-owned, built on `@langchain/core` primitives only. This keeps the dependency surface minimal and gives Dawn full control over execution semantics for future enhancements (approvals, memory — Phase 4).

**2. Route param injection**

`[tenant]` from the route path gets merged into the chain's input object. The author references `{tenant}` in prompt templates and it works automatically.

**3. Signal propagation**

`context.signal` is threaded through every `.invoke()` / `.stream()` call automatically. Abort cancels in-flight operations.

### Tool authoring and schema

Tool files support three levels of ceremony:

**Minimal (zero ceremony):**
```typescript
// tools/ping.ts
export default async () => ({ pong: true })
```

**With explicit schema and description:**
```typescript
// tools/lookup-customer.ts
import { z } from "zod"

export const description = "Look up a customer by ID"
export const schema = z.object({
  id: z.string().describe("Customer ID"),
  includeHistory: z.boolean().optional().describe("Include order history"),
})

export default async (input: { id: string; includeHistory?: boolean }) => {
  return { name: "Acme Corp", plan: "enterprise" }
}
```

**With Vite plugin (automatic inference):**
```typescript
// tools/lookup-customer.ts
/**
 * Look up a customer by ID
 * @param id - Customer ID
 * @param includeHistory - Include order history
 */
export default async (input: { id: string; includeHistory?: boolean }) => {
  return { name: "Acme Corp", plan: "enterprise" }
}
```

The Vite plugin infers the schema and description at build time. No Zod import needed.

**Precedence:** Explicit `export const schema` or `export const description` always wins over Vite plugin inference.

**Dawn tool to LangChain DynamicStructuredTool conversion:**

`tool-converter.ts` in `@dawn-ai/langchain` converts each `DiscoveredToolDefinition` to a `DynamicStructuredTool`:

```typescript
new DynamicStructuredTool({
  name: discoveredTool.name,           // from filename
  description: discoveredTool.description,  // from named export or Vite plugin
  schema: discoveredTool.schema,       // from named export or Vite plugin
  func: async (input, runManager) => {
    const result = await discoveredTool.run(input, { signal: runManager?.signal })
    return JSON.stringify(result)
  },
})
```

When no schema is provided (and no Vite plugin), falls back to `z.record(z.unknown())`.

### Vite plugin for schema inference

New package `@dawn-ai/vite-plugin` at `packages/vite-plugin/`.

The plugin runs at build time (and during `dawn dev` via Vite's transform pipeline):

1. Finds `.ts` files in `tools/` directories
2. Uses the TypeScript compiler API to extract the default export function's first parameter type
3. Converts the resolved TS type to a Zod schema
4. Extracts JSDoc description and `@param` tags
5. Injects `export const schema` and `export const description` as named exports

**Supported type mapping:**

| TypeScript | Zod |
|---|---|
| `string` | `z.string()` |
| `number` | `z.number()` |
| `boolean` | `z.boolean()` |
| `null` | `z.null()` |
| `string[]`, `Array<string>` | `z.array(z.string())` |
| `[string, number]` tuples | `z.tuple([z.string(), z.number()])` |
| `{ key: Type }` object literals | `z.object({ key: ... })` |
| `Type \| undefined`, `key?:` | `.optional()` |
| `Type \| null` | `z.union([zType(), z.null()])` |
| `Type1 \| Type2` unions | `z.union([...])` |
| `Type1 & Type2` intersections | `z.intersection(...)` |
| `"a" \| "b"` string literals | `z.enum(["a", "b"])` |
| `42`, `true` literal types | `z.literal(value)` |
| `Record<string, Type>` | `z.record(z.string(), zType())` |
| `Map<K, V>` | `z.map(zK(), zV())` |
| `Set<T>` | `z.set(zT())` |
| Nested objects | Recursive `z.object()` |
| Generics (e.g., `MyType<string>`) | Resolved by TS compiler, then mapped |
| Mapped types, `Pick`, `Omit` | Resolved by TS compiler, then mapped |

Since the TS compiler API resolves generics, mapped types, and conditional types before the plugin sees them, `zod-generator.ts` only handles concrete type nodes.

**Unsupported (fall back to `z.unknown()` with build warning):**

| TypeScript | Why |
|---|---|
| `any`, `unknown` | No structure to extract |
| Function types | Not meaningful as tool input |
| Recursive self-referencing types | Cycle detection needed — defer to v2 |

### `@dawn-ai/langchain` package structure

```
packages/langchain/
  package.json          # peerDeps: @langchain/core; deps: @dawn-ai/sdk
  tsconfig.json
  src/
    index.ts            # public exports
    chain-adapter.ts    # BackendAdapter implementation for "chain" kind
    tool-converter.ts   # Dawn tools -> LangChain DynamicStructuredTool
  test/
    chain-adapter.test.ts
    tool-converter.test.ts
```

No runtime dependency on `@dawn-ai/langgraph`. `@langchain/core` is a peer dependency (user installs it).

### `@dawn-ai/vite-plugin` package structure

```
packages/vite-plugin/
  package.json          # deps: typescript (for compiler API)
  tsconfig.json
  src/
    index.ts            # Vite plugin entry
    type-extractor.ts   # TS compiler API -> type info
    zod-generator.ts    # type info -> Zod schema code string
    jsdoc-extractor.ts  # JSDoc -> descriptions
  test/
    type-extractor.test.ts
    zod-generator.test.ts
    jsdoc-extractor.test.ts
```

### CLI execution changes

`execute-route.ts` replaces direct `invokeEntry()` with adapter dispatch:

1. CLI resolves route kind from discovery (`graph`, `workflow`, or `chain`)
2. Looks up the registered `BackendAdapter` for that kind
3. For `dawn run`: calls `adapter.stream()`, frames each chunk as NDJSON to stdout
4. For `dawn test`: calls `adapter.execute()`, asserts on final output
5. For `dawn dev`: calls `adapter.stream()`, forwards as SSE

**Adapter registration:** CLI maintains a `RouteKind -> BackendAdapter` map. On startup, imports adapters from `@dawn-ai/langgraph` and `@dawn-ai/langchain`. If an import fails (package not installed), the error surfaces at execution time when a route of that kind is invoked.

**`@dawn-ai/langgraph` refactor:** Existing `normalizeRouteModule()` and `invokeEntry()` logic moves behind the `BackendAdapter` interface. `@dawn-ai/langgraph` exports a `BackendAdapter` handling `graph` and `workflow` kinds, plus `.stream()` support.

### Streaming

**`dawn run`** — NDJSON to stdout:

```
{"type":"chunk","data":"Acme"}
{"type":"tool_call","name":"lookup-customer","input":{"id":"acme"}}
{"type":"tool_result","name":"lookup-customer","output":{"name":"Acme Corp","plan":"enterprise"}}
{"type":"done","output":"Acme Corp is..."}
```

**`dawn dev`** — SSE over HTTP (`text/event-stream`):

```
event: chunk
data: {"data":"Acme"}

event: tool_call
data: {"name":"lookup-customer","input":{"id":"acme"}}

event: tool_result
data: {"name":"lookup-customer","output":{"name":"Acme Corp","plan":"enterprise"}}

event: done
data: {"output":"Acme Corp is..."}
```

**`dawn test`** — calls `adapter.execute()`, runs to completion, asserts on final output only. No streaming.

The adapter's `.stream()` returns an `AsyncIterable`. The CLI frames it as NDJSON, the dev server frames it as SSE. Same source, two transports.

Chunk types:
- `chunk` — streaming token from the model
- `tool_call` — model requested a tool invocation
- `tool_result` — Dawn executed the tool, result
- `done` — final assembled output

### Error handling

| Condition | Behavior |
|-----------|----------|
| `@langchain/core` not installed | Fails at execution time when chain route is invoked (not at discovery) |
| Chain export is not a Runnable | `BackendAdapter.execute()` throws when `.invoke()` is not callable |
| No `BaseChatModel` found in chain but tools present | Build warning; tools are not bound; chain runs without tools |
| Unsupported TS type in Vite plugin | Falls back to `z.unknown()` with build warning |
| Tool execution fails during agent loop | Error propagated to caller; `tool_result` event includes error |

Note: Better missing-dependency DX (e.g., `dawn verify` checking for `@langchain/core`) may come later.

### Testing strategy

**`@dawn-ai/langchain` unit tests:**
- Adapter calls `.invoke()` and `.stream()` on mock Runnable
- Tool binding: when tools present, adapter binds to model and runs tool loop
- Signal propagation: abort cancels in-flight operations
- Tool converter: Dawn `DiscoveredToolDefinition` converts to `DynamicStructuredTool` correctly

**`@dawn-ai/vite-plugin` unit tests:**
- Type extractor: all supported TS types extracted correctly from function signatures
- Zod generator: type info converts to correct Zod schema code strings
- JSDoc extractor: descriptions and `@param` tags mapped correctly
- Integration: full pipeline from `.ts` source to transformed module with injected exports
- Precedence: explicit `export const schema` is not overridden

**CLI tests:**
- Adapter dispatch based on route kind
- `chain` recognized as valid export in `inferRouteKind`
- CLI-owned normalization handles all three kinds
- NDJSON streaming from `dawn run`
- SSE framing from `dawn dev`

**Generated app / harness:**
- Fixture app with chain route and `tools/` directory
- Runs through `dawn run`, `dawn test`, and `dawn dev` harness lanes

### What does not change

- `@dawn-ai/sdk` remains a pure type layer (plus new `BackendAdapter` type)
- Tool discovery in the CLI (`tool-discovery.ts`) — same filesystem conventions, same bare function exports
- Tool resolution order (route-local shadows shared)
- Route filesystem conventions (`index.ts` per route, `tools/` directories)
- `dawn verify` / `dawn test` / `dawn dev` command boundaries
- Scenario test authoring format (`run.test.ts` default export array)
- `@dawn-ai/langgraph` existing behavior for `graph` and `workflow` routes

### What to defer

- **Deep Agents integration** — Phase 3, adds fourth route kind and third adapter
- **Hosted/production deployment** — Dawn stays local-only
- **LangSmith trace wiring** — LangChain's built-in LangSmith integration works automatically for chain routes
- **Recursive type support in Vite plugin** — v2, cycle detection needed
- **Better missing-dependency DX** — fail-at-execution-time for now; `dawn verify` checks later
- **Custom SSE event types** — initial set covers the core; richer events later

### Documentation deliverables

- Tool schema inference pipeline (Vite plugin usage, supported types, JSDoc conventions)
- SSE streaming format and event types
- Chain route authoring guide (how to write a chain route, how tools are auto-bound)
- BackendAdapter interface documentation
- Updated roadmap reflecting Phase 2 completion

## Files modified

**New packages:**
- `packages/langchain/` — `@dawn-ai/langchain` adapter package
- `packages/vite-plugin/` — `@dawn-ai/vite-plugin` schema inference plugin

**Modified source:**
- `packages/sdk/src/index.ts` — add `BackendAdapter` type export
- `packages/sdk/src/backend-adapter.ts` — new file, `BackendAdapter` interface
- `packages/sdk/src/route-config.ts` — expand `RouteKind` to include `"chain"`
- `packages/core/src/discovery/discover-routes.ts` — add `chain` to `inferRouteKind()`
- `packages/cli/src/lib/runtime/load-route-kind.ts` — CLI-owned normalization replacing `normalizeRouteModule()` import
- `packages/cli/src/lib/runtime/execute-route.ts` — adapter dispatch replacing `invokeEntry()`
- `packages/cli/src/lib/runtime/tool-discovery.ts` — add optional `schema` field to `DiscoveredToolDefinition`
- `packages/langgraph/src/` — refactor to export `BackendAdapter` implementation
- Dev server — SSE transport for streaming

**Tests:**
- `packages/langchain/test/` — adapter and tool converter tests
- `packages/vite-plugin/test/` — type extractor, zod generator, jsdoc extractor tests
- CLI test updates for chain discovery and adapter dispatch
- New fixture app for chain route harness lane

## Related documents

- [`docs/next-iterations-roadmap.md`](../next-iterations-roadmap.md)
- [`docs/superpowers/specs/2026-04-17-simplify-tool-authoring-design.md`](./2026-04-17-simplify-tool-authoring-design.md)
- [`docs/superpowers/specs/2026-04-15-dawn-route-authoring-design.md`](./2026-04-15-dawn-route-authoring-design.md)
