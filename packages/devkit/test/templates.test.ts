import { describe, expect, it } from "vitest"
import { resolveTemplateDir, TEMPLATE_NAMES } from "../src/templates.js"

describe("template registry", () => {
  it("registers the research template", () => {
    expect(TEMPLATE_NAMES).toContain("research")
  })

  it("resolves the research template directory", async () => {
    const dir = await resolveTemplateDir("research")
    expect(dir.endsWith("templates/app-research")).toBe(true)
  })
})
