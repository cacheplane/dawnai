// @vitest-environment jsdom

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MediaSwitcher } from "./MediaSwitcher"

const heroSource = await readFile(resolve(process.cwd(), "app/components/landing/Hero.tsx"), "utf8")

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
})

async function mountSwitcher() {
  root = createRoot(container)
  await act(async () =>
    root?.render(
      <MediaSwitcher
        video={<div data-pane="video">Video content</div>}
        code={<div data-pane="code">Code content</div>}
      />,
    ),
  )
}

function tabs() {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

async function press(tab: HTMLButtonElement, key: string) {
  await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })))
}

describe("MediaSwitcher", () => {
  it("selects Video initially and mounts only the active panel", async () => {
    await mountSwitcher()
    const [videoTab, codeTab] = tabs()

    expect(videoTab?.textContent).toBe("Video")
    expect(codeTab?.textContent).toBe("Code")
    expect(videoTab?.getAttribute("aria-selected")).toBe("true")
    expect(videoTab?.tabIndex).toBe(0)
    expect(codeTab?.getAttribute("aria-selected")).toBe("false")
    expect(codeTab?.tabIndex).toBe(-1)
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
    expect(container.querySelector('[data-pane="video"]')).not.toBeNull()
    expect(container.querySelector('[data-pane="code"]')).toBeNull()
  })

  it("switches the mounted panel when a tab is clicked", async () => {
    await mountSwitcher()
    const codeTab = tabs()[1]

    await act(async () => codeTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })))

    expect(codeTab?.getAttribute("aria-selected")).toBe("true")
    expect(container.querySelector('[data-pane="video"]')).toBeNull()
    expect(container.querySelector('[data-pane="code"]')).not.toBeNull()
  })

  it("supports roving focus with arrows, Home, and End", async () => {
    await mountSwitcher()
    let [videoTab, codeTab] = tabs()
    videoTab?.focus()

    if (videoTab) await press(videoTab, "ArrowRight")
    ;[videoTab, codeTab] = tabs()
    expect(document.activeElement).toBe(codeTab)
    expect(codeTab?.getAttribute("aria-selected")).toBe("true")
    expect(container.querySelector('[data-pane="code"]')).not.toBeNull()

    if (codeTab) await press(codeTab, "ArrowLeft")
    ;[videoTab, codeTab] = tabs()
    expect(document.activeElement).toBe(videoTab)
    expect(videoTab?.getAttribute("aria-selected")).toBe("true")

    if (videoTab) await press(videoTab, "End")
    ;[videoTab, codeTab] = tabs()
    expect(document.activeElement).toBe(codeTab)
    expect(codeTab?.getAttribute("aria-selected")).toBe("true")

    if (codeTab) await press(codeTab, "Home")
    ;[videoTab] = tabs()
    expect(document.activeElement).toBe(videoTab)
    expect(videoTab?.getAttribute("aria-selected")).toBe("true")
  })
})

describe("Hero media ownership", () => {
  it("leads with the product loop while preserving the route and CTAs", () => {
    expect(heroSource).toContain('id="product-loop"')
    expect(heroSource).toContain("<MediaSwitcher")
    expect(heroSource).toContain('videoLabel="Video"')
    expect(heroSource).toContain('codeLabel="Code"')
    expect(heroSource).toContain("demoMedia.productLoop")
    expect(heroSource).toContain("<ClipPlayer")
    expect(heroSource).toContain("demoMedia.productLoop.caption")
    expect(heroSource).toContain("demoMedia.productLoop.transcript")
    expect(heroSource).toContain("const ROUTE_CODE")
    expect(heroSource).toContain('highlightLight(ROUTE_CODE, "typescript")')
    expect(heroSource).toContain("<CopyCommand")
    expect(heroSource).toContain("<CopyPromptButton")
  })
})
