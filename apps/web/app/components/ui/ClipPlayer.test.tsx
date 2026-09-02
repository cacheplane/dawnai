// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DemoClip } from "../../lib/demo-media"
import { ClipPlayer } from "./ClipPlayer"

const clip: DemoClip = {
  mp4: "https://media.example.test/demo/product-loop.mp4",
  webm: "https://media.example.test/demo/product-loop.webm",
  poster: "/demo/product-loop-poster.webp",
  caption: "Author, prove, run, and restore.",
  ariaLabel: "Dawn product loop",
  transcript: "https://example.test/transcript#product-loop",
}

let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  container = document.createElement("div")
  document.body.replaceChildren(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = undefined
  }
  vi.restoreAllMocks()
})

function mockMotionPreference(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

async function mountPlayer() {
  root = createRoot(container)
  await act(async () => root?.render(<ClipPlayer clip={clip} />))
}

describe("ClipPlayer", () => {
  it("renders poster-first video markup and starts playback from an effect", async () => {
    mockMotionPreference(false)
    const play = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: play,
    })

    const serverMarkup = renderToStaticMarkup(<ClipPlayer clip={clip} />)
    expect(serverMarkup.toLowerCase()).not.toContain("autoplay")

    await mountPlayer()

    const video = container.querySelector("video")
    expect(video).not.toBeNull()
    expect(video?.poster).toContain(clip.poster)
    expect(video?.muted).toBe(true)
    expect(video?.playsInline).toBe(true)
    expect(video?.controls).toBe(true)
    expect(video?.loop).toBe(true)
    expect(video?.getAttribute("aria-label")).toBe(clip.ariaLabel)
    expect(
      [...(video?.querySelectorAll("source") ?? [])].map((source) => [
        source.getAttribute("src"),
        source.getAttribute("type"),
      ]),
    ).toEqual([
      [clip.webm, "video/webm"],
      [clip.mp4, "video/mp4"],
    ])
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("does not autoplay for reduced motion and offers explicit playback", async () => {
    mockMotionPreference(true)
    const play = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: play,
    })

    await mountPlayer()

    expect(play).not.toHaveBeenCalled()
    expect(container.querySelector("video")?.loop).toBe(false)
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Play"),
    )
    expect(button).toBeDefined()

    await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("keeps the poster-backed video when autoplay is rejected", async () => {
    mockMotionPreference(false)
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error("Autoplay blocked")),
    })

    await mountPlayer()

    expect(container.querySelector("video")?.poster).toContain(clip.poster)
    expect(container.querySelector("a")).toBeNull()
  })

  it("falls back to the poster and transcript when video loading fails", async () => {
    mockMotionPreference(false)
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    })

    await mountPlayer()
    const video = container.querySelector("video")
    expect(video).not.toBeNull()

    await act(async () => video?.dispatchEvent(new Event("error", { bubbles: true })))

    expect(container.querySelector("video")).toBeNull()
    expect(container.querySelector("img")?.getAttribute("src")).toBe(clip.poster)
    expect(container.querySelector(`a[href="${clip.transcript}"]`)).not.toBeNull()
  })
})
