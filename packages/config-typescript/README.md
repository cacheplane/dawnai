# @dawn-ai/config-typescript

Shared TypeScript compiler configurations for Dawn packages and applications.

**Use this when:** You are extending Dawn's shared TypeScript configurations instead of maintaining the same strict compiler defaults yourself.

## Install

Install the config as a dev dependency with TypeScript and the ambient types required by the chosen profile:

```bash
# /node
pnpm add -D @dawn-ai/config-typescript typescript @types/node
# /nextjs
pnpm add -D @dawn-ai/config-typescript typescript @types/node @types/react @types/react-dom
```

## Configuration

Choose the configuration that matches the project runtime in `tsconfig.json`:

```json
{
  "extends": "@dawn-ai/config-typescript/node",
  "include": ["src/**/*.ts"]
}
```

Use `@dawn-ai/config-typescript/nextjs` in `extends` for a Next.js application.

## Runtime and stability

The supported static exports are the root and `/base` for strict no-emit projects, `/library` for declaration-emitting libraries, `/node` for NodeNext libraries, and `/nextjs` for Next.js applications.

These are tooling artifacts, not runtime imports. Consumer projects install these ambient type packages directly; this config package's development dependencies do not install them transitively. Next.js, React, and React DOM remain application dependencies.

## Related

- [`@dawn-ai/config-biome`](https://www.npmjs.com/package/@dawn-ai/config-biome) — shared lint and formatting configuration.
- [API catalog entry](https://dawnai.org/docs/api#dawn-aiconfig-typescript) — published configuration surfaces.
- [Getting Started](https://dawnai.org/docs/getting-started) — scaffold a Dawn application with TypeScript configured.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/config-typescript/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
