import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FeaturedPostCard } from "./FeaturedPostCard"
import { PostCard } from "./PostCard"
import type { Post } from "./post-index"

const validPost: Post = {
  slug: "valid-slug",
  title: "A valid post",
  description: "A post used to exercise blog card links.",
  date: "2026-08-24",
  tags: ["patterns"],
  type: "post",
  author: "brian",
  draft: false,
  readingTimeMinutes: 2,
  sourceFile: "2026-08-24-valid-slug.mdx",
}

const cardCases = [
  ["standard", PostCard],
  ["featured", FeaturedPostCard],
] as const

function renderCard(Card: (props: { readonly post: Post }) => React.ReactNode, post: Post): string {
  return renderToStaticMarkup(createElement(Card, { post }))
}

describe("blog post cards", () => {
  it.each(cardCases)("renders a valid slug in the %s card href", (_name, Card) => {
    const markup = renderCard(Card, validPost)

    expect(markup).toContain('href="/blog/valid-slug"')
  })

  it.each(cardCases)("encodes an adversarial slug as one %s card route segment", (_name, Card) => {
    const adversarialPost: Post = {
      ...validPost,
      slug: '//evil.example/extra/../segment?next="javascript:alert(1)"\\target',
    }
    const markup = renderCard(Card, adversarialPost)
    const href = markup.match(/href="([^"]+)"/)?.[1]

    expect(href).toBe(`/blog/${encodeURIComponent(adversarialPost.slug)}`)
    expect(href?.match(/\//g)).toHaveLength(2)
  })
})
