# `agent()` Typed API Design

## Problem

When users write a Dawn agent route using LangChain's `createAgent()` directly, TypeScript cannot infer the return type without referencing deep internal types from `@langchain/langgraph`. This produces the error:

> The inferred type of 'agent' cannot be named without a reference to 'AnnotationRoot'

Users must add a manual type annotation (`const agent: Runnable = ...`) to suppress this — poor DX for a starter template.

## Goal

Provide a single `agent()` function in `@dawn-ai/sdk` that:

1. Returns an opaque type Dawn controls — no third-party type leakage
2. Requires zero type annotations from the user
3. Provides model name autocomplete
4. Is a lazy descriptor — no LLM SDK code runs at import time
5. Works with Dawn's existing auto-discovered tools (no `tool()` wrapper needed)

## Design

### User-Facing API

```typescript
// src/app/(public)/hello/[tenant]/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant for {tenant}.",
})
```

Tools remain unchanged — default-exported functions discovered from `tools/`:

```typescript
// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (input: { readonly tenant: string }) => {
  return { name: input.tenant, plan: "starter" }
}
```

### Type Definition (in `@dawn-ai/sdk`)

```typescript
const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent")

export interface DawnAgent {
  readonly [DAWN_AGENT]: true
  readonly model: string
  readonly systemPrompt: string
}

export interface AgentConfig {
  readonly model: KnownModelId
  readonly systemPrompt: string
}

export type KnownModelId =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  | "claude-sonnet-4-20250514"
  | "claude-haiku-4-20250414"
  | (string & {})

export function agent(config: AgentConfig): DawnAgent
```

Key type tricks:
- `KnownModelId` uses the `(string & {})` pattern for autocomplete on known models while allowing any string
- `DawnAgent` is branded with a symbol — opaque to consumers, recognizable to Dawn internals
- No generics needed since tools are auto-discovered, not passed in

### Runtime Implementation (in `@dawn-ai/sdk`)

```typescript
export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
    systemPrompt: config.systemPrompt,
  }
}

export function isDawnAgent(value: unknown): value is DawnAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    DAWN_AGENT in value &&
    (value as Record<symbol, unknown>)[DAWN_AGENT] === true
  )
}
```

### Adapter Changes (in `@dawn-ai/langchain`)

The `executeAgent` function gains a branch for `DawnAgent` descriptors:

```typescript
export async function executeAgent(options: {
  readonly entry: unknown  // DawnAgent | raw Runnable
  readonly input: unknown
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly tools: readonly DawnToolDefinition[]
}): Promise<unknown> {
  if (isDawnAgent(options.entry)) {
    const materializedAgent = materializeAgent(options.entry, options.tools)
    return await invokeAgent(materializedAgent, options)
  }

  // Fallback: raw Runnable with .invoke()
  return await invokeLegacyAgent(options)
}
```

`materializeAgent` calls LangChain's `createAgent` with the config from the descriptor plus the auto-discovered tools. It caches the compiled agent for subsequent invocations.

### Route Discovery

Discovery already imports route files and checks for named exports. The check becomes (in priority order):

1. `export default` is a `DawnAgent` (check symbol) → kind is `"agent"` (preferred)
2. `export const agent` is a `DawnAgent` (check symbol) → kind is `"agent"`
3. `export const agent` is an object with `.invoke()` → kind is `"agent"` (legacy/escape-hatch)

### Escape Hatch (Power Users)

Users who want raw LangChain control can still do:

```typescript
import type { Runnable } from "@langchain/core/runnables"
import { createAgent } from "langchain"

export const agent: Runnable = createAgent({
  model: "gpt-4o-mini",
  tools: [/* manually wired tools */],
})
```

This works because the adapter falls back to calling `.invoke()` directly on anything that isn't a `DawnAgent` descriptor.

## What Changes

| Component | Change |
|-----------|--------|
| `@dawn-ai/sdk` | Add `agent()`, `DawnAgent`, `isDawnAgent`, `KnownModelId` |
| `@dawn-ai/langchain` | Add `materializeAgent`, update `executeAgent` to handle descriptors |
| Template | Replace `import { createAgent } from "langchain"` with `import { agent } from "@dawn-ai/sdk"` |
| `packages/devkit` | Update template `index.ts` and remove `langchain` from template deps |
| Route discovery | Add `isDawnAgent` check alongside existing `.invoke()` check |

## What Does NOT Change

- Tool files — still plain default-exported functions
- Tool auto-discovery — still filesystem-based
- `dawn build` — still generates compiled entries
- Other route kinds (`chain`, `graph`, `workflow`) — unaffected
- Test overlays — mock agents still use plain `{ invoke() }` objects

## Dependencies

`@dawn-ai/sdk` gains zero new dependencies. The `agent()` function is pure data construction — no imports from LangChain, zod, or anything else.

`@dawn-ai/langchain` already depends on `@langchain/core`. It gains a dependency on `@dawn-ai/sdk` (for `isDawnAgent`).

## Template Dependency Simplification

Today the template requires:
- `langchain@1.0.0-alpha.5`
- `@langchain/core@1.1.40`
- `@langchain/openai@1.0.0-alpha.1`

After this change, these become transitive deps of `@dawn-ai/langchain` (which the user already depends on). The template's `package.json` no longer lists them directly — Dawn owns the version coordination.
