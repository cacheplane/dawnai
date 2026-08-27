import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { Post } from "../../components/blog/post-index"

type ImageModule = typeof import("./opengraph-image")

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CURRENT_PRODUCTION_SLUGS = [
  "eve-validates-the-shape",
  "app-router-for-ai-agents",
  "why-we-built-dawn",
] as const

const nativeFetch = globalThis.fetch
const remoteUrls: string[] = []
let imageModule: ImageModule

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input)
      if (/^https?:\/\//.test(url)) {
        remoteUrls.push(url)
        return Promise.reject(new Error("OG images must render offline"))
      }
      return nativeFetch(input, init)
    }),
  )
  imageModule = await import("./opengraph-image")
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe("blog Open Graph images", () => {
  it("enumerates every current production-visible post and no drafts", () => {
    expect(imageModule.generateImageParams()).toEqual(
      CURRENT_PRODUCTION_SLUGS.map((slug) => ({ slug })),
    )
  })

  it("uses an injected UTC date for before, on, and after publication boundaries", () => {
    const generateForDate = (
      imageModule as ImageModule & {
        generateImageParamsForDate?: (currentDate: string) => readonly { slug: string }[]
      }
    ).generateImageParamsForDate

    expect(generateForDate).toBeTypeOf("function")
    if (!generateForDate) return

    expect(generateForDate("2026-05-11")).toEqual([])
    expect(generateForDate("2026-05-12")).toEqual([{ slug: "why-we-built-dawn" }])
    expect(generateForDate("2026-06-17").map(({ slug }) => slug)).not.toContain(
      "eve-validates-the-shape",
    )
    expect(generateForDate("2026-06-18").map(({ slug }) => slug)).toContain(
      "eve-validates-the-shape",
    )
    expect(generateForDate("2026-06-19").map(({ slug }) => slug)).toContain(
      "eve-validates-the-shape",
    )
    expect(generateForDate("2026-08-26").map(({ slug }) => slug)).not.toContain("dawn-0-4-release")
  })

  it("derives image params from visibility without depending on tags", () => {
    const generateForDate = (
      imageModule as ImageModule & {
        generateImageParamsForDate: (
          currentDate: string,
          posts?: readonly Post[],
        ) => readonly { slug: string }[]
      }
    ).generateImageParamsForDate
    const basePost: Post = {
      slug: "tag-independent-post",
      title: "Tag-independent post",
      description: "A synthetic post proving image parameters do not depend on tag inventory.",
      date: "2026-08-26",
      tags: [],
      type: "post",
      author: "brian",
      draft: false,
      readingTimeMinutes: 1,
      sourceFile: "2026-08-26-tag-independent-post.mdx",
    }
    const posts: readonly Post[] = [
      basePost,
      { ...basePost, slug: "future-post", date: "2026-08-27" },
      { ...basePost, slug: "draft-post", draft: true },
    ]

    expect(generateForDate("2026-08-26", posts)).toEqual([{ slug: "tag-independent-post" }])
  })

  it("renders every production image as a fully consumable 1200 by 630 PNG without remote fetch", async () => {
    for (const params of imageModule.generateImageParams()) {
      const response = await imageModule.default({ params: Promise.resolve(params) })
      const bytes = new Uint8Array(await response.arrayBuffer())
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

      expect(response.status, params.slug).toBe(200)
      expect(response.headers.get("content-type"), params.slug).toMatch(/^image\/png(?:;|$)/)
      expect(response.headers.get("cache-control"), params.slug).toMatch(/^public, /)
      expect(bytes.length, params.slug).toBeGreaterThan(PNG_SIGNATURE.length)
      expect([...bytes.slice(0, PNG_SIGNATURE.length)], params.slug).toEqual(PNG_SIGNATURE)
      expect(view.getUint32(16), params.slug).toBe(imageModule.size.width)
      expect(view.getUint32(20), params.slug).toBe(imageModule.size.height)
    }

    expect(remoteUrls).toEqual([])
  })

  it.each([
    ["draft", "dawn-0-4-release"],
    ["unknown", "not-a-dawn-blog-post"],
  ])("rejects a %s slug with real 404 semantics", async (_kind, slug) => {
    await expect(imageModule.default({ params: Promise.resolve({ slug }) })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    })
  })

  it("exports factual alt metadata for social-image discovery", () => {
    const { alt } = imageModule as ImageModule & { alt?: string }
    expect(alt).toBe("Dawn blog post title, type, and publication date")
  })

  it("bounds and fully renders a pathological long title", async () => {
    const { renderBlogImage, titleFontSize } = imageModule as ImageModule & {
      renderBlogImage?: (post: {
        title: string
        date: string
        type: "post" | "release"
        version?: string
      }) => Response
      titleFontSize?: (title: string) => number
    }

    expect(renderBlogImage).toBeTypeOf("function")
    expect(titleFontSize).toBeTypeOf("function")
    if (!renderBlogImage || !titleFontSize) return

    const title = `A practical guide to ${"pneumonoultramicroscopicsilicovolcanoconiosis".repeat(6)}`
    expect(titleFontSize("A short title")).toBe(84)
    expect(titleFontSize(title)).toBeGreaterThanOrEqual(54)
    expect(titleFontSize(title)).toBeLessThan(84)

    const response = renderBlogImage({ title, date: "2026-08-26", type: "post" })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toMatch(/^image\/png(?:;|$)/)
    expect([...bytes.slice(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE)
    expect(view.getUint32(16)).toBe(imageModule.size.width)
    expect(view.getUint32(20)).toBe(imageModule.size.height)
  })

  it("contains no request-time network or remote-font loading source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./opengraph-image.tsx", import.meta.url)),
      "utf8",
    )

    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/https?:\/\//)
    expect(remoteUrls).toEqual([])
  })
})
