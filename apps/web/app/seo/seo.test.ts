import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { breadcrumbsFor } from "../components/docs/nav"
import { JsonLd } from "./JsonLd"
import { resolveStaticSeoPage, toMetadata } from "./resolve"
import { breadcrumbJsonLd, techArticleJsonLd } from "./structured-data"

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
