# Dawn Blog — Design

**Date:** 2026-05-11
**Status:** Draft
**Scope:** apps/web — new `/blog` section (index, post pages, tag pages, RSS, OG images), header/footer link, sitemap/llms.txt integration

## Problem

Dawn has a polished marketing site and reasonably complete docs, but no surface for *writing* about Dawn. We need a place to publish:

1. **Origin and philosophy essays** — why Dawn exists, what it's trying to fix.
2. **Mental-model essays** — "The App Router for AI Agents" and follow-ups.
3. **Release announcements** — version notes that read as posts, not just changelogs.

The audience is TypeScript developers evaluating agent frameworks (LangGraph, Mastra, Vercel AI SDK, etc.) who arrive cold from search, HN, or social. The blog's job is to:

- Convert cold visitors into "interested enough to read the docs" via a clear conversion path at the bottom of every post.
- Establish credibility through long-form technical writing.
- Surface release news to existing users without polluting the essay surface.

## Goals

- **Medium cadence support** — roughly weekly posts, mixed essay/release types, tag taxonomy, no series support day one (defer until needed).
- **Solo author with byline** — show "Brian Love" + avatar on each post; no dedicated author pages yet, but the data model supports adding contributors later by appending one entry.
- **Reuse, don't duplicate.** MDX rendering, code blocks, callouts, related cards, TOC component, and the bottom CTA all come from existing docs/landing components.
- **Reach-optimized.** RSS feed, per-post OG images, sitemap inclusion, llms.txt inclusion, clean canonical URLs.
- **Single conversion path.** Every post ends with the existing `<CtaSection />` (Start building / Read the docs). No newsletter, no comments, no analytics widgets in the UI.

## Non-goals

- No headless CMS. Posts live as MDX files in the repo, same as docs.
- No multi-author UI (author pages, contributor list) at launch — schema supports it; UI doesn't render it.
- No series / multi-part post support at launch.
- No comments, no Disqus, no live view counts, no email newsletter signup.
- No pagination at launch — revisit when post count exceeds ~25.
- No client-side tag filtering — tag pages are real routes.
- No date-prefixed URLs (`/blog/2026/...`) — flat slugs for SEO and shareability.

## Approach

### File and route layout

```
apps/web/
├── content/
│   └── blog/
│       ├── 2026-05-12-why-we-built-dawn.mdx
│       ├── 2026-05-19-app-router-for-ai-agents.mdx
│       └── 2026-06-02-dawn-0-4-release.mdx
└── app/
    ├── blog/
    │   ├── layout.tsx               # shared blog chrome (header link active, etc.)
    │   ├── page.tsx                 # /blog — Magazine index
    │   ├── [slug]/
    │   │   ├── page.tsx             # /blog/<slug>
    │   │   └── opengraph-image.tsx  # auto-generated OG image
    │   ├── tags/
    │   │   └── [tag]/page.tsx       # /blog/tags/<tag>
    │   └── rss.xml/route.ts         # RSS 2.0 feed
    └── components/
        └── blog/
            ├── PostCard.tsx
            ├── PostHeader.tsx
            ├── PostMeta.tsx         # left-rail meta block on post pages
            ├── FeaturedPostCard.tsx
            └── post-index.ts        # build-time post loader + helpers
```

Filenames are date-prefixed for filesystem ordering only. The route URL uses the slug portion (everything after the date prefix), so `2026-05-12-why-we-built-dawn.mdx` is served at `/blog/why-we-built-dawn`. The `date` field in frontmatter is authoritative for display and sorting — the filename prefix is just a convenience.

### Frontmatter schema

```ts
type Post = {
  slug: string              // derived from filename; URL path segment
  title: string             // H1 + <title>
  description: string       // meta description + index card subtitle (140–180 chars)
  date: string              // ISO "2026-05-12" — sort + display
  tags: string[]            // lowercase kebab-case, drawn from KNOWN_TAGS
  type: "post" | "release"  // "release" gets a version pill on the index
  version?: string          // required when type === "release"
  author: "brian"           // closed union, easy to extend
  ogImage?: string          // optional override; otherwise auto-generated
  draft?: boolean           // hidden from index/rss/sitemap in prod
  readingTimeMinutes: number  // computed at build, not authored
}
```

