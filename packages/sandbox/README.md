<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/sandbox

Reference sandbox providers for Dawn workspace execution. The main export is a
Docker-backed `SandboxProvider` that redirects the workspace filesystem and
shell tools into a per-thread isolated environment.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Execution Sandbox](https://dawnai.org/docs/sandbox),
[Workspace Filesystem](https://dawnai.org/docs/workspace), and
[Configuration](https://dawnai.org/docs/configuration).

## Install

```bash
pnpm add @dawn-ai/sandbox
```

```ts
import { dockerSandbox, type DockerSandboxOptions } from "@dawn-ai/sandbox"
import { fakeSandbox, runProviderConformance } from "@dawn-ai/sandbox/testing"
import type { SandboxProvider } from "@dawn-ai/sandbox"
```

## Configure Docker

Docker must be installed and the daemon must be reachable.

```ts
import { config } from "@dawn-ai/cli"
import { dockerSandbox } from "@dawn-ai/sandbox"

export default config({
  sandbox: {
    provider: dockerSandbox({ image: "node:22-slim" }),
    network: { mode: "allow", denylist: ["169.254.169.254"] },
    env: { NODE_ENV: "production" },
    resources: { memoryMb: 512, cpus: 1, timeoutMs: 120_000 },
    idleTimeoutMs: 600_000,
  },
})
```

When this config is present, Dawn acquires a sandbox per conversation thread
and uses the returned `workspaceRoot`, filesystem backend, and exec backend for
`readFile`, `writeFile`, `listDir`, `runBash`, and `WorkspaceFs` calls.

## Public API

### Main export

- `dockerSandbox(options)` returns a `SandboxProvider`.
- `DockerSandboxOptions` accepts an `image` and an optional injected Docker CLI
  adapter for tests.
- `SandboxConfig`, `SandboxHandle`, `SandboxPolicy`, and `SandboxProvider` are
  re-exported from `@dawn-ai/workspace` for provider authors and config typing.

The Docker provider creates or reattaches a container named
`dawn-sbx-<threadId>` and a volume named `dawn-sbx-vol-<threadId>`. The
container runs with `/workspace` as its internal `workspaceRoot`.

### Testing export

`@dawn-ai/sandbox/testing` exports:

- `fakeSandbox()` - an in-memory `SandboxProvider` for deterministic unit tests
  and CI.
- `runProviderConformance({ name, makeProvider, describe })` - a shared
  Vitest conformance suite for custom sandbox providers.

## Provider Contract

A custom provider implements the `SandboxProvider` interface from
`@dawn-ai/workspace`:

```ts
import type { SandboxProvider } from "@dawn-ai/sandbox"

export const provider: SandboxProvider = {
  name: "custom",
  async acquire({ threadId, policy, signal }) {
    return {
      threadId,
      filesystem,
      exec,
      workspaceRoot: "/workspace",
    }
  },
  async release(threadId) {},
  async destroy(threadId) {},
  async preflight() {
    return { ok: true }
  },
}
```

`acquire()` is idempotent per thread. `release()` drops warm compute but keeps
the volume. `destroy()` removes both compute and persisted workspace data.

## Testing Notes

Use `fakeSandbox()` in ordinary app tests:

```ts
import { config } from "@dawn-ai/cli"
import { fakeSandbox } from "@dawn-ai/sandbox/testing"

export default config({
  sandbox: { provider: fakeSandbox() },
})
```

Use `runProviderConformance()` for a real provider implementation. The suite
checks acquire idempotency, per-thread isolation, release-versus-destroy
persistence, and numeric exec exit codes.

## Limitations and Security

- Docker `network: { mode: "deny" }` maps to `--network none` and provides zero
  egress for the reference provider.
- Docker allow-mode denylists are best-effort. Use deny mode, a stricter
  provider, or an egress proxy for hostile workloads.
- The host environment is never inherited; only `sandbox.env` is passed.
- Docker is not a microVM boundary and does not protect against container
  escape vulnerabilities.
- The sandbox controls where approved workspace operations run. It does not
  decide which tools exist or which permission prompts are approved.

## License

MIT
