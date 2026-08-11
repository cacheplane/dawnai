import { promises as fs } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"

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
