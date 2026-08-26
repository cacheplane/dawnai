import type {
  BlogPostingSeoPage,
  CollectionPageSeoPage,
  SeoPage,
  TechArticleSeoPage,
  WebPageSeoPage,
} from "./types"

const SITE_URL = "https://dawnai.org/"
const ORGANIZATION_ID = `${SITE_URL}#organization`
const WEBSITE_ID = `${SITE_URL}#website`
const LOGO_ID = `${SITE_URL}#logo`

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
  readonly "@id": string
  readonly itemListElement: readonly BreadcrumbListItemJsonLd[]
}

export function siteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        name: "Dawn AI",
        url: SITE_URL,
        logo: {
          "@type": "ImageObject",
          "@id": LOGO_ID,
          url: `${SITE_URL}brand/dawn-logo-horizontal-black.svg`,
        },
      },
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        name: "Dawn AI",
        url: SITE_URL,
        publisher: { "@id": ORGANIZATION_ID },
      },
    ],
  } as const
}

export function collectionPageJsonLd(page: CollectionPageSeoPage) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": page.canonical,
    url: page.canonical,
    name: page.title,
    description: page.description,
    isPartOf: { "@id": WEBSITE_ID },
    breadcrumb: { "@id": `${page.canonical}#breadcrumb` },
  } as const
}

export function webPageJsonLd(page: WebPageSeoPage) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${page.canonical}#webpage`,
    url: page.canonical,
    name: page.title,
    description: page.description,
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORGANIZATION_ID },
  } as const
}

export function blogPostingJsonLd(page: BlogPostingSeoPage) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${page.canonical}#article`,
    headline: page.title,
    description: page.description,
    url: page.canonical,
    datePublished: page.datePublished,
    author: {
      "@type": "Person",
      "@id": page.author.url,
      name: page.author.name,
      url: page.author.url,
      image: new URL(page.author.avatar, SITE_URL).href,
    },
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
  } as const
}

export function techArticleJsonLd(page: TechArticleSeoPage): TechArticleJsonLd {
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
    "@id": `${page.canonical}#breadcrumb`,
    itemListElement: page.breadcrumbs.map((crumb, index) => {
      const item = crumb.href
        ? new URL(crumb.href, page.canonical).href
        : page.kind !== "TechArticle" && index === page.breadcrumbs.length - 1
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
