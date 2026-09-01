# @dawn-ai/vite-plugin

Internal Vite integration for Dawn's route discovery and TypeScript type-generation pipeline.

**Use this when:** You are working on Dawn's type-generation pipeline. Dawn application authors should use the [`dawn` CLI](https://www.npmjs.com/package/@dawn-ai/cli), which wires this integration for them.

## Install

```bash
pnpm add -D @dawn-ai/vite-plugin vite
```

## Example

```ts
import { dawnToolSchemaPlugin as dawn } from "@dawn-ai/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [dawn()],
})
```

## Runtime and stability

`@dawn-ai/vite-plugin` is a Node-only, internal tooling surface. It reads Dawn routes, analyzes TypeScript tool sources, and writes generated declarations during development and builds. It is not an application-runtime plugin or an author-facing compatibility contract.

## Related

- [`@dawn-ai/cli`](https://www.npmjs.com/package/@dawn-ai/cli) — the supported application entry point for type generation and builds.
- [`@dawn-ai/core`](https://www.npmjs.com/package/@dawn-ai/core) — discovery, compiler, and type-rendering primitives used by this plugin.
- [API catalog entry](https://dawnai.org/docs/api#dawn-aivite-plugin) — audience and compatibility summary.
- [Routes guide](https://dawnai.org/docs/routes) — the route and tool files consumed by the pipeline.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/vite-plugin/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
