import "server-only"

import { breadcrumbsFor } from "../components/docs/nav"
import { STATIC_LASTMOD } from "./lastmod.generated"
import type { TechArticleSeoPage } from "./types"

const GETTING_STARTED_PATH = "/docs/getting-started"

export function requireValidLastModified(
  manifest: Readonly<Record<string, string>>,
  path: string,
): string {
  const value = manifest[path]
  const timestamp = value === undefined ? Number.NaN : Date.parse(value)

  if (
    value === undefined ||
    Number.isNaN(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`Missing or invalid last-modified date for ${path}`)
  }

  return value
}

const gettingStarted: TechArticleSeoPage = {
  path: GETTING_STARTED_PATH,
  canonical: `https://dawnai.org${GETTING_STARTED_PATH}`,
  title: "Getting Started",
  description:
    "Build a typed Dawn research agent with file-system routes, generated types, local tools, offline tests, and production build targets.",
  kind: "TechArticle",
  breadcrumbs: breadcrumbsFor(GETTING_STARTED_PATH),
  lastModified: requireValidLastModified(STATIC_LASTMOD, GETTING_STARTED_PATH),
}

export const STATIC_SEO_PAGES: Readonly<Record<string, TechArticleSeoPage>> = {
  [GETTING_STARTED_PATH]: gettingStarted,
}
