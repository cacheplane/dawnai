import { getGitHubStars } from "../../../lib/github-stars"
import { getGitHubContributors } from "../../../lib/github-contributors"
import { ProviderMark } from "../ui/ProviderMark"

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${n}`
}

function StarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4"
    >
      <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

export async function ProofStrip() {
  const [stars, contributors] = await Promise.all([
    getGitHubStars(),
    getGitHubContributors(),
  ])

  return (
    <section className="bg-surface border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-8 md:py-10">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6 md:gap-10">

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim">
              Built on
            </span>
            <a
              href="https://www.langchain.com/langgraph"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-ink hover:text-accent-saas transition-colors"
            >
              LangGraph.js
            </a>
          </div>

          <div className="flex items-center gap-5 md:gap-6">
            <a
              href="https://github.com/cacheplane/dawnai"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Star Dawn on GitHub — ${stars} stars`}
              className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors"
            >
              <StarIcon />
              <span className="tabular-nums">{formatCount(stars)}</span>
              <span className="text-ink-dim">stars</span>
            </a>
            <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
              <UsersIcon />
              <span className="tabular-nums">{contributors}</span>
              <span className="text-ink-dim">contributors</span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim hidden md:inline">
              Works with
            </span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ProviderMark name="OpenAI" href="https://openai.com" />
              <ProviderMark name="Anthropic" href="https://www.anthropic.com" />
              <ProviderMark name="Google" />
              <ProviderMark name="Ollama" />
            </div>
          </div>

        </div>
      </div>
    </section>
  )
}
