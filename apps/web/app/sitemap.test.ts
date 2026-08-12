import { describe, expect, it } from "vitest"
import { ALL_DOCS_PAGES, DOCS_PAGES } from "./components/docs/nav"
import sitemap from "./sitemap"

describe("sitemap documentation entries", () => {
  it("uses the exhaustive docs registry exactly and omits the redirect-only docs root", () => {
    const docsUrls = sitemap()
      .map((entry) => entry.url)
      .filter((url) => new URL(url).pathname.startsWith("/docs"))

    expect(DOCS_PAGES).toHaveLength(59)
    expect(ALL_DOCS_PAGES).toHaveLength(69)
    expect(docsUrls).toEqual(ALL_DOCS_PAGES.map((page) => `https://dawnai.org${page.href}`))
    expect(docsUrls).not.toContain("https://dawnai.org/docs")
  })
})
