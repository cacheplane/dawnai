import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { type CompileOptions, compile } from "@mdx-js/mdx"
import GithubSlugger from "github-slugger"
import { describe, expect, it } from "vitest"

import { MDX_REHYPE_PLUGINS, MDX_REMARK_PLUGINS } from "../../../lib/mdx-plugins"
import { DOCS_INDEX } from "./search-index"

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../content/docs")
const REPO_ROOT = join(DOCS_DIR, "../../../..")

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
  /** Heading ids in emitted document order, including any accidental duplicate. */
  readonly orderedIds: readonly string[]
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

      const openingMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      const opening = openingMatch?.[1]
      if (!opening || (opening[0] === "`" && openingMatch?.[2]?.includes("`"))) return line
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

function maintainedReadmes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "docs", "node_modules"].includes(entry.name)) return []
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return maintainedReadmes(full)
    return entry.isFile() && entry.name === "README.md" ? [full] : []
  })
}

interface MarkdownDestinationOccurrence {
  readonly index: number
  readonly destination: string
}

function markdownDestinationOccurrences(source: string): MarkdownDestinationOccurrence[] {
  const masked = maskMdxCodeAndComments(source)
  const occurrences: MarkdownDestinationOccurrence[] = []
  for (const match of masked.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g)) {
    if (match[1] && match.index !== undefined) {
      occurrences.push({ index: match.index, destination: match[1] })
    }
  }
  const references = [...masked.matchAll(/^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*<?([^\s>]+)>?/gm)]
  for (const match of references) {
    if (match[1] && match.index !== undefined) {
      occurrences.push({ index: match.index, destination: match[1] })
    }
  }
  for (const match of masked.matchAll(/\bhref\s*(?::|=)\s*["']([^"']+)["']/g)) {
    if (match[1] && match.index !== undefined) {
      occurrences.push({ index: match.index, destination: match[1] })
    }
  }
  return occurrences.sort((left, right) => left.index - right.index)
}

function markdownDestinations(source: string): string[] {
  return markdownDestinationOccurrences(source).map(({ destination }) => destination)
}

interface MarkdownHeading {
  readonly id: string
  readonly index: number
  readonly level: number
  readonly text: string
}

function markdownHeadings(source: string): MarkdownHeading[] {
  const masked = maskMdxCodeAndComments(source)
  const slugger = new GithubSlugger()
  return [...masked.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)].flatMap((match) => {
    if (match.index === undefined || !match[1]) return []
    const lineEnd = source.indexOf("\n", match.index)
    const originalLine = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd)
    const text = originalLine
      .replace(/^#{1,6}[ \t]+/, "")
      .replace(/[ \t]+#+[ \t]*$/, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim()
    return [{ id: slugger.slug(text), index: match.index, level: match[1].length, text }]
  })
}

function sectionRange(
  source: string,
  predicate: (heading: MarkdownHeading) => boolean,
): { readonly start: number; readonly end: number } | undefined {
  const headings = markdownHeadings(source)
  const headingIndex = headings.findIndex(predicate)
  const heading = headings[headingIndex]
  if (!heading) return undefined
  const nextHeading = headings.slice(headingIndex + 1).find((entry) => entry.level <= heading.level)
  return { start: heading.index, end: nextHeading?.index ?? source.length }
}

function sectionDestinations(source: string, retainedHeading: string): string[] {
  const range = sectionRange(source, (heading) => heading.text === retainedHeading)
  return range ? markdownDestinations(source.slice(range.start, range.end)) : []
}

function normalizeDocsDestination(destination: string): string | undefined {
  if (isDocsPath(destination.split("#")[0] ?? "")) return destination
  try {
    const url = new URL(destination)
    if (url.protocol === "https:" && url.hostname === "dawnai.org" && isDocsPath(url.pathname)) {
      return `${url.pathname}${url.hash}`
    }
  } catch {
    // Relative non-doc links are outside the documentation topology.
  }
  return undefined
}

function docsDestinationError(destination: string): string | undefined {
  const normalized = normalizeDocsDestination(destination)
  if (!normalized) return undefined
  const [path, fragment] = normalized.split("#")
  const target = path ? hrefToFile(path, pages) : undefined
  const targetPage = target ? pages.get(target) : undefined
  if (!targetPage) return `${normalized} -> no such page`
  if (fragment && !targetPage.ids.has(fragment)) return `${normalized} -> no such heading`
  return undefined
}

