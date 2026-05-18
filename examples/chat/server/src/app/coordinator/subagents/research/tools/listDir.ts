import { readdirSync, statSync } from "node:fs"
import { resolveWorkspacePath, workspaceRoot } from "../workspace-path.js"

/**
 * List the entries in a directory inside the workspace.
 * Pass "." to list the workspace root. Subdirectories are suffixed with "/".
 */
export default async (input: { readonly path: string }): Promise<string[]> => {
  const dir = resolveWorkspacePath(workspaceRoot(), input.path)
  const entries = readdirSync(dir)
  entries.sort()
  return entries.map((name) => {
    const isDir = statSync(`${dir}/${name}`).isDirectory()
    return isDir ? `${name}/` : name
  })
}
