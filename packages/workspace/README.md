<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/workspace

Filesystem-backed workspace utilities for Dawn agents — reading, writing, and managing files in an agent's working directory.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Workspace Filesystem](https://dawnai.org/docs/workspace),
[Execution Sandbox](https://dawnai.org/docs/sandbox), and
[Configuration](https://dawnai.org/docs/configuration#backends).

## Install

```bash
pnpm add @dawn-ai/workspace
```

```ts
import {
  compose,
  localExec,
  localFilesystem,
  withExecLogging,
  withFilesystemLogging,
  type ExecBackend,
  type FilesystemBackend,
  type SandboxProvider,
} from "@dawn-ai/workspace"
```

## Activation Behavior

The built-in workspace capability activates for agent routes when either:

- a `workspace/` directory exists under the app root, or
- the runtime supplies an explicit `context.workspaceRoot`, which is how sandbox
  integration redirects workspace operations into an isolated backend.

When active, Dawn contributes four agent-facing tools: `listDir`, `readFile`,
`writeFile`, and `runBash`. The same backend and permission gate also power the
author-facing `WorkspaceFs` handle exposed as `ctx.fs` in route tools and
runtime contexts.

In normal local development, `workspaceRoot` resolves to
`<appRoot>/workspace`. In sandboxed execution, the provider's handle supplies
the internal root, such as `/workspace`, and the tools operate there instead of
on the host directory.

## Public API

### Backend factories

- `localFilesystem(options?)` returns the default filesystem backend. It reads
  UTF-8 files, supports binary reads, creates parent directories on writes,
  lists leaf names, canonicalizes real paths for permission checks, and
  implements optional methods used by tool-output offloading.
- `localExec(options?)` returns the default shell backend. It runs commands with
  `ctx.workspaceRoot` as the default working directory.
- `LocalFilesystemOptions` and `LocalExecOptions` configure those factories.

### Backend contracts

- `BackendContext` carries the current `AbortSignal` and absolute
  `workspaceRoot`.
- `FilesystemBackend` defines `readFile`, `readBinaryFile?`, `writeFile`,
  `listDir`, `realPath`, and optional offload helpers.
- `ExecBackend` defines `runCommand({ command, cwd?, env? }, ctx)`.
- `FilesystemMiddleware` and `ExecMiddleware` wrap those backends.

### Middleware

- `compose(...middlewares)` creates a wrapper that applies middleware in order.
- `withFilesystemLogging(options?)` logs filesystem method calls.
- `withExecLogging(options?)` logs shell commands.
- `LoggingOptions` configures the destination sink.

Forward optional backend methods when writing middleware. Dropping
`readBinaryFile`, `statFile`, `removeFile`, `touchFile`, or `mkdir` changes
runtime behavior.

### Sandbox contract

The package owns the provider-agnostic sandbox types:

- `SandboxConfig`
- `SandboxPolicy`
- `SandboxHandle`
- `SandboxProvider`

`SandboxHandle.filesystem` and `SandboxHandle.exec` are the same backend
interfaces consumed by the workspace capability, and `SandboxHandle.workspaceRoot`
becomes the root for agent tools and `WorkspaceFs`.

## Examples

Configure a logging filesystem backend:

```ts
import { compose, localFilesystem, withFilesystemLogging } from "@dawn-ai/workspace"

export default {
  backends: {
    filesystem: compose(withFilesystemLogging())(localFilesystem()),
  },
} satisfies import("@dawn-ai/core").DawnConfig
```

Implement a minimal custom filesystem backend:

```ts
import type { FilesystemBackend } from "@dawn-ai/workspace"

export const filesystem: FilesystemBackend = {
  async readFile(path) {
    return remote.readText(path)
  },
  async writeFile(path, content) {
    await remote.writeText(path, content)
    return { bytesWritten: Buffer.byteLength(content) }
  },
  async listDir(path) {
    return remote.list(path)
  },
  async realPath(path) {
    return path
  },
}
```

## Testing Notes

Use `localFilesystem()` with a temporary `workspaceRoot` for backend tests, or
`createWorkspaceHarness()` from `@dawn-ai/testing` when you want a ready-made
`WorkspaceFs` handle with Dawn's permission gate in front of it.

For sandbox behavior, use `fakeSandbox()` or `runProviderConformance()` from
`@dawn-ai/sandbox/testing`.

## Limitations and Security

- `@dawn-ai/workspace` provides backend interfaces and local implementations.
  Permission decisions live in `@dawn-ai/core`; tool availability lives in the
  built-in workspace capability.
- `localFilesystem()` is path-jailed by the core `WorkspaceFs` wrapper, not by
  callers invoking the backend directly. Direct backend use receives absolute
  paths and should be treated as trusted internal code.
- `localExec()` runs on the host. Use `@dawn-ai/sandbox` when shell commands
  need process and filesystem isolation.
- Logging middleware can include file contents and shell commands in logs.
  Route logs accordingly.

## License

MIT
