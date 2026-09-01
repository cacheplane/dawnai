import { describe, expect, it } from "vitest"
import { demoMedia } from "./demo-media"

describe("demoMedia", () => {
  it("exports the exact homepage clip catalog", () => {
    expect(Object.keys(demoMedia)).toEqual(["productLoop", "author", "test", "run"])
    expect(Object.isFrozen(demoMedia)).toBe(true)
    expect(Object.values(demoMedia).every(Object.isFrozen)).toBe(true)
  })

  it("keeps every clip on the hosted-media, local-poster, and transcript contracts", () => {
    for (const [key, clip] of Object.entries(demoMedia)) {
      expect(clip.mp4, `${key} mp4`).toMatch(/^https:\/\/.+\/demo\/[a-z-]+\.mp4$/u)
      expect(clip.webm, `${key} webm`).toMatch(/^https:\/\/.+\/demo\/[a-z-]+\.webm$/u)
      expect(clip.poster, `${key} poster`).toMatch(/^\/demo\/[a-z-]+-poster\.webp$/u)
      expect(clip.caption.trim(), `${key} caption`).not.toBe("")
      expect(clip.ariaLabel.trim(), `${key} aria label`).not.toBe("")
      expect(clip.transcript, `${key} transcript`).toMatch(
        /^https:\/\/github\.com\/cacheplane\/dawnai\/blob\/main\/docs\/brand\/demo\/transcript\.md#/u,
      )
    }
  })
})
