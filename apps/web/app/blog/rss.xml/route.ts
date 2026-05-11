import { getAllPosts } from "../../components/blog/post-index"
import { buildRssFeed } from "../../components/blog/rss-feed"

const SITE_URL = "https://dawnai.org"

export function GET() {
  const xml = buildRssFeed(getAllPosts(), { siteUrl: SITE_URL })
  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  })
}
