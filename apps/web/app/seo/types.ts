import type { DocsCrumb } from "../components/docs/nav"

export interface SeoPage {
  readonly path: string
  readonly canonical: string
  readonly title: string
  readonly description: string
  readonly kind: "TechArticle"
  readonly breadcrumbs: readonly DocsCrumb[]
  readonly lastModified: string
}
