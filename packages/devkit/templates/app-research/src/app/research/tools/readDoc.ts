import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const workspaceDir = fileURLToPath(new URL("../../../../workspace/", import.meta.url))

/**
 * Read the full text of a corpus document by its workspace-relative path
 * (e.g. "corpus/agent-architectures.md"). Large documents are offloaded by
 * Dawn and retrieved on demand, so reading one does not flood the context.
 */
export default async (input: { readonly path: string }) => {
  const content = await readFile(join(workspaceDir, input.path), "utf8")
  return { content }
}
