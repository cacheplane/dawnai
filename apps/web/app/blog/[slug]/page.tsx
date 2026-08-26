import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { PostHeader } from "../../components/blog/PostHeader"
import { PostMeta } from "../../components/blog/PostMeta"
import { getAllPosts, getPost, getRelatedPosts } from "../../components/blog/post-index"
import { DocsTOC } from "../../components/docs/DocsTOC"
import { RelatedCards } from "../../components/docs/RelatedCards"
import { FinalCta } from "../../components/landing/FinalCta"
import { ReadingLayout } from "../../components/ReadingLayout"
import { JsonLd } from "../../seo/JsonLd"
import { resolveBlogSeoPage, toMetadata } from "../../seo/resolve"
import { blogPostingJsonLd, breadcrumbJsonLd } from "../../seo/structured-data"

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
  return toMetadata(resolveBlogSeoPage(post))
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
  const seoPage = resolveBlogSeoPage(post)

  const related = getRelatedPosts(post.slug, 2).map((p) => ({
    href: `/blog/${p.slug}`,
    title: p.title,
    subtitle: p.description,
  }))

  return (
    <>
      <JsonLd data={blogPostingJsonLd(seoPage)} />
      <JsonLd data={breadcrumbJsonLd(seoPage)} />
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
