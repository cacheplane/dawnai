import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { isAbsolute, normalize, relative, resolve } from "node:path"

/**
 * Resolve a user-supplied path against a workspace root, rejecting anything
 * that would escape the workspace.
 *
 * Rules:
 *  - Absolute paths are rejected outright.
 *  - The path is normalized; any `..` segment that escapes the workspace is rejected.
 *  - If the resolved path (or any ancestor) is a symlink, its real path must
 *    also be inside the workspace.
 *
 * The workspace directory is created if it does not exist.
 */
export function resolveWorkspacePath(workspaceRoot: string, userPath: string): string {
  if (!existsSync(workspaceRoot)) {
    mkdirSync(workspaceRoot, { recursive: true })
  }

  if (isAbsolute(userPath)) {
    throw new Error(`Path is absolute: ${userPath}`)
  }

  const normalized = normalize(userPath)
  const resolved = resolve(workspaceRoot, normalized)
  const rel = relative(workspaceRoot, resolved)
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${userPath}`)
  }

  // Symlink check: if the path exists and resolves outside, reject.
  if (existsSync(resolved)) {
    const real = realpathSync(resolved)
    const realRel = relative(realpathSync(workspaceRoot), real)
    if (realRel.startsWith("..")) {
      throw new Error(`Path resolves outside workspace via symlink: ${userPath}`)
    }
  }

  return resolved
}

/**
 * Resolve the workspace root for the example. Lives at `<cwd>/workspace`.
 */
export function workspaceRoot(): string {
  return resolve(process.cwd(), "workspace")
}
