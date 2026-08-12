// Server-side index builder. Reads every MDX doc page at module init, extracts
// H1/H2/H3 headings via regex, and exports a flat searchable index.
//
// This module is intentionally server-only (uses node:fs). The resulting
// `DOCS_INDEX` value is serializable and can be passed to client components
// via props.

import { readFileSync } from "node:fs"
import path from "node:path"
import { createProcessor } from "@mdx-js/mdx"
import GithubSlugger from "github-slugger"
import remarkGfm from "remark-gfm"
import { webContentRoot } from "../../../lib/content-root"
import { ARTIFACT_REGISTRY, PACKAGE_CATALOG } from "./api-reference"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import { ALL_DOCS_PAGES, DOCS_NAV, type DocsNavItem } from "./nav"

export interface DocsSearchHeading {
  readonly text: string
  readonly level: 1 | 2 | 3
  readonly anchor: string
}

export interface DocsSearchEntry {
  readonly href: string
  readonly title: string
  readonly section: string
  readonly headings: readonly DocsSearchHeading[]
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
}

function packageSurface(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`
}

interface PublicExportAliases {
  readonly aliases: readonly string[]
  readonly canonicalAliases: readonly string[]
}

function maskSearchMdx(source: string): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, " ")
  const lines = source.split(/(?<=\n)/)
  let fence: { readonly character: string; readonly length: number } | null = null
  const fencesMasked = lines
    .map((line) => {
      const content = line.replace(/\r?\n$/, "")
      if (fence) {
        const close = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(content)?.[1]
        if (close?.[0] === fence.character && close.length >= fence.length) fence = null
        return mask(line)
      }
      const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      if (!opening || (opening[1]?.[0] === "`" && opening[2]?.includes("`"))) return line
      fence = { character: opening[1]?.[0] ?? "", length: opening[1]?.length ?? 0 }
      return mask(line)
    })
    .join("")
  const maskedLines = fencesMasked.split(/(?<=\n)/)
  let inHtmlComment = false
  return maskedLines
    .map((line) => {
      if (inHtmlComment) {
        if (line.includes("-->")) inHtmlComment = false
        return mask(line)
      }
      if (/^[ \t]*<!--/.test(line)) {
        if (!line.includes("-->")) inHtmlComment = true
        return mask(line)
      }
      return line.replace(/<!--[\s\S]*?-->/g, mask)
    })
    .join("")
}

interface SearchMdxNode {
  readonly type: string
  readonly depth?: number
  readonly value?: string
  readonly url?: string
  readonly children?: readonly SearchMdxNode[]
  readonly position?: {
    readonly start: { readonly line: number }
    readonly end: { readonly line: number }
  }
}

interface OwnershipTableSpec {
  readonly heading: string
  readonly firstHeader: "Export" | "Generated export"
}

const searchMdxProcessor = createProcessor({ remarkPlugins: [remarkGfm] })

function exactTextHeading(node: SearchMdxNode, depth: number, text: string): boolean {
  return (
    node.type === "heading" &&
    node.depth === depth &&
    node.children?.length === 1 &&
    node.children[0]?.type === "text" &&
    node.children[0]?.value === text
  )
}

function exactCodeHeading(node: SearchMdxNode): string | undefined {
  if (
    node.type !== "heading" ||
    node.depth !== 3 ||
    node.children?.length !== 1 ||
    node.children[0]?.type !== "inlineCode"
  ) {
    return undefined
  }
  return node.children[0].value
}

function tableHeader(node: SearchMdxNode): readonly string[] | undefined {
  if (node.type !== "table") return undefined
  const header = node.children?.[0]
  if (header?.type !== "tableRow") return undefined
  return header.children?.map((cell) => cell.children?.[0]?.value ?? "")
}

function urlsIn(node: SearchMdxNode): readonly string[] {
  return [
    ...(node.type === "link" && node.url ? [node.url] : []),
    ...(node.children?.flatMap(urlsIn) ?? []),
  ]
}

export function parsePublicExportAliases(
  mdx: string,
  href: string,
  expectedTables: readonly OwnershipTableSpec[],
): PublicExportAliases {
  const maskedMdx = maskSearchMdx(mdx)
  const lines = maskedMdx.split(/\r?\n/)
  const root = searchMdxProcessor.parse(maskedMdx) as SearchMdxNode
  const children = root.children ?? []
  const sectionStarts = children.flatMap((node, index) =>
    exactTextHeading(node, 2, "Public exports") ? [index] : [],
  )
  if (sectionStarts.length !== 1) {
    throw new Error(`${href} must contain exactly one visible Public exports section`)
  }
  const start = sectionStarts[0] as number
  const end = children.findIndex(
    (node, index) => index > start && node.type === "heading" && node.depth === 2,
  )
  const sectionEnd = end === -1 ? children.length : end
  const sectionChildren = children.slice(start + 1, sectionEnd)
  const aliases: string[] = []
  const canonicalAliases: string[] = []
  const surfaceHeadingIndexes = new Map<string, number[]>()
  for (const [index, node] of sectionChildren.entries()) {
    const surface = exactCodeHeading(node)
    if (!surface) continue
    const indexes = surfaceHeadingIndexes.get(surface) ?? []
    indexes.push(index)
    surfaceHeadingIndexes.set(surface, indexes)
  }
  const expectedIndexes = expectedTables.map(({ heading }) => {
    const indexes = surfaceHeadingIndexes.get(heading) ?? []
    if (indexes.length !== 1) {
      throw new Error(`${href} must contain exactly one Public exports heading for ${heading}`)
    }
    return indexes[0] as number
  })
  if (
    expectedIndexes.some((index, position) => {
      const previous = expectedIndexes[position - 1]
      return previous !== undefined && index <= previous
    })
  ) {
    throw new Error(`${href} Public exports headings must follow artifact registry order`)
  }

  const expectedHeadings = new Set(expectedTables.map(({ heading }) => heading))
  for (const [position, headingIndex] of expectedIndexes.entries()) {
    const spec = expectedTables[position] as OwnershipTableSpec
    const nextHeadingOffset = sectionChildren
      .slice(headingIndex + 1)
      .findIndex((node) => node.type === "heading")
    const headingEnd =
      nextHeadingOffset === -1 ? sectionChildren.length : headingIndex + 1 + nextHeadingOffset
    const tables = sectionChildren
      .slice(headingIndex + 1, headingEnd)
      .filter((node) => node.type === "table")
    if (tables.length !== 1) {
      throw new Error(`${href} has a malformed Public exports ownership table`)
    }
    const table = tables[0] as SearchMdxNode
    if (tableHeader(table)?.join("\0") !== `${spec.firstHeader}\0Responsibility`) {
      throw new Error(`${href} has a malformed Public exports ownership table header`)
    }
    const tableStart = table.position?.start.line
    const tableEnd = table.position?.end.line
    if (!tableStart || !tableEnd) throw new Error(`${href} ownership table lacks source positions`)
    const tableLines = lines.slice(tableStart - 1, tableEnd)
    if (
      tableLines[0] !== `| ${spec.firstHeader} | Responsibility |` ||
      tableLines[1] !== "|---|---|"
    ) {
      throw new Error(`${href} has a malformed Public exports ownership table grammar`)
    }
    const rows = table.children?.slice(1) ?? []
    if (rows.length === 0) throw new Error(`${href} Public exports ownership table is empty`)
    for (const [rowIndex, rowNode] of rows.entries()) {
      const row = /^\| `([^`]+)` \| (.+) \|$/.exec(tableLines[rowIndex + 2] ?? "")
      if (!row?.[1] || !row[2]) {
        throw new Error(`${href} Public exports rows require an exact code-formatted Export cell`)
      }
      if (!aliases.includes(row[1])) aliases.push(row[1])
      const linkedOwners = urlsIn(rowNode).flatMap((url) => {
        const owner = /^(\/docs\/api\/[^#?]+)(?:[#?].*)?$/.exec(url)?.[1]
        return owner ? [owner] : []
      })
      if (linkedOwners.every((owner) => owner === href) && !canonicalAliases.includes(row[1])) {
        canonicalAliases.push(row[1])
      }
    }
  }
  for (const [index, node] of sectionChildren.entries()) {
    const heading = exactCodeHeading(node)
    if (!heading || expectedHeadings.has(heading)) continue
    const nextHeadingOffset = sectionChildren
      .slice(index + 1)
      .findIndex((candidate) => candidate.type === "heading")
    const headingEnd =
      nextHeadingOffset === -1 ? sectionChildren.length : index + 1 + nextHeadingOffset
    const hasUnexpectedOwnershipTable = sectionChildren
      .slice(index + 1, headingEnd)
      .some((candidate) => {
        const header = tableHeader(candidate)
        return (
          header?.[1] === "Responsibility" &&
          (header[0] === "Export" || header[0] === "Generated export")
        )
      })
    if (hasUnexpectedOwnershipTable) {
      throw new Error(`${href} has an ownership table for unregistered surface ${heading}`)
    }
  }
  return { aliases, canonicalAliases }
}

function ownershipTablesByHref(): ReadonlyMap<string, readonly OwnershipTableSpec[]> {
  const tables = new Map<string, OwnershipTableSpec[]>()
  const destinationByPackage = new Map(
    PACKAGE_CATALOG.map(({ packageName, canonicalReferenceDestination }) => [
      packageName,
      canonicalReferenceDestination.split("#", 1)[0] ?? canonicalReferenceDestination,
    ]),
  )
  const add = (href: string, spec: OwnershipTableSpec) => {
    const values = tables.get(href) ?? []
    values.push(spec)
    tables.set(href, values)
  }
  for (const artifact of ARTIFACT_REGISTRY) {
    if (artifact.kind === "generated") {
      add(artifact.ownerHref, { heading: artifact.moduleName, firstHeader: "Generated export" })
      continue
    }
    if (
      artifact.kind !== "import" ||
      artifact.coverage !== "detailed" ||
      artifact.surfaceKind !== "typescript-runtime"
    ) {
      continue
    }
    const destination = destinationByPackage.get(artifact.packageName)
    if (destination) {
      add(destination, {
        heading: packageSurface(artifact.packageName, artifact.subpath),
        firstHeader: "Export",
      })
    }
  }
  return tables
}

function registryAliasesByHref(): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, Set<string>>()
  const add = (href: string, alias: string) => {
    const canonicalHref = href.split("#", 1)[0] ?? href
    const values = aliases.get(canonicalHref) ?? new Set<string>()
    values.add(alias)
    aliases.set(canonicalHref, values)
  }
  const destinationByPackage = new Map(
    PACKAGE_CATALOG.map(({ packageName, canonicalReferenceDestination }) => [
      packageName,
      canonicalReferenceDestination,
    ]),
  )
  for (const entry of PACKAGE_CATALOG) add(entry.canonicalReferenceDestination, entry.packageName)
  for (const artifact of ARTIFACT_REGISTRY) {
    if (artifact.kind === "generated") {
      add(artifact.ownerHref, artifact.moduleName)
      continue
    }
    const destination = destinationByPackage.get(artifact.packageName)
    if (!destination) continue
    if (artifact.kind === "import") {
      add(destination, packageSurface(artifact.packageName, artifact.subpath))
    } else {
      add(destination, artifact.selector)
      if (artifact.selector.startsWith("bin.")) add(destination, artifact.selector.slice(4))
    }
  }
  return new Map([...aliases].map(([href, values]) => [href, [...values]]))
}

function extractHeadings(mdx: string): readonly DocsSearchHeading[] {
  const out: DocsSearchHeading[] = []
  // The same slugger `rehype-slug` runs, one instance per document, fed every
  // heading level in document order — that shared state (its duplicate-suffix
  // counter) is what keeps these anchors identical to the ids in the built page.
  const slugger = new GithubSlugger()
  let inFence = false
  for (const line of mdx.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (!match?.[1] || !match[2]) continue
    const level = match[1].length
    const text = match[2].trim().replace(/`([^`]+)`/g, "$1")
    const anchor = slugger.slug(text)
    if (level <= 3) out.push({ text, level: level as 1 | 2 | 3, anchor })
  }
  return out
}

function slugFromHref(href: string): string {
  return href.replace(/^\/docs\//, "")
}

function readMdx(slug: string): string {
  const base = path.join(webContentRoot(), "docs")
  // Try `<slug>.mdx` first; fall back to `<slug>/index.mdx` for nested
  // section landing pages (e.g. `/docs/recipes` → `recipes/index.mdx`).
  try {
    return readFileSync(path.join(base, `${slug}.mdx`), "utf8")
  } catch {
    return readFileSync(path.join(base, slug, "index.mdx"), "utf8")
  }
}

function buildEntry(
  item: DocsNavItem,
  section: string,
  registryAliases: readonly string[],
  expectedOwnershipTables: readonly OwnershipTableSpec[],
): DocsSearchEntry {
  const slug = slugFromHref(item.href)
  const mdx = readMdx(slug)
  const headings = extractHeadings(mdx)
  const h1 = headings.find((h) => h.level === 1)
  const exportAliases = item.href.startsWith("/docs/api/")
    ? parsePublicExportAliases(mdx, item.href, expectedOwnershipTables)
    : { aliases: [], canonicalAliases: [] }
  return {
    href: item.href,
    title: h1?.text ?? item.label,
    section,
    headings,
    aliases: [...new Set([...registryAliases, ...exportAliases.aliases])],
    canonicalAliases: exportAliases.canonicalAliases,
  }
}

function buildIndex(): readonly DocsSearchEntry[] {
  const aliasesByHref = registryAliasesByHref()
  const ownershipTables = ownershipTablesByHref()
  const sectionByHref = new Map<string, string>(
    DOCS_NAV.flatMap((section) => section.items.map((item) => [item.href, section.label])),
  )
  const apiReferenceSectionByHref = new Map<string, string>(
    API_REFERENCE_PAGES.map(({ href, parent }) => [href, parent.label]),
  )
  return ALL_DOCS_PAGES.map((item) => {
    const section = apiReferenceSectionByHref.get(item.href) ?? sectionByHref.get(item.href)
    if (!section) throw new Error(`Documentation page ${item.href} has no search section`)
    return buildEntry(
      item,
      section,
      aliasesByHref.get(item.href) ?? [],
      ownershipTables.get(item.href) ?? [],
    )
  })
}

export const DOCS_INDEX: readonly DocsSearchEntry[] = buildIndex()