- `KNOWN_TAGS` is a closed const exported from `post-index.ts`: `["philosophy", "typescript", "agents", "releases", "patterns"]`. Build warns (does not fail) on unknown tags.
- `AUTHORS` is a map in `post-index.ts`: `{ brian: { name: "Brian Love", avatar: "/brand/brian.jpg", url: "https://github.com/blove" } }`.
- `readingTimeMinutes` is computed by `post-index.ts` from the MDX source (≈225 wpm), not authored in frontmatter.
- Posts of `type: "release"` are auto-tagged with `"releases"` if the tag is missing.

### `post-index.ts` — build-time loader

A single module that reads `content/blog/*.mdx` at build time and exposes:

```ts
export const KNOWN_TAGS: readonly string[]
export const AUTHORS: Record<string, { name: string; avatar: string; url: string }>
export function getAllPosts(opts?: { includeDrafts?: boolean }): Post[]
export function getPost(slug: string): Post | null
export function getPostsByTag(tag: string): Post[]
export function getRelatedPosts(slug: string, limit?: number): Post[]
export function getAllTags(): { tag: string; count: number }[]
```

All listing routes, RSS, sitemap, and `generateStaticParams` go through this module. Drafts are included only in `NODE_ENV !== "production"`.

### Index page (`/blog`)

The "Magazine" layout chosen during brainstorming:

- **Header strip** — page title "Notes on Dawn", one-line subtitle, tag chip row (active tag = `All`).
- **Featured slot** — the most recent post with `type === "post"` (skipped only if no essay exists). Rendered as a tinted hero card with a 1px amber border, gradient `#fff7e0 → #ffeec2` background, type/read-time eyebrow, title, description, date + byline.
- **Grid below featured** — two columns ≥ md, single column mobile. `PostCard` shows: type badge (essay eyebrow or `v0.4.0` pill), title, description, date + read-time. No images in cards.
- **Releases inline**, visually de-emphasized: lighter card border, version pill replaces the essay eyebrow. Releases are never eligible for the featured slot.
- **Bottom**: `<CtaSection />` (existing component, imported as-is).

### Post page (`/blog/<slug>`)

The three-column grid currently lives in `app/docs/layout.tsx`. To reuse it without coupling docs and blog routes, extract the bare grid shell into `app/components/ReadingLayout.tsx` (props: `left`, `right`, `children`) and have both `app/docs/layout.tsx` and `app/blog/[slug]/page.tsx` compose it. The post page renders `ReadingLayout` followed by `<CtaSection />` as a sibling — the CTA sits full-width below the grid because it's outside it. `app/blog/layout.tsx` stays minimal (just header/footer chrome inherited from the root layout — no grid).

Grid contents on the post page (`240px | content | 240px`):

- **Left rail**: a sticky `PostMeta` block — date, read-time, tag chips, byline (avatar + name). Replaces `DocsSidebar`. On mobile, `PostMeta` collapses into the post header above the title.
- **Center column** (max 760px, identical to docs): `PostHeader` (eyebrow "Essay · 8 min read" or "Release · v0.4.0", H1 title, lede paragraph from `description`) followed by the MDX body. MDX rendering uses the existing `mdx-components.tsx` (Callout, CodeGroup, Steps, Tabs, Shiki, RehypeFigure).
- **Right rail**: existing `DocsTOC` component, reused unchanged.
- **Below content** (still inside the center column): `<RelatedCards />` with 2 related posts (selected by tag overlap, falling back to most recent). Then `<CtaSection />` rendered full-width below the three-column grid.

### Tag page (`/blog/tags/<tag>`)

Reuses the index Magazine components with these differences:

- No featured slot.
- Header reads "Posts tagged **<tag>**" with a small `← All posts` link.
- Static-generated via `generateStaticParams` from `getAllTags()`.

### RSS feed (`/blog/rss.xml`)

Next route handler returning RSS 2.0 XML. Includes:

