<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/core

Low-level integration APIs for Dawn configuration, capabilities, route discovery, state resolution, and type generation. Route authors should normally use `@dawn-ai/sdk` instead.

## Install

```bash
pnpm add @dawn-ai/core
```

```ts
import { config, renderDawnTypes } from "@dawn-ai/core"
```

## Runtime and stability

- `@dawn-ai/core` is an edge-safe, low-level integration surface.
- `@dawn-ai/core/node` is a node-only, low-level integration surface that adds filesystem discovery and compiler-backed extraction.
- `@dawn-ai/core/internal/compiler` is node-only and internal; application and integration code must not depend on it.

Use the [Core API reference](https://dawnai.org/docs/api/core) for exact exports and boundaries. See [Routes](https://dawnai.org/docs/routes) for the application model and [`@dawn-ai/sdk`](https://dawnai.org/docs/api/sdk) for route-authoring APIs.

## License

MIT
