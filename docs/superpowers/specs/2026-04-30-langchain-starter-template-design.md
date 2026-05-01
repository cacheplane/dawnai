# Agent Route Kind and LangChain Starter Template

## Goal

Introduce `agent` as a new first-class route kind in Dawn, update the default `create-dawn-app` template to use LangChain's `createAgent()`, add auto tool injection for agent routes, and implement `dawn build` to generate deployment artifacts for LangGraph Platform.

## Background

Dawn currently supports three route kinds (`chain`, `graph`, `workflow`). The default template exports a `chain` using `RunnableLambda` pipelines — a deterministic demo with no real LLM. This iteration adds `agent` as the fourth route kind, targeting LangChain v1's `createAgent()` API as the recommended entry point for new Dawn apps.

This is not Phase 3 (Deep Agents). This iterates on LangChain support — `agent` is a natural companion to `chain`, handled by `@dawn-ai/langchain`. The same pattern will extend to LangGraph and Deep Agents adapters in future iterations.

### Why a new route kind?

Agents have fundamentally different execution semantics than chains:

- **Input translation**: Agents expect conversational input (`{ messages }`) plus contextual params. Chains receive structured input directly. The adapter needs to split Dawn's input into these two concerns.
- **Tool injection**: Chains are self-contained — tools are imported by the route author. Agents should receive tools automatically from Dawn's discovery system.
- **Streaming**: Agents support multiple streaming modes (`values`, `messages`, `updates`). Chains have simple `.stream()`.
- **Meta-framework identity**: Dawn positions itself as a framework that understands different AI execution paradigms. `chain`, `graph`, `workflow`, and `agent` each have distinct semantics that Dawn normalizes.

### Cross-framework input research

LangChain's prebuilt agents are the only framework that strictly requires `{ messages: [...] }` as input. Every other framework accepts simpler forms:

| Framework | Simplest Input |
|---|---|
| LangChain `createAgent()` | `{ messages: [...] }` |
| Anthropic Agent SDK | `prompt: "string"` |
| OpenAI Agents SDK | `"string"` |
| Vercel AI SDK | `prompt: "string"` |
| Mastra | `"string"` |

Dawn should not couple its input contract to any single framework. The design uses a framework-agnostic approach: Dawn separates what it knows (route params) from what the adapter knows (everything else).

## Design

### Route kind extension

`RouteKind` expands to include `"agent"`:

```typescript
// packages/sdk/src/route-config.ts
export type RouteKind = "agent" | "chain" | "graph" | "workflow"
```

Discovery checks for `export const agent` in route `index.ts` files, following the existing pattern:

```typescript
// packages/core/src/discovery/discover-routes.ts — inferRouteKind()
const hasAgent = "agent" in routeExports && routeExports.agent !== undefined
const hasChain = "chain" in routeExports && routeExports.chain !== undefined
const hasGraph = "graph" in routeExports && routeExports.graph !== undefined
const hasWorkflow = "workflow" in routeExports && routeExports.workflow !== undefined

// Route must export exactly one of: agent, chain, graph, workflow
```

The `assistant_id` format extends naturally: `/hello/[tenant]#agent`.

All existing infrastructure that references `RouteKind` or mode strings updates to include `"agent"`:
- `RuntimeExecutionMode` in `packages/cli/src/lib/runtime/result.ts`
- `invokeEntry()` in `packages/cli/src/lib/runtime/execute-route.ts`
- `normalizeRouteModule()` in `packages/cli/src/lib/runtime/load-route-kind.ts`
- `createRouteAssistantId()` in `packages/cli/src/lib/runtime/route-identity.ts`
- `RuntimeRegistryEntry` in `packages/cli/src/lib/dev/runtime-registry.ts`
- `RunsWaitRequest` in `packages/cli/src/lib/dev/runtime-server.ts`
- `ExecuteRouteServerOptions` in `packages/cli/src/lib/runtime/execute-route-server.ts`

### Input splitting: Dawn knows params, adapter knows the rest

Dawn's agent adapter separates route params from agent input using route param names derived from discovery/typegen. This is framework-agnostic — Dawn never interprets field names like `messages` or `prompt`.

```typescript
// Conceptual flow inside the agent adapter
const inputRecord = (input ?? {}) as Record<string, unknown>
const params: Record<string, unknown> = {}
const agentInput: Record<string, unknown> = {}

for (const [key, value] of Object.entries(inputRecord)) {
  if (routeParamNames.includes(key)) {
    params[key] = value
  } else {
    agentInput[key] = value
  }
}

// params → configurable (e.g., { tenant: "acme" })
// agentInput → passthrough to agent (e.g., { messages: [...] })
return await entry.invoke(agentInput, { configurable: params, tools })
```

