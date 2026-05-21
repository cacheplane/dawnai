/**
 * Workspace backend type interfaces.
 *
 * Backends are plain objects implementing these interfaces. The
 * workspace capability calls into them to perform filesystem reads,
 * writes, listings, and shell command execution. Defaults
 * (`localFilesystem`, `localExec`) ship in this package; users can
 * provide their own implementations via dawn.config.ts.
 */

export interface BackendContext {
  /** Aborts when the parent agent run is cancelled. */
  readonly signal: AbortSignal
  /** Absolute filesystem path of the route's workspace directory. */
  readonly workspaceRoot: string
}

export interface FilesystemBackend {
  /**
   * Read a UTF-8 file. `path` is an already-resolved absolute path
   * inside `ctx.workspaceRoot` — the capability has done the path-jail.
   */
  readFile(path: string, ctx: BackendContext): Promise<string>

  /** Write a UTF-8 file. Returns the byte count of `content`. */
  writeFile(
    path: string,
    content: string,
    ctx: BackendContext,
  ): Promise<{ readonly bytesWritten: number }>

  /** List entries in a directory. Returns leaf names (not full paths). */
  listDir(path: string, ctx: BackendContext): Promise<readonly string[]>
}

export interface ExecBackend {
  /**
   * Run a shell command. `args.cwd`, if provided, is already-resolved
   * to an absolute path inside `ctx.workspaceRoot`.
   */
  runCommand(
    args: {
      readonly command: string
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
    },
    ctx: BackendContext,
  ): Promise<{
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number
  }>
}

/**
 * A filesystem middleware is a function that wraps a backend to add
 * cross-cutting behavior (logging, caching, etc.). Compose multiple
 * middlewares via `compose()`.
 */
export type FilesystemMiddleware = (next: FilesystemBackend) => FilesystemBackend

/** See FilesystemMiddleware. */
export type ExecMiddleware = (next: ExecBackend) => ExecBackend
