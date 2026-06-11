import { resolve } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { WorkspaceFs } from "@dawn-ai/sdk"
import type { FilesystemBackend } from "@dawn-ai/workspace"
import { gatePathOp, type PathOperation } from "./permission-gate.js"

export interface CreateWorkspaceFsOptions {
  readonly workspaceRoot: string
  readonly backend: FilesystemBackend
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
 * Build the author-facing sandboxed filesystem handle (`ctx.fs`). Paths are
 * workspace-relative; every call runs the same permission gate as the
 * agent-facing workspace tools.
 */
export function createWorkspaceFs(opts: CreateWorkspaceFsOptions): WorkspaceFs {
  const bctx = { signal: opts.signal, workspaceRoot: opts.workspaceRoot }

  async function gate(operation: PathOperation, path: string): Promise<string> {
    const absPath = resolve(opts.workspaceRoot, path)
    const result = await gatePathOp(opts.permissions, operation, absPath, opts.workspaceRoot, {
      interruptCapable: opts.interruptCapable,
    })
    if (!result.allowed) throw new Error(result.reason)
    return absPath
  }

  return {
    async readFile(path, readOpts) {
      return opts.backend.readFile(await gate("readFile", path), bctx, readOpts)
    },
    async readBinaryFile(path, readOpts) {
      // Check backend capability before gating so users are never prompted to
      // approve a read that will immediately fail.
      const { readBinaryFile } = opts.backend
      if (!readBinaryFile) {
        throw new Error(
          "The configured filesystem backend does not support binary reads (readBinaryFile). " +
            "localFilesystem supports it; custom backends must implement it.",
        )
      }
      const absPath = await gate("readFile", path)
      return readBinaryFile.call(opts.backend, absPath, bctx, readOpts)
    },
    async writeFile(path, content) {
      return opts.backend.writeFile(await gate("writeFile", path), content, bctx)
    },
    async listDir(path = ".") {
      return [...(await opts.backend.listDir(await gate("listDir", path), bctx))]
    },
  }
}
