import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { demoMedia } from "./demo-media"

const sectionSources = new Map<string, string>(
  await Promise.all(
    (["FeatureRouting", "FeatureDevLoop", "DurableByDefault"] as const).map(
      async (component) =>
        [
          component,
          await readFile(
            resolve(process.cwd(), "app/components/landing", component.concat(".tsx")),
            "utf8",
          ),
        ] as const,
    ),
  ),
)

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

  it("gives each supporting clip exactly one homepage owner", () => {
    for (const [clip, owner] of [
      ["author", "FeatureRouting"],
      ["test", "FeatureDevLoop"],
      ["run", "DurableByDefault"],
    ] as const) {
      const token = "demoMedia.".concat(clip)
      const owningSources = [...sectionSources.entries()]
        .filter(([, source]) => source.includes(token))
        .map(([component]) => component)
      expect(owningSources, token).toEqual([owner])
    }
  })

  it("describes Run as browser reload and checkpoint restoration, not a server restart", () => {
    expect(demoMedia.run.caption).toMatch(/browser reload/iu)
    expect(demoMedia.run.caption).toMatch(/checkpoint/iu)
    expect(demoMedia.run.caption).toMatch(/restore/iu)
    expect(demoMedia.run.caption).not.toMatch(/(?:Dawn|server|dev) restart/iu)
  })
})
