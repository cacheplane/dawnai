import type { MetadataRoute } from "next"
import { getAllPosts, getAllTags } from "./components/blog/post-index"

const SITE_URL = "https://dawnai.org"

const DOC_PATHS = [
  "/docs/getting-started",
  "/docs/mental-model",
  "/docs/routes",
  "/docs/tools",
  "/docs/state",
  "/docs/agents",
  "/docs/middleware",
  "/docs/retry",
  "/docs/testing",
  "/docs/dev-server",
  "/docs/deployment",
  "/docs/cli",
  "/docs/api",
  "/docs/faq",
  "/docs/migrating-from-langgraph",
  "/docs/recipes",
]

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString()
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/blog`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    ...DOC_PATHS.map((p) => ({
      url: `${SITE_URL}${p}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ]
  const blog: MetadataRoute.Sitemap = getAllPosts().map((p) => ({
    url: `${SITE_URL}/blog/${p.slug}`,
    lastModified: new Date(`${p.date}T00:00:00Z`).toISOString(),
    changeFrequency: "yearly",
    priority: 0.6,
  }))
  const tags: MetadataRoute.Sitemap = getAllTags().map(({ tag }) => ({
    url: `${SITE_URL}/blog/tags/${tag}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.4,
  }))
  return [...staticEntries, ...blog, ...tags]
}
