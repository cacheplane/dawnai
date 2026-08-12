import { describe, expect, it } from "vitest"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import { pageUrl, sourceSlug } from "./page-actions"

describe("page action URLs", () => {
  it("builds canonical public documentation URLs", () => {
    expect(pageUrl("memory/retrieval")).toBe("https://dawnai.org/docs/memory/retrieval")
    expect(pageUrl("api/sdk")).toBe("https://dawnai.org/docs/api/sdk")
  })

  it("maps only section landing pages to their source index", () => {
    expect(sourceSlug("recipes")).toBe("recipes/index")
    expect(sourceSlug("memory/retrieval")).toBe("memory/retrieval")
    expect(sourceSlug("api/sdk")).toBe("api/sdk")
  })

  it("builds page and source URLs for every nested API leaf", () => {
    for (const page of API_REFERENCE_PAGES) {
      const slug = page.href.slice("/docs/".length)
      expect(pageUrl(slug)).toBe(`https://dawnai.org${page.href}`)
      expect(sourceSlug(slug)).toBe(slug)
    }
  })
})
