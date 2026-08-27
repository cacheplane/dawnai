import type { Author } from "../components/blog/post-index"
import type { DocsCrumb } from "../components/docs/nav"

interface BaseSeoPage {
  readonly path: string
  readonly canonical: string
  readonly title: string
  readonly description: string
  readonly breadcrumbs: readonly DocsCrumb[]
  readonly lastModified: string
  readonly socialImage?: string
  readonly alternateTypes?: Readonly<Record<string, string>>
}

export interface TechArticleSeoPage extends BaseSeoPage {
  readonly kind: "TechArticle"
  readonly routeKind: "docs"
}

export interface WebPageSeoPage extends BaseSeoPage {
  readonly kind: "WebPage"
  readonly routeKind: "home"
}

export interface CollectionPageSeoPage extends BaseSeoPage {
  readonly kind: "CollectionPage"
  readonly routeKind: "blog-index" | "blog-tag"
}

export interface BlogPostingSeoPage extends BaseSeoPage {
  readonly kind: "BlogPosting"
  readonly routeKind: "blog-post"
  readonly datePublished: string
  readonly author: Author
}

export type SeoPage =
  | WebPageSeoPage
  | TechArticleSeoPage
  | CollectionPageSeoPage
  | BlogPostingSeoPage
