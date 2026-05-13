import Link from "next/link"

interface TagChipsProps {
  readonly tags: readonly string[]
  readonly activeTag?: string
}

export function TagChips({ tags, activeTag }: TagChipsProps) {
  return (
    <div className="flex gap-2 flex-wrap mb-8">
      <Link
        href="/blog"
        className={
          activeTag
            ? "text-xs px-3 py-1 rounded-full bg-surface/60 text-ink-muted hover:text-ink transition-colors"
            : "text-xs px-3 py-1 rounded-full bg-text-primary text-bg-primary"
        }
      >
        All
      </Link>
      {tags.map((tag) => (
        <Link
          key={tag}
          href={`/blog/tags/${tag}`}
          className={
            tag === activeTag
              ? "text-xs px-3 py-1 rounded-full bg-text-primary text-bg-primary"
              : "text-xs px-3 py-1 rounded-full bg-surface/60 text-ink-muted hover:text-ink transition-colors"
          }
        >
          {tag}
        </Link>
      ))}
    </div>
  )
}
