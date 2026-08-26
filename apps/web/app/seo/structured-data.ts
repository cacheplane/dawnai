import type { SeoPage } from "./types"

interface TechArticleJsonLd {
  readonly "@context": "https://schema.org"
  readonly "@type": "TechArticle"
  readonly headline: string
  readonly description: string
  readonly url: string
  readonly dateModified: string
}

interface BreadcrumbListItemJsonLd {
  readonly "@type": "ListItem"
  readonly position: number
  readonly name: string
  readonly item?: string
}

interface BreadcrumbListJsonLd {
  readonly "@context": "https://schema.org"
  readonly "@type": "BreadcrumbList"
  readonly itemListElement: readonly BreadcrumbListItemJsonLd[]
}

export function techArticleJsonLd(page: SeoPage): TechArticleJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": page.kind,
    headline: page.title,
    description: page.description,
    url: page.canonical,
    dateModified: page.lastModified,
  }
}

export function breadcrumbJsonLd(page: SeoPage): BreadcrumbListJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: page.breadcrumbs.map((crumb, index) => {
      const item = crumb.href
        ? new URL(crumb.href, page.canonical).href
        : index === page.breadcrumbs.length - 1
          ? page.canonical
          : undefined

      return {
        "@type": "ListItem",
        position: index + 1,
        name: crumb.label,
        ...(item !== undefined ? { item } : {}),
      }
    }),
  }
}
