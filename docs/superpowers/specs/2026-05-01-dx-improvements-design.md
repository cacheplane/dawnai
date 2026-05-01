# Dawn TypeScript DX Improvements Design

## Problem

Dawn's TypeScript developer experience has several gaps that reduce type safety and degrade the LLM's ability to use tools effectively:

1. **Stale model IDs** — `KnownModelId` lists outdated models, giving wrong autocomplete suggestions
2. **Tools invisible to the LLM** — without a user-exported zod schema, tools get `z.record(z.string(), z.unknown())` as their parameter schema, so the LLM has no information about what arguments to pass
3. **Tools invisible to TypeScript** — tool types are erased to `unknown` at the discovery boundary; no type safety flows downstream
4. **No state convention** — agents that need state beyond messages must directly use LangChain's `AnnotationRoot`, leaking framework internals
5. **Missing utility types** — no `Prettify<T>`, `RuntimeTool` not exported, duplicated internal types

## Goal

Improve Dawn's TypeScript DX by:

1. Updating model IDs with per-provider grouping and current models
2. Auto-generating JSON Schema from tool function signatures + JSDoc (codegen) so the LLM gets proper parameter descriptions with zero user effort
3. Auto-generating a type manifest so the IDE sees tool signatures and state shapes
4. Providing a convention-based state system using Standard Schema (zod/valibot/arktype) with filesystem-discovered reducers
5. Adding utility types and cleaning up exports

## Design

### 1. Per-Provider Model IDs

Replace the flat `KnownModelId` union with grouped per-provider types in `packages/sdk/src/known-model-ids.ts`:

```typescript
export type OpenAiModelId =
  // GPT-5.x series
  | "gpt-5.5"
  | "gpt-5.5-pro"
  | "gpt-5.4"
  | "gpt-5.4-pro"
  | "gpt-5-mini"
  // GPT-4.1 series
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  // GPT-4o series
  | "gpt-4o"
  | "gpt-4o-mini"
  // Reasoning
  | "o3"
  | "o3-mini"
  | "o4-mini"

export type AnthropicModelId =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"

export type GoogleModelId =
  | "gemini-3-pro-preview"
  | "gemini-3-flash-preview"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"

export type KnownModelId =
  | OpenAiModelId
  | AnthropicModelId
  | GoogleModelId
  | (string & {})
```

The `(string & {})` pattern gives autocomplete for known models while allowing any string. Users type `"claude-"` and see only Anthropic models.

### 2. Codegen Tool Schema Generation

Expand the existing `extractToolTypesForRoute` (in `@dawn-ai/core`) to produce JSON Schema from tool function signatures and JSDoc comments. This schema is provided to the LLM at runtime so it knows what arguments tools accept.

#### What the user writes (unchanged from today):

```typescript
// tools/greet.ts

/**
 * Greets the tenant and returns their plan info.
 */
export default async (input: {
  /** The tenant organization ID */
  readonly tenant: string
}) => {
  return { name: input.tenant, plan: "starter" }
}
```

#### What codegen produces:

```json
{
  "greet": {
    "description": "Greets the tenant and returns their plan info.",
    "parameters": {
      "type": "object",
      "properties": {
        "tenant": { "type": "string", "description": "The tenant organization ID" }
      },
      "required": ["tenant"],
      "additionalProperties": false
    }
  }
}
```

#### JSDoc extraction:

- Function-level JSDoc → tool `description`
- Inline property JSDoc (`/** ... */`) → property `description` in JSON Schema
- Uses `symbol.getDocumentationComment(checker)` from the TypeScript compiler API

#### TypeScript type → JSON Schema mapping:

| TS Type | JSON Schema |
|---------|-------------|
| `string` | `{ "type": "string" }` |
| `number` | `{ "type": "number" }` |
| `boolean` | `{ "type": "boolean" }` |
| `string[]` | `{ "type": "array", "items": { "type": "string" } }` |
| `{ key: T }` | `{ "type": "object", "properties": {...} }` |
| `"literal"` | `{ "type": "string", "enum": ["literal"] }` |
| `A \| B` (string union) | `{ "type": "string", "enum": ["A", "B"] }` |
| `readonly` modifier | stripped (no JSON Schema equivalent) |
| optional property | omitted from `required` array |

#### Schema priority at runtime:

