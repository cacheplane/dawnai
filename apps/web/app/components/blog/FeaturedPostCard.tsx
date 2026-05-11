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

export function FeaturedPostCard({ post }: { readonly post: Post }) {
  const author: Author = AUTHORS[post.author] ?? {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  }
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="block p-8 rounded-2xl border border-accent-amber/35 mb-6 transition-transform hover:scale-[1.005]"
      style={{ background: "linear-gradient(180deg,#fff7e0 0%,#ffeec2 100%)" }}
    >
      <span className="text-[11px] uppercase tracking-widest text-accent-amber-deep">
        Essay · {post.readingTimeMinutes} min read
      </span>
      <h2
        className="font-display text-2xl md:text-3xl font-semibold mt-2 mb-2 tracking-tight"
        style={{ color: "#1a1530" }}
      >
        {post.title}
      </h2>
      <p className="text-base mb-4 leading-relaxed" style={{ color: "#6d5638" }}>
        {post.description}
      </p>
      <div className="text-xs" style={{ color: "#8a7657" }}>
        {formatDate(post.date)} · {author.name}
      </div>
    </Link>
  )
}