interface CanonicalOwnerContract {
  readonly heading: string
  readonly required: readonly string[]
}

function canonicalOwnerViolations(
  source: string,
  { heading, required }: CanonicalOwnerContract,
): string[] {
  const destinations = sectionDestinations(source, heading).flatMap((destination) => {
    const normalized = normalizeDocsDestination(destination)
    return normalized ? [normalized] : []
  })
  return required.filter((href) => !destinations.includes(href)).map((href) => `missing ${href}`)
}

function movedLinkViolations(
  file: string,
  source: string,
  contracts: readonly CompatibilityAnchor[],
): string[] {
  const contractsByHref = new Map(contracts.map((contract) => [contract.legacyHref, contract]))
  return markdownDestinationOccurrences(source).flatMap(({ index, destination }) => {
    const normalized = normalizeDocsDestination(destination)
    const contract = normalized ? contractsByHref.get(normalized) : undefined
    if (!contract) return []
    const fragment = contract.legacyHref.split("#")[1]
    const compatibilityRange = fragment
      ? sectionRange(source, (heading) => heading.id === fragment)
      : undefined
    if (
      file === contract.legacyFile &&
      compatibilityRange &&
      index >= compatibilityRange.start &&
      index < compatibilityRange.end
    ) {
      return []
    }
    return [`${file}: ${contract.legacyHref} -> ${contract.canonicalHref}`]
  })
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
  const orderedIds: string[] = []
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
        if (typeof id === "string" && id !== "") {
          ids.add(id)
          orderedIds.push(id)
        }
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

  return { ids, orderedIds, links: [...links] }
}

const files = docFiles()
const pages = new Map<string, PageAnchors>(
  await Promise.all(files.map(async (file) => [file, await analyze(file)] as const)),
)

// Public fragment compatibility for the unsplit API reference. This exact
// ordered inventory freezes every id before the reference is split into
// package pages; additions, removals, renames, and reorders are breaking.
const FROZEN_API_HEADING_IDS = [
  "api-reference",
  "package-and-surface-index",
  "reference-conventions",
  "dawn-aisdk",
  "agent",
  "agentconfig",
  "agentconfig-1",
  "reasoningconfig",
  "retryconfig",
  "dawnagent",
  "subagent-delegation-types",
  "isdawnagentvalue",
  "middleware",
  "definemiddlewarefn",
  "allowcontext",
  "rejectstatus-body",
  "dawnmiddleware",
  "middlewarerequest",
  "middlewareresult",
  "continueresult",
  "rejectresult",
  "memory",
  "definememorydef",
  "definedmemory",
  "memoryscopedimension",
  "route-configuration",
  "routeconfig",
  "routekind",
  "route-types",
  "routestatemap",
  "routetoolmap",
  "runtime",
  "runtimecontexttools",
  "runtimetool",
  "toolregistry",
  "dawntoolcontext",
  "workspacefs",
  "models",
  "knownmodelid",
  "modelproviderid",
  "openaimodelid",
  "googlemodelid",
  "anthropicmodelid",
  "xaimodelid",
  "inferprovidermodel",
  "supported_agent_providers",
  "validatemodelidopts",
  "modelidvalidation",
  "model-id-constants",
  "backend-adapter",
  "backendadapter",
  "utilities",
  "prettifyt",
  "dawn-aicli",
  "serveruntimeoptions",
  "loadstaticmodulesmanifesturl",
  "dawnstaticmodules-and-staticroutemodule",
  "dawn-aiclifetch",
  "dawn-aicliruntime",
  "dawn-aicore",
  "capability-exports",
  "createcapabilityregistrymarkers-and-applycapabilities",
  "gatetoolop-and-wraptoolwithapproval",
  "createworkspacefsoptions",
  "loaddawnconfigoptions-and-configvalue",
  "discoverroutesoptions-finddawnappoptions-and-route-segments",
  "state-and-typegen-helpers",
  "tool-scope",
  "storage-type-re-export",
  "dawn-aiag-ui",
  "id-factories",
  "toaguieventschunks-context",
  "fromrunagentinputinput",
  "sse-subpath-encodeaguisseevent-accept",
  "dawn-aimemory",
  "memorystore",
  "memoryrecord",
  "memoryquery",
  "browsequery-browsepage-and-memorystats",
  "dawn-aimemorybrowse",
  "dawn-aimemory-pgvector",
  "pgvectormemorystoreoptions",
  "pgvectormemorystore",
  "vectorcolumndefdimensions",
  "initschemaclient-options",
  "assertidentifiername-value",
  "dawn-aipostgres-storage",
  "postgresstoreoptions",
  "dawn-aipostgres-storagenode",
  "postgrescheckpointeroptions",
  "createpostgresthreadsstoreoptions",
  "createpostgrespermissionsstoreoptions",
  "assertidentifiername-value-1",
  "default_schema--default_table_prefix",
  "dawn-aitesting",
  "harnesses",
  "aimock-fixtures-and-recording",
  "matchers",
  "run-result-utilities",
  "memory-protocol-and-subprocess-helpers",
  "example",
  "dawn-aievals",
  "eval-definition-and-execution",
  "scores-and-gates",
  "built-in-scorers",
  "memory-scorers",
  "example-1",
  "dawnroutes-generated",
  "routetoolsp",
  "routestatep",
  "where-to-read-more",
  "related",
] as const

