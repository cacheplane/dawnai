import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/react/styles.css", import.meta.url)),
  "utf8",
)

/** Every card source, for the TSX-emits-it/CSS-styles-it drift guard. */
const CARD_SOURCES = ["ActivityChecklist.tsx", "PlanActivityCard.tsx", "SubagentActivityCard.tsx"]
  .map((file) =>
    readFileSync(fileURLToPath(new URL(`../../src/react/${file}`, import.meta.url)), "utf8"),
  )
  .join("\n")

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

// The three token blocks are `:where()`-wrapped so they sit at specificity
// (0,0,0) and a consumer's own `:root` override always wins (rung 1). That makes
// their selector text `:where(:root...)`, which `rootVariant` rejects, so the
// scoping check unwraps one outer `:where()` first. Unwrapping does not weaken
// the guard: `:where(:root .consumer-class)` still fails `rootVariant` after the
// unwrap, and anything scoped to the prefix passes on the other branch anyway.
const whereWrapped = /^:where\((.*)\)$/
const unwrap = (part: string) => whereWrapped.exec(part)?.[1] ?? part

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
      "--dawn-activity-gap",
      "--dawn-activity-font-size",
      "--dawn-activity-margin",
      "--dawn-activity-padding",
      "--dawn-activity-header-weight",
      "--dawn-activity-badge-bg",
    ]) {
      expect(CSS).toContain(token)
    }
  })

  test("every :root token block is :where()-wrapped", () => {
    // This is the whole of rung 1's cross-theme guarantee, and nothing else pins
    // it. Unwrapped, the two dark blocks sit at (0,2,0) and a consumer's plain
    // `:root { --dawn-activity-*: ... }` loses in dark mode. ALL THREE or none:
    // wrapping only the dark blocks leaves the light block the most specific of
    // the three, which renders a light card under a dark system theme.
    const rootBlocks = selectors(CSS).filter((selector) => selector.includes(":root"))
    expect(rootBlocks).toHaveLength(3)
    for (const selector of rootBlocks) {
      expect(selector, `${selector} must be :where()-wrapped`).toMatch(whereWrapped)
      expect(unwrap(selector), `${selector} must wrap a bare :root variant`).toMatch(rootVariant)
    }
  })

  test("the badge background is its own token, derived from the border", () => {
    // Declared once, in the light block only. `var()` resolves at use time, so
    // the badge tracks the dark palettes for free; redeclaring it in a dark
    // block would re-pin it to the border token there.
    // The default is a FALLBACK at the use site, never a `:root` declaration.
    // Declaring it on `:root` substitutes `var(--dawn-activity-border)` at
    // computed-value time on `:root` itself, freezing the chip to the root's
    // border colour so a subtree override recolours the card but not the badge.
    expect(CSS).toContain("background: var(--dawn-activity-badge-bg, var(--dawn-activity-border));")
    // Comments are stripped first: the rationale comment above the use site
    // quotes the very declaration this asserts is absent.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(declarations.match(/--dawn-activity-badge-bg:/g)).toBeNull()
  })

  test("every rule is scoped to the dawn-activity prefix", () => {
    const unscoped = selectors(CSS).filter((selector) => {
      const parts = selector.split(",").map((part) => part.trim())
      return parts.some(
        (part) => !rootVariant.test(unwrap(part)) && !part.includes(".dawn-activity"),
      )
    })
    expect(unscoped).toEqual([])
  })

  test("ships a dark palette that an explicit light theme can override", () => {
    expect(CSS).toContain("prefers-color-scheme: dark")
    expect(CSS).toContain('[data-dawn-theme="dark"]')
    expect(CSS).toContain('[data-dawn-theme="light"]')
  })

  test("the scoping check rejects a :root selector that reaches into consumer markup", () => {
    // The `:where()` form is here because the real check unwraps one outer
    // `:where()`. Without this case the unwrap could quietly widen the exemption
    // to any `:where(:root ...)` selector that reaches into consumer markup.
    const hostile =
      ":root .consumer-class { color: red }\n:where(:root .consumer-class) { color: red }\n"
    const unscoped = selectors(hostile).filter((selector) =>
      selector
        .split(",")
        .map((part) => part.trim())
        .some((part) => !rootVariant.test(unwrap(part)) && !part.includes(".dawn-activity")),
    )
    expect(unscoped).toEqual([":root .consumer-class", ":where(:root .consumer-class)"])
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

  test("the disclosure marker is a real element, not generated content", () => {
    // The `::before` had no `classNames` key and leaked into the accessible
    // name; a `.dawn-activity__marker` span has a key and carries `aria-hidden`.
    expect(CSS).toContain(".dawn-activity__marker {")
    expect(CSS).toContain(
      ".dawn-activity[open] > .dawn-activity__header > .dawn-activity__marker {",
    )
    expect(CSS).not.toContain(".dawn-activity__header::before")
    expect(CSS).not.toContain('content: "▸"')
    // The native marker still has to be suppressed or two triangles render.
    expect(CSS).toContain(".dawn-activity__header::-webkit-details-marker")
  })

  test("every default class the cards emit has a rule in the sheet", () => {
    // Two classes moved or arrived in this sheet (`__checklist`, `__marker`), so
    // there are now two more places a rename in TSX can silently ship an
    // unstyled card. Matches the `dawn-activity__part-name` form only; the
    // `--modifier` suffixes have their own test above.
    const emitted = new Set(CARD_SOURCES.match(/dawn-activity__[a-z]+(?:-[a-z]+)*/g) ?? [])
    expect(emitted.size).toBeGreaterThan(0)
    for (const className of emitted) {
      expect(CSS, `${className} is emitted by a card but has no rule`).toContain(`.${className}`)
    }
  })
})
