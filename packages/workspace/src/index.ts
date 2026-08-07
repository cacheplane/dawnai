export { compose } from "./compose.js"
// NOTE: `localExec`/`localFilesystem` live on the `./node` subpath — importing
// them here would put node builtins back into every consumer's graph.
export type { LocalExecOptions } from "./local-exec.js"
export type { LocalFilesystemOptions } from "./local-filesystem.js"
export type {
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxSecurityPolicy,
} from "./sandbox-types.js"
export type {
  BackendContext,
  ExecBackend,
  ExecMiddleware,
  FilesystemBackend,
  FilesystemMiddleware,
} from "./types.js"
export { type LoggingOptions, withExecLogging, withFilesystemLogging } from "./with-logging.js"
