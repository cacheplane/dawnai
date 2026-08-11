import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  buildReadme,
  extractSummary,
  extractTitle,
  loadNav,
  mdxToMarkdown,
  parseFrontmatter,
  parseNav,
  parseNavOrder,
} from "../src/lib/docs-bundle.js"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const EXPECTED_DOCS_NAV = [
  { slug: "getting-started", label: "Getting Started" },
  { slug: "mental-model", label: "Mental Model" },
  { slug: "migrating-from-langgraph", label: "Migrating from LangGraph" },
  { slug: "routes", label: "Routes" },
  { slug: "agents", label: "Agents" },
  { slug: "tools", label: "Tools" },
  { slug: "state", label: "State" },
  { slug: "workspace", label: "Workspace Filesystem" },
  { slug: "memory", label: "Memory" },
  { slug: "memory/long-term", label: "Long-term Memory" },
  { slug: "memory/retrieval", label: "Recall and Retrieval" },
  { slug: "memory/episodes", label: "Episodes" },
  { slug: "memory/distillation", label: "Distillation" },
  { slug: "planning", label: "Planning" },
  { slug: "skills", label: "Skills" },
  { slug: "subagents", label: "Subagents" },
  { slug: "context-management", label: "Context Management" },
  { slug: "reasoning-effort", label: "Reasoning Effort" },
  { slug: "dev-server", label: "Dev Server" },
  { slug: "dev-server/agent-protocol", label: "Agent Protocol" },
  { slug: "middleware", label: "Middleware" },
  { slug: "ag-ui", label: "AG-UI and Web Clients" },
  { slug: "embedding", label: "Embed the Runtime" },
  { slug: "blueprints", label: "Blueprints" },
  { slug: "testing", label: "Scenario Testing" },
  { slug: "testing-agents", label: "Agent Test Harness" },
  { slug: "testing-agents/fixtures", label: "Fixtures and Recording" },
  { slug: "evals", label: "Evals" },
  { slug: "persistence", label: "Persistence and Tenancy" },
  { slug: "production-topology", label: "Production Topology" },
  { slug: "security-architecture", label: "Security Architecture" },
  { slug: "access-control", label: "Access Control" },
  { slug: "permissions", label: "Permissions" },
  { slug: "retry", label: "Retry" },
  { slug: "observability", label: "Observability" },
  { slug: "inspector", label: "Inspector" },
  { slug: "memory/browse", label: "Browse and Manage Memory" },
  { slug: "upgrading", label: "Upgrading" },
  { slug: "deployment", label: "Deployment Options" },
  { slug: "deployment/node", label: "Node and Docker" },
  { slug: "deployment/kubernetes", label: "Kubernetes" },
  { slug: "deployment/langsmith", label: "LangSmith" },
  { slug: "deployment/edge", label: "Edge and Hono" },
  { slug: "sandbox", label: "Execution Sandbox" },
  { slug: "sandbox/kubernetes", label: "Kubernetes Sandbox" },
  { slug: "recipes", label: "Recipes Overview" },
  { slug: "recipes/add-a-tool", label: "Add a Tool" },
  { slug: "recipes/typed-state", label: "Typed State" },
  { slug: "recipes/auth-middleware", label: "Auth Middleware" },
  { slug: "recipes/stream-output", label: "Stream Output" },
  { slug: "recipes/retry-flaky-tools", label: "Retry Transient Model Calls" },
  { slug: "recipes/dispatch-from-route", label: "Dispatch from a Route" },
  { slug: "recipes/research-web-ui", label: "Research Assistant Web UI" },
  { slug: "configuration", label: "Configuration Reference" },
  { slug: "cli", label: "CLI Reference" },
  { slug: "api", label: "API Reference" },
  { slug: "errors", label: "Error Codes" },
  { slug: "faq", label: "FAQ" },
] as const
const scannedTextExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
])

function isExcludedDocumentationPath(relativePath: string, pathSeparator = sep): boolean {
  const parts = relativePath.split(pathSeparator)
  return (
    (parts[0] === "docs" && parts[1] === "superpowers") ||
    parts.some(
      (part) =>
        part === "node_modules" ||
        part === ".dawn" ||
        part === ".next" ||
        part === ".turbo" ||
        part === "dist",
    ) ||
    parts.at(-1)?.endsWith(".tsbuildinfo") === true
  )
}

