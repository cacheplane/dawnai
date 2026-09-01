# @dawn-ai/core

Low-level Dawn APIs for configuration, capabilities, route discovery, state resolution, and type generation.

**Use this when:** You are building Dawn integrations or tooling below the author-facing SDK. Direct route authors should use [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk) instead.

## Install

```bash
pnpm add @dawn-ai/core
```

## Example

The root export includes the typed configuration helper and pure type renderers:

```ts
import { config, renderDawnTypes } from "@dawn-ai/core"

export const appConfig = config({
  build: { targets: ["node"] },
})

export const declarations = renderDawnTypes({ appRoot: "/app", routes: [] }, [])
```

## Runtime and stability

- `@dawn-ai/core` is an edge-safe, low-level integration surface.
- `@dawn-ai/core/node` is a Node-only, low-level surface for filesystem discovery and compiler-backed extraction.
- `@dawn-ai/core/internal/compiler` is Node-only and internal. Application and integration code must not depend on it.

Importing `/node` registers the disk-backed `dawn.config.ts` loader. The root stays free of that filesystem-loader edge so static runtimes can seed configuration instead.

## Related

- [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk) — author-facing agents, tools, middleware, and route contracts.
- [`@dawn-ai/cli`](https://www.npmjs.com/package/@dawn-ai/cli) — route discovery, type generation, development, and builds.
- [Core API reference](https://dawnai.org/docs/api/core) — complete exports and surface boundaries.
- [Routes guide](https://dawnai.org/docs/routes) — Dawn's application and filesystem route model.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/core/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
