# @dawn-ai/config-typescript

Shared TypeScript compiler configurations for Dawn packages and applications.

**Use this when:** You are extending Dawn's shared TypeScript configurations instead of maintaining the same strict compiler defaults yourself.

## Install

Install it as a dev dependency alongside TypeScript:

```bash
pnpm add -D @dawn-ai/config-typescript typescript
```

## Configuration

Choose the configuration that matches the project runtime in `tsconfig.json`:

```json
{
  "extends": "@dawn-ai/config-typescript/node",
  "include": ["src/**/*.ts"]
}
```

## Runtime and stability

The supported static configuration exports are:

- `@dawn-ai/config-typescript` and `/base` for strict, no-emit projects.
- `@dawn-ai/config-typescript/library` for declaration-emitting libraries.
- `@dawn-ai/config-typescript/node` for NodeNext libraries.
- `@dawn-ai/config-typescript/nextjs` for Next.js applications.

These are tooling artifacts, not runtime imports. The Next.js configuration carries React and Node type dependencies; the other exports do not add runtime code.

## Related

- [`@dawn-ai/config-biome`](https://www.npmjs.com/package/@dawn-ai/config-biome) — shared lint and formatting configuration.
- [API catalog entry](https://dawnai.org/docs/api#dawn-aiconfig-typescript) — published configuration surfaces.
- [Getting Started](https://dawnai.org/docs/getting-started) — scaffold a Dawn application with TypeScript configured.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/config-typescript/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