function currentDocumentationFiles(path: string): string[] {
  if (!existsSync(path)) return []

  const relativePath = relative(repoRoot, path)
  if (isExcludedDocumentationPath(relativePath)) {
    return []
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return []
  if (stat.isFile()) {
    return /changelog/i.test(path) || !scannedTextExtensions.has(extname(path).toLowerCase())
      ? []
      : [path]
  }
  if (!stat.isDirectory()) return []

  return readdirSync(path).flatMap((entry) => currentDocumentationFiles(join(path, entry)))
}

describe("current AG-UI documentation", () => {
  it("tolerates an optional documentation root that has not been generated", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-docs-bundle-"))
    try {
      expect(currentDocumentationFiles(join(fixtureRoot, "missing"))).toEqual([])
    } finally {
      rmSync(fixtureRoot, { recursive: true })
    }
  })

  it("excludes generated cache directories", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-docs-bundle-"))
    const component = join(fixtureRoot, "component.tsx")
    const notes = join(fixtureRoot, "notes.mdx")
    const readme = join(fixtureRoot, "README.md")
    try {
      for (const directory of [".dawn", ".next", ".turbo", "dist", "node_modules"]) {
        mkdirSync(join(fixtureRoot, directory))
        writeFileSync(join(fixtureRoot, directory, "generated.log"), "createAgUiTranslator")
      }
      writeFileSync(join(fixtureRoot, "tsconfig.tsbuildinfo"), "createAgUiTranslator")
      writeFileSync(join(fixtureRoot, "custom-name.tsbuildinfo"), "createAgUiTranslator")
      writeFileSync(join(fixtureRoot, "checkpoint.sqlite"), Buffer.from("\0createAgUiTranslator\0"))
      writeFileSync(component, "export function Component() { return null }")
      writeFileSync(notes, "# Current documentation")
      writeFileSync(readme, "Current documentation")

      expect(currentDocumentationFiles(fixtureRoot).sort()).toEqual(
        [component, notes, readme].sort(),
      )
    } finally {
      rmSync(fixtureRoot, { recursive: true })
    }
  })

  it("classifies Windows-style paths by platform separator", () => {
    expect(isExcludedDocumentationPath("examples\\chat\\web\\.turbo\\build.log", "\\")).toBe(true)
    expect(isExcludedDocumentationPath("docs\\superpowers\\plans\\task.md", "\\")).toBe(true)
    expect(isExcludedDocumentationPath("examples\\chat\\README.md", "\\")).toBe(false)
  })

  it("does not follow symlinked directories", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-docs-bundle-"))
    const scanRoot = join(fixtureRoot, "scan")
    const targetRoot = join(fixtureRoot, "target")
    const readme = join(scanRoot, "README.md")
    try {
      mkdirSync(scanRoot)
      mkdirSync(targetRoot)
      writeFileSync(join(targetRoot, "stale.md"), "createAgUiTranslator")
      symlinkSync(
        targetRoot,
        join(scanRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      )
      writeFileSync(readme, "Current documentation")

      expect(currentDocumentationFiles(scanRoot)).toEqual([readme])
    } finally {
      rmSync(fixtureRoot, { recursive: true })
    }
  })

  it("does not reference removed adapter APIs or example UI", () => {
    // Retired Dawn/adapter vocabulary. `useInterrupt` and `PermissionInterrupt`
    // are deliberately NOT listed: the canonicalized adapter still surfaces
    // permission gates as AG-UI standard interrupts, and the example UIs render
    // them with CopilotKit's current `useInterrupt` hook (see each example's
    // PermissionInterrupt.tsx). Exact `dawn.subagent` is now a valid standard
    // activity type. What must stay gone is the *legacy* vocabulary below — the
    // dotted custom-event family, custom-event interrupt, and `forwardedProps`
    // resume path.
    const removed = [
      "createAgUiTranslator",
      "mapRunInput",
      'CUSTOM{name:"on_interrupt"}',
      "forwardedProps.command.resume",
      "STATE_SNAPSHOT",
      "dawn.subagent.",
      "TodosPanel",
    ]
    const roots = [
      "packages/ag-ui/README.md",
      "packages/cli/docs",
      "apps/web/content/docs",
      "examples/chat",
      "examples/research",
    ]
    const staleReferences = roots.flatMap((root) =>
      currentDocumentationFiles(join(repoRoot, root)).flatMap((file) => {
        const contents = readFileSync(file, "utf8")
        return removed
          .filter((term) => contents.includes(term))
          .map((term) => `${relative(repoRoot, file)}: ${term}`)
      }),
    )

    expect(staleReferences).toEqual([])
  })
})

