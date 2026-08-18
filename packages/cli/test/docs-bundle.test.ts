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
import { fileURLToPath, pathToFileURL } from "node:url"
import { tsImport } from "tsx/esm/api"
import { describe, expect, it } from "vitest"
import {
  buildReadme,
  extractSummary,
  extractTitle,
  loadDocsPages,
  mdxToMarkdown,
  parseDocsPages,
  parseFrontmatter,
} from "../src/lib/docs-bundle.js"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
interface RegistryPage {
  readonly label: string
  readonly href: string
}

const navModule = (await tsImport(
  pathToFileURL(join(repoRoot, "apps/web/app/components/docs/nav.ts")).href,
  import.meta.url,
)) as { readonly ALL_DOCS_PAGES: readonly RegistryPage[] }
const EXPECTED_DOCS = navModule.ALL_DOCS_PAGES.map(({ href, label }) => ({
  slug: href.slice("/docs/".length),
  label,
}))
const apiHubIndex = EXPECTED_DOCS.findIndex(({ slug }) => slug === "api")
const FINAL_PR2_API_DOCS = [
  ["@dawn-ai/permissions", "api/permissions.md"],
  ["@dawn-ai/workspace", "api/workspace.md"],
  ["@dawn-ai/sandbox", "api/sandbox.md"],
  ["@dawn-ai/langgraph", "api/langgraph.md"],
  ["@dawn-ai/langchain", "api/langchain.md"],
  ["@dawn-ai/sqlite-storage", "api/sqlite-storage.md"],
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

  it("strips API behavior authority comments outside fences", () => {
    const marker =
      '{/* api-behavior-authorities: [{"kind":"test-assertion","file":"x.test.ts","testNames":["works"]}] */}'
    const raw = `# X\n\n${marker}\nVisible claim.\n\n\`${marker}\`\n\n\`\`\`md\n${marker}\n\`\`\`\n`
    const out = mdxToMarkdown(raw)

    expect(out).toContain("Visible claim.")
    expect(out).toContain(`\`${marker}\``)
    expect(out).toContain(`\`\`\`md\n${marker}\n\`\`\``)
    expect(out).not.toContain(`# X\n\n${marker}\nVisible claim.`)
    expect(out.split(marker)).toHaveLength(3)
  })

  it("matches fenced blocks by delimiter character and minimum opening length", () => {
    const marker =
      '{/* api-behavior-authorities: [{"kind":"test-assertion","file":"x.test.ts","testNames":["works"]}] */}'
    const raw = [
      "# X",
      "",
      "~~~~md",
      marker,
      "~~~",
      marker,
      "~~~~",
      marker,
      "",
      "````md",
      marker,
      "```",
      marker,
      "````",
      marker,
      "",
    ].join("\n")

    const out = mdxToMarkdown(raw)
    expect(out.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(
      4,
    )
    expect(out).toContain(`~~~~md\n${marker}\n~~~\n${marker}\n~~~~`)
    expect(out).toContain(`\`\`\`\`md\n${marker}\n\`\`\`\n${marker}\n\`\`\`\``)
  })

  it("rejects backticks in backtick-fence info strings but permits them for tilde fences", () => {
    const marker =
      '{/* api-behavior-authorities: [{"kind":"test-assertion","file":"x.test.ts","testNames":["works"]}] */}'
    const invalid = mdxToMarkdown(`# X\n\n\`\`\`md \`invalid\`\n${marker}\n`)
    const valid = mdxToMarkdown(`# X\n\n~~~md \`valid\`\n${marker}\n~~~\n`)

    expect(invalid).not.toContain(marker)
    expect(valid).toContain(`~~~md \`valid\`\n${marker}\n~~~`)
  })

  it("does not add a second H1 when the body already starts with one", () => {
    const raw = "---\ntitle: Dup\n---\n# Real Heading\n\nBody.\n"
    const out = mdxToMarkdown(raw)
    expect(out.match(/^# /gm)?.length).toBe(1)
    expect(out).toContain("# Real Heading")
  })
})

describe("loadDocsPages()", () => {
  it("loads every exhaustive page in canonical registry order", async () => {
    expect(await loadDocsPages(join(repoRoot, "apps/web/app/components/docs/nav.ts"))).toEqual(
      EXPECTED_DOCS,
    )
  })

  it("loads only exported ALL_DOCS_PAGES, ignoring comments, strings, and non-exported lookalikes", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-docs-nav-"))
    const navFile = join(fixtureRoot, "nav.ts")
    try {
      writeFileSync(
        navFile,
        `
// export const ALL_DOCS_PAGES = [{ label: "Comment decoy", href: "/docs/faq" }]
const text = 'export const ALL_DOCS_PAGES = [{ label: "String decoy", href: "/docs/errors" }]'
const OTHER_PAGES = [{ label: "Non-exported decoy", href: "/docs/api" }]
export const DOCS_NAV = [{ items: [{ label: "Journey decoy", href: "/docs/faq" }] }]
export const ALL_DOCS_PAGES = [{ label: "Routes", href: "/docs/routes" }]
void text
void OTHER_PAGES
`,
      )

      expect(await loadDocsPages(navFile)).toEqual([{ slug: "routes", label: "Routes" }])
    } finally {
      rmSync(fixtureRoot, { recursive: true })
    }
  })

  it("rejects modules without the named exhaustive export", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dawn-docs-pages-"))
    const navFile = join(fixtureRoot, "nav.ts")
    try {
      writeFileSync(
        navFile,
        'export const DOCS_NAV = [{ items: [{ label: "Routes", href: "/docs/routes" }] }]\n',
      )
      await expect(loadDocsPages(navFile)).rejects.toThrow(/ALL_DOCS_PAGES/)
    } finally {
      rmSync(fixtureRoot, { recursive: true })
    }
  })
})

