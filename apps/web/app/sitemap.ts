import type { MetadataRoute } from "next"
import { getAllPosts, getAllTags } from "./components/blog/post-index"
import { ALL_DOCS_PAGES } from "./components/docs/nav"
import { STATIC_LASTMOD } from "./seo/lastmod.generated"

const SITE_URL = "https://dawnai.org"

function staticLastModified(route: string): string {
  const value = STATIC_LASTMOD[route]
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`Missing or invalid sitemap lastModified for ${route}`)
  }
  return value
}

export default function sitemap(): MetadataRoute.Sitemap {
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      lastModified: staticLastModified("/"),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/blog`,
      lastModified: staticLastModified("/blog"),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...ALL_DOCS_PAGES.map((p) => ({
      url: `${SITE_URL}${p.href}`,
      lastModified: staticLastModified(p.href),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ]
  const posts = getAllPosts().filter((post) => !post.draft)
  const blog: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${SITE_URL}/blog/${p.slug}`,
    lastModified: new Date(`${p.date}T00:00:00Z`).toISOString(),
    changeFrequency: "yearly",
    priority: 0.6,
  }))
  const tags: MetadataRoute.Sitemap = getAllTags()
    .filter(({ tag }) => posts.some((post) => post.tags.includes(tag)))
    .map(({ tag }) => ({
      url: `${SITE_URL}/blog/tags/${tag}`,
      lastModified: staticLastModified(`/blog/tags/${tag}`),
      changeFrequency: "weekly",
      priority: 0.4,
    }))
  return [...staticEntries, ...blog, ...tags]
}
