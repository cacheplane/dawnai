import type { Post } from "./post-index"

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
    </header>
  )
}
