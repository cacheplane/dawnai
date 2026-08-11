import { describe, expect, it } from "vitest"
import { DOCS_PAGES } from "./components/docs/nav"
import sitemap from "./sitemap"

describe("sitemap documentation entries", () => {
  it("uses the nav registry exactly and omits the redirect-only docs root", () => {
    const docsUrls = sitemap()
      .map((entry) => entry.url)
      .filter((url) => new URL(url).pathname.startsWith("/docs"))

    expect(docsUrls).toEqual(DOCS_PAGES.map((page) => `https://dawnai.org${page.href}`))
    expect(docsUrls).not.toContain("https://dawnai.org/docs")
  })
})
