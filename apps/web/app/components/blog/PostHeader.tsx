import Image from "next/image"
import Link from "next/link"
import { AUTHORS, type Author, type Post } from "./post-index"

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function PostHeader({ post }: { readonly post: Post }) {
  const eyebrow =
    post.type === "release"
      ? `Release · v${post.version}`
      : `Essay · ${post.readingTimeMinutes} min read`
  const author: Author = AUTHORS[post.author] ?? {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  }
  return (
    <header className="mb-8 pb-8 border-b border-border-subtle">
      <div className="text-[11px] uppercase tracking-widest text-text-muted mb-2">{eyebrow}</div>
      <h1
        className="font-display text-4xl md:text-5xl font-semibold tracking-tight mb-3 text-text-primary"
        style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
      >
        {post.title}
      </h1>
      <p className="text-lg text-text-secondary leading-relaxed">{post.description}</p>
      <div className="text-sm text-text-muted mt-4">{formatDate(post.date)}</div>

      {/* Mobile-only: author byline + tags. Desktop sees these in the PostMeta left rail. */}
      <div className="md:hidden mt-5 flex items-center gap-3">
        <Image
          src={author.avatar}
          alt={author.name}
          width={28}
          height={28}
          className="rounded-full"
        />
        <a
          href={author.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-text-primary hover:text-accent-amber-deep transition-colors"
        >
          {author.name}
        </a>
      </div>
      {post.tags.length > 0 && (
        <div className="md:hidden mt-3 flex flex-wrap gap-1.5">
          {post.tags.map((tag) => (
            <Link
              key={tag}
              href={`/blog/tags/${tag}`}
              className="text-xs px-2 py-0.5 rounded-full bg-bg-card/60 text-text-secondary hover:text-accent-amber-deep transition-colors"
            >
              {tag}
            </Link>
          ))}
        </div>
      )}
    </header>
  )
}
