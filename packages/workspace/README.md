# @dawn-ai/workspace

Filesystem and shell backend contracts for Dawn agent workspaces.

**Use this when:** You are supplying filesystem or shell backends, middleware, or workspace tools to a Dawn application.

## Install

```bash
pnpm add @dawn-ai/workspace
```

## Example

```ts
import { compose, type FilesystemBackend, withFilesystemLogging } from "@dawn-ai/workspace"
import { localFilesystem } from "@dawn-ai/workspace/node"

const base: FilesystemBackend = localFilesystem({ maxFileBytes: 512 * 1024 })
const filesystem = compose(withFilesystemLogging())(base)
```

## Runtime and stability

- `@dawn-ai/workspace` is an edge-safe, supported application surface.
- `@dawn-ai/workspace/node` is a node-only, supported application surface.

Workspace backends define where operations run; they are not an isolation boundary by themselves. Use a sandbox provider when untrusted execution must leave the host process.

## Related

- [Workspace API reference](https://dawnai.org/docs/api/workspace) — exact backend, middleware, and tool contracts.
- [Workspace Filesystem](https://dawnai.org/docs/workspace) — application configuration and backend behavior.
- [`@dawn-ai/sandbox`](https://www.npmjs.com/package/@dawn-ai/sandbox) — isolated execution providers for workspace operations.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/workspace` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/workspace/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
