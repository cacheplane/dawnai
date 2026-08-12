import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveWebContentRoot } from "../lib/content-root"

describe("web content root", () => {
  it("defaults to the content directory under the current working directory", () => {
    expect(resolveWebContentRoot("/workspace/web")).toBe(join("/workspace/web", "content"))
  })

  it("honors an explicit absolute content root", () => {
    expect(resolveWebContentRoot("/workspace/web", "/fixtures/web-content")).toBe(
      "/fixtures/web-content",
    )
  })
})
