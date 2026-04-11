import type { MetadataRoute } from "next"

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"

const routes = [
  "",
  "/docs",
  "/docs/getting-started",
  "/docs/cli",
  "/docs/packages",
  "/docs/app-graph",
  "/docs/examples",
]

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    changeFrequency: route === "" ? "weekly" : "monthly",
    lastModified: new Date(),
    priority: route === "" ? 1 : 0.7,
    url: `${siteUrl}${route}`,
  }))
}
