import type { Metadata } from "next"
import { STATIC_SEO_PAGES } from "./registry"
import { SOCIAL_CARD, SOCIAL_IMAGE_PATH, SOCIAL_SITE_NAME } from "./social"
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
      siteName: SOCIAL_SITE_NAME,
      title: page.title,
      description: page.description,
      images: [SOCIAL_IMAGE_PATH],
    },
    twitter: {
      card: SOCIAL_CARD,
      title: page.title,
      description: page.description,
      images: [SOCIAL_IMAGE_PATH],
    },
  }
}
