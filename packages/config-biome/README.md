# @dawn-ai/config-biome

Shared Biome lint and format configuration for Dawn TypeScript workspace packages.

**Use this when:** You are extending Dawn's internal shared Biome configuration. Application authors may copy these conventions, but this package primarily follows Dawn's own workspace tooling.

## Install

Install it as a dev dependency alongside Biome:

```bash
pnpm add -D @dawn-ai/config-biome @biomejs/biome
```

## Configuration

Extend the package from your `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.11/schema.json",
  "extends": ["@dawn-ai/config-biome"]
}
```

Or point Biome directly at the published configuration:

```bash
pnpm exec biome check --config-path ./node_modules/@dawn-ai/config-biome/biome.json .
```

## Runtime and stability

The root export and `@dawn-ai/config-biome/biome` both resolve to the supported `biome.json` tooling artifact. This is static configuration with no runtime import. It is maintained for Dawn's internal workspace and may evolve with Dawn's pinned Biome version.

## Related

- [`@dawn-ai/config-typescript`](https://www.npmjs.com/package/@dawn-ai/config-typescript) — shared compiler configurations for the same workspace packages.
- [API catalog entry](https://dawnai.org/docs/api#dawn-aiconfig-biome) — published configuration surfaces.
- [Getting Started](https://dawnai.org/docs/getting-started) — scaffold a Dawn application with workspace tooling configured.
- [Dawn repository contribution guide](https://github.com/cacheplane/dawnai/blob/main/CONTRIBUTING.md) — workspace development commands and checks.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/config-biome/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
