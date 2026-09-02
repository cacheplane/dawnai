# @dawn-ai/sandbox

Docker and Kubernetes sandbox providers for isolated Dawn workspace execution.

**Use this when:** You need to isolate workspace filesystem and shell execution from the Dawn host process.

## Install

```bash
pnpm add @dawn-ai/sandbox
```

## Example

```ts
import { dockerSandbox } from "@dawn-ai/sandbox"
import { fakeSandbox } from "@dawn-ai/sandbox/testing"

const provider = dockerSandbox({ image: "node:24-slim" })
const testProvider = fakeSandbox()
```

## Runtime and stability

- `@dawn-ai/sandbox` is a node-only, supported application surface.
- `@dawn-ai/sandbox/testing` is a node-only, supported testing surface.

A sandbox narrows where workspace operations run; applications still own image hardening, credentials, network policy, and resource limits.

## Related

- [Sandbox API reference](https://dawnai.org/docs/api/sandbox) — Docker, Kubernetes, and testing provider contracts.
- [Execution Sandbox guide](https://dawnai.org/docs/sandbox) — application setup and security boundaries.
- [`@dawn-ai/workspace`](https://www.npmjs.com/package/@dawn-ai/workspace) — the filesystem and shell contracts sandbox providers implement.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/sandbox` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/sandbox/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
