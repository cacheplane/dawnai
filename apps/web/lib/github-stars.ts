/**
 * Server-side GitHub stats fetcher with 1-hour ISR cache.
 *
 * Reads stargazers_count + forks_count from the public GitHub API.
 * Falls back to a celebratory floor (100 stars) on any error or rate-limit
 * so the UI never regresses below the milestone we're marking.
 */

const REPO = "cacheplane/dawnai"
const REPO_URL = `https://github.com/${REPO}`
const API_URL = `https://api.github.com/repos/${REPO}`

export interface GitHubStats {
  readonly stars: number
  readonly forks: number
  readonly url: string
}

const FALLBACK: GitHubStats = {
  stars: 100,
  forks: 2,
  url: REPO_URL,
}

export async function getGitHubStats(): Promise<GitHubStats> {
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    })
    if (!res.ok) return FALLBACK
    const data = (await res.json()) as {
      stargazers_count?: number
      forks_count?: number
    }
    const stars = typeof data.stargazers_count === "number" ? data.stargazers_count : FALLBACK.stars
    const forks = typeof data.forks_count === "number" ? data.forks_count : FALLBACK.forks
    return { stars, forks, url: REPO_URL }
  } catch {
    return FALLBACK
  }
}

export function formatStarCount(stars: number): string {
  if (stars < 1000) return String(stars)
  const k = stars / 1000
  return `${k.toFixed(1)}k`
}
