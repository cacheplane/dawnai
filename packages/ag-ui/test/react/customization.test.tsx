import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { PlanActivityCard } from "../../src/react/PlanActivityCard.js"
import type { DawnActivityClassNames } from "../../src/react/parts.js"
import { SubagentActivityCard } from "../../src/react/SubagentActivityCard.js"

const PLAN = {
  todos: [
    { content: "Search the corpus", status: "completed" },
    { content: "Read the best sources", status: "in_progress" },
  ],
} as const

const SUBAGENT = {
  name: "researcher",
  depth: 1,
  status: "running",
  tools: [{ name: "searchCorpus", status: "running" }],
  totalToolCount: 1,
} as const

/**
 * Every part in `DawnActivityClassNames`, each with a distinct consumer class,
 * so a render can be checked part-by-part instead of sampling a lucky few.
 */
const EVERY_PART: Required<DawnActivityClassNames> = {
  root: "my-root",
  header: "my-header",
  marker: "my-marker",
  title: "my-title",
  meta: "my-meta",
  badge: "my-badge",
  section: "my-section",
  sectionLabel: "my-section-label",
  checklist: "my-checklist",
  list: "my-list",
  item: "my-item",
  itemGlyph: "my-item-glyph",
  itemLabel: "my-item-label",
  itemStatus: "my-item-status",
  overflow: "my-overflow",
  error: "my-error",
}

/**
 * The full `class` attribute each part must emit when a consumer class is
 * appended. Matching the whole attribute — not a substring — is what proves the
 * default survives rather than being replaced.
 */
const APPENDED_ATTRIBUTE: Record<keyof DawnActivityClassNames, RegExp> = {
  root: /class="dawn-activity my-root"/,
  header: /class="dawn-activity__header my-header"/,
  marker: /class="dawn-activity__marker my-marker"/,
  title: /class="dawn-activity__title my-title"/,
  meta: /class="dawn-activity__meta my-meta"/,
  badge: /class="dawn-activity__badge my-badge"/,
  section: /class="dawn-activity__section my-section"/,
  sectionLabel: /class="dawn-activity__section-label my-section-label"/,
  checklist: /class="dawn-activity__checklist my-checklist"/,
  list: /class="dawn-activity__list my-list"/,
  item: /class="dawn-activity__item dawn-activity__item--\w+ my-item"/,
  itemGlyph: /class="dawn-activity__item-glyph my-item-glyph"/,
  itemLabel: /class="dawn-activity__item-label my-item-label"/,
  itemStatus: /class="dawn-activity__item-status my-item-status"/,
  overflow: /class="dawn-activity__overflow my-overflow"/,
  error: /class="dawn-activity__error my-error"/,
}

/** The default class a part emits, used to prove a card renders no such part. */
const DEFAULT_CLASS: Record<keyof DawnActivityClassNames, string> = {
  root: "dawn-activity",
  header: "dawn-activity__header",
  marker: "dawn-activity__marker",
  title: "dawn-activity__title",
  meta: "dawn-activity__meta",
  badge: "dawn-activity__badge",
  section: "dawn-activity__section",
  sectionLabel: "dawn-activity__section-label",
  checklist: "dawn-activity__checklist",
  list: "dawn-activity__list",
  item: "dawn-activity__item ",
  itemGlyph: "dawn-activity__item-glyph",
  itemLabel: "dawn-activity__item-label",
  itemStatus: "dawn-activity__item-status",
  overflow: "dawn-activity__overflow",
  error: "dawn-activity__error",
}

const ALL_PARTS = Object.keys(APPENDED_ATTRIBUTE) as Array<keyof DawnActivityClassNames>

/** A plan long enough to overflow, with a completed and an active todo. */
const OVERFLOWING_PLAN = {
  todos: [
    { content: "Search the corpus", status: "completed" as const },
    { content: "Read the best sources", status: "in_progress" as const },
    ...Array.from({ length: 8 }, (_, index) => ({
      content: `Follow up ${index}`,
      status: "pending" as const,
    })),
  ],
}

/** Nested, failed, with todos past the bound and a tool: reaches every part. */
const EXHAUSTIVE_SUBAGENT = {
  name: "researcher",
  depth: 2,
  status: "failed" as const,
  error: "The source service returned an error",
  todos: OVERFLOWING_PLAN.todos,
  tools: [{ name: "searchCorpus", status: "incomplete" as const }],
  totalToolCount: 3,
}

/**
 * Parts the plan card has no markup for.
 *
 * `section` is here deliberately, pinning a documented behaviour change rather
 * than hiding it: the plan card has no labelled region, so `section` pairs with
 * `sectionLabel` and reaches neither card's checklist wrapper. `checklist` is
 * the key for that wrapper now.
 */
const PARTS_ABSENT_FROM_PLAN_CARD = ["badge", "section", "sectionLabel", "error"] as const

