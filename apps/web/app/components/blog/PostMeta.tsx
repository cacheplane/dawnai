import Image from "next/image"
import Link from "next/link"
import { AUTHORS, type Author, type Post } from "./post-index"

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function PostMeta({ post }: { readonly post: Post }) {
  const author: Author = AUTHORS[post.author] ?? {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  }
  return (
    <div className="flex flex-col gap-6 text-sm">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">Published</div>
        <div className="text-ink">{formatDate(post.date)}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">Reading time</div>
        <div className="text-ink">{post.readingTimeMinutes} min</div>
      </div>
      {post.tags.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">Tags</div>
          <div className="flex flex-wrap gap-1.5">
            {post.tags.map((tag) => (
              <Link
                key={tag}
                href={`/blog/tags/${tag}`}
                className="text-xs px-2 py-0.5 rounded-full bg-surface/60 text-ink-muted hover:text-accent-saas transition-colors"
              >
                {tag}
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="pt-4 border-t border-divider">
        <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">Author</div>
        <div className="flex items-center gap-3">
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
            className="text-ink hover:text-accent-saas transition-colors"
          >
            {author.name}
          </a>
        </div>
      </div>
    </div>
  )
}
