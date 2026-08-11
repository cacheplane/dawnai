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

const FOUNDATION_DOCS_NAV = [
  {
    label: "Get Started",
    items: [
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Mental Model", href: "/docs/mental-model" },
      { label: "Migrating from LangGraph", href: "/docs/migrating-from-langgraph" },
    ],
  },
  {
    label: "Build",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Workspace Filesystem", href: "/docs/workspace" },
      { label: "Memory", href: "/docs/memory" },
      { label: "Planning", href: "/docs/planning" },
      { label: "Skills", href: "/docs/skills" },
      { label: "Subagents", href: "/docs/subagents" },
      { label: "Context Management", href: "/docs/context-management" },
      { label: "Reasoning Effort", href: "/docs/reasoning-effort" },
    ],
  },
  {
    label: "Integrate",
    items: [
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Agent Protocol", href: "/docs/dev-server/agent-protocol" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "AG-UI and Web Clients", href: "/docs/ag-ui" },
      { label: "Embed the Runtime", href: "/docs/embedding" },
      { label: "Blueprints", href: "/docs/blueprints" },
    ],
  },
  {
    label: "Test",
    items: [
      { label: "Scenario Testing", href: "/docs/testing" },
      { label: "Agent Test Harness", href: "/docs/testing-agents" },
      { label: "Evals", href: "/docs/evals" },
    ],
  },
  {
    label: "Operate",
    items: [
      { label: "Persistence and Tenancy", href: "/docs/persistence" },
      { label: "Production Topology", href: "/docs/production-topology" },
      { label: "Security Architecture", href: "/docs/security-architecture" },
      { label: "Access Control", href: "/docs/access-control" },
      { label: "Permissions", href: "/docs/permissions" },
      { label: "Retry", href: "/docs/retry" },
      { label: "Observability", href: "/docs/observability" },
      { label: "Inspector", href: "/docs/inspector" },
      { label: "Upgrading", href: "/docs/upgrading" },
    ],
  },
  {
    label: "Deploy",
    items: [
      { label: "Deployment Options", href: "/docs/deployment" },
      { label: "Node and Docker", href: "/docs/deployment/node" },
      { label: "Kubernetes", href: "/docs/deployment/kubernetes" },
      { label: "LangSmith", href: "/docs/deployment/langsmith" },
      { label: "Edge and Hono", href: "/docs/deployment/edge" },
      { label: "Execution Sandbox", href: "/docs/sandbox" },
      { label: "Kubernetes Sandbox", href: "/docs/sandbox/kubernetes" },
    ],
  },
  {
    label: "Recipes",
    items: [
      { label: "Recipes Overview", href: "/docs/recipes" },
      { label: "Add a Tool", href: "/docs/recipes/add-a-tool" },
      { label: "Typed State", href: "/docs/recipes/typed-state" },
      { label: "Auth Middleware", href: "/docs/recipes/auth-middleware" },
      { label: "Stream Output", href: "/docs/recipes/stream-output" },
      {
        label: "Retry Transient Model Calls",
        href: "/docs/recipes/retry-flaky-tools",
      },
      { label: "Dispatch from a Route", href: "/docs/recipes/dispatch-from-route" },
      { label: "Research Assistant Web UI", href: "/docs/recipes/research-web-ui" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Configuration Reference", href: "/docs/configuration" },
      { label: "CLI Reference", href: "/docs/cli" },
      { label: "API Reference", href: "/docs/api" },
      { label: "Error Codes", href: "/docs/errors" },
      { label: "FAQ", href: "/docs/faq" },
    ],
  },
] as const

interface CompatibilityStubAnalysis {
  readonly found: boolean
  readonly stub: string
  readonly destinations: readonly string[]
  readonly charCount: number
  readonly maxChars: number
  readonly hasCanonicalLink: boolean
  readonly exceedsMaxChars: boolean
}

interface DocTitleAnalysis {
  readonly firstH1: string | null
  readonly metadataTitle: string | null
}

interface DocTitleFixture {
  readonly mdxSource: string
  readonly wrapperSource: string
}

let docTitleAnalysisProcessCount = 0

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

function analyzeDocTitlesBatch(fixtures: readonly DocTitleFixture[]): readonly DocTitleAnalysis[] {
  docTitleAnalysisProcessCount++
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-doc-titles", JSON.stringify(fixtures)],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\[/)
  return JSON.parse(result.stdout) as readonly DocTitleAnalysis[]
}

