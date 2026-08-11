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
  /** Links found in rendered anchors. */
  readonly links: readonly string[]
}

function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function maskText(value: string): string {
  return value.replace(/[^\r\n]/g, " ")
}

function maskFencedCode(source: string): string {
  let fence: { readonly character: string; readonly length: number } | null = null
  return source
    .split(/(?<=\n)/)
    .map((line) => {
      const content = line.replace(/\r?\n$/, "")
      if (fence) {
        const activeFence = fence
        const closingRun = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(content)?.[1]
        const closesFence =
          closingRun !== undefined &&
          closingRun.length >= activeFence.length &&
          [...closingRun].every((character) => character === activeFence.character)
        if (closesFence) fence = null
        return maskText(line)
      }

      const opening = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(content)?.[1]
      if (!opening) return line
      fence = { character: opening[0] ?? "", length: opening.length }
      return maskText(line)
    })
    .join("")
}

function maskRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index++) {
    if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " "
  }
}

function inlineCodeEnd(source: string, start: number, delimiterLength: number): number {
  let index = start + delimiterLength
  while (index < source.length && source[index] !== "\r" && source[index] !== "\n") {
    if (source[index] !== "`") {
      index++
      continue
    }
    let runEnd = index
    while (source[runEnd] === "`") runEnd++
    if (runEnd - index === delimiterLength) return runEnd
    index = runEnd
  }
  return -1
}

function maskInlineCodeAndComments(source: string): string {
  const characters = source.split("")
  let index = 0
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const closing = source.indexOf("-->", index + 4)
      const end = closing === -1 ? source.length : closing + 3
      maskRange(characters, index, end)
      index = end
      continue
    }
    if (source.startsWith("{/*", index)) {
      const closing = source.indexOf("*/}", index + 3)
      const end = closing === -1 ? source.length : closing + 3
      maskRange(characters, index, end)
      index = end
      continue
    }
    if (source[index] === "`") {
      let runEnd = index
      while (source[runEnd] === "`") runEnd++
      const end = inlineCodeEnd(source, index, runEnd - index)
      if (end !== -1) {
        maskRange(characters, index, end)
        index = end
        continue
      }
      index = runEnd
      continue
    }
    index++
  }
  return characters.join("")
}

function maskMdxCodeAndComments(source: string): string {
  return maskInlineCodeAndComments(maskFencedCode(source))
}

function collectMdxNavigationHrefs(source: string): string[] {
  const masked = maskMdxCodeAndComments(source)
  return [...masked.matchAll(/<RelatedCards\b[\s\S]*?(?:\/>|<\/RelatedCards\s*>)/g)].flatMap(
    (component) =>
      [...component[0].matchAll(/\bhref\s*(?::|=)\s*["']([^"']+)["']/g)].flatMap((href) =>
        href[1] ? [href[1]] : [],
      ),
  )
}

function isDocsPath(path: string): boolean {
  return path === "/docs" || path.startsWith("/docs/")
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
  const links = new Set<string>()
  const source = readFileSync(join(DOCS_DIR, file), "utf8")

  // MDX JSX such as RelatedCards is not rendered by compile(), so collect its
  // literal docs hrefs from source in addition to the Markdown anchors below.
  for (const href of collectMdxNavigationHrefs(source)) links.add(href)

  const collect = () => (tree: HastNode) => {
    walk(tree, (node) => {
      if (node.type !== "element") return
      if (typeof node.tagName === "string" && /^h[1-6]$/.test(node.tagName)) {
        const id = node.properties?.id
        if (typeof id === "string" && id !== "") ids.add(id)
      }
      if (node.tagName === "a") {
        const href = node.properties?.href
        if (typeof href === "string") links.add(href)
      }
    })
  }

  await compile(source, {
    remarkPlugins: await resolvePlugins(MDX_REMARK_PLUGINS),
    // The syntax highlighter is skipped: it is slow and cannot affect heading ids.
    rehypePlugins: [
      ...(await resolvePlugins(
        MDX_REHYPE_PLUGINS.filter(([name]) => name !== "rehype-pretty-code"),
      )),
      collect,
    ],
  })

  return { ids, links: [...links] }
}

const files = docFiles()
const pages = new Map<string, PageAnchors>(
  await Promise.all(files.map(async (file) => [file, await analyze(file)] as const)),
)

