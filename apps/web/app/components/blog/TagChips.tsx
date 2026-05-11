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
            ? "text-xs px-3 py-1 rounded-full bg-bg-card/60 text-text-secondary hover:text-text-primary transition-colors"
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
              : "text-xs px-3 py-1 rounded-full bg-bg-card/60 text-text-secondary hover:text-text-primary transition-colors"
          }
        >
          {tag}
        </Link>
      ))}
    </div>
  )
}
