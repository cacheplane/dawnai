import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { breadcrumbsFor, DOCS_NAV, DOCS_PAGES, siblingsFor } from "./nav"

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const CONTENT_ROOT = join(WEB_ROOT, "content/docs")
const WRAPPERS_ROOT = join(WEB_ROOT, "app/docs")
const NAV_PATH = join(dirname(fileURLToPath(import.meta.url)), "nav.ts")
const CHECK_DOCS_PATH = join(WEB_ROOT, "../../scripts/check-docs.mjs")

interface CompatibilityStubAnalysis {
  readonly found: boolean
  readonly stub: string
  readonly destinations: readonly string[]
  readonly charCount: number
  readonly maxChars: number
  readonly hasCanonicalLink: boolean
  readonly exceedsMaxChars: boolean
}

function analyzeCompatibilityStub(
  source: string,
  retainedHeading: string,
  canonicalHref: string,
  maxChars?: number,
): CompatibilityStubAnalysis {
  const fixture = {
    source,
    retainedHeading,
    canonicalHref,
    ...(maxChars !== undefined ? { maxChars } : {}),
  }
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-compatibility-stub", JSON.stringify(fixture)],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\{/)
  return JSON.parse(result.stdout) as CompatibilityStubAnalysis
}

function filesUnder(
  root: string,
  matches: (fileName: string) => boolean,
  base: string = root,
): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = join(root, entry.name)
    if (entry.isDirectory()) return filesUnder(full, matches, base)
    return matches(entry.name) ? [relative(base, full)] : []
  })
}

function contentHref(file: string): string {
  const normalized = file.replaceAll("\\", "/")
  const slug = normalized.endsWith("/index.mdx")
    ? normalized.slice(0, -"/index.mdx".length)
    : normalized.slice(0, -".mdx".length)
  return `/docs/${slug}`
}

function wrapperHref(file: string): string {
  const normalized = file.replaceAll("\\", "/")
  if (normalized === "page.tsx") return "/docs"
  const slug = normalized.slice(0, -"/page.tsx".length)
  return `/docs/${slug}`
}

