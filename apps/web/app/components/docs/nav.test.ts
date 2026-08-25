import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import {
  ALL_DOCS_PAGES,
  breadcrumbsFor,
  DOCS_NAV,
  DOCS_PAGES,
  type DocsNavSection,
  siblingsFor,
} from "./nav"

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
      {
        label: "Migrating from LangGraph",
        href: "/docs/migrating-from-langgraph",
      },
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
      { label: "Long-term Memory", href: "/docs/memory/long-term" },
      { label: "Recall and Retrieval", href: "/docs/memory/retrieval" },
      { label: "Episodes", href: "/docs/memory/episodes" },
      { label: "Distillation", href: "/docs/memory/distillation" },
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
      {
        label: "Fixtures and Recording",
        href: "/docs/testing-agents/fixtures",
      },
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
      { label: "Thread Access", href: "/docs/thread-access" },
      { label: "Permissions", href: "/docs/permissions" },
      { label: "Retry", href: "/docs/retry" },
      { label: "Observability", href: "/docs/observability" },
      { label: "Inspector", href: "/docs/inspector" },
      { label: "Browse and Manage Memory", href: "/docs/memory/browse" },
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
      {
        label: "Dispatch from a Route",
        href: "/docs/recipes/dispatch-from-route",
      },
      {
        label: "Research Assistant Web UI",
        href: "/docs/recipes/research-web-ui",
      },
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
  readonly contentImportTarget: string | null
  readonly docsPageImportTarget: string | null
  readonly docsPageHref: string | null
}

interface DocTitleFixture {
  readonly mdxSource: string
  readonly wrapperSource: string
}

interface DocLinkGuardAnalysis {
  readonly movedViolations: readonly string[]
  readonly canonicalViolations: readonly string[]
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
  const result = spawnSync(process.execPath, [CHECK_DOCS_PATH, "--analyze-doc-titles"], {
    encoding: "utf8",
    input: JSON.stringify(fixtures),
  })
  const stderr = result.stderr ?? ""

