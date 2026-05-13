const REPO = "cacheplane/dawnai"
const FALLBACK = 5

/**
 * Fetches the contributor count for the Dawn repo via the GitHub API.
 * Mirrors getGitHubStars: 1-hour ISR cache, optional GITHUB_TOKEN, graceful
 * fallback on any error. Uses the `contributors?per_page=1&anon=true` endpoint
 * and parses the `Link` header `last` page number to avoid pulling the whole
 * list.
 */
export async function getGitHubContributors(): Promise<number> {
  try {
    const headers: HeadersInit = { Accept: "application/vnd.github+json" }
    const token = process.env.GITHUB_TOKEN
    if (token !== undefined && token !== "") {
      headers.Authorization = `Bearer ${token}`
    }
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/contributors?per_page=1&anon=true`,
      { headers, next: { revalidate: 3600 } }
    )
    if (!response.ok) return FALLBACK
    const link = response.headers.get("link") ?? ""
    const match = link.match(/[?&]page=(\d+)>; rel="last"/)
    if (match?.[1] !== undefined) {
      const last = Number.parseInt(match[1], 10)
      if (Number.isFinite(last) && last > 0) return last
    }
    const data = (await response.json()) as readonly unknown[]
    return Array.isArray(data) ? data.length : FALLBACK
  } catch {
    return FALLBACK
  }
}
