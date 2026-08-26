import { breadcrumbsFor } from "../components/docs/nav"
import { STATIC_LASTMOD } from "./lastmod.generated"
import type { SeoPage } from "./types"

const GETTING_STARTED_PATH = "/docs/getting-started"

const gettingStarted: SeoPage = {
  path: GETTING_STARTED_PATH,
  canonical: `https://dawnai.org${GETTING_STARTED_PATH}`,
  title: "Getting Started",
  description:
    "Build a typed Dawn research agent with file-system routes, generated types, local tools, offline tests, and production build targets.",
  kind: "TechArticle",
  breadcrumbs: breadcrumbsFor(GETTING_STARTED_PATH),
  lastModified: STATIC_LASTMOD[GETTING_STARTED_PATH] as string,
}

export const STATIC_SEO_PAGES: Readonly<Record<string, SeoPage>> = {
  [GETTING_STARTED_PATH]: gettingStarted,
}
