<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180">
</p>

# @dawn-ai/sdk

Author-facing TypeScript declarations for Dawn agents, tools, middleware, memory, routes, and typed runtime contracts.

**Use this when:** You are authoring routes, tools, middleware, memory declarations, or typed runtime contracts.

<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install

Requires Node.js 24 or later.

```bash
pnpm add @dawn-ai/sdk
```

Add `zod` when declaring typed long-term memory:

```bash
pnpm add zod
```

## Example

Define a minimal agent route:

```ts
// src/app/support/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer support questions clearly and concisely.",
})
```

The same package provides adjacent memory and middleware declarations:

```ts
// src/app/support/memory.ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
  }),
})
```

```ts
// src/middleware.ts
import { defineMiddleware } from "@dawn-ai/sdk"

export default defineMiddleware(() => ({ action: "continue" }))
```

## Runtime and stability

- `@dawn-ai/sdk` is the supported, edge-safe application surface.
- `@dawn-ai/sdk/pure` is a supported, dependency-free edge-safe integration surface.
- `@dawn-ai/sdk/testing` is a supported Node-only scenario-authoring surface. It is separate from `@dawn-ai/testing`.

## Related

- [`@dawn-ai/cli`](https://www.npmjs.com/package/@dawn-ai/cli) develops, tests, builds, and serves routes declared with the SDK.
- [`@dawn-ai/testing`](https://www.npmjs.com/package/@dawn-ai/testing) provides programmatic harnesses for Dawn applications.
- [SDK API reference](https://dawnai.org/docs/api/sdk)
- [Agents](https://dawnai.org/docs/agents)
- [Tools](https://dawnai.org/docs/tools)
- [Middleware](https://dawnai.org/docs/middleware)
- [Memory](https://dawnai.org/docs/memory)
- [Scenario testing](https://dawnai.org/docs/testing)

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/sdk` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/sdk/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
