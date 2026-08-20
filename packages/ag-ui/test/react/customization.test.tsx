import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { PlanActivityCard } from "../../src/react/PlanActivityCard.js"
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

describe("customization ladder", () => {
  test("rung 2: classNames append to defaults rather than replacing them", () => {
    const html = renderToStaticMarkup(
      <PlanActivityCard
        content={PLAN}
        classNames={{ root: "my-root", list: "my-list", itemLabel: "my-label" }}
      />,
    )
    expect(html).toContain("dawn-activity my-root")
    expect(html).toContain("dawn-activity__list my-list")
    expect(html).toContain("dawn-activity__item-label my-label")
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
