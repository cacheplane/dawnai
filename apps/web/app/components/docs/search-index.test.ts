import { describe, expect, it } from "vitest"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import { ALL_DOCS_PAGES, DOCS_NAV } from "./nav"
import { DOCS_INDEX } from "./search-index"

describe("documentation search index", () => {
  it("contains every registered page in exhaustive registry order", () => {
    const journeySectionByHref = new Map<string, string>(
      DOCS_NAV.flatMap((section) => section.items.map((item) => [item.href, section.label])),
    )
    const apiHrefs = new Set<string>(API_REFERENCE_PAGES.map(({ href }) => href))
    const expected = ALL_DOCS_PAGES.map((item) => ({
      href: item.href,
      title: item.label,
      section: apiHrefs.has(item.href) ? "API Reference" : journeySectionByHref.get(item.href),
    }))

    expect(DOCS_INDEX.map(({ href, title, section }) => ({ href, title, section }))).toEqual(
      expected,
    )
    expect(expected).toContainEqual({
      href: "/docs/recipes",
      title: "Recipes Overview",
      section: "Recipes",
    })
    expect(expected).toContainEqual({
      href: "/docs/memory/long-term",
      title: "Long-term Memory",
      section: "Build",
    })
    expect(expected).toContainEqual({
      href: "/docs/testing-agents/fixtures",
      title: "Fixtures and Recording",
      section: "Test",
    })
    for (const page of API_REFERENCE_PAGES) {
      expect(expected).toContainEqual({
        href: page.href,
        title: page.label,
        section: "API Reference",
      })
    }
  })
})
