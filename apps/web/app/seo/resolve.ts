import type { Metadata } from "next"
import { AUTHORS, type Post } from "../components/blog/post-index"
import { STATIC_LASTMOD } from "./lastmod.generated"
import { requireValidLastModified, STATIC_SEO_PAGES } from "./registry"
import { SOCIAL_CARD, SOCIAL_IMAGE, SOCIAL_SITE_NAME } from "./social"
import type {
  BlogPostingSeoPage,
  CollectionPageSeoPage,
  SeoPage,
  TechArticleSeoPage,
} from "./types"

const SITE_URL = "https://dawnai.org"
const BLOG_INDEX_DESCRIPTION =
  "Writing on the agent stack, type-safety, and the tools we're building."

export function resolveStaticSeoPage(path: string): TechArticleSeoPage | undefined {
  return STATIC_SEO_PAGES[path]
}

export function resolveBlogIndexSeoPage(): CollectionPageSeoPage {
  const path = "/blog"
  return {
    path,
    canonical: `${SITE_URL}${path}`,
    title: "Blog",
    description: BLOG_INDEX_DESCRIPTION,
    kind: "CollectionPage",
    breadcrumbs: [{ label: "Home", href: "/" }, { label: "Blog" }],
    lastModified: requireValidLastModified(STATIC_LASTMOD, path),
    alternateTypes: { "application/rss+xml": "/blog/rss.xml" },
  }
}

function tagDescription(tag: string, posts: readonly Post[]): string {
  const noun = posts.length === 1 ? "post" : "posts"
  const withTitles = `Read ${posts.length} Dawn blog ${noun} tagged "${tag}": ${posts
    .map((post) => post.title)
    .join("; ")}.`
  if (withTitles.length <= 155) return withTitles

  return `Read ${posts.length} published Dawn blog ${noun} tagged "${tag}", selected from the current production-visible article collection.`
}

export function resolveBlogTagSeoPage(tag: string, posts: readonly Post[]): CollectionPageSeoPage {
  if (posts.length === 0) throw new Error(`Cannot resolve an empty blog tag page: ${tag}`)

  const path = `/blog/tags/${tag}`
  const title = `Posts tagged ${tag}`
  return {
    path,
    canonical: `${SITE_URL}${path}`,
    title,
    description: tagDescription(tag, posts),
    kind: "CollectionPage",
    breadcrumbs: [{ label: "Home", href: "/" }, { label: "Blog", href: "/blog" }, { label: title }],
    lastModified: requireValidLastModified(STATIC_LASTMOD, path),
  }
}

export function resolveBlogSeoPage(post: Post): BlogPostingSeoPage {
  const path = `/blog/${post.slug}`
  const author = AUTHORS[post.author]
  if (!author) throw new Error(`Unknown blog author: ${post.author}`)

  return {
    path,
    canonical: `${SITE_URL}${path}`,
    title: post.title,
    description: post.description,
    kind: "BlogPosting",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: "Blog", href: "/blog" },
      { label: post.title },
    ],
    lastModified: new Date(`${post.date}T00:00:00Z`).toISOString(),
    datePublished: post.date,
    author,
    ...(post.ogImage !== undefined ? { socialImage: post.ogImage } : {}),
  }
}

export function toMetadata(page: SeoPage | undefined): Metadata {
  if (!page) return {}

  const images =
    page.socialImage !== undefined
      ? [page.socialImage]
      : page.kind === "BlogPosting"
        ? undefined
        : [SOCIAL_IMAGE]
  const articleFields =
    page.kind === "BlogPosting"
      ? { publishedTime: page.datePublished, authors: [page.author.name] }
      : {}

  return {
    title: page.title,
    description: page.description,
    alternates: {
      canonical: page.canonical,
      ...(page.alternateTypes !== undefined ? { types: page.alternateTypes } : {}),
    },
    openGraph: {
      type: page.kind === "CollectionPage" ? "website" : "article",
      url: page.canonical,
      siteName: SOCIAL_SITE_NAME,
      title: page.title,
      description: page.description,
      ...(images !== undefined ? { images } : {}),
      ...articleFields,
    },
    twitter: {
      card: SOCIAL_CARD,
      title: page.title,
      description: page.description,
      ...(images !== undefined ? { images } : {}),
    },
  }
}
