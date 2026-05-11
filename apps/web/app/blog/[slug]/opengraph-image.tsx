import { ImageResponse } from "next/og"
import { getAllPosts, getPost } from "../../components/blog/post-index"

export const contentType = "image/png"
export const size = { width: 1200, height: 630 }

export function generateImageParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }))
}

export default async function Image({ params }: { params: { slug: string } }) {
  const post = getPost(params.slug)
  const title = post?.title ?? "Dawn"
  const eyebrow =
    post?.type === "release" ? `Release · v${post.version}` : "Essay"

  return new ImageResponse(
    (
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
          fontFamily: "system-ui",
        }}
      >
        <div style={{ fontSize: 22, letterSpacing: 4, textTransform: "uppercase", color: "#8a7657" }}>
          {eyebrow}
        </div>
        <div
          style={{
            fontSize: 84,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            maxWidth: "1040px",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 24, color: "#6d5638" }}>dawnai.org/blog</div>
      </div>
    ),
    size,
  )
}
