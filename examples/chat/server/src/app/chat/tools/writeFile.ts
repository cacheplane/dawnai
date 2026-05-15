import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { resolveWorkspacePath, workspaceRoot } from "../workspace-path.js"

/**
 * Write a UTF-8 text file to the workspace. Overwrites existing files.
 * Creates parent directories as needed. Returns a one-line summary.
 */
export default async (
  input: { readonly path: string; readonly content: string },
): Promise<string> => {
  const file = resolveWorkspacePath(workspaceRoot(), input.path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, input.content, "utf8")
  const bytes = Buffer.byteLength(input.content, "utf8")
  return `wrote ${bytes} bytes to ${input.path}`
}