interface CompatibilityAnchor {
  readonly legacyFile: string
  readonly legacyHref: string
  readonly canonicalHref: string
}

function compatibilityAnchors(
  legacyFile: string,
  legacyPath: string,
  canonicalHref: string,
  fragments: readonly string[],
): CompatibilityAnchor[] {
  return fragments.map((fragment) => ({
    legacyFile,
    legacyHref: `${legacyPath}#${fragment}`,
    canonicalHref,
  }))
}

const COMPATIBILITY_ANCHOR_MAP = [
  ...compatibilityAnchors("memory.mdx", "/docs/memory", "/docs/memory/long-term", [
    "long-term-collection-memoryts",
    "generated-tools",
    "write-governance",
    "ask-mode",
    "reviewing-candidates",
    "configuration",
    "testing",
    "verifying-against-a-real-model",
    "whats-deferred",
  ]),
  ...compatibilityAnchors("memory.mdx", "/docs/memory", "/docs/memory/retrieval", [
    "how-recall-ranks",
    "semantic-recall-opt-in",
    "postgres-backend-pgvector",
    "the-injected-index",
  ]),
  ...compatibilityAnchors("memory.mdx", "/docs/memory", "/docs/memory/episodes", [
    "episodic-memory",
    "enabling-the-run-recorder",
    "what-gets-recorded",
    "retention",
    "time-windowed-recall",
    "governance",
    "agent-authored-episodes",
  ]),
  ...compatibilityAnchors("memory.mdx", "/docs/memory", "/docs/memory/distillation", [
    "distillation",
    "consolidation",
    "reflection",
    "distilled-records-are-found-by-keyword",
    "provenance",
    "cost",
    "running-it-on-a-schedule",
    "distillation-configuration",
  ]),
  ...compatibilityAnchors("deployment.mdx", "/docs/deployment", "/docs/deployment/node", [
    "deploying-to-production-nodedocker",
  ]),
  ...compatibilityAnchors("deployment.mdx", "/docs/deployment", "/docs/deployment/kubernetes", [
    "deploying-on-kubernetes",
  ]),
  ...compatibilityAnchors("deployment.mdx", "/docs/deployment", "/docs/deployment/langsmith", [
    "the-langsmith--langgraph-platform-path",
  ]),
  ...compatibilityAnchors("deployment.mdx", "/docs/deployment", "/docs/deployment/edge", [
    "edge-runtimes",
    "the-dawn-aiclifetch-entry-point",
    "the-hono-build-target",
    "why-the-stores-are-per-request",
    "what-the-edge-cannot-serve",
    "what-is-proven-and-what-is-not",
  ]),
  ...compatibilityAnchors("deployment.mdx", "/docs/deployment", "/docs/deployment", [
    "what-dawn-does-not-do",
    "troubleshooting",
    "related",
  ]),
  ...compatibilityAnchors("deployment.mdx", "/docs/deployment", "/docs/deployment/node", [
    "self-hosting",
  ]),
  ...compatibilityAnchors("sandbox.mdx", "/docs/sandbox", "/docs/sandbox/kubernetes", [
    "kubernetes-provider",
    "security-hardening-on-kubernetes",
    "network-policy-on-kubernetes",
    "deploying-the-sandbox-infrastructure-helm",
    "key-caveats",
    "deploying-a-dawn-app-helm",
    "serviceaccount-and-namespace-wiring",
    "env-secrets-and-replicas",
  ]),
  ...compatibilityAnchors("dev-server.mdx", "/docs/dev-server", "/docs/dev-server/agent-protocol", [
    "agent-protocol-endpoints",
    "sse-event-types",
    "thread-lifecycle-with-curl",
    "one-run-at-a-time-per-thread",
    "client-disconnect",
  ]),
  ...compatibilityAnchors("dev-server.mdx", "/docs/dev-server", "/docs/ag-ui", ["ag-ui-endpoint"]),
  ...compatibilityAnchors("dev-server.mdx", "/docs/dev-server", "/docs/observability", ["tracing"]),
  ...compatibilityAnchors("dev-server.mdx", "/docs/dev-server", "/docs/middleware", ["middleware"]),
  ...compatibilityAnchors("memory.mdx", "/docs/memory", "/docs/workspace", ["updating-it"]),
  ...compatibilityAnchors(
    "testing-agents.mdx",
    "/docs/testing-agents",
    "/docs/testing-agents/fixtures",
    [
      "fixture-files-author-commit-replay",
      "author-inline-and-snapshot-to-a-file",
      "record-from-a-real-model-local-only",
      "replay-a-fixture-file-in-tests",
      "live-mode-real-model",
    ],
  ),
] as const

