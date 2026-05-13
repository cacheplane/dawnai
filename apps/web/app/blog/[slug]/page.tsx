import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { PostHeader } from "../../components/blog/PostHeader"
import { PostMeta } from "../../components/blog/PostMeta"
import { getAllPosts, getPost, getRelatedPosts } from "../../components/blog/post-index"
import { DocsTOC } from "../../components/docs/DocsTOC"
import { RelatedCards } from "../../components/docs/RelatedCards"
import { FinalCta } from "../../components/landing-v2/FinalCta"
import { ReadingLayout } from "../../components/ReadingLayout"

interface PageProps {
  readonly params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) return {}
  const url = `https://dawnai.org/blog/${post.slug}`
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      title: post.title,
      description: post.description,
      publishedTime: post.date,
      authors: [post.author],
      siteName: "Dawn AI",
      ...(post.ogImage && { images: [post.ogImage] }),
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      ...(post.ogImage && { images: [post.ogImage] }),
    },
  }
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()

  // Dynamic import resolves at build time because generateStaticParams enumerates slugs.
  // post.sourceFile is the on-disk filename — authoritative even if frontmatter date drifts.
  const mod = (await import(`../../../content/blog/${post.sourceFile}`)) as {
    default: React.ComponentType
  }
  const MdxContent = mod.default

  const related = getRelatedPosts(post.slug, 2).map((p) => ({
    href: `/blog/${p.slug}`,
    title: p.title,
    subtitle: p.description,
  }))

  return (
    <>
      <ReadingLayout left={<PostMeta post={post} />} right={<DocsTOC />}>
        <article className="prose-dawn">
          <PostHeader post={post} />
          <MdxContent />
          {related.length > 0 && (
            <div className="mt-16">
              <RelatedCards items={related} />
            </div>
          )}
        </article>
      </ReadingLayout>
      <FinalCta />
    </>
  )
}
