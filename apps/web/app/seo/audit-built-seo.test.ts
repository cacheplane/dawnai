import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import {
  assertExactRobots,
  CURRENT_SNAPSHOT_MINIMUM_DISTINCT_LASTMOD_DATES,
  canonicalForPath,
  compareOrderedInventory,
  docSectionOccurrences,
  extractPageMetadata,
  flattenJsonLd,
  lastmodDateDistributionFailure,
  obviousTextRegression,
  parseAuditOptions,
  readPngDimensions,
} from "../../scripts/audit-built-seo.mjs"

const APPROVED_AGENTS = [
  "*",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
] as const

function pageHtml(jsonLd: unknown): string {
  return `<!doctype html>
    <html><head>
      <meta name="description" content="Route description">
      <meta property="og:description" content="Route description">
      <meta name="twitter:description" content="Route description">
      <meta property="og:image" content="https://dawnai.org/opengraph-image?abc">
      <link rel="canonical" href="https://dawnai.org/docs/tools">
    </head><body><main>Visible route content</main>
      <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    </body></html>`
}

function exactRobots(): string {
  return `${APPROVED_AGENTS.map((agent) => `User-Agent: ${agent}\nAllow: /\nDisallow: /api/`).join(
    "\n\n",
  )}

Host: https://dawnai.org
Sitemap: https://dawnai.org/sitemap.xml
`
}

