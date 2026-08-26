import type { Metadata } from "next"
import { STATIC_SEO_PAGES } from "./registry"
import type { SeoPage } from "./types"

export function resolveStaticSeoPage(path: string): SeoPage | undefined {
  return STATIC_SEO_PAGES[path]
}

export function toMetadata(page: SeoPage | undefined): Metadata {
  if (!page) return {}

  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.canonical },
    openGraph: {
      type: "article",
      url: page.canonical,
      title: page.title,
      description: page.description,
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
    },
  }
}