function analyzeDocTitles(mdxSource: string, wrapperSource: string): DocTitleAnalysis {
  const analysis = analyzeDocTitlesBatch([{ mdxSource, wrapperSource }])[0]
  expect(analysis).toBeDefined()
  return analysis as DocTitleAnalysis
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
  it("uses the exact eight-section foundation", () => {
    expect(DOCS_NAV).toEqual(FOUNDATION_DOCS_NAV)
  })

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
      { label: "Integrate" },
      { label: "AG-UI and Web Clients" },
    ])
    expect(siblingsFor("/docs/dev-server/agent-protocol").prev?.href).toBe("/docs/dev-server")
    expect(siblingsFor("/docs/dev-server/agent-protocol").next?.href).toBe("/docs/middleware")
    expect(siblingsFor("/docs/ag-ui").prev?.href).toBe("/docs/middleware")
    expect(siblingsFor("/docs/ag-ui").next?.href).toBe("/docs/embedding")
    expect(DOCS_PAGES).toHaveLength(52)
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

  it("keeps nav labels, first MDX headings, and wrapper titles identical", () => {
    const processCountBefore = docTitleAnalysisProcessCount
    const fixtures = DOCS_PAGES.map((item) => {
      const slug = item.href.replace(/^\/docs\//, "")
      const contentPath = join(
        CONTENT_ROOT,
        slug === "recipes" ? "recipes/index.mdx" : `${slug}.mdx`,
      )
      const wrapperPath = join(WRAPPERS_ROOT, slug, "page.tsx")
      return {
        mdxSource: readFileSync(contentPath, "utf8"),
        wrapperSource: readFileSync(wrapperPath, "utf8"),
      }
    })
    const analyses = analyzeDocTitlesBatch(fixtures)

    expect(docTitleAnalysisProcessCount - processCountBefore).toBe(1)
    expect(analyses).toHaveLength(DOCS_PAGES.length)
    for (const [index, item] of DOCS_PAGES.entries()) {
      const { firstH1, metadataTitle } = analyses[index] ?? {}

      expect(firstH1, `${item.href} first MDX H1`).toBe(item.label)
      expect(metadataTitle, `${item.href} metadata.title`).toBe(item.label)
    }
  })

  it.each(["evals.mdx", "testing-agents.mdx"])(
    "uses the exact Scenario Testing title for /docs/testing cards in %s",
    (file) => {
      const source = readFileSync(join(CONTENT_ROOT, file), "utf8")
      expect(source).toContain('{ href: "/docs/testing", title: "Scenario Testing",')
    },
  )
})

describe("documentation title analysis", () => {
  const wrapper = `import type { Metadata } from "next"
export const metadata: Metadata = { title: "Real Title" }
`

  it("ignores fenced pseudo-H1s before the first rendered H1", () => {
    const analysis = analyzeDocTitles(
      `\`\`\`md
# Fake
\`\`\`
# Real Title
`,
      wrapper,
    )

    expect(analysis.firstH1).toBe("Real Title")
  })

  it("ignores MDX-commented pseudo-H1s before the first rendered H1", () => {
    const analysis = analyzeDocTitles(
      `{/*
# Fake
*/}
# Real Title
`,
      wrapper,
    )

    expect(analysis.firstH1).toBe("Real Title")
  })

  it("ignores pseudo-H1s in leading YAML frontmatter", () => {
    const analysis = analyzeDocTitles(
      `---
# Expected
description: "Documentation metadata"
---
# Real Title
`,
      wrapper,
    )

    expect(analysis.firstH1).toBe("Real Title")
  })

  it("normalizes CommonMark code spans and closing ATX hashes", () => {
    const analysis = analyzeDocTitles("# Use `` `code` `` Today ###\n", wrapper)

    expect(analysis.firstH1).toBe("Use `code` Today")
  })

  it("ignores commented-out wrapper metadata", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `// export const metadata: Metadata = { title: "Fake" }
/* export const metadata: Metadata = { title: "Also Fake" } */
export const metadata: Metadata = { title: "Real Title" }
`,
    )

    expect(analysis.metadataTitle).toBe("Real Title")
  })

  it("ignores metadata-like text inside JavaScript regex literals", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `const marker = /export const metadata: Metadata = { title: "Fake" }/
export const metadata: Metadata = { title: "Real Title" }
`,
    )

    expect(analysis.metadataTitle).toBe("Real Title")
  })

  it("ignores metadata-like regex literals after a closing parenthesis", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `if (true) /export const metadata: Metadata = { title: "Fake" }/.test("")
export const metadata: Metadata = { title: "Real Title" }
`,
    )

    expect(analysis.metadataTitle).toBe("Real Title")
  })

  it("ignores non-exported metadata declarations", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `if (true) {
  const metadata: Metadata = { title: "Fake" }
}
export const metadata: Metadata = { title: "Real Title" }
`,
    )

    expect(analysis.metadataTitle).toBe("Real Title")
  })

  it("reads only a direct title property from exported metadata", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `export const metadata: Metadata = {
  nested: { title: "Fake" },
  title: "Real Title",
}
`,
    )

    expect(analysis.metadataTitle).toBe("Real Title")
  })

  it.each([
    'export const metadata = ({ title: "Real Title" } as const)',
    'export const metadata = ({ title: "Real Title" } satisfies Metadata)',
    'export const metadata = { title: "Real Title" as const }',
  ])("unwraps supported metadata expressions: %s", (wrapperSource) => {
    expect(analyzeDocTitles("# Real Title\n", wrapperSource).metadataTitle).toBe("Real Title")
  })

  it("returns the actual first top-level H1 and exported metadata title", () => {
    expect(analyzeDocTitles("## Lead-in\n# `Real` Title\n# Later Title\n", wrapper)).toEqual({
      firstH1: "Real Title",
      metadataTitle: "Real Title",
    })
  })
})

describe("compatibility stub analysis", () => {
  const canonicalHref = "/docs/canonical"

  it("recognizes retained heading text that contains inline code", () => {
    const analysis = analyzeCompatibilityStub(
      `### The \`@dawn-ai/cli/fetch\` entry point
[Canonical](${canonicalHref})
`,
      "The `@dawn-ai/cli/fetch` entry point",
      canonicalHref,
    )

    expect(analysis.found).toBe(true)
    expect(analysis.hasCanonicalLink).toBe(true)
  })

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