describe("documentation registry invariants", () => {
  it("uses unique section labels, page labels, and hrefs", () => {
    const sectionLabels = DOCS_NAV.map((section) => section.label)
    const pageLabels = DOCS_PAGES.map((page) => page.label)
    const hrefs = DOCS_PAGES.map((page) => page.href)
    expect(new Set(sectionLabels).size).toBe(sectionLabels.length)
    expect(new Set(pageLabels).size).toBe(pageLabels.length)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("derives breadcrumbs and siblings from the registered order", () => {
    expect(breadcrumbsFor("/docs/ag-ui")).toEqual([
      { label: "Docs", href: "/docs/getting-started" },
      { label: "Tooling" },
      { label: "AG-UI & Web Clients" },
    ])
    expect(siblingsFor("/docs/ag-ui").prev?.href).toBe("/docs/dev-server")
    expect(siblingsFor("/docs/ag-ui").next?.href).toBe("/docs/blueprints")
    expect(siblingsFor("/docs/faq").next).toBeNull()
  })

  it("keeps every nav item on one line with label before href", () => {
    const itemLines = readFileSync(NAV_PATH, "utf8")
      .split("\n")
      .filter((line) => /^\s*\{ label: .*href: "\/docs\//.test(line))

    expect(itemLines).toHaveLength(DOCS_PAGES.length)
    for (const line of itemLines) {
      expect(line).toMatch(/^\s*\{ label: "[^"]+", href: "\/docs\/[^"]+" \},\s*$/)
    }
  })

  it("registers exactly the authored content and route wrappers", () => {
    const navHrefs = DOCS_PAGES.map((page) => page.href)
    const contentHrefs = filesUnder(CONTENT_ROOT, (file) => file.endsWith(".mdx"))
      .map(contentHref)
      .sort()
    const wrapperHrefs = filesUnder(WRAPPERS_ROOT, (file) => file === "page.tsx")
      .map(wrapperHref)
      .filter((href) => href !== "/docs")
      .sort()

    expect([...navHrefs].sort()).toEqual(contentHrefs)
    expect([...navHrefs].sort()).toEqual(wrapperHrefs)
  })
})

describe("compatibility stub analysis", () => {
  const canonicalHref = "/docs/canonical"

  it("keeps nested headings and fenced pseudo-headings inside the stub", () => {
    const analysis = analyzeCompatibilityStub(
      `# Overview

## Retained topic

See [the canonical guide](${canonicalHref}).

### Nested detail

Nested prose.

\`\`\`md
## Fenced pseudo-boundary
[fenced link](${canonicalHref}/fenced)
\`\`\`

Still part of the retained stub.

## Next topic

Must not be part of the stub.
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.found).toBe(true)
    expect(analysis.stub).toContain("### Nested detail")
    expect(analysis.stub).toContain("## Fenced pseudo-boundary")
    expect(analysis.stub).toContain("Still part of the retained stub.")
    expect(analysis.stub).not.toContain("## Next topic")
    expect(analysis.destinations).toEqual(["/docs/canonical"])
    expect(analysis.hasCanonicalLink).toBe(true)
  })

  it.each([
    ["same-level", "## Boundary"],
    ["higher-level", "# Boundary"],
  ])("stops at the next %s heading", (_label, boundary) => {
    const analysis = analyzeCompatibilityStub(
      `# Overview
## Retained topic
[Canonical](${canonicalHref})
### Nested
Nested prose.
${boundary}
Outside prose.
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.stub).toContain("Nested prose.")
    expect(analysis.stub).not.toContain("Outside prose.")
  })

  it("requires an exact link destination rather than text or prefix collisions", () => {
    const analysis = analyzeCompatibilityStub(
      `## Retained topic
[Prefix](${canonicalHref}/extra)
[Suffix](/prefix${canonicalHref})
Plain text: ${canonicalHref}
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.destinations).toEqual(["/docs/canonical/extra", "/prefix/docs/canonical"])
    expect(analysis.hasCanonicalLink).toBe(false)
  })

  it("recognizes an exact literal MDX href destination", () => {
    const analysis = analyzeCompatibilityStub(
      `## Retained topic
<RelatedCards items={[{ href: "${canonicalHref}" }]} />
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.destinations).toEqual([canonicalHref])
    expect(analysis.hasCanonicalLink).toBe(true)
  })

  it("does not treat a Markdown image destination as a canonical link", () => {
    const analysis = analyzeCompatibilityStub(
      `## Retained topic
![Architecture diagram](${canonicalHref})
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.destinations).toEqual([])
    expect(analysis.hasCanonicalLink).toBe(false)
  })

  it("keeps links after an inline-code HTML comment marker visible", () => {
    const mdxHref = "/docs/mdx-visible"
    const analysis = analyzeCompatibilityStub(
      `## Retained topic
\`<!--\`
[Canonical](${canonicalHref})
<RelatedCards items={[{ href: "${mdxHref}" }]} />
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.destinations).toEqual([canonicalHref, mdxHref])
    expect(analysis.hasCanonicalLink).toBe(true)
  })

  it("ignores link-like text in fences, inline code, and comments", () => {
    const analysis = analyzeCompatibilityStub(
      `## Retained topic
\`[inline](${canonicalHref})\`
<!-- [HTML comment](${canonicalHref}) -->
{/* [MDX comment](${canonicalHref}) */}
\`\`\`md
[fenced](${canonicalHref})
\`\`\`
`,
      "Retained topic",
      canonicalHref,
    )

    expect(analysis.destinations).toEqual([])
    expect(analysis.hasCanonicalLink).toBe(false)
  })

  it("uses a 600-character default cap and accepts an explicit override", () => {
    const source = `## Retained topic
[Canonical](${canonicalHref})
${"x".repeat(650)}
## Boundary
`
    const defaultCap = analyzeCompatibilityStub(source, "Retained topic", canonicalHref)
    const overrideCap = analyzeCompatibilityStub(source, "Retained topic", canonicalHref, 800)

    expect(defaultCap.maxChars).toBe(600)
    expect(defaultCap.charCount).toBe(defaultCap.stub.length)
    expect(defaultCap.exceedsMaxChars).toBe(true)
    expect(overrideCap.maxChars).toBe(800)
    expect(overrideCap.exceedsMaxChars).toBe(false)
  })
})
