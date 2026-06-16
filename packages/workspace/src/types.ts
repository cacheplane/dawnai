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
   * Pass `opts.maxBytes` to override the backend's default size cap for
   * this single call (e.g. use `Number.POSITIVE_INFINITY` for uncapped reads
   * of offloaded tool outputs).
   */
  readFile(
    path: string,
    ctx: BackendContext,
    opts?: { readonly maxBytes?: number },
  ): Promise<string>

  /**
   * Read a file's raw bytes. Like `readFile`, `path` is an already-resolved
   * absolute path inside `ctx.workspaceRoot` — the capability has done the
   * path-jail. No decoding is applied. `opts.maxBytes` overrides the
   * backend's default size cap for this single call (same semantics as
   * `readFile`).
   *
   * Optional — backends that omit it provide no binary read; callers must
   * handle absence with a clear error (mirror how offload GC handles a
   * missing `statFile`).
   */
  readBinaryFile?(
    path: string,
    ctx: BackendContext,
    opts?: { readonly maxBytes?: number },
  ): Promise<Uint8Array>

  /** Write a UTF-8 file. Returns the byte count of `content`. */
  writeFile(
    path: string,
    content: string,
    ctx: BackendContext,
  ): Promise<{ readonly bytesWritten: number }>

  /** List entries in a directory. Returns leaf names (not full paths). */
  listDir(path: string, ctx: BackendContext): Promise<readonly string[]>

  /**
   * Canonicalize an already-resolved absolute path — resolving symlinks and
   * `..` to a real target location — so the permission gate compares true
   * locations, not lexical strings. Must tolerate a path that does not exist
   * yet (e.g. a writeFile target): resolve the deepest existing ancestor and
   * re-append the non-existent tail. Backends with no symlink concept
   * (in-memory, remote) may return the path unchanged.
   */
  realPath(path: string, ctx: BackendContext): Promise<string>

  /** Stat a file. Optional — backends that omit it disable offload GC. */
  statFile?(
    path: string,
    ctx: BackendContext,
  ): Promise<{ readonly size: number; readonly mtimeMs: number }>

  /** Delete a file. Optional — required for offload GC eviction. */
  removeFile?(path: string, ctx: BackendContext): Promise<void>

  /** Bump a file's mtime to now (LRU-by-access). Optional. */
  touchFile?(path: string, ctx: BackendContext): Promise<void>

  /** Create a directory (recursive). Optional — offloading uses it to ensure the tool-outputs/ dir exists. */
  mkdir?(path: string, ctx: BackendContext): Promise<void>
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
