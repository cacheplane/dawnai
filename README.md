<p align="center">
  <img src="docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="360" />
</p>

# Dawn

Dawn is a TypeScript meta-framework for authoring agents and workflows: filesystem-based route discovery, the `agent()` descriptor, route-local tools, per-route middleware, type generation, a local development runtime, and `dawn build` for producing LangGraph Platform deployment artifacts.

## Status

This repository documents the current behavior only. Dawn does not host or run production traffic — `dawn build` produces deployment artifacts (`.dawn/build/langgraph.json` plus per-route entry files) that LangGraph Platform runs. Dawn is not a LangSmith trace replacement and not a hosted platform.

## Quickstart

1. Create a new app.

```bash
pnpm create dawn-ai-app my-dawn-app
cd my-dawn-app
pnpm install
```

2. Validate the app and generate types in one call.

```bash
pnpm exec dawn verify
```

3. Run the scaffolded route. The route path must be quoted because it contains `(`, `)`, and `[]`.

```bash
echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]"
```

4. Optionally start the local runtime in one terminal and send the same route through `--url` from another terminal.

```bash
pnpm exec dawn dev --port 3001
echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]" --url http://127.0.0.1:3001
```

## App Contract

A Dawn app root contains `package.json` and `dawn.config.ts`.

Route discovery starts at `src/app` by default.

`appDir` is the only currently supported config option, and it defaults to `src/app`.

A route is a directory containing `index.ts`. The `index.ts` exports exactly one of four route kinds: an `agent` descriptor (the scaffold default), a `workflow` function, a `graph` function/object, or a `chain`:

```ts
// agent-style route (the basic scaffold default)
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant for the {tenant} organization.",
})

// workflow-style route
export async function workflow(state, ctx) { return state }

// graph-style route
export async function graph(state, ctx) { return state }
// or
export const graph = { invoke: async (state, ctx) => state }

// chain-style route
export async function chain(state, ctx) { return state }
```

Route directories support these additional files:

- `state.ts` — default-exported Zod schema describing the route's state shape (the scaffold uses `z.object({...})`).
- `tools/*.ts` — route-local tools, each exporting `(input, ctx) => ...` where `ctx` is `{ middleware?, signal }`.
- `reducers/<field>.ts` — optional per-field reducers that override the default merge behavior for state.
- `run.test.ts` — colocated scenarios picked up by `dawn test`.
- `page.tsx` — UI route surface.

The current `basic` scaffold ships an agent-style route:

- `src/app/(public)/hello/[tenant]/index.ts` — `export default agent({ model, systemPrompt })`
- `src/app/(public)/hello/[tenant]/state.ts` — default-exported Zod schema
- `src/app/(public)/hello/[tenant]/tools/greet.ts` — a route-local tool

### Authoring agents

`agent({ model, systemPrompt, retry?: { maxAttempts, baseDelay } })` is the recommended export for new routes. The optional `retry` config controls how the agent retries failed model calls. `dawn build` binds route-local tools to the agent at build time so the LLM can invoke them on LangGraph Platform.

```ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "...",
  retry: { maxAttempts: 3, baseDelay: 250 },
})
```

### Middleware

Per-route middleware runs before each invocation. Use `defineMiddleware` together with `reject(status, body?)` to deny a request, or `allow(context?)` to continue and pass an immutable context bag through to tools via `ctx.middleware`:

```ts
import { defineMiddleware, allow, reject } from "@dawn-ai/sdk"

export default defineMiddleware(async (req) => {
  if (!req.headers.authorization) return reject(401, { error: "unauthorized" })
  return allow({ tenantId: req.params.tenant })
})
```

`req` (`MiddlewareRequest`) carries `assistantId`, `headers`, `method`, `params`, `routeId`, and `url`. Middleware runs identically under `dawn dev` and on the deployed runtime.

## Commands

This is the user-first command set the README focuses on today, not an exhaustive internal CLI reference.

### `create-dawn-ai-app`

Scaffold a new Dawn app from the available template set.

```bash
pnpm create dawn-ai-app my-dawn-app
```

### `dawn check`

Validate the app structure and configuration for the current workspace.

### `dawn verify`

Run all four integrity checks (app, routes, typegen, deps) in one command. The canonical pre-deploy gate, with optional `--json` output for CI.

### `dawn routes`

Discover and print the routes Dawn sees in the current app.

### `dawn typegen`

Generate route types for the current app.

### `dawn run`

Execute one route invocation with JSON stdin/stdout.

```bash
echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]"
```

### `dawn test`

Run colocated `run.test.ts` scenarios against route targets.

### `dawn dev`

Start the local development runtime for interactive route execution.

```bash
pnpm exec dawn dev
```

### `dawn build`

Produce LangGraph Platform deployment artifacts under `.dawn/build/`. Emits a `langgraph.json` (with `dependencies: ["."]`, `node_version: "22"`, and an `env` path) plus per-route entry files. Agent routes have their tools bound at build time.

```bash
pnpm exec dawn build
```

## Packages

- `@dawn-ai/core` owns discovery, config loading, validation, and route types.
- `@dawn-ai/sdk` owns the backend-neutral author-facing contract: types, helpers, runtime context, and tool authoring.
- `@dawn-ai/langgraph` is the LangGraph adapter that implements the `@dawn-ai/sdk` contract.
- `@dawn-ai/langchain` is the LangChain adapter that materializes `chain` and `agent` routes.
- `@dawn-ai/vite-plugin` is the Vite plugin that drives Dawn's typegen pipeline (extracts tool types, emits ambient route declarations).
- `@dawn-ai/cli` owns the user-facing commands and local runtime behavior.
- `create-dawn-ai-app` owns scaffolding for new apps.
- `@dawn-ai/devkit` owns shared template and file-generation helpers.
- `@dawn-ai/config-typescript` provides the shared TypeScript workspace configuration.
- `@dawn-ai/config-biome` provides the shared Biome workspace configuration.

## Current Boundaries

Local runtime ownership stops at `dawn dev`. Production traffic runs on LangGraph Platform from the artifacts `dawn build` emits.

The starter template surface is intentionally small, and the supported config surface is intentionally narrow.

## Documentation

The canonical reference lives on the docs site:

- [Getting started](https://dawn-ai.org/docs/getting-started)
- [Routes](https://dawn-ai.org/docs/routes)
- [Tools](https://dawn-ai.org/docs/tools)
- [State](https://dawn-ai.org/docs/state)
- [CLI](https://dawn-ai.org/docs/cli)
- [Dev server](https://dawn-ai.org/docs/dev-server)
- [Testing](https://dawn-ai.org/docs/testing)
- [Deployment](https://dawn-ai.org/docs/deployment)

## Contributing

For the public contribution workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md). For repository layout, test lanes, and local verification commands, see [CONTRIBUTORS.md](./CONTRIBUTORS.md).
