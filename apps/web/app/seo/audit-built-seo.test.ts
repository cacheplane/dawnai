import { Buffer } from "node:buffer"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertExactRobots,
  auditBuiltSeo,
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

const LOCAL_ORIGIN = "http://127.0.0.1:3018"
const POST_PATH = "/blog/eve-validates-the-shape"

function sitemapXml(url: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${url}</loc><lastmod>2026-08-26T00:00:00.000Z</lastmod></url>
</urlset>`
}

function auditablePostHtml(imageUrl: string): string {
  const description = "A production-visible post description."
  const jsonLd = [
    {
      "@id": "https://dawnai.org/#organization",
      "@type": "Organization",
      logo: {
        "@id": "https://dawnai.org/#logo",
        "@type": "ImageObject",
        url: "https://dawnai.org/brand/dawn-logo-horizontal-black.svg",
      },
      name: "Dawn AI",
      url: "https://dawnai.org/",
    },
    {
      "@id": "https://dawnai.org/#website",
      "@type": "WebSite",
      name: "Dawn AI",
      publisher: { "@id": "https://dawnai.org/#organization" },
      url: "https://dawnai.org/",
    },
    { "@type": "BlogPosting", description },
    { "@type": "BreadcrumbList" },
  ]
  return `<!doctype html><html><head>
    <meta name="description" content="${description}">
    <meta property="og:description" content="${description}">
    <meta name="twitter:description" content="${description}">
    <meta property="og:image" content="${imageUrl}">
    <link rel="canonical" href="https://dawnai.org${POST_PATH}">
  </head><body><main>Visible post content</main>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </body></html>`
}

function observeAuditFetches(options: { pageHtml?: string; sitemapUrl: string }): string[] {
  const escapedTargets: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const requested =
        input instanceof Request
          ? new URL(input.url)
          : input instanceof URL
            ? input
            : new URL(input)
      if (requested.origin !== LOCAL_ORIGIN) {
        escapedTargets.push(requested.href)
        throw new Error(`outbound fetch attempted: ${requested.href}`)
      }
      if (requested.pathname === "/sitemap.xml") {
        return new Response(sitemapXml(options.sitemapUrl), {
          headers: { "content-type": "application/xml" },
          status: 200,
        })
      }
      if (requested.pathname === POST_PATH && options.pageHtml !== undefined) {
        return new Response(options.pageHtml, {
          headers: { "content-type": "text/html" },
          status: 200,
        })
      }
      return new Response("fixture rejection", { status: 500 })
    }),
  )
  return escapedTargets
}

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
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

  it("accepts whitespace before HTML closing-tag brackets", () => {
    const html = pageHtml({ "@type": "TechArticle" })
      .replace("</script>", "</script >")
      .replace(
        "<main>Visible route content</main>",
        "<main>Visible route content</main><style>Hidden style text</style ><noscript>Hidden fallback text</noscript >",
      )

    const parsed = extractPageMetadata(html)

    expect(parsed.jsonLdEntities).toEqual([{ "@type": "TechArticle" }])
    expect(parsed.visibleText).toContain("Visible route content")
    expect(parsed.visibleText).not.toContain("Hidden style text")
    expect(parsed.visibleText).not.toContain("Hidden fallback text")
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

  it("rejects 22 distinct lastmod dates for the current production inventory snapshot", () => {
    expect(CURRENT_SNAPSHOT_MINIMUM_DISTINCT_LASTMOD_DATES).toBe(23)
    expect(lastmodDateDistributionFailure(22, "2026-08-26")).toBe(
      "sitemap has only 22 distinct lastmod dates; expected at least 23 for the 2026-08-26 production inventory snapshot",
    )
  })

  it("accepts 23 distinct lastmod dates for the current production inventory snapshot", () => {
    expect(lastmodDateDistributionFailure(23, "2026-08-26")).toBeUndefined()
  })

  it("keeps a double-slash sitemap path on the configured local origin", async () => {
    const escapedTargets = observeAuditFetches({
      sitemapUrl: "https://dawnai.org//169.254.169.254/latest/meta-data",
    })

    await auditBuiltSeo({ asOf: "2026-08-26", baseUrl: LOCAL_ORIGIN })

    expect(escapedTargets).toEqual([])
  })

  it("keeps a triple-slash sitemap path on the configured local origin", async () => {
    const escapedTargets = observeAuditFetches({
      sitemapUrl: "https://dawnai.org///outside.example/escape",
    })

    await auditBuiltSeo({ asOf: "2026-08-26", baseUrl: LOCAL_ORIGIN })

    expect(escapedTargets).toEqual([])
  })

  it("keeps a rendered OG image path on the configured local origin", async () => {
    const imageUrl = "https://dawnai.org//169.254.169.254/latest/og-image"
    const escapedTargets = observeAuditFetches({
      pageHtml: auditablePostHtml(imageUrl),
      sitemapUrl: `https://dawnai.org${POST_PATH}`,
    })

    await auditBuiltSeo({ asOf: "2026-08-26", baseUrl: LOCAL_ORIGIN })

    expect(escapedTargets).toEqual([])
  })
})
