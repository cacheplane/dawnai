import { FeaturedPostCard } from "../components/blog/FeaturedPostCard"
import { PostCard } from "../components/blog/PostCard"
import { getAllPosts, getAllTags, getFeaturedPost } from "../components/blog/post-index"
import { TagChips } from "../components/blog/TagChips"
import { FinalCta } from "../components/landing/FinalCta"
import { Eyebrow } from "../components/ui/Eyebrow"

export default function BlogIndexPage() {
  const all = getAllPosts()
  const featured = getFeaturedPost()
  const rest = featured ? all.filter((p) => p.slug !== featured.slug) : all
  const tags = getAllTags().map((t) => t.tag)

  return (
    <>
      <div className="max-w-[960px] mx-auto px-6 md:px-8 py-16">
        <div className="mb-2">
          <Eyebrow tone="accent">Blog</Eyebrow>
        </div>
        <h1
          className="font-display text-4xl md:text-5xl font-semibold tracking-tight mb-3 text-ink"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Notes on Dawn
        </h1>
        <p className="text-lg text-ink-muted mb-8 max-w-[60ch]">
          Writing on the agent stack, type-safety, and the tools we're building.
        </p>
        <TagChips tags={tags} />
        {featured && <FeaturedPostCard post={featured} />}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rest.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
      <FinalCta />
    </>
  )
}
