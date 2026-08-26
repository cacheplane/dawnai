import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadPostsFromDir, type Post } from "./components/blog/post-index"
import { ALL_DOCS_PAGES, DOCS_PAGES } from "./components/docs/nav"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const blogContentDirectory = resolve(appDirectory, "../content/blog")

function visibleProductionPosts(): readonly Post[] {
  return loadPostsFromDir(blogContentDirectory, {
    currentDate: "2026-08-26",
    includeDrafts: false,
  })
}

function visibleProductionTags(posts: readonly Post[]): readonly string[] {
  const counts = new Map<string, number>()
  for (const post of posts) {
    for (const tag of post.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].sort((left, right) => right[1] - left[1]).map(([tag]) => tag)
}

async function productionSitemap() {
  vi.resetModules()
  vi.stubEnv("NODE_ENV", "production")
  const { default: sitemap } = await import("./sitemap")
  return sitemap()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock("./seo/resolve")
  vi.doUnmock("./seo/lastmod.generated")
  vi.resetModules()
})

describe("sitemap documentation entries", () => {
  it("maps the resolver inventory by route kind without rebuilding route sources", async () => {
    const lastModified = "2026-08-26T12:00:00.000Z"
    const inventory = [
      { path: "/", canonical: "https://dawnai.org/", lastModified, routeKind: "home" },
      {
        path: "/blog",
        canonical: "https://dawnai.org/blog",
        lastModified,
        routeKind: "blog-index",
      },
      {
        path: "/docs/example",
        canonical: "https://dawnai.org/docs/example",
        lastModified,
        routeKind: "docs",
      },
      {
        path: "/blog/example",
        canonical: "https://dawnai.org/blog/example",
        lastModified,
        routeKind: "blog-post",
      },
      {
        path: "/blog/tags/example",
        canonical: "https://dawnai.org/blog/tags/example",
        lastModified,
        routeKind: "blog-tag",
      },
    ]

    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    vi.doMock("./seo/resolve", () => ({ resolveProductionSeoPages: () => inventory }))
    const { default: sitemap } = await import("./sitemap")

    expect(sitemap()).toEqual([
      { url: inventory[0]?.canonical, lastModified, changeFrequency: "weekly", priority: 1 },
      { url: inventory[1]?.canonical, lastModified, changeFrequency: "weekly", priority: 0.8 },
      { url: inventory[2]?.canonical, lastModified, changeFrequency: "monthly", priority: 0.7 },
      { url: inventory[3]?.canonical, lastModified, changeFrequency: "yearly", priority: 0.6 },
      { url: inventory[4]?.canonical, lastModified, changeFrequency: "weekly", priority: 0.4 },
    ])
  })

  it("uses the exhaustive docs registry exactly and omits the redirect-only docs root", async () => {
    const entries = await productionSitemap()
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
    const entries = await productionSitemap()
    const posts = visibleProductionPosts()
    const tags = visibleProductionTags(posts)
    const resolvedPaths = entries.map((entry) => new URL(entry.url).pathname)
    const expectedPaths = [
      "/",
      "/blog",
      ...ALL_DOCS_PAGES.map((page) => page.href),
      ...posts.map((post) => `/blog/${post.slug}`),
      ...tags.map((tag) => `/blog/tags/${tag}`),
    ]

    expect(resolvedPaths).toEqual(expectedPaths)
    expect(new Set(resolvedPaths)).toEqual(new Set(expectedPaths))
    expect(new Set(resolvedPaths).size).toBe(resolvedPaths.length)
    expect(resolvedPaths).not.toContain("/docs")
    expect(resolvedPaths).not.toContain("/blog/dawn-0-8-framework-around-the-agent")
    expect(resolvedPaths).not.toContain("/blog/dawn-at-the-edge")
    expect(resolvedPaths).not.toContain("/blog/dawn-0-4-release")
    expect(entries).toHaveLength(2 + ALL_DOCS_PAGES.length + posts.length + tags.length)
    expect(entries).toHaveLength(83)
  })

  it("uses valid, content-derived ISO last-modified dates", async () => {
    const entries = await productionSitemap()
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

  it("keeps the production sitemap runtime free of Git and mtime discovery", () => {
    const sources = ["sitemap.ts", "seo/resolve.ts", "seo/registry.ts"]
      .map((path) => readFileSync(resolve(appDirectory, path), "utf8"))
      .join("\n")

    expect(sources).not.toMatch(/child_process|\bgit\b|mtime|statSync/)
  })

  it("fails closed when a static route lacks a valid manifest date", async () => {
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    vi.doMock("./seo/lastmod.generated", () => ({
      STATIC_LASTMOD: { "/": "2026-08-10T18:36:49.000Z" },
    }))

    await expect(import("./sitemap")).rejects.toThrow(
      "Missing or invalid last-modified date for /docs/getting-started",
    )
  })
})
