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

// A `:root`-prefixed selector with a combinator or descendant (e.g.
// `:root .consumer-class`, `:root div`, `:root > body`) reaches outside the
// document root into a consumer's own markup — exactly what the scoping
// assertion exists to prevent. So the exemption is anchored to accept only
// `:root` plus directly-chained attribute/pseudo qualifiers with no
// whitespace or combinator, i.e. root-level custom-property declarations.
const rootVariant = /^:root(:[\w-]+(?:\([^)]*\))?|\[[^\]]*\])*$/

describe("styles.css", () => {
  test("defines the documented tokens with light values", () => {
    for (const token of [
      "--dawn-activity-surface",
      "--dawn-activity-border",
      "--dawn-activity-text",
      "--dawn-activity-muted",
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
      return parts.some((part) => !rootVariant.test(part) && !part.includes(".dawn-activity"))
    })
    expect(unscoped).toEqual([])
  })

  test("ships a dark palette that an explicit light theme can override", () => {
    expect(CSS).toContain("prefers-color-scheme: dark")
    expect(CSS).toContain('[data-dawn-theme="dark"]')
    expect(CSS).toContain('[data-dawn-theme="light"]')
  })

  test("the scoping check rejects a :root selector that reaches into consumer markup", () => {
    const hostile = ":root .consumer-class { color: red }\n"
    const unscoped = selectors(hostile).filter((selector) =>
      selector
        .split(",")
        .map((part) => part.trim())
        .some((part) => !rootVariant.test(part) && !part.includes(".dawn-activity")),
    )
    expect(unscoped).toEqual([":root .consumer-class"])
  })

  test("every status modifier the cards emit has a glyph rule", () => {
    // Todo statuses: `statusPresentation` in ActivityChecklist.tsx.
    // Tool statuses: `toolStatusPresentation` in SubagentActivityCard.tsx.
    const todoStatuses = ["pending", "in_progress", "completed"]
    const toolStatuses = ["running", "completed", "incomplete"]
    for (const status of new Set([...todoStatuses, ...toolStatuses])) {
      expect(CSS).toContain(`.dawn-activity__item--${status} .dawn-activity__item-glyph`)
    }
  })
})
