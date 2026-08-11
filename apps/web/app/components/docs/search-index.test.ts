import { describe, expect, it } from "vitest"
import { DOCS_NAV } from "./nav"
import { DOCS_INDEX } from "./search-index"

describe("documentation search index", () => {
  it("contains one titled entry per nav item in registry order", () => {
    const expected = DOCS_NAV.flatMap((section) =>
      section.items.map((item) => ({
        href: item.href,
        title: item.label,
        section: section.label,
      })),
    )

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
  })
})
