import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { collectPostTags, loadPostsFromDir, type Post, selectVisiblePosts } from "./post-index"

function withFixture(files: Record<string, string>, run: (dir: string) => void) {
  const dir = join(tmpdir(), `blog-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf8")
    }
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const samplePost = `---
title: Why we built Dawn
description: Origin essay about the framework.
date: 2026-05-12
tags: [philosophy]
type: post
author: brian
---

# Why we built Dawn

Words here. ${"word ".repeat(200)}
`

const sampleRelease = `---
title: Dawn 0.4
description: Release notes.
date: 2026-05-18
tags: []
type: release
version: 0.4.0
author: brian
---

Release body.
`

function withFrontmatterSlug(slug: unknown): string {
  return samplePost.replace(
    "tags: [philosophy]",
    `tags: [philosophy]\nslug: ${JSON.stringify(slug)}`,
  )
}

function expectInvalidSlug(filename: string, raw: string): void {
  withFixture({ [filename]: raw }, (dir) => {
    let caught: unknown
    try {
      loadPostsFromDir(dir, { includeDrafts: false })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(`Post ${filename} has an invalid slug`)
  })
}

const invalidFrontmatterSlugs = [
  ["protocol-like text", "https://evil.example/post"],
  ["network-path text", "//evil.example/post"],
  ["a single quote", "single'quote"],
  ["a double quote", 'double"quote'],
  ["a backslash", "path\\segment"],
  ["a current-directory dot segment", "."],
  ["a parent-directory dot segment", ".."],
  ["a control character", "line\nbreak"],
  ["uppercase text", "Uppercase"],
  ["a leading hyphen", "-leading"],
  ["a trailing hyphen", "trailing-"],
  ["repeated hyphens", "repeated--hyphens"],
] as const

const invalidFilenameSlugs = [
  ["protocol-like text", "https:evil.example.mdx"],
  ["an encoded network path", "%2F%2Fevil.example.mdx"],
  ["a single quote", "single'quote.mdx"],
  ["a double quote", 'double"quote.mdx'],
  ["a backslash", "path\\segment.mdx"],
  ["a current-directory dot segment", "..mdx"],
  ["a parent-directory dot segment", "...mdx"],
  ["a control character", "line\nbreak.mdx"],
  ["uppercase text", "Uppercase.mdx"],
  ["a leading hyphen", "-leading.mdx"],
  ["a trailing hyphen", "trailing-.mdx"],
  ["repeated hyphens", "repeated--hyphens.mdx"],
] as const

describe("loadPostsFromDir", () => {
  it("selects scheduled posts on their UTC publication date while always excluding drafts", () => {
    const scheduled = `---
title: Scheduled post
description: A scheduled article with a unique production description for visibility testing.
date: 2026-09-01
tags: [scheduled]
type: post
author: brian
---

Scheduled body.
`
    const draft = scheduled
      .replace("title: Scheduled post", "title: Scheduled draft")
      .replace("date: 2026-09-01", "date: 2026-08-01\ndraft: true")
    withFixture(
      {
        "2026-09-01-scheduled-post.mdx": scheduled,
        "2026-08-01-scheduled-draft.mdx": draft,
      },
      (dir) => {
        const authored = loadPostsFromDir(dir, { includeDrafts: true })
        expect(selectVisiblePosts(authored, "2026-08-31").map(({ slug }) => slug)).toEqual([])
        expect(selectVisiblePosts(authored, "2026-09-01").map(({ slug }) => slug)).toEqual([
          "scheduled-post",
        ])
        expect(selectVisiblePosts(authored, "2026-09-02").map(({ slug }) => slug)).toEqual([
          "scheduled-post",
        ])
      },
    )
  })

  it("publishes a tag only when a post visible on the selected date owns it", () => {
    const scheduled: Post = {
      slug: "scheduled-post",
      title: "Scheduled post",
      description:
        "A scheduled article with a unique production description for visibility testing.",
      date: "2026-09-01",
      tags: ["scheduled"],
      type: "post",
      author: "brian",
      draft: false,
      readingTimeMinutes: 1,
      sourceFile: "2026-09-01-scheduled-post.mdx",
    }
    const draft: Post = {
      ...scheduled,
      slug: "scheduled-draft",
      title: "Scheduled draft",
      tags: ["draft-only"],
      draft: true,
      sourceFile: "2026-09-01-scheduled-draft.mdx",
    }
    expect(collectPostTags(selectVisiblePosts([scheduled, draft], "2026-08-31"))).toEqual([])
    expect(collectPostTags(selectVisiblePosts([scheduled, draft], "2026-09-01"))).toEqual([
      "scheduled",
    ])
    expect(collectPostTags(selectVisiblePosts([scheduled, draft], "2026-09-02"))).toEqual([
      "scheduled",
    ])
  })

  it("exposes authored posts independently of the production route cache", async () => {
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")

    try {
      const { getAllPosts, getAuthoredPosts } = await import("./post-index")
      const authored = getAuthoredPosts()
      const production = getAllPosts()

      expect(authored.some((post) => post.draft)).toBe(true)
      expect(production.every((post) => !post.draft)).toBe(true)
      expect(authored.length).toBeGreaterThan(production.length)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it("parses frontmatter and returns sorted posts (newest first)", () => {
    withFixture(
      {
        "2026-05-12-why-we-built-dawn.mdx": samplePost,
        "2026-06-02-dawn-0-4.mdx": sampleRelease,
      },
      (dir) => {
        const posts = loadPostsFromDir(dir, { includeDrafts: false })
        expect(posts).toHaveLength(2)
        expect(posts[0]?.slug).toBe("dawn-0-4")
        expect(posts[1]?.slug).toBe("why-we-built-dawn")
      },
    )
  })

  it("derives slug from filename by stripping leading date prefix", () => {
    withFixture({ "2026-05-12-why-we-built-dawn.mdx": samplePost }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p?.slug).toBe("why-we-built-dawn")
    })
  })

  it.each([
    [
      "frontmatter",
      "2026-05-12-source-post.mdx",
      withFrontmatterSlug("valid-explicit-123"),
      "valid-explicit-123",
    ],
    ["filename", "2026-05-12-valid-derived-123.mdx", samplePost, "valid-derived-123"],
  ])("round-trips a valid lowercase %s slug", (_source, filename, raw, expectedSlug) => {
    withFixture({ [filename]: raw }, (dir) => {
      const [post] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(post?.slug).toBe(expectedSlug)
    })
  })

  it.each(invalidFrontmatterSlugs)(
    "rejects frontmatter slugs containing %s without echoing the value",
    (_description, slug) => {
      expectInvalidSlug("2026-05-12-source-post.mdx", withFrontmatterSlug(slug))
    },
  )

  it.each([
    ["null", null],
    ["a number", 123],
  ])("rejects %s as a non-string frontmatter slug", (_description, slug) => {
    expectInvalidSlug("2026-05-12-source-post.mdx", withFrontmatterSlug(slug))
  })

  it.each(invalidFilenameSlugs)(
    "rejects filename-derived slugs containing %s",
    (_description, filename) => {
      expectInvalidSlug(filename, samplePost)
    },
  )

  it("preserves the on-disk filename as sourceFile", () => {
    withFixture({ "2026-05-12-why-we-built-dawn.mdx": samplePost }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p?.sourceFile).toBe("2026-05-12-why-we-built-dawn.mdx")
    })
  })

  it("computes reading time from body word count", () => {
    withFixture({ "2026-05-12-why-we-built-dawn.mdx": samplePost }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p?.readingTimeMinutes).toBeGreaterThanOrEqual(1)
    })
  })

  it("auto-tags releases with 'releases' when missing", () => {
    withFixture({ "2026-06-02-dawn-0-4.mdx": sampleRelease }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p?.tags).toContain("releases")
      expect(p?.type).toBe("release")
      expect(p?.version).toBe("0.4.0")
    })
  })

  it("excludes drafts when includeDrafts is false", () => {
    const draft = `---
title: Draft
description: x
date: 2026-05-01
tags: []
type: post
author: brian
draft: true
---

Body
`
    withFixture({ "2026-05-01-draft.mdx": draft }, (dir) => {
      expect(loadPostsFromDir(dir, { includeDrafts: false })).toHaveLength(0)
      expect(loadPostsFromDir(dir, { includeDrafts: true })).toHaveLength(1)
    })
  })

  it("excludes future-dated posts when includeDrafts is false", () => {
    const future = `---
title: Future post
description: Not published yet.
date: 2026-06-02
tags: []
type: post
author: brian
---

Body
`
    withFixture({ "2026-06-02-future.mdx": future }, (dir) => {
      expect(
        loadPostsFromDir(dir, {
          currentDate: "2026-05-18",
          includeDrafts: false,
        }),
      ).toHaveLength(0)
      expect(
        loadPostsFromDir(dir, {
          currentDate: "2026-05-18",
          includeDrafts: true,
        }),
      ).toHaveLength(1)
    })
  })
})
