import { describe, expect, it } from "vitest"
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
})
