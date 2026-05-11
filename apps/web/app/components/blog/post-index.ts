import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"
import readingTime from "reading-time"

export const KNOWN_TAGS = [
  "philosophy",
  "typescript",
  "agents",
  "releases",
  "patterns",
] as const

export type KnownTag = (typeof KNOWN_TAGS)[number]

export interface Author {
  readonly name: string
  readonly avatar: string
  readonly url: string
}

export const AUTHORS: Readonly<Record<string, Author>> = {
  brian: {
    name: "Brian Love",
    avatar: "/brand/brian.jpg",
    url: "https://github.com/blove",
  },
}

export type AuthorId = keyof typeof AUTHORS

export type PostType = "post" | "release"

export interface Post {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly date: string
  readonly tags: readonly string[]
  readonly type: PostType
  readonly version?: string
  readonly author: AuthorId
  readonly ogImage?: string
  readonly draft: boolean
  readonly readingTimeMinutes: number
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/

function slugFromFilename(filename: string): string {
  return filename.replace(/\.mdx?$/, "").replace(DATE_PREFIX, "")
}

interface Frontmatter {
  title: string
  description: string
  date: string | Date
  tags?: string[]
  type?: PostType
  version?: string
  author?: AuthorId
  ogImage?: string
  draft?: boolean
  slug?: string
}

function parsePost(filename: string, raw: string): Post {
  const { data, content } = matter(raw)
  const fm = data as Frontmatter

  if (!fm.title || !fm.description || !fm.date || !fm.author) {
    throw new Error(`Post ${filename} is missing required frontmatter (title/description/date/author)`)
  }

  const type: PostType = fm.type ?? "post"
  const rawTags = (fm.tags ?? []).map((t) => t.toLowerCase())
  const tags =
    type === "release" && !rawTags.includes("releases") ? [...rawTags, "releases"] : rawTags

  // Warn (don't fail) on unknown tags so experimentation isn't blocked
  for (const tag of tags) {
    if (!(KNOWN_TAGS as readonly string[]).includes(tag)) {
      console.warn(`[blog] Unknown tag "${tag}" in ${filename}. Add to KNOWN_TAGS if intentional.`)
    }
  }

  if (type === "release" && !fm.version) {
    throw new Error(`Release post ${filename} is missing required "version" frontmatter`)
  }

  // gray-matter parses YAML date scalars as JS Date objects; normalise to YYYY-MM-DD string.
  const dateStr =
    fm.date instanceof Date
      ? fm.date.toISOString().slice(0, 10)
      : String(fm.date).slice(0, 10)

  const stats = readingTime(content)
  return {
    slug: fm.slug ?? slugFromFilename(filename),
    title: fm.title,
    description: fm.description,
    date: dateStr,
    tags,
    type,
    ...(fm.version !== undefined && { version: fm.version }),
    author: fm.author,
    ...(fm.ogImage !== undefined && { ogImage: fm.ogImage }),
    draft: fm.draft === true,
    readingTimeMinutes: Math.max(1, Math.round(stats.minutes)),
  }
}

export function loadPostsFromDir(
  dir: string,
  opts: { includeDrafts: boolean },
): Post[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mdx"))
  const posts = files.map((f) => parsePost(f, readFileSync(join(dir, f), "utf8")))
  const visible = opts.includeDrafts ? posts : posts.filter((p) => !p.draft)
  return visible.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

const CONTENT_DIR = join(process.cwd(), "content", "blog")

let cache: Post[] | null = null

function loadAll(): Post[] {
  if (cache) return cache
  cache = loadPostsFromDir(CONTENT_DIR, {
    includeDrafts: process.env.NODE_ENV !== "production",
  })
  return cache
}

export function getAllPosts(): readonly Post[] {
  return loadAll()
}

export function getPost(slug: string): Post | null {
  return loadAll().find((p) => p.slug === slug) ?? null
}

export function getPostsByTag(tag: string): readonly Post[] {
  return loadAll().filter((p) => p.tags.includes(tag))
}

export function getAllTags(): readonly { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of loadAll()) {
    for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

export function getRelatedPosts(slug: string, limit = 2): readonly Post[] {
  const current = getPost(slug)
  if (!current) return []
  const others = loadAll().filter((p) => p.slug !== slug)
  const scored = others.map((p) => ({
    post: p,
    score: p.tags.filter((t) => current.tags.includes(t)).length,
  }))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.post.date < b.post.date ? 1 : -1
  })
  return scored.slice(0, limit).map((s) => s.post)
}

export function getFeaturedPost(): Post | null {
  return loadAll().find((p) => p.type === "post") ?? null
}