describe("parseFrontmatter()", () => {
  it("extracts title and description and strips the frontmatter block", () => {
    const raw = '---\ntitle: "Tools"\ndescription: Co-located tools\n---\n\nBody text.\n'
    const { data, body } = parseFrontmatter(raw)
    expect(data.title).toBe("Tools")
    expect(data.description).toBe("Co-located tools")
    expect(body).toBe("\nBody text.\n")
  })

  it("returns empty data when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter("# Heading\n")
    expect(data).toEqual({})
    expect(body).toBe("# Heading\n")
  })
})

describe("mdxToMarkdown()", () => {
  it("drops frontmatter, promotes title to an H1, and removes module imports", () => {
    const raw = '---\ntitle: "Routes"\n---\nimport { Callout } from "x"\n\nA route is a folder.\n'
    const out = mdxToMarkdown(raw)
    expect(out).toContain("# Routes")
    expect(out).toContain("A route is a folder.")
    expect(out).not.toContain("import { Callout }")
    expect(out).not.toContain("---")
  })

  it("removes RelatedCards components, including multi-line ones", () => {
    const raw = '# X\n\nText.\n\n<RelatedCards items={[\n  { href: "/docs/routes" },\n]} />\n'
    const out = mdxToMarkdown(raw)
    expect(out).not.toContain("RelatedCards")
    expect(out).toContain("Text.")
  })

  it("removes the paired <RelatedCards>…</RelatedCards> form too", () => {
    const raw = "# X\n\nKeep.\n\n<RelatedCards>\n  <Card/>\n</RelatedCards>\n"
    const out = mdxToMarkdown(raw)
    expect(out).not.toContain("RelatedCards")
    expect(out).toContain("Keep.")
  })

  it("preserves import lines inside fenced code blocks", () => {
    const raw = '# X\n\n```ts\nimport { agent } from "@dawn-ai/sdk"\n```\n'
    const out = mdxToMarkdown(raw)
    expect(out).toContain('import { agent } from "@dawn-ai/sdk"')
  })

  it("does not add a second H1 when the body already starts with one", () => {
    const raw = "---\ntitle: Dup\n---\n# Real Heading\n\nBody.\n"
    const out = mdxToMarkdown(raw)
    expect(out.match(/^# /gm)?.length).toBe(1)
    expect(out).toContain("# Real Heading")
  })
})

describe("parseNavOrder()", () => {
  it("returns nested doc slugs in source order without duplicates", () => {
    const nav = [
      {
        items: [
          { label: "Getting Started", href: "/docs/getting-started" },
          { label: "Routes", href: "/docs/routes" },
          { label: "Long-term Memory", href: "/docs/memory/long-term" },
          { label: "Add a tool", href: "/docs/recipes/add-a-tool" },
          { label: "Routes again", href: "/docs/routes" },
        ],
      },
    ]
    expect(parseNavOrder(nav)).toEqual([
      "getting-started",
      "routes",
      "memory/long-term",
      "recipes/add-a-tool",
    ])
  })

  it("loads the complete real registry in an independently pinned reading order", async () => {
    expect(await loadNav(join(repoRoot, "apps/web/app/components/docs/nav.ts"))).toEqual(
      EXPECTED_DOCS_NAV,
    )
  })

  it("loads only exported DOCS_NAV, ignoring comments, strings, and non-exported lookalikes", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-docs-nav-"))
    const navFile = join(fixtureRoot, "nav.ts")
    try {
      writeFileSync(
        navFile,
        `
// { label: "Comment decoy", href: "/docs/faq" },
const text = '{ label: "String decoy", href: "/docs/errors" }'
const OTHER_NAV = [{
  label: "Other",
  items: [{ label: "Non-exported decoy", href: "/docs/api" }],
}]
export const DOCS_NAV = [{
  label: "Build",
  items: [{ label: "Routes", href: "/docs/routes" }],
}]
void text
void OTHER_NAV
`,
      )

      expect(await loadNav(navFile)).toEqual([{ slug: "routes", label: "Routes" }])
    } finally {
      rmSync(fixtureRoot, { recursive: true })
    }
  })
})

describe("parseNav()", () => {
  it("returns ordered nested slug/label pairs, deduped by slug", () => {
    const nav = [
      {
        items: [
          { label: "Getting Started", href: "/docs/getting-started" },
          { label: "Tools", href: "/docs/tools" },
          { label: "Long-term Memory", href: "/docs/memory/long-term" },
          { label: "Add a tool", href: "/docs/recipes/add-a-tool" },
          { label: "Tools again", href: "/docs/tools" },
        ],
      },
    ]
    expect(parseNav(nav)).toEqual([
      { slug: "getting-started", label: "Getting Started" },
      { slug: "tools", label: "Tools" },
      { slug: "memory/long-term", label: "Long-term Memory" },
      { slug: "recipes/add-a-tool", label: "Add a tool" },
    ])
  })
})

describe("generated documentation bundle", () => {
  it("contains exactly one topic file per real nav entry in registry order", () => {
    const readme = readFileSync(join(repoRoot, "packages/cli/docs/README.md"), "utf8")
    const topics = [...readme.matchAll(/^- \[([^\]]+)\]\(\.\/([^)]+)\)/gm)].flatMap((match) =>
      match[1] && match[2] ? [{ title: match[1], file: match[2] }] : [],
    )
    const expectedFiles = EXPECTED_DOCS_NAV.map((entry) =>
      entry.slug === "recipes" ? "recipes/index.md" : `${entry.slug}.md`,
    )

    expect(topics).toEqual(
      EXPECTED_DOCS_NAV.map((entry, index) => ({
        title: entry.label,
        file: expectedFiles[index] ?? "",
      })),
    )
    expect(topics).toContainEqual({
      title: "Recipes Overview",
      file: "recipes/index.md",
    })
    expect(topics).toContainEqual({
      title: "Long-term Memory",
      file: "memory/long-term.md",
    })
    expect(topics).toContainEqual({
      title: "Fixtures and Recording",
      file: "testing-agents/fixtures.md",
    })
    for (const { title, file } of topics) {
      const topicPath = join(repoRoot, "packages/cli/docs", file)
      expect(existsSync(topicPath), file).toBe(true)
      expect(extractTitle(readFileSync(topicPath, "utf8")), file).toBe(title)
    }
  })
})