Example invocation:
```bash
echo '{"tenant":"acme","messages":[{"role":"user","content":"Hi"}]}' | dawn run /hello/[tenant]
# Dawn splits:
#   params:     { tenant: "acme" }     → configurable
#   agentInput: { messages: [{...}] }  → passthrough to agent
```

This means:
- LangChain users pass `{ tenant: "acme", messages: [...] }`
- Future Anthropic Agent SDK users pass `{ tenant: "acme", prompt: "..." }`
- Future OpenAI Agents SDK users pass `{ tenant: "acme", input: "..." }`

Dawn doesn't care about the non-param fields. No reserved field names.

### Route param name flow

Route param names must flow from discovery into the execution context. Today, `discoverToolDefinitions()` already receives `routeDir`. The param names can flow similarly:

1. Discovery extracts dynamic segment names from the route path (e.g., `["tenant"]` from `/hello/[tenant]`)
2. These are passed through `executeRouteAtResolvedPath()` to `invokeEntry()`
3. The agent adapter uses them for input splitting

For non-agent kinds, param names are ignored — chains, graphs, and workflows receive input verbatim as they do today.

### Auto tool injection

Dawn discovers tools from `<routeDir>/tools/*.ts` and `<appRoot>/src/tools/*.ts`. For agent routes, these are automatically converted and injected:

1. `discoverToolDefinitions()` finds tools (existing mechanism)
2. Agent adapter converts each via `convertToolToLangChain()` from `@dawn-ai/langchain`
3. Tools are passed to `entry.invoke()` alongside `configurable`

The route author never imports tools in `index.ts`:

```typescript
// src/app/(public)/hello/[tenant]/index.ts
import { createAgent } from "langchain"

export const agent = createAgent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant for the {tenant} organization.",
})
// Dawn auto-discovers ./tools/greet.ts and injects it
```

Tool injection strategy: pass tools at invocation time (via config/options to `entry.invoke()`). If `createAgent()` doesn't support runtime tool injection, fall back to binding tools before invocation (e.g., `entry.bind({ tools })` or equivalent).

### Execution in `invokeEntry()`

```typescript
if (kind === "agent") {
  if (
    typeof entry === "object" &&
    entry !== null &&
    "invoke" in entry &&
    typeof (entry as { invoke?: unknown }).invoke === "function"
  ) {
    // Delegate to agent adapter for input splitting + tool injection
    return await executeAgent(entry, input, context)
  }
  throw new Error("Agent entry must expose invoke(input)")
}
```

### `dawn build` command

Generates deployment artifacts for LangGraph Platform.

**What it does:**

1. Discovers all routes via `discoverRoutes()`
2. Discovers tools per route via `discoverToolDefinitions()`
3. For each route, generates a compiled entry file in `.dawn/build/`
4. Reads the user's `langgraph.json` (if it exists at app root)
5. Merges Dawn-generated `graphs` entries into the user's config
6. Writes the merged `langgraph.json` to `.dawn/build/`

**Compiled entries by route kind:**

| Kind | Compiled entry | Notes |
|---|---|---|
| `agent` | Converts tools with `tool()`, binds to agent, re-exports as `graph` | Tools baked in for production |
| `chain` | Re-exports `chain` as `graph` | Already self-contained |
| `graph` | Re-exports `graph` directly | Already self-contained |
| `workflow` | Wraps workflow function, re-exports as `graph` | Adapter wrapping |

**Example compiled entry for an agent route:**

```typescript
// .dawn/build/hello-tenant.ts (generated)
import { agent } from "../../src/app/(public)/hello/[tenant]/index.js"
import greet from "../../src/app/(public)/hello/[tenant]/tools/greet.js"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

const greetTool = tool(greet, {
  name: "greet",
  description: "Look up information about a tenant.",
  schema: z.object({ tenant: z.string() }),
})

export const graph = agent.bindTools([greetTool])
```

**`langgraph.json` merge strategy:**

The user owns `langgraph.json` at the app root — checked into git. Dawn owns the `graphs` field. At build time, Dawn reads the user's file, injects/overwrites `graphs`, and writes the merged result to `.dawn/build/langgraph.json`.

User's `langgraph.json`:
```json
{
  "node_version": "20",
  "env": ".env",
  "store": {
    "index": { "embed": "openai:text-embedding-3-small", "dims": 1536 }
  }
}
```

Generated `.dawn/build/langgraph.json`:
```json
{
  "node_version": "20",
  "env": ".env",
  "store": {
    "index": { "embed": "openai:text-embedding-3-small", "dims": 1536 }
  },
  "graphs": {
    "/hello/[tenant]#agent": "./.dawn/build/hello-tenant.ts:graph"
  }
}
```

