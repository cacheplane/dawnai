import { promises as fs } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { API_REFERENCE_PAGES } from "../../../components/docs/api-reference-pages"
import { GET } from "./route"

const FINAL_PR2_API_HREFS = [
  "/docs/api/permissions",
  "/docs/api/workspace",
  "/docs/api/sandbox",
  "/docs/api/langgraph",
  "/docs/api/langchain",
  "/docs/api/sqlite-storage",
] as const

async function getMarkdown(slug: readonly string[]): Promise<Response> {
  return GET(new Request(`https://dawnai.org/api/markdown/${slug.join("/")}`), {
    params: Promise.resolve({ slug }),
  })
}

describe("markdown route", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("serves section index pages", async () => {
    const response = await getMarkdown(["recipes"])

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("# Recipes")
  })

  it("continues to serve leaf pages", async () => {
    const response = await getMarkdown(["recipes", "add-a-tool"])

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("# Add a Tool")
  })

  it("serves the Thread Access journey page", async () => {
    const response = await getMarkdown(["thread-access"])
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("# Thread Access")
  })

  it.each(API_REFERENCE_PAGES)("serves nested API reference $href", async (page) => {
    const response = await getMarkdown(page.href.slice("/docs/".length).split("/"))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(`# ${page.label}`)
  })

  it("serves all six PR2 API reference leaves", async () => {
    for (const href of FINAL_PR2_API_HREFS) {
      const response = await getMarkdown(href.slice("/docs/".length).split("/"))
      expect(response.status, href).toBe(200)
    }
  })

  it("rejects an empty slug", async () => {
    expect((await getMarkdown([])).status).toBe(400)
  })

  it.each([".", "..", "%2e%2e", "recipes\\..\\secret", "/etc/passwd"])(
    "rejects invalid slug segment: %s",
    async (segment) => {
      expect((await getMarkdown([segment])).status).toBe(400)
    },
  )

  it("returns 404 for an unknown source", async () => {
    expect((await getMarkdown(["not-a-real-document"])).status).toBe(404)
  })

  it("propagates non-ENOENT read errors", async () => {
    const readError = Object.assign(new Error("permission denied"), { code: "EACCES" })
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async () => {
      throw readError
    })

    await expect(getMarkdown(["recipes"])).rejects.toBe(readError)
    expect(readFile).toHaveBeenCalledOnce()
  })
})
