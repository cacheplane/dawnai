import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { PlanCard } from "./PlanCard"
import { SubagentCard } from "./SubagentCard"

const PLAN_CONTENT = {
  todos: [
    { content: "Search the corpus", status: "completed" },
    { content: "Read the best sources", status: "in_progress" },
  ],
} as const

const SUBAGENT_CONTENT = {
  name: "researcher",
  depth: 2,
  status: "running",
  todos: [{ content: "Summarize the findings", status: "pending" }],
  tools: [{ name: "web_search", status: "completed" }],
  totalToolCount: 3,
} as const

describe("workbench plan card", () => {
  test("keeps the package defaults and adds the workbench classes", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_CONTENT} />)
    expect(markup).toContain("dawn-activity tracking-tight")
    expect(markup).toContain("dawn-activity__title font-medium")
    expect(markup).toContain("dawn-activity__meta tabular-nums")
    expect(markup).toContain("dawn-activity__item-glyph inline-block w-4 text-center")
  })

  test("still renders the package's content and bounds", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_CONTENT} />)
    expect(markup).toContain("Search the corpus")
    expect(markup).toContain("dawn-activity__item--in_progress")
    expect(markup).toContain("1/2 complete")
  })
})

describe("workbench subagent card", () => {
  test("keeps the package defaults and adds the workbench classes", () => {
    const markup = renderToStaticMarkup(<SubagentCard content={SUBAGENT_CONTENT} />)
    expect(markup).toContain("dawn-activity tracking-tight")
    expect(markup).toContain("dawn-activity__badge uppercase tracking-wide")
    expect(markup).toContain("dawn-activity__section-label uppercase")
    expect(markup).toContain("dawn-activity__item-status whitespace-nowrap")
  })

  test("still renders the package's content, badge, and tool list", () => {
    const markup = renderToStaticMarkup(<SubagentCard content={SUBAGENT_CONTENT} />)
    expect(markup).toContain("researcher")
    expect(markup).toContain("nested")
    expect(markup).toContain("web_search")
    expect(markup).toContain("3 tools")
  })
})
