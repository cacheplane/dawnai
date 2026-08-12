import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const source = await readFile(new URL("./MobileMenu.tsx", import.meta.url), "utf8")

describe("MobileMenu modal behavior", () => {
  it("uses the native modal dialog lifecycle instead of a focusable hidden overlay", () => {
    expect(source).toContain("<dialog")
    expect(source).toContain(".showModal()")
    expect(source).toContain("onCancel=")
    expect(source).toContain("triggerRef.current?.focus()")
    expect(source).toContain('matchMedia("(min-width: 48rem)")')
    expect(source).toContain('addEventListener("change"')
    expect(source).not.toContain("opacity-0 pointer-events-none")
  })
})
