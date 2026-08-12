<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/sdk

Author-facing declarations for Dawn agents, tools, middleware, memory, and routes. This is the supported package most application code should import.

## Install

```bash
pnpm add @dawn-ai/sdk
```

```ts
import { agent, defineMemory, defineMiddleware } from "@dawn-ai/sdk"
```

## Runtime and stability

- `@dawn-ai/sdk` is a supported, edge-safe application surface.
- `@dawn-ai/sdk/pure` is a supported, dependency-free edge-safe integration surface.
- `@dawn-ai/sdk/testing` is a supported node-only scenario-authoring surface; it is separate from `@dawn-ai/testing`.

Use the [SDK API reference](https://dawnai.org/docs/api/sdk) for exact exports and contracts. Start with [Agents](https://dawnai.org/docs/agents), then see [Tools](https://dawnai.org/docs/tools), [Middleware](https://dawnai.org/docs/middleware), or [Scenario Testing](https://dawnai.org/docs/testing) for application workflows.

## License

MIT
