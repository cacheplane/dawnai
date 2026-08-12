import { pathToFileURL } from "node:url"
import { tsImport } from "tsx/esm/api"

export interface DocFrontmatter {
  title?: string
  description?: string
}

export interface DocTopic {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly file: string
}

/** Split a leading `---` YAML frontmatter block off an MDX document. */
export function parseFrontmatter(raw: string): { data: DocFrontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!match) {
    return { data: {}, body: raw }
  }
  const data: DocFrontmatter = {}
  for (const line of (match[1] ?? "").split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line)
    if (!m) {
      continue
    }
    let value = (m[2] ?? "").trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (m[1] === "title") {
      data.title = value
    } else if (m[1] === "description") {
      data.description = value
    }
  }
  return { data, body: raw.slice(match[0].length) }
}

/**
 * Convert an MDX doc page to plain markdown suitable for the bundled tree.
 * Minimal transform: strip frontmatter (promoting `title` to an H1 when the
 * body has none), drop module `import`/`export` lines and API behavior authority
 * metadata OUTSIDE fenced code, and remove `<RelatedCards … />` navigation
 * components. Code fences are untouched.
 */
export function mdxToMarkdown(raw: string): string {
  const { data, body } = parseFrontmatter(raw)
  const out: string[] = []
  let fence: { readonly character: "`" | "~"; readonly length: number } | undefined
  for (const line of body.split("\n")) {
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    if (!fence && fenceMatch?.[2] && (fenceMatch[2][0] === "~" || !fenceMatch[3]?.includes("`"))) {
      fence = { character: fenceMatch[2][0] as "`" | "~", length: fenceMatch[2].length }
      out.push(line)
      continue
    }
    if (fence) {
      out.push(line)
      if (
        fenceMatch?.[2]?.[0] === fence.character &&
        fenceMatch[2].length >= fence.length &&
        fenceMatch[3]?.trim() === ""
      ) {
        fence = undefined
      }
      continue
    }
    if (/^(import|export)\s/.test(line)) {
      continue
    }
    if (/^\{\/\* api-behavior-authorities: \[[\s\S]*\] \*\/\}$/.test(line.trim())) {
      continue
    }
    out.push(line)
  }
  let result = out
    .join("\n")
    .replace(/<RelatedCards[\s\S]*?<\/RelatedCards>/g, "")
    .replace(/<RelatedCards[^>]*\/>/g, "")
  result = result.replace(/\n{3,}/g, "\n\n").trim()
  if (data.title && !/^#\s/.test(result)) {
    result = `# ${data.title}\n\n${result}`
  }
  return `${result}\n`
}

export interface DocsPageEntry {
  readonly slug: string
  readonly label: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
}

/** Validate an evaluated `ALL_DOCS_PAGES` export without changing its order or membership. */
export function parseDocsPages(pagesValue: unknown): DocsPageEntry[] {
  if (!Array.isArray(pagesValue)) {
    throw new TypeError("ALL_DOCS_PAGES must be an array")
  }

  const entries: DocsPageEntry[] = []
  const seen = new Set<string>()
  for (const [index, item] of pagesValue.entries()) {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.href !== "string") {
      throw new TypeError(`ALL_DOCS_PAGES[${index}] must contain string label and href fields`)
    }
    if (item.label.length === 0 || item.label.trim() !== item.label || /[\r\n]/.test(item.label)) {
      throw new TypeError(`ALL_DOCS_PAGES[${index}].label must be a non-empty single-line label`)
    }
    const hrefMatch = /^\/docs\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)$/.exec(item.href)
    if (!hrefMatch?.[1]) {
      throw new TypeError(`ALL_DOCS_PAGES[${index}].href must be an unfragmented /docs/<slug> path`)
    }
    const slug = hrefMatch[1]
    if (seen.has(slug)) throw new TypeError(`ALL_DOCS_PAGES contains duplicate slug: ${slug}`)
    seen.add(slug)
    entries.push({ slug, label: item.label })
  }
  return entries
}

/** Runtime-import the exact exhaustive registry and ignore every other binding. */
export async function loadDocsPages(navFile: string): Promise<DocsPageEntry[]> {
  const loaded = (await tsImport(pathToFileURL(navFile).href, import.meta.url)) as Record<
    string,
    unknown
  >
  if (!("ALL_DOCS_PAGES" in loaded)) {
    throw new TypeError(`${navFile} does not export ALL_DOCS_PAGES`)
  }
  return parseDocsPages(loaded.ALL_DOCS_PAGES)
}

/** The text of the first `# ` heading in a markdown document, if any. */
export function extractTitle(markdown: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown)
  return m ? m[1] : undefined
}

/** A one-line summary built from the first paragraph after the leading heading. */
export function extractSummary(markdown: string): string {
  const lines = markdown.split("\n")
  let i = 0
  while (i < lines.length && ((lines[i] ?? "").trim() === "" || (lines[i] ?? "").startsWith("#"))) {
    i++
  }
  const para: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.trim() === "") {
      if (para.length > 0) {
        break
      }
      continue
    }
    if (
      line.startsWith("#") ||
      /^\s*```/.test(line) ||
      /^\s*[-*|]/.test(line) ||
      line.startsWith("<")
    ) {
      if (para.length > 0) {
        break
      }
      continue
    }
    para.push(line.trim())
  }
  let text = para
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  const sentenceEnd = text.indexOf(". ")
  if (sentenceEnd !== -1 && sentenceEnd <= 160) {
    text = text.slice(0, sentenceEnd + 1)
  } else if (text.length > 160) {
    text = `${text.slice(0, 157).trimEnd()}…`
  }
  return text
}

/** Render the bundled docs `README.md` index. */
export function buildReadme(topics: readonly DocTopic[]): string {
  const lines = [
    "# Dawn — Documentation",
    "",
    "Version-matched Dawn reference for coding agents. These files match the installed `@dawn-ai/cli` version.",
    "Run `dawn docs <topic>` to read one (e.g. `dawn docs tools`), or open the files in this directory.",
    "",
    "## Topics",
    "",
  ]
  for (const t of topics) {
    lines.push(`- [${t.title}](./${t.file})${t.description ? ` — ${t.description}` : ""}`)
  }
  return `${lines.join("\n")}\n`
}
