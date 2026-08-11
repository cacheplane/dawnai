import { describe, expect, it } from "vitest"
import { DOCS_NAV } from "./nav"
import { DOCS_INDEX } from "./search-index"

describe("documentation search index", () => {
  it("contains one entry per nav item in registry order", () => {
    const expected = DOCS_NAV.flatMap((section) =>
      section.items.map((item) => ({ href: item.href, section: section.label })),
    )

    expect(DOCS_INDEX.map(({ href, section }) => ({ href, section }))).toEqual(expected)
  })
})
