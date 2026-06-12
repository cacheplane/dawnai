/**
 * Sandboxed filesystem handle scoped to the route's workspace/ directory.
 *
 * Relative paths resolve against the workspace root. Every call is
 * permission-gated with the same rules as the agent-facing workspace tools:
 * paths inside workspace/ are always allowed; paths outside consult the
 * permissions store (interactive prompt where available, fail-closed
 * otherwise).
 */
export interface WorkspaceFs {
  /** Read a UTF-8 file. */
  readFile(path: string, opts?: { readonly maxBytes?: number }): Promise<string>
  /**
   * Read raw bytes (images, PDFs, …). Throws a descriptive error when the
   * configured filesystem backend does not implement binary reads.
   */
  readBinaryFile(path: string, opts?: { readonly maxBytes?: number }): Promise<Uint8Array>
  /** Write a UTF-8 file. localFilesystem creates missing parent directories. */
  writeFile(path: string, content: string): Promise<{ readonly bytesWritten: number }>
  /** List entries (leaf names). Defaults to the workspace root. */
  listDir(path?: string): Promise<readonly string[]>
}

/** The context argument Dawn passes to a route tool's function. */
export interface DawnToolContext {
  readonly signal: AbortSignal
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly fs: WorkspaceFs
}
