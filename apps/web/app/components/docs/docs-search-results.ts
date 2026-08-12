import type { DocsSearchEntry, DocsSearchHeading } from "./search-index"

export interface DocsSearchResult {
  readonly href: string
  readonly title: string
  readonly section: string
  readonly heading?: DocsSearchHeading
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
  readonly key: string
}

export function flattenDocsSearchIndex(
  index: readonly DocsSearchEntry[],
): readonly DocsSearchResult[] {
  const results: DocsSearchResult[] = []
  for (const entry of index) {
    results.push({
      href: entry.href,
      title: entry.title,
      section: entry.section,
      aliases: entry.aliases,
      canonicalAliases: entry.canonicalAliases,
      key: entry.href,
    })
    for (const heading of entry.headings) {
      if (heading.level === 1) continue
      results.push({
        href: `${entry.href}#${heading.anchor}`,
        title: entry.title,
        section: entry.section,
        heading,
        aliases: [],
        canonicalAliases: [],
        key: `${entry.href}#${heading.anchor}`,
      })
    }
  }
  return results
}

function scoreMatch(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (t.includes(` ${q}`)) return 60
  if (t.includes(q)) return 40
  return 0
}

export function filterDocsSearchResults(
  query: string,
  all: readonly DocsSearchResult[],
): readonly DocsSearchResult[] {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return all.slice(0, 20)
  return all
    .map((result, index) => {
      const titleScore = scoreMatch(normalizedQuery, result.title)
      const headingScore = result.heading ? scoreMatch(normalizedQuery, result.heading.text) : 0
      const sectionScore = scoreMatch(normalizedQuery, result.section) * 0.3
      const aliasScore = result.aliases.reduce((best, alias) => {
        const match = scoreMatch(normalizedQuery, alias)
        return Math.max(best, match > 0 ? match + 30 : 0)
      }, 0)
      const canonicalAliasScore = result.canonicalAliases.reduce((best, alias) => {
        const match = scoreMatch(normalizedQuery, alias)
        return Math.max(best, match > 0 ? match + 60 : 0)
      }, 0)
      return {
        result,
        index,
        score: Math.max(titleScore, headingScore, aliasScore, canonicalAliasScore) + sectionScore,
      }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 20)
    .map(({ result }) => result)
}
