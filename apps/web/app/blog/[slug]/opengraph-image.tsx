import { ImageResponse } from "next/og"
import { getAuthoredPosts, getPost, selectVisiblePosts } from "../../components/blog/post-index"

export const contentType = "image/png"
export const size = { width: 1200, height: 630 }

export function generateImageParams(currentDate = new Date().toISOString().slice(0, 10)) {
  return selectVisiblePosts(getAuthoredPosts(), currentDate).map((post) => ({ slug: post.slug }))
}

// Next's metadata-route loader recognizes this export and prerenders the known slugs.
export function generateStaticParams() {
  return generateImageParams()
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getPost(slug)
  const title = post?.title ?? "Dawn"
  const type = post?.type === "release" ? `Release · v${post.version}` : "Essay"
  const eyebrow = post ? `${type} · ${post.date}` : type

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
          fontSize: 84,
          fontWeight: 600,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          maxWidth: "1040px",
          fontFamily: "ui-serif, Georgia, serif",
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 24, color: "#6d5638" }}>dawnai.org/blog</div>
    </div>,
    { ...size },
  )
}