describe("customization ladder", () => {
  test("rung 2: every part the plan card renders appends its consumer class", () => {
    const html = renderToStaticMarkup(
      <PlanActivityCard content={OVERFLOWING_PLAN} classNames={EVERY_PART} />,
    )

    const absent = new Set<string>(PARTS_ABSENT_FROM_PLAN_CARD)
    for (const part of ALL_PARTS) {
      if (absent.has(part)) continue
      expect(html, `part ${part} must append its consumer class`).toMatch(APPENDED_ATTRIBUTE[part])
    }
  })

  test("rung 2: the plan card renders no badge, section label, or error part", () => {
    const html = renderToStaticMarkup(
      <PlanActivityCard content={OVERFLOWING_PLAN} classNames={EVERY_PART} />,
    )

    for (const part of PARTS_ABSENT_FROM_PLAN_CARD) {
      expect(html, `part ${part} is not a plan card part`).not.toContain(DEFAULT_CLASS[part])
      expect(html).not.toContain(EVERY_PART[part])
    }
  })

  test("rung 2: every part the subagent card renders appends its consumer class", () => {
    const html = renderToStaticMarkup(
      <SubagentActivityCard content={EXHAUSTIVE_SUBAGENT} classNames={EVERY_PART} />,
    )

    for (const part of ALL_PARTS) {
      expect(html, `part ${part} must append its consumer class`).toMatch(APPENDED_ATTRIBUTE[part])
    }
  })

  test("rung 2: a consumer section class lands on the region, not on the checklist too", () => {
    // The regression pin for the `section`/`checklist` split. The subagent card
    // renders two labelled regions, and it used to render the checklist wrapper
    // with the same class — three matches, two of them nested, so any box-like
    // utility passed to `section` drew twice. The lookahead keeps
    // `my-section-label` from being counted as a `my-section` match.
    const html = renderToStaticMarkup(
      <SubagentActivityCard content={EXHAUSTIVE_SUBAGENT} classNames={EVERY_PART} />,
    )
    expect(html.match(/my-section(?![\w-])/g)).toHaveLength(2)
    expect(html.match(/my-checklist/g)).toHaveLength(1)
  })

  test("rung 2: the marker is the first child of the header and hidden from a11y", () => {
    // Structure, position, and `aria-hidden` in one pattern. The glyph was a
    // `::before` with no key; Chrome put its content in the summary's accessible
    // name, so the span must stay `aria-hidden` and stay first.
    const markerFirst =
      /<summary class="dawn-activity__header[^"]*"><span aria-hidden="true" class="dawn-activity__marker/
    expect(
      renderToStaticMarkup(<PlanActivityCard content={PLAN} classNames={EVERY_PART} />),
    ).toMatch(markerFirst)
    expect(
      renderToStaticMarkup(<SubagentActivityCard content={SUBAGENT} classNames={EVERY_PART} />),
    ).toMatch(markerFirst)
    expect(renderToStaticMarkup(<PlanActivityCard content={PLAN} />)).toMatch(markerFirst)
  })

  test("rung 2: omitted parts keep bare defaults", () => {
    const html = renderToStaticMarkup(<PlanActivityCard content={PLAN} />)
    expect(html).toContain('class="dawn-activity"')
    expect(html).not.toContain("undefined")
  })

  test("rung 3: a TodoRow slot replaces the row body", () => {
    const html = renderToStaticMarkup(
      <PlanActivityCard
        content={PLAN}
        components={{ TodoRow: ({ content }) => <em>{content}</em> }}
      />,
    )
    expect(html).toContain("<em>Search the corpus</em>")
    expect(html).not.toContain("dawn-activity__item-glyph")
  })

  test("rung 3: a ToolRow slot replaces tool rows", () => {
    const html = renderToStaticMarkup(
      <SubagentActivityCard
        content={SUBAGENT}
        components={{ ToolRow: ({ name }) => <b>{name}</b> }}
      />,
    )
    expect(html).toContain("<b>searchCorpus</b>")
  })

  test("a slot cannot exceed the card's todo bound", () => {
    const many = {
      todos: Array.from({ length: 20 }, (_, index) => ({
        content: `todo ${index}`,
        status: "pending" as const,
      })),
    }
    const html = renderToStaticMarkup(
      <PlanActivityCard
        content={many}
        components={{ TodoRow: ({ content }) => <em>{content}</em> }}
      />,
    )
    expect(html.match(/<em>/g)).toHaveLength(8)
    expect(html).toContain("+12 more")
  })

  test("status modifiers drive per-item styling hooks", () => {
    const html = renderToStaticMarkup(<PlanActivityCard content={PLAN} />)
    expect(html).toContain("dawn-activity__item--completed")
    expect(html).toContain("dawn-activity__item--in_progress")
  })
})