describe("built SEO audit parsing", () => {
  it("extracts metadata and flattens JSON-LD graph entities", () => {
    const parsed = extractPageMetadata(
      pageHtml({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Dawn AI" },
          { "@type": "WebSite", publisher: { "@id": "https://dawnai.org/#organization" } },
        ],
      }),
    )

    expect(parsed.description).toBe("Route description")
    expect(parsed.openGraphDescription).toBe("Route description")
    expect(parsed.twitterDescription).toBe("Route description")
    expect(parsed.canonical).toBe("https://dawnai.org/docs/tools")
    expect(parsed.openGraphImages).toEqual(["https://dawnai.org/opengraph-image?abc"])
    expect(parsed.visibleText).toContain("Visible route content")
    expect(parsed.jsonLdEntities.map((entity: Record<string, unknown>) => entity["@type"])).toEqual(
      ["Organization", "WebSite"],
    )
    expect(
      flattenJsonLd([
        { "@type": "TechArticle" },
        { "@graph": [{ "@type": "BreadcrumbList" }] },
      ]).map((entity: Record<string, unknown>) => entity["@type"]),
    ).toEqual(["TechArticle", "BreadcrumbList"])
  })

  it("fails closed on duplicate and malformed metadata", () => {
    const duplicateDescription = pageHtml({ "@type": "TechArticle" }).replace(
      '<meta name="description" content="Route description">',
      '<meta name="description" content="First"><meta name="description" content="Second">',
    )
    const duplicateCanonical = pageHtml({ "@type": "TechArticle" }).replace(
      '<link rel="canonical" href="https://dawnai.org/docs/tools">',
      '<link rel="canonical" href="https://dawnai.org/docs/tools"><link rel="canonical" href="https://dawnai.org/docs/tools">',
    )
    const malformedJsonLd = pageHtml({ "@type": "TechArticle" }).replace(
      '{"@type":"TechArticle"}',
      '{"@type":',
    )

    expect(() => extractPageMetadata(duplicateDescription)).toThrow(
      "expected exactly one nonempty meta description; found 2",
    )
    expect(() => extractPageMetadata(duplicateCanonical)).toThrow(
      "expected exactly one self-canonical candidate; found 2",
    )
    expect(() => extractPageMetadata(malformedJsonLd)).toThrow("malformed JSON-LD script 1")
  })

  it("requires the exact wildcard and ten approved robots groups", () => {
    expect(assertExactRobots(exactRobots())).toEqual({
      groups: 11,
      agents: [...APPROVED_AGENTS],
      host: "https://dawnai.org",
      sitemap: "https://dawnai.org/sitemap.xml",
    })

    expect(() =>
      assertExactRobots(exactRobots().replace("User-Agent: CCBot\n", "User-Agent: GPTBot\n")),
    ).toThrow("robots user-agent groups do not exactly match the approved order")
    expect(() =>
      assertExactRobots(exactRobots().replace("Disallow: /api/", "Disallow: /")),
    ).toThrow("robots group * must contain exactly Allow: / and Disallow: /api/")
    expect(() =>
      assertExactRobots(
        exactRobots().replace(
          "Sitemap: https://dawnai.org/sitemap.xml",
          "Sitemap: https://dawnai.org/sitemap_index.xml",
        ),
      ),
    ).toThrow("robots must not reference sitemap_index")
  })

  it("validates the PNG signature and reads IHDR dimensions", () => {
    const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write("IHDR", 12, "ascii")
    png.writeUInt32BE(1200, 16)
    png.writeUInt32BE(630, 20)

    expect(readPngDimensions(png)).toEqual({ width: 1200, height: 630 })
    expect(() => readPngDimensions(Buffer.from("not a png"))).toThrow("invalid PNG signature")

    const wrongChunk = Buffer.from(png)
    wrongChunk.write("IDAT", 12, "ascii")
    expect(() => readPngDimensions(wrongChunk)).toThrow("PNG does not begin with an IHDR chunk")
  })

  it("reports missing, extra, duplicate, and reordered inventory entries", () => {
    expect(compareOrderedInventory(["/", "/blog", "/docs/tools"], ["/", "/blog"])).toEqual([
      "missing source URL in sitemap: /docs/tools",
    ])
    expect(compareOrderedInventory(["/", "/blog"], ["/", "/blog", "/extra"])).toEqual([
      "extra sitemap URL not present in source inventory: /extra",
    ])
    expect(compareOrderedInventory(["/", "/blog"], ["/", "/", "/blog"])).toContain(
      "duplicate sitemap URL: /",
    )
    expect(compareOrderedInventory(["/", "/blog"], ["/blog", "/"])).toEqual([
      "sitemap URL order differs from source inventory at index 0: expected /, received /blog",
    ])
    expect(compareOrderedInventory(["/", "/blog"], ["/", "/blog"])).toEqual([])
  })

  it("accepts the package-manager argument separator before task-specific options", () => {
    expect(
      parseAuditOptions(["--", "--base-url", "http://127.0.0.1:3018", "--as-of", "2026-08-26"]),
    ).toEqual({ asOf: "2026-08-26", baseUrl: "http://127.0.0.1:3018" })
  })

  it("uses Next's exact root-canonical serialization and specific text regression markers", () => {
    expect(canonicalForPath("/")).toBe("https://dawnai.org")
    expect(canonicalForPath("/docs/tools")).toBe("https://dawnai.org/docs/tools")
    expect(obviousTextRegression("Dawn docs explain ENOENT and undefined values.")).toBeUndefined()
    expect(obviousTextRegression("<!doctype html><html><body>Error</body></html>")).toBe(
      "HTML document",
    )
    expect(obviousTextRegression("Internal Server Error")).toBe("Internal Server Error")
  })

  it("counts an exact llms-full document section despite colliding authored headings", () => {
    const source = "# Tools\n\nAuthored content\n\n### Tools\n\nNested heading"
    const body = `## Documentation\n\n### Tools\n\n${source}\n\n---\n\n### Agents\n\nOther`

    expect(docSectionOccurrences(body, "Tools", source)).toBe(1)
  })

  it("rejects 24 distinct lastmod dates for the current production inventory snapshot", () => {
    expect(CURRENT_SNAPSHOT_MINIMUM_DISTINCT_LASTMOD_DATES).toBe(25)
    expect(lastmodDateDistributionFailure(24, "2026-08-26")).toBe(
      "sitemap has only 24 distinct lastmod dates; expected at least 25 for the 2026-08-26 production inventory snapshot",
    )
  })

  it("accepts 25 distinct lastmod dates for the current production inventory snapshot", () => {
    expect(lastmodDateDistributionFailure(25, "2026-08-26")).toBeUndefined()
  })
})
