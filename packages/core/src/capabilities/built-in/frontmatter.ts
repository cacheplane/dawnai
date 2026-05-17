/**
 * Minimal YAML-frontmatter parser. Sufficient for Dawn's skill files,
 * which use a flat `key: value` block at the top delimited by `---` lines.
 *
 * Supports: keys, double-quoted values, single-quoted values, `#` comments,
 * blank lines, CRLF endings, leading/trailing whitespace.
 *
 * Does NOT support: nested objects, arrays, multi-line strings, anchors,
 * any other real YAML feature. If a skill needs full YAML, swap to the
 * `yaml` npm package without changing this module's contract.
 */
export interface ParsedFrontmatter {
  readonly frontmatter: Readonly<Record<string, string>>
  readonly body: string
}

const OPEN_MARKER = /^---\r?\n/
const CLOSE_MARKER = /\r?\n---\r?\n?/

export function parseFrontmatter(input: string): ParsedFrontmatter {
  if (!OPEN_MARKER.test(input)) {
    return { frontmatter: {}, body: input }
  }
  const openLen = OPEN_MARKER.exec(input)?.[0].length ?? 0
  const afterOpen = input.slice(openLen)
  const closeMatch = CLOSE_MARKER.exec(afterOpen)
  if (!closeMatch) {
    return { frontmatter: {}, body: input }
  }
  const block = afterOpen.slice(0, closeMatch.index)
  const bodyStart = closeMatch.index + closeMatch[0].length
  const body = afterOpen.slice(bodyStart).replace(/^\r?\n/, "")
  const frontmatter = parseFrontmatterBlock(block)
  return { frontmatter, body }
}

function parseFrontmatterBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith("#")) continue
    const colonIdx = line.indexOf(":")
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    if (key.length === 0) continue
    const rawValue = line.slice(colonIdx + 1).trim()
    out[key] = stripQuotes(rawValue)
  }
  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}