1. User-exported `schema` (zod object) → wins (explicit override, already supported today)
2. Codegen-generated JSON Schema → default (new)
3. `z.record(z.string(), z.unknown())` → last resort (only if codegen didn't run)

#### Pipeline:

- `dawn build` runs typegen → produces `.dawn/routes/<routeId>/tools.json`
- `dawn dev` watches tool files → regenerates on change
- At request time, runtime loads the manifest and injects the generated schema into `DiscoveredToolDefinition`
- `convertToolToLangChain` already uses `schema` if present → LLM gets proper JSON Schema

### 3. Codegen Type Manifest

Alongside the JSON Schema (for LLM), codegen emits a `.d.ts` that gives the TypeScript type system visibility into tool and state signatures via module augmentation.

#### Generated output:

```typescript
// .dawn/generated/route-tools.d.ts
declare module "@dawn-ai/sdk" {
  interface RouteToolMap {
    "/hello/[tenant]": {
      greet: (input: { readonly tenant: string }) => Promise<{ name: string; plan: string }>
    }
  }
}
```

```typescript
// .dawn/generated/route-state.d.ts
declare module "@dawn-ai/sdk" {
  interface RouteStateMap {
    "/hello/[tenant]": {
      context: string
      confidence: number
      results: string[]
    }
  }
}
```

#### SDK provides empty interfaces for augmentation:

```typescript
// packages/sdk/src/route-types.ts
export interface RouteToolMap {}
export interface RouteStateMap {}
```

#### How it integrates:

- `dawn dev` / `dawn build` emits files to `.dawn/generated/`
- The generated directory is gitignored
- Project's `tsconfig.json` includes `.dawn/generated/` (via `include` or `/// <reference>`)
- IDE sees augmented types automatically after `dawn dev` starts

### 4. Convention-Based Agent State

#### Filesystem convention:

```
src/app/(public)/hello/[tenant]/
  index.ts              ← agent({ model, systemPrompt })
  state.ts              ← Standard Schema export (optional)
  reducers/             ← custom reducer overrides (optional)
    results.ts
  tools/
    greet.ts
```

#### State definition (`state.ts`):

Users export a Standard Schema (zod, valibot, arktype — anything implementing Standard Schema v1):

```typescript
// state.ts
import { z } from "zod"

export default z.object({
  /** Accumulated context from tool calls */
  context: z.string().default(""),
  /** Confidence score */
  confidence: z.number().default(0),
  /** Research results collected across tool calls */
  results: z.array(z.string()).default([]),
})
```

#### Reducer conventions:

Dawn infers reducers from default values — no runtime inspection of schema library internals:

- `Array.isArray(defaultValue)` → **append** reducer (accumulate across tool calls)
- Everything else → **replace** reducer (last value wins)
- Messages → always present, always append (implicit, never user-defined)

Dawn codes against the Standard Schema v1 interface only. No vendor-specific inspection of zod `.shape`, valibot `.entries`, or any other internal API.

#### Reducer overrides (`reducers/` folder):

For edge cases where convention is wrong (e.g., an array that should replace):

```typescript
// reducers/results.ts — override: replace instead of append
export default (current: string[], incoming: string[]) => incoming
```

Convention:
- Filename matches state field name
- Default export is `(current: T, incoming: T) => T`
- If no file exists → inferred from default value

#### Discovery and adapter flow:

1. Discovery: check for `state.ts` adjacent to route `index.ts` → import, validate Standard Schema
2. Extract defaults from schema → infer reducers
3. Discover `reducers/` folder → load override functions
4. Adapter: map resolved fields → LangChain `AnnotationRoot`
5. Pass to `createReactAgent({ stateSchema: annotation })`

#### Adapter mapping (`@dawn-ai/langchain`):

```typescript
// packages/langchain/src/state-adapter.ts
import { Annotation, MessagesAnnotation } from "@langchain/langgraph"

export function materializeStateSchema(
  fields: readonly ResolvedStateField[],
): AnnotationRoot<any> {
  const spec: Record<string, any> = {
    ...MessagesAnnotation.spec,
  }

  for (const field of fields) {
    if (typeof field.reducer === "function") {
      spec[field.name] = Annotation({
        reducer: field.reducer,
        default: () => field.default,
      })
    } else if (field.reducer === "append") {
      spec[field.name] = Annotation({
        reducer: (prev: unknown[], next: unknown[]) => [...prev, ...next],
        default: () => field.default ?? [],
      })
    } else {
      spec[field.name] = Annotation({
        reducer: (_: unknown, next: unknown) => next,
        default: () => field.default,
      })
    }
  }

  return Annotation.Root(spec)
}
```

#### What the user never does:

- Import LangChain annotations
- Write reducer config objects
- Define messages (always implicit)
- Wire state to the agent (auto-discovered)

### 5. Utility Types and Export Cleanup

**A. `Prettify<T>` utility:**

```typescript
// packages/sdk/src/types.ts
export type Prettify<T> = { [K in keyof T]: T[K] } & {}
```

Makes IDE hovers show resolved shapes instead of intersection noise.

**B. Export `RuntimeTool` from SDK barrel** — consumers can reference it for typing tool registries.

**C. Consolidate `NormalizedRouteModule`** — single source of truth in `@dawn-ai/core`, re-exported by cli.

## What Changes

| Package | Changes |
|---------|---------|
| `@dawn-ai/sdk` | Per-provider model IDs, `Prettify<T>`, `RouteToolMap`/`RouteStateMap` interfaces, export `RuntimeTool` |
| `@dawn-ai/core` | Expand typegen: JSON Schema generation + JSDoc extraction + type manifest emission, state field resolution (Standard Schema v1 interface), consolidate `NormalizedRouteModule` |
| `@dawn-ai/langchain` | `materializeStateSchema()` maps resolved fields → AnnotationRoot, update `materializeAgent` to accept state |
| `@dawn-ai/cli` | Discover `state.ts` + `reducers/` folder, load and pass to adapter, write `.dawn/` generated output, inject generated schema into tool definitions at runtime |
| `@dawn-ai/devkit` | Update templates to show stateful agent example, add `state.ts` to template |

## What Does NOT Change

- Tool files — still plain default-exported functions
- Tool auto-discovery — still filesystem-based
- `agent()` API signature — same (model + systemPrompt), state is auto-wired by convention
- `dawn build` output format — still generates compiled entries
- Existing stateless agents — zero changes needed
- Other route kinds (`chain`, `graph`, `workflow`) — unaffected

## Dependencies

- `@dawn-ai/sdk` gains zero new dependencies (utility types and interfaces only)
- `@dawn-ai/core` already depends on `typescript` for typegen; no new deps
- `@dawn-ai/langchain` already depends on `@langchain/langgraph`; no new deps
- `@dawn-ai/cli` already depends on `@dawn-ai/core`; no new deps
- Standard Schema v1 is an interface — no package dependency required

## Generated Output Structure

```
.dawn/                          (gitignored)
  generated/
    route-tools.d.ts            RouteToolMap module augmentation
    route-state.d.ts            RouteStateMap module augmentation
  routes/
    hello-[tenant]/
      tools.json                JSON Schema per tool (fed to LLM at runtime)
      state.json                Field definitions + reducers + defaults
```
