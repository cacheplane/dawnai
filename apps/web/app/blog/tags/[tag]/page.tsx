import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { PostCard } from "../../../components/blog/PostCard"
import { getAllTags, getPostsByTag } from "../../../components/blog/post-index"
import { TagChips } from "../../../components/blog/TagChips"
import { FinalCta } from "../../../components/landing/FinalCta"
import { JsonLd } from "../../../seo/JsonLd"
import { resolveBlogTagSeoPage, toMetadata } from "../../../seo/resolve"
import { breadcrumbJsonLd, collectionPageJsonLd } from "../../../seo/structured-data"

interface PageProps {
  readonly params: Promise<{ tag: string }>
}

export function generateStaticParams() {
  return getAllTags().map(({ tag }) => ({ tag }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tag } = await params
  const posts = getPostsByTag(tag)
  return posts.length === 0 ? {} : toMetadata(resolveBlogTagSeoPage(tag, posts))
}

export default async function TagPage({ params }: PageProps) {
  const { tag } = await params
  const posts = getPostsByTag(tag)
  if (posts.length === 0) notFound()
  const allTags = getAllTags().map((t) => t.tag)
  const seoPage = resolveBlogTagSeoPage(tag, posts)

  return (
    <>
      <JsonLd data={collectionPageJsonLd(seoPage)} />
      <JsonLd data={breadcrumbJsonLd(seoPage)} />
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