If no user `langgraph.json` exists, Dawn generates a minimal one in `.dawn/build/`.

**Output structure:**
```
my-dawn-app/
├── langgraph.json              # user-owned, checked into git
├── .dawn/
│   └── build/
│       ├── langgraph.json      # merged output (gitignored)
│       └── hello-tenant.ts     # compiled entry (gitignored)
└── src/
    └── app/...
```

**CLI interface:**
```bash
dawn build                    # generates .dawn/build/ + merged langgraph.json
dawn build --clean            # removes .dawn/build/ first
```

The command lives in `packages/cli/src/commands/build.ts`.

**Deployment:** `langgraph deploy` points at `.dawn/build/langgraph.json`. A future `dawn deploy` could wrap this: run `dawn build` then `langgraph deploy --config .dawn/build/langgraph.json`.

**`assistant_id` consistency:** The same assistant ID format (`/hello/[tenant]#agent`) works against both `dawn dev` and LangGraph Platform. Client SDK calls are portable:

```typescript
await client.runs.wait(null, "/hello/[tenant]#agent", {
  input: { messages: [{ role: "user", content: "Hi" }] },
  config: { configurable: { tenant: "acme" } },
})
```

### Template update

The default `create-dawn-app` template changes from `chain` (RunnableLambda pipeline) to `agent` (createAgent with real LLM).

**New `index.ts`:**
```typescript
import { createAgent } from "langchain"

export const agent = createAgent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant for the {tenant} organization ({plan} plan). Answer questions about the tenant.",
})
```

**`tools/greet.ts`** — unchanged:
```typescript
/**
 * Look up information about a tenant.
 */
export default async (input: { readonly tenant: string }) => {
  return {
    name: input.tenant,
    plan: "starter",
  }
}
```

**`state.ts`** — kept for backward compatibility with test overlays that import `HelloState`.

**`package.json.template` changes:**
- Add `langchain` (new top-level package for `createAgent`)
- Keep `@langchain/core`, `@langchain/openai` (peer dependencies)
- Remove `zod` (not used by template)
- Keep all `@dawn-ai/*` packages

**`.dawn/dawn.generated.d.ts`** — regenerated to reflect the tool types (unchanged since route path and tools are the same).

### Harness test strategy

The template ships with `createAgent()` calling a real LLM. Harness tests need deterministic output without API keys.

**Approach:** Use the existing overlay mechanism. The basic template targets real usage. Harness tests use overlays that mock the agent for deterministic output.

**Framework harness** (`test/generated/`):
- Validates discovery of `kind: "agent"`
- Validates typegen output
- Validates `assistant_id` format `/hello/[tenant]#agent`
- Update `basic.expected.json` fixture

**Runtime harness** (`test/runtime/`):
- New `agent-basic.overlay.json` with a mock agent that returns deterministic output
- Validates `mode: "agent"` in execution result
- Parity testing: in-process, CLI, and server-backed execution

**Smoke harness** (`test/smoke/`):
- New `agent-basic.overlay.json` following same pattern
- Validates end-to-end with `kind: "agent"`

**Build harness** (new):
- Validates `dawn build` output structure
- Validates `.dawn/build/langgraph.json` merge behavior
- Validates compiled entry files are generated correctly

## Packages touched

| Package | Changes |
|---|---|
| `packages/sdk` | `RouteKind` type updated |
| `packages/core` | Discovery: `inferRouteKind()`, `loadRouteExports()`. Typegen: no changes needed. |
| `packages/cli` | `execute-route.ts`: new agent branch in `invokeEntry()`. `load-route-kind.ts`: agent normalization. `route-identity.ts`: agent mode. `runtime-registry.ts`: agent entries. `runtime-server.ts`: agent in `RunsWaitRequest`. `execute-route-server.ts`: agent mode. New `commands/build.ts`. |
| `packages/langchain` | New agent adapter: input splitting, tool injection, agent invocation. |
| `packages/devkit` | Template update: `index.ts`, `package.json.template`, `dawn.generated.d.ts`. |
| `packages/create-dawn-app` | Dependency specifier updates for `langchain` package. |
| `test/generated` | Updated fixtures for `kind: "agent"`. |
| `test/runtime` | New agent overlay fixtures. |
| `test/smoke` | New agent overlay fixtures. |

## What this does NOT change

- Route discovery mechanics (filesystem convention unchanged)
- Existing `chain`, `graph`, `workflow` behavior (no regressions)
- The `@dawn-ai/sdk` `BackendAdapter` interface shape
- The `dawn.config.ts` format
- The `@dawn-ai/langgraph` package
