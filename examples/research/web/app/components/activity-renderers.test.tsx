import { DAWN_PLAN_ACTIVITY_TYPE, DAWN_SUBAGENT_ACTIVITY_TYPE } from "@dawn-ai/ag-ui"
import { planActivityContentSchema, subagentActivityContentSchema } from "@dawn-ai/ag-ui/react"
import type { ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { workbenchActivityRenderers } from "./activity-renderers"
import { PlanCard } from "./PlanCard"
import { SubagentCard } from "./SubagentCard"

const PLAN_CONTENT = {
  todos: [
    { content: "Search the corpus", status: "completed" },
    { content: "Read the best sources", status: "in_progress" },
  ],
} as const

/** Ten todos against the package's limit of 8 — the checklist bound. */
const PLAN_OVERFLOW_CONTENT = {
  todos: Array.from({ length: 10 }, (_, index) => ({
    content: `Step ${index + 1}`,
    status: "pending" as const,
  })),
}

const SUBAGENT_CONTENT = {
  name: "researcher",
  depth: 2,
  status: "running",
  todos: [{ content: "Summarize the findings", status: "pending" }],
  tools: [{ name: "web_search", status: "completed" }],
  totalToolCount: 3,
} as const

const FAILED_SUBAGENT_CONTENT = {
  name: "researcher",
  depth: 1,
  status: "failed",
  error: "The search backend refused the query",
  tools: [{ name: "web_search", status: "incomplete" }],
  totalToolCount: 1,
} as const

describe("workbench plan card", () => {
  test("keeps the package defaults and adds the workbench classes", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_CONTENT} />)
    expect(markup).toContain("dawn-activity tracking-tight")
    expect(markup).toContain("dawn-activity__title font-medium")
    expect(markup).toContain("dawn-activity__meta tabular-nums")
    expect(markup).toContain("dawn-activity__item-glyph w-4 shrink-0 text-center")
    expect(markup).toContain("dawn-activity__item-label leading-5")
  })

  test("still renders the package's content", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_CONTENT} />)
    expect(markup).toContain("Search the corpus")
    expect(markup).toContain("dawn-activity__item--in_progress")
    expect(markup).toContain("1/2 complete")
  })

  test("keeps the package's checklist bound and styles the overflow node", () => {
    const markup = renderToStaticMarkup(<PlanCard content={PLAN_OVERFLOW_CONTENT} />)
    expect(markup).toContain("Step 8")
    expect(markup).not.toContain("Step 9")
    expect(markup).toContain("dawn-activity__overflow tabular-nums")
    expect(markup).toContain("+2 more")
  })
})

describe("workbench subagent card", () => {
  test("keeps the package defaults and adds the workbench classes", () => {
    const markup = renderToStaticMarkup(<SubagentCard content={SUBAGENT_CONTENT} />)
    expect(markup).toContain("dawn-activity tracking-tight")
    expect(markup).toContain("dawn-activity__badge uppercase tracking-wide")
    expect(markup).toContain("dawn-activity__section-label uppercase tracking-[0.08em]")
    expect(markup).toContain("dawn-activity__item-status whitespace-nowrap")
  })

  test("still renders the package's content, badge, and tool list", () => {
    const markup = renderToStaticMarkup(<SubagentCard content={SUBAGENT_CONTENT} />)
    expect(markup).toContain("researcher")
    expect(markup).toContain("nested")
    expect(markup).toContain("web_search")
    expect(markup).toContain("3 tools")
  })

  test("styles a failed subagent's error and keeps its message", () => {
    const markup = renderToStaticMarkup(<SubagentCard content={FAILED_SUBAGENT_CONTENT} />)
    expect(markup).toContain("dawn-activity__error border-l-2 pl-2")
    expect(markup).toContain("The search backend refused the query")
    expect(markup).toContain("dawn-activity__item--incomplete")
    // depth 1 is not nested, so the badge stays absent.
    expect(markup).not.toContain("dawn-activity__badge")
  })
})

/**
 * The provider takes `ReactActivityMessageRenderer<any>[]`, which erases the
 * content type at that boundary: wiring both entries to `PlanCard`, or pairing
 * the plan schema with the subagent card, typechecks cleanly and simply renders
 * nothing at runtime. These tests are the only thing standing between that slip
 * and a silent blank transcript.
 */
function renderEntry(entry: (typeof workbenchActivityRenderers)[number], content: unknown): string {
  // The provider passes `{ activityType, content, message, agent }`; both
  // wrappers read only `content`, so the omitted props are deliberate.
  const Renderer = entry.render as unknown as ComponentType<{ content: unknown }>
  return renderToStaticMarkup(<Renderer content={content} />)
}

describe("workbench activity renderer registry", () => {
  test("registers the package's two activity types, in order", () => {
    expect(workbenchActivityRenderers.map((entry) => entry.activityType)).toEqual([
      DAWN_PLAN_ACTIVITY_TYPE,
      DAWN_SUBAGENT_ACTIVITY_TYPE,
    ])
  })

  test("pairs each activity type with the package's matching schema", () => {
    const [plan, subagent] = workbenchActivityRenderers
    expect(plan?.content).toBe(planActivityContentSchema)
    expect(subagent?.content).toBe(subagentActivityContentSchema)
  })

  test("renders the workbench card that belongs to each entry", () => {
    const [plan, subagent] = workbenchActivityRenderers
    if (!plan || !subagent) throw new Error("expected two registered renderers")

    const planMarkup = renderEntry(plan, PLAN_CONTENT)
    expect(planMarkup).toContain("dawn-activity__title font-medium")
    expect(planMarkup).toContain("1/2 complete")

    // The badge and the tool list exist only on the subagent card, so these
    // fail loudly if that entry is wired to `PlanCard`.
    const subagentMarkup = renderEntry(subagent, SUBAGENT_CONTENT)
    expect(subagentMarkup).toContain("dawn-activity__badge uppercase tracking-wide")
    expect(subagentMarkup).toContain("web_search")
  })
})
