<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/cli

The `dawn` command and runtime embedding entry points for developing, checking, testing, building, and serving Dawn applications.

## Install

```bash
pnpm add -D @dawn-ai/cli
pnpm exec dawn dev
```

Install it as a production dependency only when your application imports the runtime:

```ts
import { serveRuntime } from "@dawn-ai/cli"
```

## Runtime and stability

- `@dawn-ai/cli` and its `dawn` command are supported node-only application/tooling surfaces.
- `@dawn-ai/cli/fetch` is a supported edge-safe integration surface for generated fetch deployments.
- `@dawn-ai/cli/runtime` is node-only and low-level.
- `@dawn-ai/cli/testing` is a supported node-only testing surface.

Use the [CLI API reference](https://dawnai.org/docs/api/cli) for imports and embedding contracts, and the [CLI guide](https://dawnai.org/docs/cli) for commands and workflows. The generated CLI docs bundle includes every registered package reference page.

## License

MIT
