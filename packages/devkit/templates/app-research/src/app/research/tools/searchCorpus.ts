import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const corpusDir = fileURLToPath(new URL("../../../../workspace/corpus/", import.meta.url))

/**
 * Search the bundled research corpus for documents matching a query.
 * Returns up to five matches ranked by how many query terms each document
 * contains, with a short snippet around the first matched term.
 */
export default async (input: { readonly query: string }) => {
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean)
  const files = (await readdir(corpusDir)).filter((file) => file.endsWith(".md"))

  const results: { readonly path: string; readonly score: number; readonly snippet: string }[] = []
  for (const file of files) {
    const text = await readFile(join(corpusDir, file), "utf8")
    const haystack = text.toLowerCase()
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
    if (score === 0) continue
    const firstTerm = terms.find((term) => haystack.includes(term))
    const at = firstTerm ? haystack.indexOf(firstTerm) : 0
    const snippet = text
      .slice(Math.max(0, at - 40), at + 120)
      .replace(/\s+/g, " ")
      .trim()
    results.push({ path: `corpus/${file}`, score, snippet })
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 5)
}
