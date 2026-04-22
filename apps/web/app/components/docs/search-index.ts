// Server-side index builder. Reads every MDX doc page at module init, extracts
// H1/H2/H3 headings via regex, and exports a flat searchable index.
//
// This module is intentionally server-only (uses node:fs). The resulting
// `DOCS_INDEX` value is serializable and can be passed to client components
// via props.

import { readFileSync } from "node:fs"
import path from "node:path"
import { DOCS_NAV, type DocsNavItem } from "./nav"

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
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}

function extractHeadings(mdx: string): readonly DocsSearchHeading[] {
  const out: DocsSearchHeading[] = []
  let inFence = false
  for (const line of mdx.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (!match || !match[1] || !match[2]) continue
    const level = match[1].length as 1 | 2 | 3
    const text = match[2].trim().replace(/`([^`]+)`/g, "$1")
    out.push({ text, level, anchor: slugify(text) })
  }
  return out
}

function slugFromHref(href: string): string {
  return href.replace(/^\/docs\//, "")
}

function buildEntry(item: DocsNavItem, section: string): DocsSearchEntry {
  const slug = slugFromHref(item.href)
  const mdxPath = path.join(process.cwd(), "content/docs", `${slug}.mdx`)
  const mdx = readFileSync(mdxPath, "utf8")
  const headings = extractHeadings(mdx)
  const h1 = headings.find((h) => h.level === 1)
  return {
    href: item.href,
    title: h1?.text ?? item.label,
    section,
    headings,
  }
}

function buildIndex(): readonly DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = []
  for (const section of DOCS_NAV) {
    for (const item of section.items) {
      try {
        entries.push(buildEntry(item, section.label))
      } catch {
        // MDX file not present — skip silently rather than crashing the build
      }
    }
  }
  return entries
}

export const DOCS_INDEX: readonly DocsSearchEntry[] = buildIndex()
