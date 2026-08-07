import type { PermissionsStore } from "@dawn-ai/permissions"
import type { WorkspaceFs } from "@dawn-ai/sdk"
import { POSIX_SEP, pureResolve } from "@dawn-ai/sdk/pure"
import type { FilesystemBackend } from "@dawn-ai/workspace"
import { gatePathOp, type PathOperation } from "./permission-gate.js"

export interface CreateWorkspaceFsOptions {
  /**
   * POSIX-normalized ABSOLUTE path. Containment is decided with pure path
   * arithmetic, which has no cwd to resolve a relative root against and throws
   * rather than guess; node callers get this for free (the CLI normalizes at
   * its boundary), and sandbox handles already report absolute in-container
   * roots.
   */
  readonly workspaceRoot: string
  /**
   * The backend, or a thunk resolved (and memoized) at the FIRST filesystem
   * operation. The thunk form exists for hosts that cannot know at handle-
   * construction time whether a backend is obtainable — an edge runtime with no
   * filesystem at all. Such a host passes a thunk that throws, and the throw
   * lands on the operation that actually needed a filesystem instead of on
   * every route execution, including the overwhelming majority that never
   * touch `ctx.fs`. It is deliberately NOT a way to make a missing backend
   * silent: the thunk still throws, by name, at first use.
   */
  readonly backend: FilesystemBackend | (() => FilesystemBackend)
  readonly permissions: PermissionsStore | undefined
  readonly signal: AbortSignal
  /**
   * Whether this execution context can surface the interactive LangGraph
   * permission interrupt (true inside agent-route tool execution; false for
   * workflow/graph entries, which run outside the graph).
   */
  readonly interruptCapable: boolean
}

/**
 * The jail's precondition, enforced where core is ENTERED rather than deep
 * inside `pureResolve`. Every host lane must canonicalize its app root to a
 * POSIX-absolute path before handing it to core (`toPosixAppRoot` in
 * `@dawn-ai/cli` is the node lane's single conversion); nothing mechanically
 * forces a NEW host entry point to do so, so a miss must fail here — loudly,
 * naming the value — instead of surfacing later as an opaque `pureResolve`
 * throw on the first file operation, or (worse) as a containment comparison
 * against a root that is not what the caller meant.
 */
function assertPosixAbsoluteWorkspaceRoot(workspaceRoot: string): void {
  if (workspaceRoot.startsWith(POSIX_SEP)) return
  throw new Error(
    `createWorkspaceFs requires a POSIX-normalized absolute workspaceRoot; got ${JSON.stringify(workspaceRoot)}. ` +
      "The host lane must canonicalize before calling core (see toPosixAppRoot in @dawn-ai/cli).",
  )
}

/**
 * Build the author-facing sandboxed filesystem handle (`ctx.fs`). Paths are
 * workspace-relative; every call runs the same permission gate as the
 * agent-facing workspace tools.
 */
export function createWorkspaceFs(opts: CreateWorkspaceFsOptions): WorkspaceFs {
  // Eager, and staying that way: the root is known at construction time, so a
  // host that hands core a relative one must hear about it here rather than on
  // some later file operation. Only the BACKEND is deferred below.
  assertPosixAbsoluteWorkspaceRoot(opts.workspaceRoot)
  const bctx = { signal: opts.signal, workspaceRoot: opts.workspaceRoot }

  // Memoized after the first successful resolution, so a thunk that opens a
  // real handle does so at most once per workspace handle. A thunk that throws
  // is re-entered on every operation — it has produced nothing to cache, and
  // each failed operation deserves its own loud error.
  let resolved: FilesystemBackend | undefined =
    typeof opts.backend === "function" ? undefined : opts.backend
  const backend = (): FilesystemBackend => {
    if (resolved === undefined) resolved = (opts.backend as () => FilesystemBackend)()
    return resolved
  }

  async function gate(operation: PathOperation, path: string): Promise<string> {
    // Order is load-bearing and must not be rearranged: resolve first (an
    // absolute `path` DISCARDS the root — that is what makes an escape
    // attempt classify as outside instead of being folded back inside), then
    // canonicalize BOTH operands through the backend so the gate compares real
    // locations rather than lexical strings (the symlink-escape cases in
    // workspace-fs.test.ts cover that half). `workspaceRoot` must already be a
    // POSIX-normalized absolute path — the node lane converts once at its
    // boundary (see `toPosixAppRoot` in @dawn-ai/cli); pureResolve throws on a
    // relative base rather than silently rooting it somewhere.
    const absPath = pureResolve(opts.workspaceRoot, path)
    const fs = backend()
    const canonicalPath = await fs.realPath(absPath, bctx)
    const canonicalRoot = await fs.realPath(opts.workspaceRoot, bctx)
    const result = await gatePathOp(opts.permissions, operation, canonicalPath, canonicalRoot, {
      interruptCapable: opts.interruptCapable,
    })
    if (!result.allowed) throw new Error(result.reason)
    return absPath
  }

  return {
    async readFile(path, readOpts) {
      return backend().readFile(await gate("readFile", path), bctx, readOpts)
    },
    async readBinaryFile(path, readOpts) {
      // Check backend capability before gating so users are never prompted to
      // approve a read that will immediately fail.
      const fs = backend()
      const { readBinaryFile } = fs
      if (!readBinaryFile) {
        throw new Error(
          "The configured filesystem backend does not support binary reads (readBinaryFile). " +
            "localFilesystem supports it; custom backends must implement it.",
        )
      }
      const absPath = await gate("readFile", path)
      return readBinaryFile.call(fs, absPath, bctx, readOpts)
    },
    async writeFile(path, content) {
      return backend().writeFile(await gate("writeFile", path), content, bctx)
    },
    async listDir(path = ".") {
      return [...(await backend().listDir(await gate("listDir", path), bctx))]
    },
  }
}
