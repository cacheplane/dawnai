import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DocsPage } from "../components/docs/DocsPage"
import { breadcrumbsFor } from "../components/docs/nav"
import { JsonLd } from "./JsonLd"
import { requireValidLastModified, STATIC_SEO_PAGES } from "./registry"
import { resolveStaticSeoPage, toMetadata } from "./resolve"
import { breadcrumbJsonLd, techArticleJsonLd } from "./structured-data"

const seoDirectory = dirname(fileURLToPath(import.meta.url))
const GETTING_STARTED_PATH = "/docs/getting-started"
const GETTING_STARTED_DESCRIPTION =
  "Build a typed Dawn research agent with file-system routes, generated types, local tools, offline tests, and production build targets."

describe("static SEO pages", () => {
  it("resolves one normalized Getting Started description across metadata and TechArticle data", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    const metadata = toMetadata(page)
    const article = techArticleJsonLd(page)

    expect(page.description).toBe(GETTING_STARTED_DESCRIPTION)
    expect(metadata.description).toBe(page.description)
    expect(metadata.openGraph?.description).toBe(page.description)
    expect(metadata.twitter?.description).toBe(page.description)
    expect(article.description).toBe(page.description)
  })

  it("returns complete social metadata without dropping shared fields", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    expect(toMetadata(page)).toEqual({
      title: "Getting Started",
      description: GETTING_STARTED_DESCRIPTION,
      alternates: { canonical: "https://dawnai.org/docs/getting-started" },
      openGraph: {
        type: "article",
        url: "https://dawnai.org/docs/getting-started",
        siteName: "Dawn AI",
        title: "Getting Started",
        description: GETTING_STARTED_DESCRIPTION,
        images: [
          {
            url: "/opengraph-image",
            type: "image/png",
            width: 1200,
            height: 630,
            alt: "Dawn — TypeScript meta-framework for LangGraph.js",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: "Getting Started",
        description: GETTING_STARTED_DESCRIPTION,
        images: [
          {
            url: "/opengraph-image",
            type: "image/png",
            width: 1200,
            height: 630,
            alt: "Dawn — TypeScript meta-framework for LangGraph.js",
          },
        ],
      },
    })
  })

  it("uses an absolute self-referencing canonical for Getting Started", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    expect(page.canonical).toBe("https://dawnai.org/docs/getting-started")
    expect(toMetadata(page).alternates?.canonical).toBe(page.canonical)
    expect(techArticleJsonLd(page).url).toBe(page.canonical)
  })

  it("derives BreadcrumbList names, order, and URLs from docs navigation breadcrumbs", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    const expectedBreadcrumbs = breadcrumbsFor(GETTING_STARTED_PATH)
    const breadcrumbList = breadcrumbJsonLd(page)

    expect(page.breadcrumbs).toEqual(expectedBreadcrumbs)
    expect(breadcrumbList.itemListElement.map(({ name, item }) => ({ name, item }))).toEqual(
      expectedBreadcrumbs.map((crumb, index) => ({
        name: crumb.label,
        item: crumb.href
          ? new URL(crumb.href, page.canonical).href
          : index === expectedBreadcrumbs.length - 1
            ? page.canonical
            : undefined,
      })),
    )
  })

  it("returns undefined for an unregistered page", () => {
    expect(resolveStaticSeoPage("/docs/not-registered")).toBeUndefined()
  })

  it("keeps the partial registry locked to Getting Started", () => {
    expect(Object.keys(STATIC_SEO_PAGES)).toEqual([GETTING_STARTED_PATH])
  })

  it("requires a checked valid last-modified value", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    const registrySource = readFileSync(resolve(seoDirectory, "registry.ts"), "utf8")
    expect(registrySource).not.toContain("as string")
    expect(page.lastModified).toBe("2026-08-19T18:31:12.000Z")
    expect(Number.isNaN(Date.parse(page.lastModified))).toBe(false)
    expect(techArticleJsonLd(page).dateModified).toBe(page.lastModified)
  })

  it("fails closed when a last-modified value is missing or invalid", () => {
    expect(() => requireValidLastModified({}, GETTING_STARTED_PATH)).toThrow(
      `Missing or invalid last-modified date for ${GETTING_STARTED_PATH}`,
    )
    expect(() =>
      requireValidLastModified({ [GETTING_STARTED_PATH]: "not-an-ISO-date" }, GETTING_STARTED_PATH),
    ).toThrow(`Missing or invalid last-modified date for ${GETTING_STARTED_PATH}`)
  })

  it("marks the registry as server-only", () => {
    const registrySource = readFileSync(resolve(seoDirectory, "registry.ts"), "utf8")

    expect(registrySource).toMatch(/^import ["']server-only["']/m)
  })

  it("renders structured data only for the registered docs route", () => {
    function Content() {
      return createElement("h1", null, "Docs page")
    }

    const registered = renderToStaticMarkup(
      createElement(DocsPage, { href: GETTING_STARTED_PATH, Content }),
    )
    const unregistered = renderToStaticMarkup(
      createElement(DocsPage, { href: "/docs/agents", Content }),
    )

    expect(registered).toContain('type="application/ld+json"')
    expect(registered).toContain('"@type":"TechArticle"')
    expect(registered).toContain('"@type":"BreadcrumbList"')
    expect(unregistered).not.toContain('type="application/ld+json"')
  })
})

describe("JsonLd", () => {
  it("renders JSON-LD with less-than signs escaped", () => {
    const html = renderToStaticMarkup(
      createElement(JsonLd, { data: { value: "</script><script>alert(1)</script>" } }),
    )

    expect(html).toContain('type="application/ld+json"')
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>")
    expect(html).not.toContain("</script><script>")
  })
})
