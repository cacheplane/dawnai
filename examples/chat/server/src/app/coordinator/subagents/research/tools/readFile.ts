import { readFileSync, statSync } from "node:fs"
import { resolveWorkspacePath, workspaceRoot } from "../workspace-path.js"

const MAX_BYTES = 256 * 1024

/**
 * Read a UTF-8 text file from the workspace. Rejects files larger than 256 KiB.
 */
export default async (input: { readonly path: string }): Promise<string> => {
  const file = resolveWorkspacePath(workspaceRoot(), input.path)
  const size = statSync(file).size
  if (size > MAX_BYTES) {
    throw new Error(`File too large: ${size} bytes (limit ${MAX_BYTES})`)
  }
  return readFileSync(file, "utf8")
}
