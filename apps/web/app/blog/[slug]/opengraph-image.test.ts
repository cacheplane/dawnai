import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import Image, { generateImageParams, size } from "./opengraph-image"

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CURRENT_PRODUCTION_SLUGS = [
  "eve-validates-the-shape",
  "app-router-for-ai-agents",
  "why-we-built-dawn",
] as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("blog Open Graph images", () => {
  it("enumerates every current production-visible post and no drafts", () => {
    expect(generateImageParams()).toEqual(CURRENT_PRODUCTION_SLUGS.map((slug) => ({ slug })))
  })

  it("renders every production image as a fully consumable 1200 by 630 PNG without remote fetch", async () => {
    const nativeFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (/^https?:\/\//.test(url)) {
        return Promise.reject(new Error("OG images must render offline"))
      }
      return nativeFetch(input, init)
    })
    vi.stubGlobal("fetch", fetchSpy)

    for (const params of generateImageParams()) {
      const response = await Image({ params: Promise.resolve(params) })
      const bytes = new Uint8Array(await response.arrayBuffer())
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

      expect(response.status, params.slug).toBe(200)
      expect(response.headers.get("content-type"), params.slug).toMatch(/^image\/png(?:;|$)/)
      expect(bytes.length, params.slug).toBeGreaterThan(PNG_SIGNATURE.length)
      expect([...bytes.slice(0, PNG_SIGNATURE.length)], params.slug).toEqual(PNG_SIGNATURE)
      expect(view.getUint32(16), params.slug).toBe(size.width)
      expect(view.getUint32(20), params.slug).toBe(size.height)
    }

    const remoteUrls = fetchSpy.mock.calls
      .map(([input]) =>
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      )
      .filter((url) => /^https?:\/\//.test(url))
    expect(remoteUrls).toEqual([])
  })

  it("contains no request-time network or remote-font loading source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./opengraph-image.tsx", import.meta.url)),
      "utf8",
    )

    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/https?:\/\//)
  })
})
