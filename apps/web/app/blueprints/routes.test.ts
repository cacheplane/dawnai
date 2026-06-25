import { describe, expect, it } from "vitest"
import { GET as itemGet } from "./[name]/route"
import { GET as catalogGet } from "./index.json/route"

describe("/blueprints/index.json", () => {
  it("returns the catalog as JSON with derived name/category and url", async () => {
    const res = catalogGet()
    expect(res.headers.get("content-type")).toContain("application/json")
    const catalog = (await res.json()) as Array<{ name: string; category: string; url: string }>
    expect(Array.isArray(catalog)).toBe(true)
    const otel = catalog.find((c) => c.name === "opentelemetry")
    expect(otel?.category).toBe("observability")
    expect(otel?.url).toBe("https://dawnai.org/blueprints/opentelemetry.md")
  })
})

describe("/blueprints/[name].md", () => {
  it("returns the markdown body (frontmatter stripped) for a known name", async () => {
    const res = await itemGet(new Request("https://x/blueprints/opentelemetry.md"), {
      params: Promise.resolve({ name: "opentelemetry.md" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const text = await res.text()
    expect(text).toMatch(/^#\s/m)
    expect(text).not.toContain("description:")
  })

  it("404s for an unknown name", async () => {
    const res = await itemGet(new Request("https://x/blueprints/nope.md"), {
      params: Promise.resolve({ name: "nope.md" }),
    })
    expect(res.status).toBe(404)
  })
})