describe("extractTitle()", () => {
  it("returns the first H1 heading text", () => {
    expect(extractTitle("# Getting Started\n\nBody.\n")).toBe("Getting Started")
  })
  it("returns undefined when there is no H1", () => {
    expect(extractTitle("Just text.\n")).toBeUndefined()
  })
})

describe("extractSummary()", () => {
  it("uses the first paragraph after the heading, first sentence only", () => {
    const md = "# Tools\n\nTools are units of work. More detail follows here.\n\n## Next\n"
    expect(extractSummary(md)).toBe("Tools are units of work.")
  })
  it("flattens markdown links and skips lists/code", () => {
    const md = "# X\n\nSee [State](/docs/state) for more.\n"
    expect(extractSummary(md)).toBe("See State for more.")
  })
})

describe("buildReadme()", () => {
  it("renders an index linking each topic file with its description", () => {
    const md = buildReadme([
      {
        slug: "tools",
        title: "Tools",
        description: "Co-located tools",
        file: "tools.md",
      },
      { slug: "state", title: "State", description: "", file: "state.md" },
    ])
    expect(md).toContain("# Dawn — Documentation")
    expect(md).toContain("dawn docs <topic>")
    expect(md).toContain("- [Tools](./tools.md) — Co-located tools")
    expect(md).toContain("- [State](./state.md)")
    expect(md).not.toContain("State](./state.md) —")
  })
})
