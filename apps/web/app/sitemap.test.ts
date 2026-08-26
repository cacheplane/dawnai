import { afterEach, describe, expect, it, vi } from "vitest"
import { ALL_DOCS_PAGES, DOCS_PAGES } from "./components/docs/nav"

async function productionSitemap() {
  vi.resetModules()
  vi.stubEnv("NODE_ENV", "production")
  const { getAllPosts, getAllTags } = await import("./components/blog/post-index")
  const { default: sitemap } = await import("./sitemap")
  return { entries: sitemap(), posts: getAllPosts(), tags: getAllTags() }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("sitemap documentation entries", () => {
  it("uses the exhaustive docs registry exactly and omits the redirect-only docs root", async () => {
    const { entries } = await productionSitemap()
    const docsUrls = entries
      .map((entry) => entry.url)
      .filter((url) => new URL(url).pathname.startsWith("/docs"))

    expect(DOCS_PAGES).toHaveLength(59)
    expect(ALL_DOCS_PAGES).toHaveLength(75)
    expect(docsUrls).toEqual(ALL_DOCS_PAGES.map((page) => `https://dawnai.org${page.href}`))
    expect(docsUrls).toContain("https://dawnai.org/docs/thread-access")
    expect(docsUrls).not.toContain("https://dawnai.org/docs")
  })

  it("contains the complete resolved production static, docs, and tag inventory", async () => {
    const { entries, posts, tags } = await productionSitemap()
    const individualPostPaths = new Set(posts.map((post) => `/blog/${post.slug}`))
    const resolvedPaths = entries
      .map((entry) => new URL(entry.url).pathname)
      .filter((pathname) => !individualPostPaths.has(pathname))

    expect(resolvedPaths).toEqual([
      "/",
      "/blog",
      ...ALL_DOCS_PAGES.map((page) => page.href),
      ...tags.map(({ tag }) => `/blog/tags/${tag}`),
    ])
    expect(resolvedPaths).not.toContain("/docs")
    expect(entries).toHaveLength(2 + ALL_DOCS_PAGES.length + posts.length + tags.length)
    expect(entries).toHaveLength(83)
  })

  it("uses valid, content-derived ISO last-modified dates", async () => {
    const { entries } = await productionSitemap()
    const lastModified = entries.map((entry) => {
      expect(typeof entry.lastModified).toBe("string")
      if (typeof entry.lastModified !== "string") {
        throw new Error(`Expected an ISO lastModified value for ${entry.url}`)
      }
      return entry.lastModified
    })

    expect(lastModified).toHaveLength(entries.length)
    for (const value of lastModified) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
      expect(Number.isNaN(Date.parse(value))).toBe(false)
    }
    expect(new Set(lastModified).size).toBeGreaterThan(10)
  })
})
