import type { DawnToolContext } from "@dawn-ai/sdk"

function assertCorpusPath(path: string): void {
  if (!path.startsWith("corpus/") || path.includes("..") || path.startsWith("/")) {
    throw new Error(`readDoc only accepts workspace corpus paths, got "${path}"`)
  }
}

/**
 * Read the full text of a corpus document by its workspace-relative path
 * (e.g. "corpus/agent-architectures.md"). Large documents are offloaded by
 * Dawn and retrieved on demand, so reading one does not flood the context.
 */
export default async (input: { readonly path: string }, ctx: DawnToolContext) => {
  assertCorpusPath(input.path)
  const content = await ctx.fs.readFile(input.path)
  return { content }
}
