import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { type CompileOptions, compile } from "@mdx-js/mdx"
import { describe, expect, it } from "vitest"

import { MDX_REHYPE_PLUGINS, MDX_REMARK_PLUGINS } from "../../../lib/mdx-plugins"
import { DOCS_INDEX } from "./search-index"

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../content/docs")

/**
 * `/docs/deployment` -> `deployment.mdx`, `/docs/recipes` -> `recipes/index.mdx`
 * — the same `<slug>.mdx`-then-`<slug>/index.mdx` lookup the site itself uses.
 */
function hrefToFile(href: string, known: ReadonlyMap<string, unknown>): string {
  const slug = href.replace(/^\/docs\/?/, "")
  if (slug === "") return "index.mdx"
  return known.has(`${slug}.mdx`) ? `${slug}.mdx` : join(slug, "index.mdx")
}

function docFiles(dir: string = DOCS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return docFiles(full)
    return entry.name.endsWith(".mdx") ? [relative(DOCS_DIR, full)] : []
  })
}

interface HastNode {
  readonly type: string
  readonly tagName?: string
  readonly properties?: Record<string, unknown>
  readonly children?: readonly HastNode[]
}

interface PageAnchors {
  /** Heading ids the built page will actually carry. */
  readonly ids: ReadonlySet<string>
  /** In-page and cross-page `#fragment` links found in rendered anchors. */
  readonly links: readonly string[]
}

function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

type PluginList = NonNullable<CompileOptions["rehypePlugins"]>

/** Turns the config's `[name, options]` pairs into loaded unified plugins. */
async function resolvePlugins(specs: readonly (readonly [string, unknown])[]): Promise<PluginList> {
  return await Promise.all(
    specs.map(async ([name, options]) => {
      const mod = (await import(name)) as { default: unknown }
      // Plugin identity is only known at runtime here, as it is in next.config.
      return [mod.default, options] as unknown as PluginList[number]
    }),
  )
}

/**
 * Compiles a doc through the shipped MDX pipeline and reports the heading ids it
 * emits plus every fragment link it renders. Reading ids off the real pipeline
 * is the point: a slug plugin dropped from `lib/mdx-plugins.ts` fails this test.
 */
async function analyze(file: string): Promise<PageAnchors> {
  const ids = new Set<string>()
  const links: string[] = []

  const collect = () => (tree: HastNode) => {
    walk(tree, (node) => {
      if (node.type !== "element") return
      if (typeof node.tagName === "string" && /^h[1-6]$/.test(node.tagName)) {
        const id = node.properties?.id
        if (typeof id === "string" && id !== "") ids.add(id)
      }
      if (node.tagName === "a") {
        const href = node.properties?.href
        if (typeof href === "string" && href.includes("#")) links.push(href)
      }
    })
  }

  await compile(readFileSync(join(DOCS_DIR, file), "utf8"), {
    remarkPlugins: await resolvePlugins(MDX_REMARK_PLUGINS),
    // The syntax highlighter is skipped: it is slow and cannot affect heading ids.
    rehypePlugins: [
      ...(await resolvePlugins(
        MDX_REHYPE_PLUGINS.filter(([name]) => name !== "rehype-pretty-code"),
      )),
      collect,
    ],
  })

  return { ids, links }
}

const files = docFiles()
const pages = new Map<string, PageAnchors>(
  await Promise.all(files.map(async (file) => [file, await analyze(file)] as const)),
)

describe("docs in-page anchors", () => {
  it("finds docs to check", () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it("gives every heading an id, at every level", () => {
    // `####` headings exist in the docs and are linked to; ids come from the
    // build, not from the client-side TOC, which only ever walks `h2, h3`.
    const withoutIds = files.filter((file) => pages.get(file)?.ids.size === 0)
    expect(withoutIds).toEqual([])

    const deployment = pages.get("deployment.mdx")
    expect(deployment?.ids).toContain("what-the-edge-cannot-serve")
    expect(deployment?.ids).toContain("why-the-stores-are-per-request")
  })

  it("resolves every fragment link to a heading that exists", () => {
    const broken: string[] = []

    for (const [file, page] of pages) {
      for (const href of page.links) {
        const [path, fragment] = href.split("#")
        if (fragment === undefined || fragment === "") continue

        // Only fragments into the docs site are checkable here.
        const target =
          path === "" ? file : path?.startsWith("/docs") ? hrefToFile(path, pages) : undefined
        if (target === undefined) continue

        const targetPage = pages.get(target)
        if (!targetPage) {
          broken.push(`${file}: ${href} -> no such page`)
          continue
        }
        if (!targetPage.ids.has(fragment)) broken.push(`${file}: ${href} -> no such heading`)
      }
    }

    expect(broken).toEqual([])
  })

  it("emits search-result anchors that match the built heading ids", () => {
    // Search results deep-link into a page, so the index has to slug headings
    // exactly the way the MDX pipeline does.
    const broken: string[] = []

    for (const entry of DOCS_INDEX) {
      const page = pages.get(hrefToFile(entry.href, pages))
      if (!page) {
        broken.push(`${entry.href} -> no such page`)
        continue
      }
      for (const heading of entry.headings) {
        if (!page.ids.has(heading.anchor)) {
          broken.push(`${entry.href}#${heading.anchor} (${heading.text}) -> no such heading`)
        }
      }
    }

    expect(broken).toEqual([])
  })
})
