<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/sdk

The author-facing TypeScript SDK for Dawn, the meta-framework for LangGraph that lets you build LangGraph agents like Next.js apps. Use it to declare AI agent and workflow routes, define request middleware, and type the runtime context, tools, and route metadata that the Dawn CLI consumes. Ships small runtime helpers (`agent()`, `defineMiddleware()`, `allow()`, `reject()`, `isDawnAgent()`) alongside the type primitives — it is the canonical entry point for authoring Dawn routes.

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

- **Agents** — `agent()`, `AgentConfig`, `DawnAgent`, `ModelProviderId`, `ReasoningConfig`, `RetryConfig`, `isDawnAgent`
- **Middleware** — `defineMiddleware()`, `allow()`, `reject()`, `DawnMiddleware`, `MiddlewareRequest`, `MiddlewareResult`
- **Route and runtime types** — `RouteConfig`, `RouteKind`, `RuntimeContext`, `RuntimeTool`, `ToolRegistry`, `KnownModelId`

### Declaring an agent route

A Dawn route's `index.ts` exports an `agent()` descriptor. The `model` field is typed against `KnownModelId`; `provider`, `reasoning`, and `retry` are optional.

```ts
// src/app/hello/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a helpful assistant.",
  retry: { maxAttempts: 3, baseDelay: 250 },
})
```

`provider?: ModelProviderId` is optional. When omitted, Dawn infers a provider for known model families. Set it explicitly to one of the supported built-in provider ids for aliases, ambiguous model names, local models, or provider-router model ids.

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

- [Routes](https://dawnai.org/docs/routes)
- [Tools](https://dawnai.org/docs/tools)
- [State](https://dawnai.org/docs/state)
- [Getting started](https://dawnai.org/docs/getting-started)

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawnai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## License

MIT
