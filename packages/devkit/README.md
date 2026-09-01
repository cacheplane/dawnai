# @dawn-ai/devkit

Internal scaffold templates and generated-application test utilities shared by Dawn tooling.

**Use this when:** You are working on Dawn scaffold templates or generator tests. Application authors should run [`create-dawn-ai-app`](https://www.npmjs.com/package/create-dawn-ai-app) instead of importing this package.

## Install

```bash
pnpm add -D @dawn-ai/devkit
```

## Example

```ts
import { resolveTemplateDir } from "@dawn-ai/devkit"

const templateDir = await resolveTemplateDir("research")
```

`resolveTemplateDir` accepts Dawn's supported `basic` and `research` template names and verifies that the bundled template directory exists.

## Runtime and stability

`@dawn-ai/devkit` is a Node-only, internal tooling surface. It reads packaged templates and supports Dawn's own scaffold generation and generated-app tests; it is not an application runtime or author-facing SDK.

## Related

- [`create-dawn-ai-app`](https://www.npmjs.com/package/create-dawn-ai-app) — the supported scaffold command for application authors.
- [`@dawn-ai/cli`](https://www.npmjs.com/package/@dawn-ai/cli) — development, verification, and build tooling for generated applications.
- [API catalog entry](https://dawnai.org/docs/api#dawn-aidevkit) — audience and compatibility summary.
- [Getting Started](https://dawnai.org/docs/getting-started) — scaffold and run a Dawn application.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/devkit/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
