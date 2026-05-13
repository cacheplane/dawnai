import { describe, expect, it } from "vitest"
import type { Post } from "./post-index"
import { buildRssFeed } from "./rss-feed"

const samplePost: Post = {
  slug: "why-we-built-dawn",
  title: "Why we built Dawn",
  description: "Origin essay.",
  date: "2026-05-12",
  tags: ["philosophy"],
  type: "post",
  author: "brian",
  draft: false,
  readingTimeMinutes: 8,
  sourceFile: "2026-05-12-why-we-built-dawn.mdx",
}

describe("buildRssFeed", () => {
  it("includes channel metadata", () => {
    const xml = buildRssFeed([samplePost], { siteUrl: "https://dawnai.org" })
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">')
    expect(xml).toContain("<title>Dawn</title>")
    expect(xml).toContain("<link>https://dawnai.org/blog</link>")
  })

  it("includes atom:link self-reference for validator compliance", () => {
    const xml = buildRssFeed([samplePost], { siteUrl: "https://dawnai.org" })
    expect(xml).toContain(
      '<atom:link href="https://dawnai.org/blog/rss.xml" rel="self" type="application/rss+xml"/>',
    )
  })

  it("includes one item per post with required fields", () => {
    const xml = buildRssFeed([samplePost], { siteUrl: "https://dawnai.org" })
    expect(xml).toContain("<title>Why we built Dawn</title>")
    expect(xml).toContain("<link>https://dawnai.org/blog/why-we-built-dawn</link>")
    expect(xml).toContain("<guid>https://dawnai.org/blog/why-we-built-dawn</guid>")
    expect(xml).toContain("<description>Origin essay.</description>")
    expect(xml).toContain("<pubDate>")
  })

  it("escapes XML special characters", () => {
    const post: Post = { ...samplePost, title: "A & B <c>" }
    const xml = buildRssFeed([post], { siteUrl: "https://dawnai.org" })
    expect(xml).toContain("A &amp; B &lt;c&gt;")
  })
})