describe("docs links and in-page anchors", () => {
  it("collects real RelatedCards hrefs but ignores code and comments", () => {
    const docsRoot = "/docs"
    const source = `
[Rendered Markdown](${docsRoot}/rendered-by-hast)
<RelatedCards items={[{ href: "${docsRoot}/real-jsx" }]} />
\`{ href: "${docsRoot}/inline-code" }\`
<!-- <RelatedCards items={[{ href: "${docsRoot}/html-comment" }]} /> -->
{/* <RelatedCards items={[{ href: "${docsRoot}/mdx-comment" }]} /> */}
\`\`\`md
[Fenced Markdown](${docsRoot}/fenced-markdown)
<RelatedCards items={[{ href: "${docsRoot}/fenced-jsx" }]} />
\`\`\`
`

    expect(collectMdxNavigationHrefs(source)).toEqual(["/docs/real-jsx"])
  })

  it("keeps RelatedCards after an inline-code HTML comment marker visible", () => {
    const docsRoot = "/docs"
    const source = `
\`<!--\`
<RelatedCards items={[{ href: "${docsRoot}/still-visible" }]} />
`

    expect(collectMdxNavigationHrefs(source)).toEqual(["/docs/still-visible"])
  })

  it("recognizes only the docs root and slash-delimited docs routes", () => {
    expect(isDocsPath("/docs")).toBe(true)
    expect(isDocsPath("/docs/agents")).toBe(true)
    expect(isDocsPath("/docs-old")).toBe(false)
    expect(isDocsPath("/docstore")).toBe(false)
  })

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
    expect(deployment?.ids).toContain("what-is-proven-and-what-is-not")

    const edge = pages.get("deployment/edge.mdx")
    expect(edge?.ids).toContain("what-the-edge-cannot-serve")
    expect(edge?.ids).toContain("why-the-stores-are-per-request")
    expect(edge?.ids).toContain("what-is-proven-and-what-is-not")

    const agentProtocolAnchors = [
      "agent-protocol-endpoints",
      "thread-lifecycle-with-curl",
      "one-run-at-a-time-per-thread",
      "client-disconnect",
    ]
    const devServer = pages.get("dev-server.mdx")
    const agentProtocol = pages.get("dev-server/agent-protocol.mdx")
    for (const anchor of agentProtocolAnchors) {
      expect(devServer?.ids).toContain(anchor)
      expect(agentProtocol?.ids).toContain(anchor)
    }

    const agentHarness = pages.get("testing-agents.mdx")
    const fixtureGuide = pages.get("testing-agents/fixtures.mdx")
    for (const anchor of [
      "fixture-files-author-commit-replay",
      "author-inline-and-snapshot-to-a-file",
      "record-from-a-real-model-local-only",
      "replay-a-fixture-file-in-tests",
      "live-mode-real-model",
    ]) {
      expect(agentHarness?.ids).toContain(anchor)
      expect(fixtureGuide?.ids).toContain(anchor)
    }

    const memory = pages.get("memory.mdx")
    const longTerm = pages.get("memory/long-term.mdx")
    const retrieval = pages.get("memory/retrieval.mdx")
    const episodes = pages.get("memory/episodes.mdx")
    const distillation = pages.get("memory/distillation.mdx")

    for (const anchor of [
      "how-recall-ranks",
      "semantic-recall-opt-in",
      "postgres-backend-pgvector",
    ]) {
      expect(memory?.ids).toContain(anchor)
      expect(retrieval?.ids).toContain(anchor)
    }
    expect(memory?.ids).toContain("episodic-memory")
    expect(episodes?.ids).toContain("episodic-memory")
    expect(memory?.ids).toContain("distillation")
    expect(distillation?.ids).toContain("distillation")
    for (const anchor of ["write-governance", "reviewing-candidates", "configuration", "testing"]) {
      expect(memory?.ids).toContain(anchor)
      expect(longTerm?.ids).toContain(anchor)
    }

    const configuration = pages.get("configuration.mdx")
    for (const anchor of [
      "backends",
      "permissions",
      "permissionsstore",
      "memory",
      "build",
      "sandbox",
      "postgres-backend",
    ]) {
      expect(configuration?.ids).toContain(anchor)
    }
  })

  it("resolves every repository-owned docs link and supplied fragment", () => {
    const broken: string[] = []

    for (const [file, page] of pages) {
      for (const href of page.links) {
        const [path, fragment] = href.split("#")

        // External URLs and historical blog links are outside the authored docs topology.
        const target =
          path === "" ? file : path && isDocsPath(path) ? hrefToFile(path, pages) : undefined
        if (target === undefined) continue

        const targetPage = pages.get(target)
        if (!targetPage) {
          broken.push(`${file}: ${href} -> no such page`)
          continue
        }
        if (fragment && !targetPage.ids.has(fragment)) {
          broken.push(`${file}: ${href} -> no such heading`)
        }
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
