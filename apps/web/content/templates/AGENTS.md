# Dawn App — Coding Agent Instructions

This project uses **Dawn**, a TypeScript-first meta-framework for building graph-based AI agents with the ergonomics of Next.js. When working in this project, follow the Dawn conventions below.

## Project Shape

- **`dawn.config.ts`** at the repo root. Only supported field is `appDir` (defaults to `src/app`). Do not invent other config. The config is parsed by a strict tokenizer — only string-literal `appDir: "..."` or `const X = "..."; export default { appDir: X }` are supported.
- **`src/app/`** — all routes live here. A route is a directory containing `index.ts`.
- **`src/app/**/index.ts`** — route entry. MUST export exactly ONE of:
  - `agent` — a `DawnAgent` descriptor from `@dawn-ai/sdk`, typically the `default` export. Preferred for LLM-driven routes; tools auto-bind at build time.
  - `workflow` (async function — explicit code-driven orchestration)
  - `graph` (LangGraph graph instance)
  - `chain` (LangChain LCEL Runnable)
- **`src/app/**/state.ts`** — the route's state schema (default-exported Zod schema). Imported by `index.ts`.
- **`src/app/**/tools/*.ts`** — co-located tools. Each file has a default export that is an async function. Types are inferred and written to `dawn.generated.d.ts`.
- **`src/tools/*.ts`** — shared tools (optional). Discovered alongside route-local tools and merged into every route's tool registry. Route-local tools override shared tools with the same name.
- **`src/middleware.ts`** — optional. Default-exports a function returned by `defineMiddleware(...)`. Runs before every `/runs/wait` and `/runs/stream` request, on `dawn dev` and on LangSmith.
- **`src/app/**/run.test.ts`** — colocated scenario tests. Default-export an array of scenario records (`{ name, input, expect, run?, assert? }`). Custom assertion helpers live at `@dawn-ai/sdk/testing` (`expectOutput`, `expectMeta`, `expectError`).
- **`dawn.generated.d.ts`** — auto-generated. Do NOT edit by hand.
- **`dawn:routes`** — virtual module emitted by the Dawn Vite plugin and backed by `dawn.generated.d.ts`. If `RouteTools` does not resolve, run `dawn typegen`.

## Pathname Rules

- Directory segments become URL pathname segments.
- Segments in parentheses `(public)` are route groups — excluded from the pathname.
- Segments in brackets `[tenant]` are dynamic — they are injected from the URL path onto state fields of the same name at runtime. Do NOT declare dynamic-segment fields in the Zod schema.

Example: `src/app/(public)/hello/[tenant]/index.ts` → pathname `/hello/[tenant]`.

## Defining an Agent Route

```ts
// src/app/(public)/hello/[tenant]/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a helpful assistant for the {tenant} organization.",
  // Optional retry policy:
  // retry: { maxAttempts: 3, baseDelay: 250 },
})
```

- `model` is a `KnownModelId` (covers OpenAI, Anthropic, and Google ids).
- `retry?: { maxAttempts?: number, baseDelay?: number }` — applied per agent call.
- Tools in the same route's `tools/` directory (and shared tools in `src/tools/`) are automatically bound to the agent at `dawn build` time.

## Tool Authoring

```ts
// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (
  input: { readonly tenant: string },
  ctx: { signal: AbortSignal; middleware?: Readonly<Record<string, unknown>> },
) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

- Input type is inferred from the parameter annotation; output type from the return.
- The second parameter is optional but recommended:
  - `ctx.signal` — `AbortSignal` for cooperative cancellation. Pass it to `fetch()` and any awaited operations.
  - `ctx.middleware` — readonly bag populated by `allow({ ... })` in `src/middleware.ts`. Request-scoped context (auth, tenancy, etc.) flows through here.
- Use `readonly` on input fields; Dawn preserves it.
- Input and output must be JSON-serializable (no `Date`, `Map`, classes, functions).
- Tools may live in either route-local `tools/` (preferred default) OR shared `src/tools/`. Route-local names override shared names.

## Middleware

```ts
// src/middleware.ts
import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"

export default defineMiddleware(async (req) => {
  if (!req.headers["x-tenant-id"]) {
    return reject(401, { error: "missing x-tenant-id" })
  }
  return allow({ tenantId: req.headers["x-tenant-id"] })
})
```

- `MiddlewareRequest`: `{ assistantId, headers, method, params, routeId, url }`.
- Return `reject(status, body?)` to short-circuit the request, or `allow(context?)` to continue.
- The `context` passed to `allow(...)` is forwarded to every tool as `ctx.middleware`.

## Route Entry — workflow form (alternative to agent)

```ts
// src/app/(public)/hello/[tenant]/index.ts
import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { z } from "zod"
import type state from "./state.js"

type HelloState = z.infer<typeof state>

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  // ctx.signal is the request-scoped AbortSignal.
  // ctx.tools.greet is fully typed from the route's tools/ directory.
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

The `RouteTools<"/hello/[tenant]">` lookup uses the route's pathname as the key — these keys are populated by `dawn typegen`. Run `dawn typegen` if `dawn:routes` does not resolve.

## Commands (run via `pnpm exec`)

- `dawn check` — validate app structure/config (lightweight).
- `dawn verify` — full integrity check across app, routes, typegen, deps. Preferred CI gate.
- `dawn routes` — list discovered routes.
- `dawn typegen` — regenerate `dawn.generated.d.ts` and per-route `tools.json`.
- `dawn run '/hello/acme'` — execute a route once with JSON stdin/stdout.
- `dawn test` — run colocated `run.test.ts` scenarios.
- `dawn dev` — local runtime server (LangSmith protocol).
- `dawn build` — write `.dawn/build/langgraph.json` and per-route entry files for LangSmith deployment. Generated `langgraph.json` includes `dependencies: ["."]`, `env`, and `node_version: "22"`. Assistant ids are `<routeId>#<kind>` (e.g. `/hello/[tenant]#agent`).

## Packages

- `@dawn-ai/sdk` — backend-neutral contract: `agent`, `defineMiddleware`, `allow`, `reject`, types (`RuntimeContext` carries `signal: AbortSignal`, `AgentConfig`, `RetryConfig`, `MiddlewareRequest`, etc.).
- `@dawn-ai/langgraph` — adapter for LangGraph graphs and workflows.
- `@dawn-ai/langchain` — adapter for LangChain LCEL chains.
- `@dawn-ai/cli` — the `dawn` CLI. Test helpers live at `@dawn-ai/sdk/testing`.

## Do Not

- Do NOT edit `dawn.generated.d.ts` or files under `.dawn/`.
- Do NOT add Zod schemas for tool input/output — types are inferred from TypeScript source.
- Do NOT export more than one of `agent`/`workflow`/`graph`/`chain` from a single `index.ts`.
- Do NOT declare dynamic-segment fields (e.g. `tenant`) in the `state.ts` Zod schema — they are injected from the URL path.
- Do NOT edit `.dawn/build/langgraph.json` by hand. To deploy, run `dawn build` and hand `.dawn/build/` to LangSmith.

## Reference

- Full agent-consumable reference: https://dawnai.org/llms-full.txt
- Compact summary: https://dawnai.org/llms.txt
- Human docs: https://dawnai.org/docs/getting-started