function isOrderedSubsequence(expected: readonly string[], actual: readonly string[]): boolean {
  let actualIndex = 0
  for (const id of expected) {
    actualIndex = actual.indexOf(id, actualIndex)
    if (actualIndex === -1) return false
    actualIndex++
  }
  return true
}

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

  it("keeps links and headings visible after an invalid backtick-fence opener", () => {
    const source = `\`\`\`md \`invalid\`
## Visible heading
[Visible link](/docs/routes)
`

    expect(markdownHeadings(source).map(({ text }) => text)).toEqual(["Visible heading"])
    expect(markdownDestinations(source)).toEqual(["/docs/routes"])
  })

  it("allows backticks in tilde-fence info strings and masks their contents", () => {
    const source = `~~~md \`valid\`
## Hidden heading
[Hidden link](/docs/routes)
~~~
`

    expect(markdownHeadings(source)).toEqual([])
    expect(markdownDestinations(source)).toEqual([])
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

    const api = pages.get("api.mdx")
    expect(FROZEN_API_HEADING_IDS).toHaveLength(112)
    expect(new Set(FROZEN_API_HEADING_IDS).size).toBe(112)
    expect(api?.orderedIds).toHaveLength(api?.ids.size ?? -1)
    expect(new Set(api?.orderedIds).size).toBe(api?.orderedIds.length)
    expect(api?.orderedIds).toEqual(FROZEN_API_HEADING_IDS)
    // Mutation probe: a membership-only assertion would miss this reorder.
    expect(
      isOrderedSubsequence(
        [FROZEN_API_HEADING_IDS[1], FROZEN_API_HEADING_IDS[0]],
        api?.orderedIds ?? [],
      ),
    ).toBe(false)
    expect(api?.ids).toContain("dawn-aicli")
    expect(api?.ids).toContain("dawn-aiclifetch")
    expect(api?.ids).toContain("dawn-aimemory")
    expect(api?.ids).toContain("dawn-aimemorybrowse")

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

  it("resolves maintained package and example README docs links and fragments", () => {
    const readmes = [
      ...maintainedReadmes(join(REPO_ROOT, "packages")),
      ...maintainedReadmes(join(REPO_ROOT, "examples")),
    ]
    const broken = readmes.flatMap((file) =>
      markdownDestinations(readFileSync(file, "utf8")).flatMap((destination) => {
        const error = docsDestinationError(destination)
        return error ? [`${relative(REPO_ROOT, file)}: ${error}`] : []
      }),
    )

    expect(broken).toEqual([])
  })

  it("normalizes absolute docs URLs and rejects path and fragment mutations", () => {
    expect(
      normalizeDocsDestination("https://dawnai.org/docs/memory/retrieval#how-recall-ranks"),
    ).toBe("/docs/memory/retrieval#how-recall-ranks")
    expect(docsDestinationError("/docs/memory/retrievall")).toContain("no such page")
    expect(docsDestinationError("/docs/memory/retrieval#how-recall-rankz")).toContain(
      "no such heading",
    )
  })

  it("ignores legacy destinations in code, comments, and plain migration prose", () => {
    const legacyHref = "/docs/memory#how-recall-ranks"
    const source = [
      `The old path was ${legacyHref} before the guide split.`,
      `\`${legacyHref}\``,
      `<!-- [comment](${legacyHref}) -->`,
      `{/* <RelatedCards items={[{ href: "${legacyHref}" }]} /> */}`,
      "```md",
      `[fenced](${legacyHref})`,
      "```",
    ].join("\n")
    const contract = {
      legacyFile: "memory.mdx",
      legacyHref,
      canonicalHref: "/docs/memory/retrieval",
    }

    expect(movedLinkViolations("other.mdx", source, [contract])).toEqual([])
    expect(movedLinkViolations("other.mdx", `[active](${legacyHref})`, [contract])).toEqual([
      `other.mdx: ${legacyHref} -> /docs/memory/retrieval`,
    ])
  })

  it("allows a neutral overview beside the focused owner but rejects overview-only subjects", () => {
    const contract = {
      heading: "Recall",
      required: ["/docs/memory/retrieval"],
      legacyOverview: "/docs/memory",
    }
    expect(
      canonicalOwnerViolations(
        `[Memory overview](/docs/memory)\n\n## Recall\n\n[Recall details](/docs/memory/retrieval)`,
        contract,
      ),
    ).toEqual([])
    expect(
      canonicalOwnerViolations(`## Recall\n\n[Memory overview](/docs/memory)`, contract),
    ).toContain("missing /docs/memory/retrieval")
  })

  it("exempts a legacy self-link only inside its matching compatibility stub", () => {
    const legacyHref = "/docs/memory#how-recall-ranks"
    const contract = {
      legacyFile: "memory.mdx",
      legacyHref,
      canonicalHref: "/docs/memory/retrieval",
    }
    expect(
      movedLinkViolations(
        "memory.mdx",
        `## How recall ranks\n\n[Legacy self-link](${legacyHref})`,
        [contract],
      ),
    ).toEqual([])
    expect(
      movedLinkViolations("memory.mdx", `## Other\n\n[Legacy self-link](${legacyHref})`, [
        contract,
      ]),
    ).toHaveLength(1)
  })

  it("retains every explicit compatibility anchor and its canonical destination", () => {
    const broken: string[] = []

    for (const { legacyFile, legacyHref, canonicalHref } of COMPATIBILITY_ANCHOR_MAP) {
      const fragment = legacyHref.split("#")[1]
      if (!fragment || !pages.get(legacyFile)?.ids.has(fragment)) {
        broken.push(`${legacyHref} -> no such compatibility heading`)
      }
      if (!pages.has(hrefToFile(canonicalHref, pages))) {
        broken.push(`${canonicalHref} -> no such canonical page`)
      }
    }

    expect(broken).toEqual([])
  })

  it("keeps maintained inbound links on each focused canonical owner", () => {
    const docViolations = files.flatMap((file) =>
      movedLinkViolations(
        file,
        readFileSync(join(DOCS_DIR, file), "utf8"),
        COMPATIBILITY_ANCHOR_MAP,
      ),
    )
    const readmeViolations = [
      ...maintainedReadmes(join(REPO_ROOT, "packages")),
      ...maintainedReadmes(join(REPO_ROOT, "examples")),
    ].flatMap((file) =>
      movedLinkViolations(
        relative(REPO_ROOT, file),
        readFileSync(file, "utf8"),
        COMPATIBILITY_ANCHOR_MAP,
      ),
    )

    expect([...docViolations, ...readmeViolations]).toEqual([])
  })

  it("keeps subject-specific references on focused canonical pages", () => {
    const contracts = [
      {
        file: "apps/web/content/docs/agents.mdx",
        heading: "Streaming",
        required: ["/docs/dev-server/agent-protocol"],
      },
      ...[
        "apps/web/content/docs/cli.mdx",
        "apps/web/content/docs/middleware.mdx",
        "apps/web/content/docs/mental-model.mdx",
        "apps/web/content/docs/observability.mdx",
        "apps/web/content/docs/planning.mdx",
        "apps/web/content/docs/recipes/dispatch-from-route.mdx",
        "apps/web/content/docs/recipes/stream-output.mdx",
        "apps/web/content/docs/subagents.mdx",
      ].map((file) => ({
        file,
        heading: "Related",
        required: ["/docs/dev-server/agent-protocol"],
      })),
      {
        file: "apps/web/content/docs/cli.mdx",
        heading: "dawn dev",
        required: ["/docs/dev-server/agent-protocol"],
      },
      {
        file: "apps/web/content/docs/observability.mdx",
        heading: "Live SSE streaming (no account required)",
        required: ["/docs/dev-server/agent-protocol"],
      },
      {
        file: "apps/web/content/docs/routes.mdx",
        heading: "Running a route",
        required: ["/docs/dev-server/agent-protocol"],
      },
      {
        file: "packages/ag-ui/README.md",
        heading: "@dawn-ai/ag-ui",
        required: ["/docs/ag-ui", "/docs/dev-server/agent-protocol"],
      },
      ...["dawn memory", "dawn inspect"].map((heading) => ({
        file: "apps/web/content/docs/cli.mdx",
        heading,
        required: ["/docs/memory/browse"],
      })),
      ...["Inspector", "Related"].map((heading) => ({
        file: "apps/web/content/docs/inspector.mdx",
        heading,
        required: ["/docs/memory/browse"],
      })),
      {
        file: "apps/web/content/docs/configuration.mdx",
        heading: "memory",
        required: [
          "/docs/memory/long-term",
          "/docs/memory/retrieval",
          "/docs/memory/episodes",
          "/docs/memory/distillation",
        ],
      },
      {
        file: "packages/memory-pgvector/README.md",
        heading: "@dawn-ai/memory-pgvector",
        required: ["/docs/memory/retrieval"],
      },
      {
        file: "apps/web/content/docs/permissions.mdx",
        heading: 'Memory write approval (writes: "ask")',
        required: ["/docs/memory/long-term"],
      },
      {
        file: "apps/web/content/docs/recipes/research-web-ui.mdx",
        heading: "Related",
        required: ["/docs/memory/long-term"],
      },
      ...["Execution: replay vs live", "Related"].map((heading) => ({
        file: "apps/web/content/docs/evals.mdx",
        heading,
        required: ["/docs/testing-agents/fixtures"],
      })),
      {
        file: "apps/web/content/docs/testing.mdx",
        heading: "Related",
        required: ["/docs/testing-agents/fixtures"],
      },
      {
        file: "packages/evals/README.md",
        heading: "@dawn-ai/evals",
        required: ["/docs/testing-agents/fixtures"],
      },
      {
        file: "apps/web/content/docs/api.mdx",
        heading: "Memory",
        required: ["/docs/memory/long-term"],
      },
      {
        file: "apps/web/content/docs/api.mdx",
        heading: "@dawn-ai/testing",
        required: ["/docs/testing-agents/fixtures"],
      },
      {
        file: "apps/web/content/docs/access-control.mdx",
        heading: "Execution sandbox — what a call can touch",
        required: ["/docs/sandbox/kubernetes"],
      },
      {
        file: "apps/web/content/docs/recipes/auth-middleware.mdx",
        heading: "Related",
        required: ["/docs/middleware"],
      },
    ]
    const broken = contracts.flatMap(({ file, heading, required }) =>
      canonicalOwnerViolations(readFileSync(join(REPO_ROOT, file), "utf8"), {
        heading,
        required,
      }).map((failure) => `${file} ${heading}: ${failure}`),
    )

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