  if (result.status !== 0) {
    throw new Error(
      [
        `Documentation title analysis failed with status ${String(result.status)}`,
        `signal: ${result.signal ?? "none"}`,
        `error: ${result.error?.message ?? "none"}`,
        `stderr: ${stderr.slice(0, 2_000) || "none"}`,
      ].join("\n"),
    )
  }
  expect(stderr).toBe("")
  expect(result.stdout).toMatch(/^\[/)
  return JSON.parse(result.stdout) as readonly DocTitleAnalysis[]
}

function analyzeDocTitles(mdxSource: string, wrapperSource: string): DocTitleAnalysis {
  const analysis = analyzeDocTitlesBatch([{ mdxSource, wrapperSource }])[0]
  expect(analysis).toBeDefined()
  return analysis as DocTitleAnalysis
}

function analyzeDocLinkGuards(fixture: Record<string, unknown>): DocLinkGuardAnalysis {
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-doc-link-guards", JSON.stringify(fixture)],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\{/)
  return JSON.parse(result.stdout) as DocLinkGuardAnalysis
}

function analyzeMaintainedHeadingIds(source: string): readonly string[] {
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-maintained-heading-ids", JSON.stringify({ source })],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\[/)
  return JSON.parse(result.stdout) as readonly string[]
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

function topologyFailures(
  journeyHrefs: readonly string[],
  apiHrefs: readonly string[],
  contentHrefs: readonly string[],
  wrapperHrefs: readonly string[],
): string[] {
  const journey = new Set(journeyHrefs)
  const allowedApi = new Set(apiHrefs)
  const content = new Set(contentHrefs)
  const wrappers = new Set(wrapperHrefs)
  const failures: string[] = []
  for (const href of new Set(contentHrefs)) {
    if (contentHrefs.filter((candidate) => candidate === href).length > 1) {
      failures.push(`duplicate docs content: ${href}`)
    }
  }
  for (const href of new Set(wrapperHrefs)) {
    if (wrapperHrefs.filter((candidate) => candidate === href).length > 1) {
      failures.push(`duplicate docs wrapper: ${href}`)
    }
  }
  for (const href of journey) {
    if (!content.has(href)) failures.push(`missing journey content: ${href}`)
    if (!wrappers.has(href)) failures.push(`missing journey wrapper: ${href}`)
  }
  for (const href of allowedApi) {
    if (!content.has(href)) failures.push(`missing API content: ${href}`)
    if (!wrappers.has(href)) failures.push(`missing API wrapper: ${href}`)
  }
  for (const href of new Set([...content, ...wrappers])) {
    if (journey.has(href)) continue
    if (!allowedApi.has(href)) failures.push(`unregistered docs leaf: ${href}`)
    if (content.has(href) !== wrappers.has(href)) failures.push(`unpaired API leaf: ${href}`)
  }
  return failures
}

describe("documentation registry invariants", () => {
  it("uses the exact eight-section foundation", () => {
    expect(DOCS_NAV).toEqual(FOUNDATION_DOCS_NAV)
  })

  it("pins the exact 59-page reading order", () => {
    const expectedPages = (FOUNDATION_DOCS_NAV as readonly DocsNavSection[]).flatMap(
      (section) => section.items,
    )

    expect(expectedPages).toHaveLength(59)
    expect(DOCS_PAGES).toEqual(expectedPages)
  })

  it("adds sixteen hidden API leaves immediately after the hub", () => {
    expect(DOCS_NAV.reduce((count, section) => count + section.items.length, 0)).toBe(59)
    expect(DOCS_PAGES).toHaveLength(59)
    expect(ALL_DOCS_PAGES).toHaveLength(75)

    const hubIndex = ALL_DOCS_PAGES.findIndex(({ href }) => href === "/docs/api")
    expect(ALL_DOCS_PAGES.slice(hubIndex + 1, hubIndex + 17)).toEqual(API_REFERENCE_PAGES)
    expect(ALL_DOCS_PAGES[hubIndex + 17]?.href).toBe("/docs/errors")
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
    expect(siblingsFor("/docs/faq").next).toBeNull()
  })

  it("gives hidden API leaves a four-part breadcrumb and no journey siblings", () => {
    for (const leaf of API_REFERENCE_PAGES) {
      expect(breadcrumbsFor(leaf.href)).toEqual([
        { label: "Docs", href: "/docs/getting-started" },
        { label: "Reference" },
        { label: "API Reference", href: "/docs/api" },
        { label: leaf.label },
      ])
      expect(siblingsFor(leaf.href)).toEqual({ prev: null, next: null })
    }
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

  it("matches authored content and wrappers to the exact exhaustive registry", () => {
    const navHrefs = DOCS_PAGES.map((page) => page.href)
    const contentHrefs = filesUnder(CONTENT_ROOT, (file) => file.endsWith(".mdx"))
      .map(contentHref)
      .sort()
    const wrapperHrefs = filesUnder(WRAPPERS_ROOT, (file) => file === "page.tsx")
      .map(wrapperHref)
      .filter((href) => href !== "/docs")
      .sort()

    expect(
      topologyFailures(
        navHrefs,
        API_REFERENCE_PAGES.map(({ href }) => href),
        contentHrefs,
        wrapperHrefs,
      ),
    ).toEqual([])
  })

  it("rejects missing, unregistered, and unpaired API leaves", () => {
    const journey = ["/docs/api"]
    const registered = ["/docs/api/sdk"]

    expect(
      topologyFailures(
        journey,
        registered,
        [...journey, ...registered, "/docs/api/foreign"],
        [...journey, ...registered, "/docs/api/foreign"],
      ),
    ).toContain("unregistered docs leaf: /docs/api/foreign")
    expect(topologyFailures(journey, registered, [...journey, ...registered], journey)).toContain(
      "unpaired API leaf: /docs/api/sdk",
    )
    expect(topologyFailures(journey, registered, journey, journey)).toEqual(
      expect.arrayContaining([
        "missing API content: /docs/api/sdk",
        "missing API wrapper: /docs/api/sdk",
      ]),
    )
    expect(
      topologyFailures(
        journey,
        registered,
        [...journey, ...registered, ...registered],
        [...journey, ...registered],
      ),
    ).toContain("duplicate docs content: /docs/api/sdk")
  })

  it("keeps nav labels, first MDX headings, and wrapper titles identical", () => {
    const processCountBefore = docTitleAnalysisProcessCount
    const contentHrefSet = new Set(
      filesUnder(CONTENT_ROOT, (file) => file.endsWith(".mdx")).map(contentHref),
    )
    const wrapperHrefSet = new Set(
      filesUnder(WRAPPERS_ROOT, (file) => file === "page.tsx").map(wrapperHref),
    )
    expect([...contentHrefSet].filter((href) => href.startsWith("/docs/api/"))).toEqual(
      expect.arrayContaining(API_REFERENCE_PAGES.map(({ href }) => href)),
    )
    expect([...wrapperHrefSet].filter((href) => href.startsWith("/docs/api/"))).toEqual(
      expect.arrayContaining(API_REFERENCE_PAGES.map(({ href }) => href)),
    )
    const authoredPages = ALL_DOCS_PAGES
    const fixtures = authoredPages.map((item) => {
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
    expect(analyses).toHaveLength(authoredPages.length)
    for (const [index, item] of authoredPages.entries()) {
      const { firstH1, metadataTitle, contentImportTarget, docsPageImportTarget, docsPageHref } =
        analyses[index] ?? {}
      const slug = item.href.replace(/^\/docs\//, "")
      const wrapperPath = join(WRAPPERS_ROOT, slug, "page.tsx")
      const contentPath = join(
        CONTENT_ROOT,
        slug === "recipes" ? "recipes/index.mdx" : `${slug}.mdx`,
      )

      expect(firstH1, `${item.href} first MDX H1`).toBe(item.label)
      expect(metadataTitle, `${item.href} metadata.title`).toBe(item.label)
      expect(
        resolve(dirname(wrapperPath), contentImportTarget ?? ""),
        `${item.href} MDX import`,
      ).toBe(contentPath)
      expect(
        `${resolve(dirname(wrapperPath), docsPageImportTarget ?? "")}.tsx`,
        `${item.href} DocsPage import`,
      ).toBe(join(WEB_ROOT, "app/components/docs/DocsPage.tsx"))
      expect(docsPageHref, `${item.href} DocsPage href`).toBe(item.href)
    }
  })

  it.each(["evals.mdx", "testing-agents.mdx"])(
    "uses the exact Scenario Testing title for /docs/testing cards in %s",
    (file) => {
      const source = readFileSync(join(CONTENT_ROOT, file), "utf8")
      expect(source).toContain('{ href: "/docs/testing", title: "Scenario Testing",')
    },
  )

  it("uses registered labels for every visible RelatedCards destination", () => {
    const labels = new Map(ALL_DOCS_PAGES.map((item) => [item.href, item.label]))
    const mismatches: string[] = []

    for (const file of filesUnder(CONTENT_ROOT, (name) => name.endsWith(".mdx"))) {
      const source = readFileSync(join(CONTENT_ROOT, file), "utf8")
      for (const match of source.matchAll(
        /\{\s*href:\s*"(\/docs\/[^"]+)",\s*title:\s*"([^"]+)"/g,
      )) {
        const href = match[1] ?? ""
        const title = match[2] ?? ""
        const expected = labels.get(href)
        if (expected !== undefined && title !== expected) {
          mismatches.push(
            `${file}: ${href} uses ${JSON.stringify(title)}; expected ${JSON.stringify(expected)}`,
          )
        }
      }
    }

    expect(mismatches).toEqual([])
  })

  it("keeps Getting Started focused on the first app journey", () => {
    const source = readFileSync(join(CONTENT_ROOT, "getting-started.mdx"), "utf8")
    const finalCards = source.slice(source.indexOf("## Where to go next"))
    const cardTitles = [...finalCards.matchAll(/\btitle:\s*"([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    )

    expect(source).toContain("[Deployment Options](/docs/deployment)")
    expect(source).toContain("[Node and Docker](/docs/deployment/node)")
    expect(source).not.toContain("## 5. Ship it")
    expect(source).not.toContain("docker run -p 8000:8000")
    expect(cardTitles).toEqual(["Mental Model", "Add a Tool", "Deployment Options"])
  })

  it("groups Recipes Overview around build, integrate, test, and deploy tasks", () => {
    const source = readFileSync(join(CONTENT_ROOT, "recipes/index.mdx"), "utf8")
    const recipeLabels = [
      "Add a Tool",
      "Typed State",
      "Retry Transient Model Calls",
      "Dispatch from a Route",
      "Auth Middleware",
      "Stream Output",
      "Research Assistant Web UI",
    ]

    for (const heading of ["Build", "Integrate", "Test", "Deploy"]) {
      expect(source).toContain(`## ${heading}`)
    }
    for (const label of recipeLabels) {
      expect(source.split(`[${label}]`)).toHaveLength(2)
    }
    for (const link of [
      "[Scenario Testing](/docs/testing)",
      "[Agent Test Harness](/docs/testing-agents)",
      "[Fixtures and Recording](/docs/testing-agents/fixtures)",
      "[Deployment Options](/docs/deployment)",
      "[Node and Docker](/docs/deployment/node)",
      "[Kubernetes](/docs/deployment/kubernetes)",
    ]) {
      expect(source).toContain(link)
    }
  })
})

describe("documentation title analysis", () => {
  const wrapper = `import type { Metadata } from "next"
export const metadata: Metadata = { title: "Real Title" }
`

  it("accepts a small fixture through the legacy argv interface", () => {
    const fixture = { mdxSource: "# Real Title\n", wrapperSource: wrapper }
    const result = spawnSync(
      process.execPath,
      [CHECK_DOCS_PATH, "--analyze-doc-titles", JSON.stringify(fixture)],
      { encoding: "utf8" },
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      firstH1: "Real Title",
      metadataTitle: "Real Title",
      contentImportTarget: null,
      docsPageImportTarget: null,
      docsPageHref: null,
    })
  })

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

  it("does not open a backtick fence whose info string contains a backtick", () => {
    const analysis = analyzeDocTitles(
      `\`\`\`md \`invalid\`
# Real Title
`,
      wrapper,
    )

    expect(analysis.firstH1).toBe("Real Title")
  })

  it("allows backticks in tilde-fence info strings", () => {
    const analysis = analyzeDocTitles(
      `~~~md \`valid\`
# Fake
~~~
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
      contentImportTarget: null,
      docsPageImportTarget: null,
      docsPageHref: null,
    })
  })

  it("structurally resolves the MDX import and literal DocsPage href with aliases", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `import Article from "../../../content/docs/real.mdx"
import { DocsPage as RenderDocsPage } from "../../components/docs/DocsPage"
export const metadata = { title: "Real Title" }
export default function Page() {
  return <RenderDocsPage href="/docs/real" Content={Article} />
}`,
    )

    expect(analysis).toEqual({
      firstH1: "Real Title",
      metadataTitle: "Real Title",
      contentImportTarget: "../../../content/docs/real.mdx",
      docsPageImportTarget: "../../components/docs/DocsPage",
      docsPageHref: "/docs/real",
    })
  })

  it("rejects a wrong MDX import despite a correct decoy string and comment", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `import Content from "../../../content/docs/wrong.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
// import Content from "../../../content/docs/real.mdx"
const decoy = 'import Content from "../../../content/docs/real.mdx"'
export const metadata = { title: "Real Title" }
export default function Page() {
  return <DocsPage href="/docs/real" Content={Content} />
}
void decoy`,
    )

    expect(analysis.contentImportTarget).toBe("../../../content/docs/wrong.mdx")
  })

  it("rejects a wrong DocsPage href despite correct decoy text", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `import Content from "../../../content/docs/real.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
// <DocsPage href="/docs/real" Content={Content} />
const decoy = '<DocsPage href="/docs/real" Content={Content} />'
export const metadata = { title: "Real Title" }
export default function Page() {
  return <DocsPage href="/docs/wrong" Content={Content} />
}
void decoy`,
    )

    expect(analysis.docsPageHref).toBe("/docs/wrong")
  })

  it("rejects wrong metadata despite correct decoy text", () => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `import Content from "../../../content/docs/real.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
// export const metadata = { title: "Real Title" }
const decoy = 'export const metadata = { title: "Real Title" }'
export const metadata = { title: "Wrong Title" }
export default function Page() {
  return <DocsPage href="/docs/real" Content={Content} />
}
void decoy`,
    )

    expect(analysis.metadataTitle).toBe("Wrong Title")
  })

  it.each([
    [
      "Content parameter",
      `export default function Page(Content: unknown) {
  return <DocsPage href="/docs/real" Content={Content} />
}`,
    ],
    [
      "function-local DocsPage",
      `export default function Page() {
  const DocsPage = () => null
  return <DocsPage href="/docs/real" Content={Content} />
}`,
    ],
    [
      "nested Content binding",
      `export default function Page() {
  {
    const Content = WrongContent
    return <DocsPage href="/docs/real" Content={Content} />
  }
}`,
    ],
  ])("rejects import shadowing at the JSX use site: %s", (_name, pageSource) => {
    const analysis = analyzeDocTitles(
      "# Real Title\n",
      `import Content from "../../../content/docs/real.mdx"
import WrongContent from "../../../content/docs/wrong.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
export const metadata = { title: "Real Title" }
${pageSource}`,
    )

    expect(
      analysis.contentImportTarget === "../../../content/docs/real.mdx" &&
        analysis.docsPageImportTarget === "../../components/docs/DocsPage",
    ).toBe(false)
  })
})

describe("maintained documentation heading identity analysis", () => {
  it.each([
    ["inline code", "## Use `@dawn-ai/cli/fetch`\n", ["use-dawn-aiclifetch"]],
    [
      "an ordinary Markdown link",
      "## Read the [deployment guide](/docs/deployment)\n",
      ["read-the-deployment-guide"],
    ],
    [
      "nested tag-like text",
      "## Nested <scr<script>ipt> identity\n",
      ["nested-scrscriptipt-identity"],
    ],
    ["repeated headings", "## Repeat\n## Repeat\n", ["repeat", "repeat-1"]],
  ])("uses GitHub-style IDs for %s", (_label, source, expectedIds) => {
    expect(analyzeMaintainedHeadingIds(source)).toEqual(expectedIds)
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

describe("canonical docs link guard analysis", () => {
  it("uses only active destinations and scopes focused ownership to its subject section", () => {
    const legacyHref = "/docs/memory#how-recall-ranks"
    const ignoredSource = [
      `The former destination was ${legacyHref}.`,
      `\`${legacyHref}\``,
      `<!-- [comment](${legacyHref}) -->`,
      "```md",
      `[fenced](${legacyHref})`,
      "```",
      "",
      "[Memory overview](/docs/memory)",
      "",
      "## Recall",
      "",
      "[Focused owner](/docs/memory/retrieval)",
    ].join("\n")
    const fixture = {
      file: "other.mdx",
      source: ignoredSource,
      movedContracts: [
        {
          legacyFile: "memory.mdx",
          legacyHref,
          canonicalHref: "/docs/memory/retrieval",
        },
      ],
      canonicalContracts: [{ heading: "Recall", required: ["/docs/memory/retrieval"] }],
    }

    expect(analyzeDocLinkGuards(fixture)).toEqual({
      movedViolations: [],
      canonicalViolations: [],
    })
    expect(
      analyzeDocLinkGuards({
        ...fixture,
        source: `## Recall\n\n[Overview only](/docs/memory)\n\n[Active old link](${legacyHref})`,
      }),
    ).toEqual({
      movedViolations: [`other.mdx: ${legacyHref} -> /docs/memory/retrieval`],
      canonicalViolations: ["Recall: missing /docs/memory/retrieval"],
    })
  })
})
