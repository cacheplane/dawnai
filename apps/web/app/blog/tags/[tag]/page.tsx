import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { PostCard } from "../../../components/blog/PostCard"
import { getAllTags, getPostsByTag } from "../../../components/blog/post-index"
import { TagChips } from "../../../components/blog/TagChips"
import { FinalCta } from "../../../components/landing/FinalCta"

interface PageProps {
  readonly params: Promise<{ tag: string }>
}

export function generateStaticParams() {
  return getAllTags().map(({ tag }) => ({ tag }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tag } = await params
  return {
    title: `Posts tagged ${tag}`,
    description: `Dawn blog posts tagged ${tag}.`,
    alternates: { canonical: `https://dawnai.org/blog/tags/${tag}` },
  }
}

export default async function TagPage({ params }: PageProps) {
  const { tag } = await params
  const posts = getPostsByTag(tag)
  if (posts.length === 0) notFound()
  const allTags = getAllTags().map((t) => t.tag)

  return (
    <>
      <div className="max-w-[960px] mx-auto px-6 md:px-8 py-16">
        <Link href="/blog" className="text-sm text-ink-dim hover:text-ink mb-4 inline-block">
          ← All posts
        </Link>
        <h1
          className="font-display text-4xl md:text-5xl font-semibold tracking-tight mb-8 text-ink"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Posts tagged <span className="text-accent-saas">{tag}</span>
        </h1>
        <TagChips tags={allTags} activeTag={tag} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
      <FinalCta />
    </>
  )
}
