import type { MetadataRoute } from "next"
import { resolveProductionSeoPages } from "./seo/resolve"
import type { SeoPage } from "./seo/types"

type SitemapPolicy = Pick<MetadataRoute.Sitemap[number], "changeFrequency" | "priority">

function sitemapPolicy(page: SeoPage): SitemapPolicy {
  switch (page.routeKind) {
    case "home":
      return { changeFrequency: "weekly", priority: 1 }
    case "blog-index":
      return { changeFrequency: "weekly", priority: 0.8 }
    case "docs":
      return { changeFrequency: "monthly", priority: 0.7 }
    case "blog-post":
      return { changeFrequency: "yearly", priority: 0.6 }
    case "blog-tag":
      return { changeFrequency: "weekly", priority: 0.4 }
  }
}

export function toSitemapEntry(page: SeoPage): MetadataRoute.Sitemap[number] {
  return {
    url: page.canonical,
    lastModified: page.lastModified,
    ...sitemapPolicy(page),
  }
}

export function buildSitemap(
  currentDate = new Date().toISOString().slice(0, 10),
): MetadataRoute.Sitemap {
  return resolveProductionSeoPages(currentDate).map(toSitemapEntry)
}

export default function sitemap(): MetadataRoute.Sitemap {
  return buildSitemap()
}
