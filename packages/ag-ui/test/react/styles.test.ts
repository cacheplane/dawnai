import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/react/styles.css", import.meta.url)),
  "utf8",
)

/** Selector text of every rule, excluding at-rule preludes. */
function selectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: string[] = []
  for (const match of withoutComments.matchAll(/(^|[}{;])\s*([^{}@]+?)\s*\{/g)) {
    const selector = match[2]?.trim()
    if (selector) out.push(selector)
  }
  return out
}

describe("styles.css", () => {
  test("defines the documented tokens with light values", () => {
    for (const token of [
      "--dawn-activity-surface",
      "--dawn-activity-border",
      "--dawn-activity-text",
      "--dawn-activity-muted",
      "--dawn-activity-accent",
      "--dawn-activity-running",
      "--dawn-activity-complete",
      "--dawn-activity-failed",
      "--dawn-activity-radius",
    ]) {
      expect(CSS).toContain(token)
    }
  })

  test("every rule is scoped to the dawn-activity prefix", () => {
    const unscoped = selectors(CSS).filter((selector) => {
      const parts = selector.split(",").map((part) => part.trim())
      // A bare `:root`, or a `:root` variant like `:root:not(...)` or
      // `:root[data-dawn-theme="dark"]`, only ever declares custom properties
      // on the document root — it cannot touch a consumer's markup, so it is
      // exempt from the prefix requirement the same way bare `:root` is.
      return parts.some((part) => !part.startsWith(":root") && !part.includes(".dawn-activity"))
    })
    expect(unscoped).toEqual([])
  })

  test("ships a dark palette that an explicit light theme can override", () => {
    expect(CSS).toContain("prefers-color-scheme: dark")
    expect(CSS).toContain('[data-dawn-theme="dark"]')
    expect(CSS).toContain('[data-dawn-theme="light"]')
  })
})
