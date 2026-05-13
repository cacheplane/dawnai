import Link from "next/link"
import type { Post } from "./post-index"

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function PostCard({ post }: { readonly post: Post }) {
  const isRelease = post.type === "release"
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`block p-5 rounded-xl border transition-colors ${
        isRelease
          ? "border-divider bg-surface/30 hover:bg-surface/60"
          : "border-divider bg-surface/60 hover:border-accent-saas/40"
      }`}
    >
      {isRelease ? (
        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-accent-blue/15 text-accent-blue-deep">
          v{post.version}
        </span>
      ) : (
        <span className="text-[11px] uppercase tracking-widest text-ink-dim">
          Essay · {post.readingTimeMinutes} min
        </span>
      )}
      <h3 className="font-display text-lg font-semibold text-ink mt-2 mb-1 leading-snug">
        {post.title}
      </h3>
      <p className="text-sm text-ink-muted leading-relaxed mb-3">{post.description}</p>
      <div className="text-xs text-ink-dim">{formatDate(post.date)}</div>
    </Link>
  )
}
