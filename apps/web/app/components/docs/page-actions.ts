const CANONICAL_BASE = "https://dawnai.org"

export function pageUrl(slug: string): string {
  return `${CANONICAL_BASE}/docs/${slug}`
}

export function sourceSlug(slug: string): string {
  return slug === "recipes" ? "recipes/index" : slug
}
