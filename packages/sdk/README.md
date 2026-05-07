<p>
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/sdk

The author-facing SDK for Dawn. Use it to declare agent routes, define request middleware, and type the runtime context, tools, and route metadata that the Dawn CLI consumes. Ships small runtime helpers (`agent()`, `defineMiddleware()`, `allow()`, `reject()`, `isDawnAgent()`) alongside the type primitives — it is the canonical entry point for authoring Dawn routes.

## Install

```sh
npm install @dawn-ai/sdk
# or
pnpm add @dawn-ai/sdk
# or
yarn add @dawn-ai/sdk
```

Requires Node.js 22.12+.

## Key APIs

The SDK groups around three surfaces:

- **Agents** — `agent()`, `AgentConfig`, `DawnAgent`, `RetryConfig`, `isDawnAgent`
- **Middleware** — `defineMiddleware()`, `allow()`, `reject()`, `DawnMiddleware`, `MiddlewareRequest`, `MiddlewareResult`
- **Route and runtime types** — `RouteConfig`, `RouteKind`, `RuntimeContext`, `RuntimeTool`, `ToolRegistry`, `KnownModelId`

### Declaring an agent route

A Dawn route's `index.ts` exports an `agent()` descriptor. The `model` field is typed against `KnownModelId`; `retry` is optional.

```ts
// src/app/hello/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant.",
  retry: { maxAttempts: 3, baseDelay: 250 },
})
```

### Defining middleware

Middleware runs before a route invocation and can either continue (optionally attaching context) or reject with a status code.

```ts
// src/app/hello/middleware.ts
import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"

export default defineMiddleware((req) => {
  if (!req.headers.authorization) {
    return reject(401, { error: "missing authorization" })
  }
  return allow({ tenant: req.params.tenant })
})
```

## Documentation

Full reference and guides:

- Routes — https://dawn-ai.org/docs/routes
- Tools — https://dawn-ai.org/docs/tools
- State — https://dawn-ai.org/docs/state
- Getting started — https://dawn-ai.org/docs/getting-started

## License

MIT