- Channel: `title="Dawn"`, `description`, `link="https://dawnai.org/blog"`, `language="en"`.
- Item per non-draft post: `title`, `link` (absolute), `guid` (= link), `pubDate` (RFC 822), `description` (frontmatter description only — full content omitted at launch, revisit if requested).

### OG images (`opengraph-image.tsx`)

Per-slug `app/blog/[slug]/opengraph-image.tsx` using Next's `ImageResponse`:

- 1200×630, brand background: amber gradient + dot grid matching `CtaSection`.
- Title in Fraunces (loaded via `@vercel/og` font loader) up to 3 lines, then ellipsis.
- Eyebrow text: "Essay" or "Release · v0.4.0".
- Footer: "dawnai.org/blog".
- Frontmatter `ogImage` (when set) bypasses the generated image; `generateMetadata` returns that URL instead.

### Navigation

- `Header` gets a "Blog" link between "Docs" and the right-side actions. Active when `pathname.startsWith("/blog")`.
- `Footer` gets a "Blog" link in the existing primary column and an RSS icon link pointing at `/blog/rss.xml`.

### Sitemap and llms.txt

- Extend `apps/web/app/sitemap.ts` (or equivalent) to include `/blog`, every post URL, and every tag URL. Drafts excluded.
- Extend the existing `llms.txt` / `llms-full.txt` generator scripts to include blog posts (title + URL + description in `llms.txt`; full content in `llms-full.txt`).

### Metadata per post

`generateMetadata({ params })` for `/blog/[slug]`:

- `title` (post title), `description`, `alternates.canonical` = absolute post URL.
- `openGraph`: type `article`, `publishedTime`, `authors`, `images` (pointing at the generated or override OG image), `siteName: "Dawn AI"`.
- `twitter`: `card: "summary_large_image"`, `images`.

## Components reused (not built)

- `mdx-components.tsx` — all MDX renderers.
- `DocsTOC` — sticky right-rail TOC.
- `RelatedCards` — bottom-of-post cards.
- `CtaSection` — bottom CTA strip.
- `Header`, `Footer` — only modifications are adding a "Blog" link.

## Components introduced

- `app/components/blog/PostCard.tsx`
- `app/components/blog/PostHeader.tsx`
- `app/components/blog/PostMeta.tsx`
- `app/components/blog/FeaturedPostCard.tsx`
- `app/components/blog/post-index.ts`
- `app/blog/layout.tsx`, `app/blog/page.tsx`, `app/blog/[slug]/page.tsx`, `app/blog/[slug]/opengraph-image.tsx`, `app/blog/tags/[tag]/page.tsx`, `app/blog/rss.xml/route.ts`

## Launch content

Three posts authored alongside the implementation:

1. **"Why we built Dawn"** — origin essay. Type `post`, tags `["philosophy"]`.
2. **"The App Router for AI Agents"** — mental-model essay. Type `post`, tags `["philosophy", "typescript", "agents"]`.
3. **"Dawn 0.x release"** — version announcement. Type `release`, version set from current Dawn version, tags `["releases"]` (auto).

Content for these three posts is in scope of the implementation plan; the prose itself can be drafted iteratively but at least placeholder MDX must ship so the blog is non-empty on launch.

## Testing

- **Build smoke test** — `next build` must succeed with at least one post of each type.
- **Static type check** — frontmatter is parsed into the `Post` type; `post-index.ts` exports are typed.
- **Link audit** — extend the existing link-audit script to crawl `/blog`, `/blog/<slug>` for each post, and tag pages.
- **RSS validity** — a small unit test that parses the generated XML and asserts required channel/item fields exist.
- **Sitemap inclusion** — assert post URLs appear in the generated sitemap.
- **No visual regression test** for the index/post layouts in this pass; rely on the existing `biome` and `tsc` gates.

## Open questions

None blocking. Defaults to revisit after launch:

- RSS body: description-only vs full content (default: description-only).
- Pagination on the index (default: none until >25 posts).
- Series support (default: not built; add when a real series is being written).
- Author pages (default: not built; add when a second author joins).
