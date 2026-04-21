# Dawn App — Coding Agent Instructions

This project uses **Dawn**, a TypeScript-first meta-framework for building graph-based AI agents with the ergonomics of Next.js. When working in this project, follow the Dawn conventions below.

## Project Shape

- **`dawn.config.ts`** at the repo root. Only supported field is `appDir` (defaults to `src/app`). Do not invent other config.
- **`src/app/`** — all routes live here. A route is a directory containing `index.ts`.
- **`src/app/**/index.ts`** — route entry. MUST export exactly ONE of:
  - `workflow` (async function — most common)
  - `graph` (LangGraph graph instance)
  - `chain` (LangChain LCEL Runnable)
- **`src/app/**/state.ts`** — the route's state type. Imported by `index.ts`.
- **`src/app/**/tools/*.ts`** — co-located tools. Each file has a default export that is an async function. Types are inferred and written to `dawn.generated.d.ts`.
- **`src/app/**/run.test.ts`** — colocated scenario tests. Use `@dawn/sdk/testing`.
- **`dawn.generated.d.ts`** — auto-generated. Do NOT edit by hand.

## Pathname Rules

- Directory segments become URL pathname segments.
- Segments in parentheses `(public)` are route groups — excluded from the pathname.
- Segments in brackets `[tenant]` are dynamic — they become state fields of the same name.

Example: `src/app/(public)/hello/[tenant]/index.ts` → pathname `/hello/[tenant]`.

## Tool Authoring

```ts
// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

- Input type is inferred from the parameter annotation.
- Output type is inferred from the return.
- Tool is available as `ctx.tools.greet` inside the route's workflow, fully typed.
- Use `readonly` on input fields; Dawn preserves it.
- Input and output must be JSON-serializable.

## Route Entry

```ts
// src/app/(public)/hello/[tenant]/index.ts
import type { RuntimeContext } from "@dawn/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>
) {
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

## Commands (run via `pnpm exec`)

- `dawn check` — validate app structure/config.
- `dawn routes` — list discovered routes.
- `dawn typegen` — regenerate `dawn.generated.d.ts`.
- `dawn run '/hello/acme'` — execute a route once with JSON stdin/stdout.
- `dawn test` — run colocated `run.test.ts` scenarios.
- `dawn dev` — local runtime server (LangGraph Platform protocol).

## Packages

- `@dawn/sdk` — backend-neutral contract (types, `RuntimeContext`, test helpers).
- `@dawn/langgraph` — adapter for LangGraph graphs and workflows.
- `@dawn/langchain` — adapter for LangChain LCEL chains.
- `@dawn/cli` — the `dawn` CLI.

## Do Not

- Do NOT edit `dawn.generated.d.ts`.
- Do NOT add Zod schemas for tool input/output — types are inferred.
- Do NOT put tools outside a route's `tools/` directory.
- Do NOT export more than one of `workflow`/`graph`/`chain` from a single `index.ts`.
- Do NOT deploy from Dawn directly — Dawn owns local development; production runs on LangGraph Platform.

## Reference

- Full agent-consumable reference: https://dawnai.org/llms-full.txt
- Compact summary: https://dawnai.org/llms.txt
- Human docs: https://dawnai.org/docs/getting-started
