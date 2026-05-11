import type { Post } from "./post-index"

interface BuildOpts {
  readonly siteUrl: string
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function rfc822(dateIso: string): string {
  return new Date(`${dateIso}T00:00:00Z`).toUTCString()
}

export function buildRssFeed(posts: readonly Post[], opts: BuildOpts): string {
  const { siteUrl } = opts
  const items = posts
    .map((p) => {
      const url = `${siteUrl}/blog/${p.slug}`
      return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${url}</link>
      <guid>${url}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${escapeXml(p.description)}</description>
    </item>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Dawn</title>
    <link>${siteUrl}/blog</link>
    <atom:link href="${siteUrl}/blog/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Writing on the agent stack, type-safety, and the tools we're building.</description>
    <language>en</language>
${items}
  </channel>
</rss>
`
}
