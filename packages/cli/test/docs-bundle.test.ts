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
  mdxToMarkdown,
  parseFrontmatter,
  parseNav,
  parseNavOrder,
} from "../src/lib/docs-bundle.js"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
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
    const removed = [
      "createAgUiTranslator",
      "mapRunInput",
      'CUSTOM{name:"on_interrupt"}',
      "forwardedProps.command.resume",
      "STATE_SNAPSHOT",
      "dawn.subagent",
      "useInterrupt",
      "PermissionInterrupt",
      "TodosPanel",
    ]
    const roots = [
      "packages/ag-ui/README.md",
      "packages/cli/docs",
      "apps/web/content/docs",
      "examples/chat",
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
  it("returns doc slugs in source order without duplicates", () => {
    const nav = `
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Routes", href: "/docs/routes" },
      { label: "Routes again", href: "/docs/routes" },
    `
    expect(parseNavOrder(nav)).toEqual(["getting-started", "routes"])
  })
})

describe("parseNav()", () => {
  it("returns ordered slug/label pairs, deduped by slug", () => {
    const nav = `
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Tools", href: "/docs/tools" },
      { label: "Tools again", href: "/docs/tools" },
    `
    expect(parseNav(nav)).toEqual([
      { slug: "getting-started", label: "Getting Started" },
      { slug: "tools", label: "Tools" },
    ])
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
      { slug: "tools", title: "Tools", description: "Co-located tools", file: "tools.md" },
      { slug: "state", title: "State", description: "", file: "state.md" },
    ])
    expect(md).toContain("# Dawn — Documentation")
    expect(md).toContain("dawn docs <topic>")
    expect(md).toContain("- [Tools](./tools.md) — Co-located tools")
    expect(md).toContain("- [State](./state.md)")
    expect(md).not.toContain("State](./state.md) —")
  })
})