describe("parseDocsPages()", () => {
  it("returns ordered nested slug/label pairs", () => {
    expect(
      parseDocsPages([
        { label: "Getting Started", href: "/docs/getting-started" },
        { label: "Tools", href: "/docs/tools" },
        { label: "Long-term Memory", href: "/docs/memory/long-term" },
        { label: "Add a tool", href: "/docs/recipes/add-a-tool" },
      ]),
    ).toEqual([
      { slug: "getting-started", label: "Getting Started" },
      { slug: "tools", label: "Tools" },
      { slug: "memory/long-term", label: "Long-term Memory" },
      { slug: "recipes/add-a-tool", label: "Add a tool" },
    ])
  })

  it("rejects duplicate slugs instead of silently changing the registry", () => {
    expect(() =>
      parseDocsPages([
        { label: "Tools", href: "/docs/tools" },
        { label: "Tools again", href: "/docs/tools" },
      ]),
    ).toThrow(/duplicate.*tools/i)
  })

  it.each([
    ["non-array", null],
    ["non-object item", ["routes"]],
    ["missing label", [{ href: "/docs/routes" }]],
    ["empty label", [{ label: "", href: "/docs/routes" }]],
    ["whitespace label", [{ label: " Routes ", href: "/docs/routes" }]],
    ["multiline label", [{ label: "Routes\nInjected", href: "/docs/routes" }]],
    ["missing href", [{ label: "Routes" }]],
    ["docs root", [{ label: "Docs", href: "/docs/" }]],
    ["fragment", [{ label: "Routes", href: "/docs/routes#agent" }]],
    ["query", [{ label: "Routes", href: ["/docs/routes", "mode=all"].join("?") }]],
    ["outside docs", [{ label: "Routes", href: "/routes" }]],
    ["traversal", [{ label: "Routes", href: ["/docs", "..", "routes"].join("/") }]],
    ["backslash", [{ label: "Routes", href: ["/docs/api", "routes"].join("\\") }]],
    ["double separator", [{ label: "Routes", href: ["/docs/api", "routes"].join("//") }]],
  ])("rejects malformed exhaustive pages: %s", (_name, value) => {
    expect(() => parseDocsPages(value)).toThrow()
  })
})

describe("generated documentation bundle", () => {
  it("contains exactly one topic file per real nav entry in registry order", () => {
    const readme = readFileSync(join(repoRoot, "packages/cli/docs/README.md"), "utf8")
    const topics = [...readme.matchAll(/^- \[([^\]]+)\]\(\.\/([^)]+)\)/gm)].flatMap((match) =>
      match[1] && match[2] ? [{ title: match[1], file: match[2] }] : [],
    )
    const expectedFiles = EXPECTED_DOCS.map((entry) =>
      entry.slug === "recipes" ? "recipes/index.md" : `${entry.slug}.md`,
    )
    const actualFiles = readdirSync(join(repoRoot, "packages/cli/docs"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
      .map((entry) =>
        relative(join(repoRoot, "packages/cli/docs"), join(entry.parentPath, entry.name)),
      )
      .sort()

    expect(actualFiles).toEqual([...expectedFiles].sort())

    expect(topics).toEqual(
      EXPECTED_DOCS.map((entry, index) => ({
        title: entry.label,
        file: expectedFiles[index] ?? "",
      })),
    )
    expect(topics).toContainEqual({
      title: "Recipes Overview",
      file: "recipes/index.md",
    })
    expect(topics).toHaveLength(EXPECTED_DOCS.length)
    expect(topics).toHaveLength(75)
    expect(topics).toContainEqual({ title: "Thread Access", file: "thread-access.md" })
    expect(topics.slice(apiHubIndex, apiHubIndex + 17).map(({ title }) => title)).toEqual([
      "API Reference",
      "@dawn-ai/sdk",
      "@dawn-ai/cli",
      "@dawn-ai/core",
      "@dawn-ai/ag-ui",
      "@dawn-ai/memory",
      "@dawn-ai/memory-pgvector",
      "@dawn-ai/postgres-storage",
      "@dawn-ai/testing",
      "@dawn-ai/evals",
      "dawn:routes",
      ...FINAL_PR2_API_DOCS.map(([title]) => title),
    ])
    for (const [title, file] of FINAL_PR2_API_DOCS) {
      expect(topics).toContainEqual({ title, file })
    }
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
