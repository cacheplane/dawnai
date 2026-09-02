<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180">
</p>

# @dawn-ai/cli

Command-line development tools and runtime embedding entry points for Dawn applications.

**Use this when:** You are developing, checking, testing, building, serving, or embedding a Dawn runtime.

<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install

Requires Node.js 24 or later. Install the CLI as a development dependency for normal application workflows:

```bash
pnpm add -D @dawn-ai/cli
```

Install it as a production dependency only when application code imports its runtime entry points.

## Example

Use the local binary to develop, validate, test, and build an application:

```bash
pnpm exec dawn dev
pnpm exec dawn check
pnpm exec dawn test
pnpm exec dawn build
```

The corresponding commands are `dawn dev`, `dawn check`, `dawn test`, and `dawn build` when the local binary is already on `PATH`.

To let application code own a production Node listener, import `serveRuntime` from the package root:

```ts
import { serveRuntime } from "@dawn-ai/cli"

const runtime = await serveRuntime({
  appRoot: process.cwd(),
  host: "0.0.0.0",
  port: 8000,
})

console.log(runtime.url)
// Call await runtime.close() during your host's ordered shutdown.
```

## Runtime and stability

- `@dawn-ai/cli` and its `dawn` command are supported node-only application and tooling surfaces.
- `@dawn-ai/cli/fetch` is a supported edge-safe integration surface for generated fetch deployments.
- `@dawn-ai/cli/runtime` is Node-only and low-level.
- `@dawn-ai/cli/testing` is a deprecated, back-compat-only node-only alias of `@dawn-ai/sdk/testing`; it remains supported only for existing imports, and new scenario code should use the SDK subpath.

`serveRuntime()` starts once and does not watch files or run type generation at boot. Use `dawn dev` for the development watcher and generated types.

## Related

- [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk) supplies the route and runtime contracts consumed by the CLI.
- [`@dawn-ai/core`](https://www.npmjs.com/package/@dawn-ai/core) provides the route discovery, configuration, and type-generation primitives used by the CLI.
- [CLI guide](https://dawnai.org/docs/cli)
- [CLI API reference](https://dawnai.org/docs/api/cli)
- [Embed the runtime](https://dawnai.org/docs/embedding)
- [Deployment options](https://dawnai.org/docs/deployment)
- [`@dawn-ai/cli` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/cli/CHANGELOG.md)

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/cli` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/cli/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
