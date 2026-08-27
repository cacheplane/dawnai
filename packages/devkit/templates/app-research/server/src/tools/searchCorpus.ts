import type { DawnToolContext } from "@dawn-ai/sdk"

/**
 * Search the bundled research corpus for documents matching a query.
 * Returns up to five matches ranked by how many query terms each document
 * contains, with a short snippet around the first matched term.
 */
export default async (input: { readonly query: string }, ctx: DawnToolContext) => {
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean)
  const files = (await ctx.fs.listDir("corpus")).filter((file) => file.endsWith(".md"))

  const results: { readonly path: string; readonly score: number; readonly snippet: string }[] = []
  for (const file of files) {
    const path = `corpus/${file}`
    const text = await ctx.fs.readFile(path)
    const haystack = text.toLowerCase()
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
    if (score === 0) continue
    const firstTerm = terms.find((term) => haystack.includes(term))
    const at = firstTerm ? haystack.indexOf(firstTerm) : 0
    const snippet = text
      .slice(Math.max(0, at - 40), at + 120)
      .replace(/\s+/g, " ")
      .trim()
    results.push({ path, score, snippet })
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 5)
}
