const REPO = "cacheplane/dawnai"
const FALLBACK = 100

/**
 * Fetches the GitHub star count for the Dawn repo.
 * Uses Next.js fetch revalidation (1 hour) so the value is cached during
 * production builds and refreshed during ISR. Returns a fallback on error.
 */
export async function getGitHubStars(): Promise<number> {
  try {
    const headers: HeadersInit = { Accept: "application/vnd.github+json" }
    const token = process.env.GITHUB_TOKEN
    if (token !== undefined && token !== "") {
      headers.Authorization = `Bearer ${token}`
    }
    const response = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers,
      next: { revalidate: 3600 },
    })
    if (!response.ok) return FALLBACK
    const data = (await response.json()) as { stargazers_count?: number }
    return typeof data.stargazers_count === "number" ? data.stargazers_count : FALLBACK
  } catch {
    return FALLBACK
  }
}
