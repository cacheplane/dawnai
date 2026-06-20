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
  for (const line of match[1].split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line)
    if (!m) {
      continue
    }
    let value = m[2].trim()
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
 * body has none), drop module `import`/`export` lines OUTSIDE fenced code, and
 * remove `<RelatedCards … />` navigation components. Code fences are untouched.
 */
export function mdxToMarkdown(raw: string): string {
  const { data, body } = parseFrontmatter(raw)
  const out: string[] = []
  let inFence = false
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (/^(import|export)\s/.test(line)) {
      continue
    }
    out.push(line)
  }
  let result = out.join("\n").replace(/<RelatedCards[\s\S]*?\/>/g, "")
  result = result.replace(/\n{3,}/g, "\n\n").trim()
  if (data.title && !/^#\s/.test(result)) {
    result = `# ${data.title}\n\n${result}`
  }
  return `${result}\n`
}

/** Extract `/docs/<slug>` hrefs from the website nav source, in order, deduped. */
export function parseNavOrder(navSource: string): string[] {
  const slugs: string[] = []
  const re = /href:\s*["']\/docs\/([^"']+)["']/g
  let m: RegExpExecArray | null = re.exec(navSource)
  while (m !== null) {
    if (!slugs.includes(m[1])) {
      slugs.push(m[1])
    }
    m = re.exec(navSource)
  }
  return slugs
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
