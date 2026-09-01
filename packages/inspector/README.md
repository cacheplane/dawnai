# @dawn-ai/inspector

Browser application for inspecting a running Dawn app.

**Use this when:** You want a browser inspector for reviewing memory and runtime state in a Dawn application.

## Install

Install the inspector application separately; the Dawn CLI launches it rather than importing it as an API:

```bash
pnpm add -D @dawn-ai/inspector
```

## Example

Launch it from a Dawn application:

```bash
pnpm exec dawn inspect
```

## Runtime and stability

`dawnInspector.server` identifies the supported node-only application shipped as a standalone server. The package is launched through the CLI, not imported as a TypeScript API.

## Related

- [Inspector guide](https://dawnai.org/docs/inspector) — launch options and browser workflow.
- [API catalog entry](https://dawnai.org/docs/api#dawn-aiinspector) — the package's runtime classification.
- [`@dawn-ai/cli`](https://www.npmjs.com/package/@dawn-ai/cli) — the command that launches the inspector.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/inspector` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/inspector/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
