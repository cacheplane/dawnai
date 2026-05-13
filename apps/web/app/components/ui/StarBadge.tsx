import { getGitHubStars } from "../../../lib/github-stars"

interface StarBadgeProps {
  readonly className?: string
}

function StarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="w-3.5 h-3.5"
    >
      <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
    </svg>
  )
}

function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
  }
  return `${count}`
}

/**
 * GitHub star badge for the Dawn repo. Server component — wrap in
 * <Suspense fallback={...}> at the call site to avoid blocking page streaming.
 */
export async function StarBadge({ className = "" }: StarBadgeProps) {
  const stars = await getGitHubStars()
  return (
    <a
      href="https://github.com/cacheplane/dawnai"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${formatStars(stars)} stars on GitHub — star Dawn`}
      className={`inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors ${className}`}
    >
      <StarIcon />
      <span className="tabular-nums">{formatStars(stars)}</span>
    </a>
  )
}
