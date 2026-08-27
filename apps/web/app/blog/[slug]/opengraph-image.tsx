import { notFound } from "next/navigation"
import { ImageResponse } from "next/og"
import { getAuthoredPosts, selectVisiblePosts } from "../../components/blog/post-index"

export const contentType = "image/png"
export const size = { width: 1200, height: 630 }
export const alt = "Dawn blog post title, type, and publication date"

function visiblePosts(currentDate: string, posts = getAuthoredPosts()) {
  return selectVisiblePosts(posts, currentDate)
}

export function generateImageParamsForDate(currentDate: string, posts = getAuthoredPosts()) {
  return visiblePosts(currentDate, posts).map((post) => ({ slug: post.slug }))
}

export function generateImageParams() {
  return generateImageParamsForDate(new Date().toISOString().slice(0, 10))
}

// Next's metadata-route loader recognizes this export and prerenders the known slugs.
export function generateStaticParams() {
  return generateImageParams()
}

interface BlogImageContent {
  readonly title: string
  readonly date: string
  readonly type: "post" | "release"
  readonly version?: string
}

export function titleFontSize(title: string): number {
  if (title.length <= 48) return 84
  if (title.length <= 72) return 74
  if (title.length <= 110) return 64
  return 54
}

export function renderBlogImage(post: BlogImageContent) {
  const type = post.type === "release" ? `Release · v${post.version}` : "Essay"
  const eyebrow = `${type} · ${post.date}`
  const fontSize = titleFontSize(post.title)

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "80px",
        background: "linear-gradient(180deg,#fff7e0 0%,#ffe2a8 100%)",
        color: "#1a1530",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 22,
          letterSpacing: 4,
          textTransform: "uppercase",
          color: "#8a7657",
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          display: "flex",
          fontSize,
          fontWeight: 600,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          maxHeight: "350px",
          maxWidth: "1040px",
          overflow: "hidden",
          wordBreak: "break-word",
          fontFamily: "ui-serif, Georgia, serif",
        }}
      >
        {post.title}
      </div>
      <div style={{ fontSize: 24, color: "#6d5638" }}>dawnai.org/blog</div>
    </div>,
    { ...size },
  )
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = visiblePosts(new Date().toISOString().slice(0, 10)).find(
    (candidate) => candidate.slug === slug,
  )
  if (!post) notFound()

  return renderBlogImage(post)
}
