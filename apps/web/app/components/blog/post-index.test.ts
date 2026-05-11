import { describe, expect, it } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { loadPostsFromDir } from "./post-index"

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
date: 2026-06-02
tags: []
type: release
version: 0.4.0
author: brian
---

Release body.
`

describe("loadPostsFromDir", () => {
  it("parses frontmatter and returns sorted posts (newest first)", () => {
    withFixture(
      {
        "2026-05-12-why-we-built-dawn.mdx": samplePost,
        "2026-06-02-dawn-0-4.mdx": sampleRelease,
      },
      (dir) => {
        const posts = loadPostsFromDir(dir, { includeDrafts: false })
        expect(posts).toHaveLength(2)
        expect(posts[0]!.slug).toBe("dawn-0-4")
        expect(posts[1]!.slug).toBe("why-we-built-dawn")
      },
    )
  })

  it("derives slug from filename by stripping leading date prefix", () => {
    withFixture({ "2026-05-12-why-we-built-dawn.mdx": samplePost }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p!.slug).toBe("why-we-built-dawn")
    })
  })

  it("computes reading time from body word count", () => {
    withFixture({ "2026-05-12-why-we-built-dawn.mdx": samplePost }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p!.readingTimeMinutes).toBeGreaterThanOrEqual(1)
    })
  })

  it("auto-tags releases with 'releases' when missing", () => {
    withFixture({ "2026-06-02-dawn-0-4.mdx": sampleRelease }, (dir) => {
      const [p] = loadPostsFromDir(dir, { includeDrafts: false })
      expect(p!.tags).toContain("releases")
      expect(p!.type).toBe("release")
      expect(p!.version).toBe("0.4.0")
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
})
