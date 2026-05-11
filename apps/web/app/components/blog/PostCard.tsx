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
          ? "border-border-subtle bg-bg-card/30 hover:bg-bg-card/60"
          : "border-border-subtle bg-bg-card/60 hover:border-accent-amber/40"
      }`}
    >
      {isRelease ? (
        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-accent-blue/15 text-accent-blue-deep">
          v{post.version}
        </span>
      ) : (
        <span className="text-[11px] uppercase tracking-widest text-text-muted">
          Essay · {post.readingTimeMinutes} min
        </span>
      )}
      <h3 className="font-display text-lg font-semibold text-text-primary mt-2 mb-1 leading-snug">
        {post.title}
      </h3>
      <p className="text-sm text-text-secondary leading-relaxed mb-3">{post.description}</p>
      <div className="text-xs text-text-muted">{formatDate(post.date)}</div>
    </Link>
  )
}
