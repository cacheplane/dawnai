import { describe, expect, it } from "vitest"
import { pageUrl, sourceSlug } from "./page-actions"

describe("page action URLs", () => {
  it("builds canonical public documentation URLs", () => {
    expect(pageUrl("memory/retrieval")).toBe("https://dawnai.org/docs/memory/retrieval")
  })

  it("maps only section landing pages to their source index", () => {
    expect(sourceSlug("recipes")).toBe("recipes/index")
    expect(sourceSlug("memory/retrieval")).toBe("memory/retrieval")
  })
})
