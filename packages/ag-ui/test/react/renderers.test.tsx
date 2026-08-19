import { isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DAWN_PLAN_ACTIVITY_TYPE, DAWN_SUBAGENT_ACTIVITY_TYPE } from "../../src/activities.js"
import { ActivityChecklist } from "../../src/react/ActivityChecklist.js"
import { PlanActivityCard } from "../../src/react/PlanActivityCard.js"
import { dawnActivityRenderers } from "../../src/react/renderers.js"
import { SubagentActivityCard } from "../../src/react/SubagentActivityCard.js"
import {
  planActivityContentSchema,
  subagentActivityContentSchema,
} from "../../src/react/schemas.js"

describe("plan schema", () => {
  it("accepts a valid plan activity", () => {
    expect(
      planActivityContentSchema.safeParse({
        todos: [
          { content: "Search the corpus", status: "in_progress" },
          { content: "Write the report", status: "pending" },
        ],
      }).success,
    ).toBe(true)
  })

  it("rejects extra keys", () => {
    expect(
      planActivityContentSchema.safeParse({
        todos: [{ content: "Search the corpus", status: "completed" }],
        id: "runtime-plan-id",
      }).success,
    ).toBe(false)
  })
})

const runningSubagent = {
  name: "researcher",
  depth: 1,
  status: "running",
  tools: [{ name: "searchCorpus", status: "running" }],
  totalToolCount: 1,
} as const

describe("subagent schema valid states", () => {
  it.each([
    runningSubagent,
    { ...runningSubagent, status: "completed", tools: [] as const },
    { ...runningSubagent, status: "failed", error: "Corpus unavailable" },
  ])("accepts $status content", (content) => {
    expect(subagentActivityContentSchema.safeParse(content).success).toBe(true)
  })
})

describe("subagent schema privacy", () => {
  it.each(["call_id", "route_id", "id", "input", "output", "final_message"])(
    "rejects the extra key %s",
    (key) => {
      expect(
        subagentActivityContentSchema.safeParse({ ...runningSubagent, [key]: "private" }).success,
      ).toBe(false)
    },
  )
})

describe("subagent schema bounds", () => {
  it("rejects more than five tools", () => {
    expect(
      subagentActivityContentSchema.safeParse({
        ...runningSubagent,
        tools: Array.from({ length: 6 }, (_, index) => ({
          name: `tool-${index}`,
          status: "completed",
        })),
        totalToolCount: 6,
      }).success,
    ).toBe(false)
  })

  it("rejects errors longer than 400 characters", () => {
    expect(
      subagentActivityContentSchema.safeParse({
        ...runningSubagent,
        status: "failed",
        error: "x".repeat(401),
      }).success,
    ).toBe(false)
  })

  it.each(["running", "completed"] as const)("rejects an error for %s content", (status) => {
    expect(
      subagentActivityContentSchema.safeParse({
        ...runningSubagent,
        status,
        error: "not allowed",
      }).success,
    ).toBe(false)
  })

  it("requires an error for failed content", () => {
    expect(
      subagentActivityContentSchema.safeParse({ ...runningSubagent, status: "failed" }).success,
    ).toBe(false)
  })

  it.each([0, -1, 1.5])("rejects invalid depth %s", (depth) => {
    expect(subagentActivityContentSchema.safeParse({ ...runningSubagent, depth }).success).toBe(
      false,
    )
  })

  it("rejects a total tool count below the displayed tool count", () => {
    expect(
      subagentActivityContentSchema.safeParse({ ...runningSubagent, totalToolCount: 0 }).success,
    ).toBe(false)
  })
})

describe("plan activity card", () => {
  it("expands an active plan and shows progress with visible status labels", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard
        content={{
          todos: [
            { content: "Collect sources", status: "pending" },
            { content: "Analyze evidence", status: "in_progress" },
            { content: "Write report", status: "completed" },
          ],
        }}
      />,
    )

    expect(markup).toContain("<details open")
    expect(markup).toContain("Plan · 1/3 complete")
    expect(markup).toContain("pending")
    expect(markup).toContain("in progress")
    expect(markup).toContain("completed")
  })

  it("shows at most eight todos and reports the overflow", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard
        content={{
          todos: Array.from({ length: 10 }, (_, index) => ({
            content: `Step ${index + 1}`,
            status: "pending" as const,
          })),
        }}
      />,
    )

    expect(markup.match(/<li/g)).toHaveLength(8)
    expect(markup).toContain("+2 more")
  })

  it("collapses a plan with no active todo", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard
        content={{ todos: [{ content: "Collect sources", status: "completed" }] }}
      />,
    )

    expect(markup).not.toContain("<details open")
  })
})

const displayedTools = [
  { name: "searchCorpus", status: "completed" },
  { name: "readDoc", status: "completed" },
  { name: "extractQuotes", status: "completed" },
  { name: "compareSources", status: "running" },
  { name: "checkCitation", status: "incomplete" },
] as const

describe("subagent activity card", () => {
  it("expands running work with a child plan and five visible tool statuses", () => {
    const markup = renderToStaticMarkup(
      <SubagentActivityCard
        content={{
          name: "researcher",
          depth: 2,
          status: "running",
          todos: [
            { content: "Find primary sources", status: "completed" },
            { content: "Compare the evidence", status: "in_progress" },
          ],
          tools: displayedTools,
          totalToolCount: 12,
        }}
      />,
    )

    expect(markup).toContain("<details open")
    expect(markup).toContain("researcher")
    expect(markup).toContain("running")
    expect(markup).toContain("12 tools")
    expect(markup).toContain("Find primary sources")
    for (const tool of displayedTools) {
      expect(markup).toContain(tool.name)
      expect(markup).toContain(tool.status)
    }
  })

  it("labels only subagents deeper than the first level as nested", () => {
    const nestedMarkup = renderToStaticMarkup(
      <SubagentActivityCard
        content={{
          name: "fact checker",
          depth: 2,
          status: "completed",
          tools: [],
          totalToolCount: 0,
        }}
      />,
    )
    const rootMarkup = renderToStaticMarkup(
      <SubagentActivityCard
        content={{
          name: "researcher",
          depth: 1,
          status: "completed",
          tools: [],
          totalToolCount: 0,
        }}
      />,
    )

    expect(nestedMarkup).toContain("nested")
    expect(rootMarkup).not.toContain("nested")
  })

  it.each([
    {
      name: "researcher",
      depth: 1,
      status: "completed" as const,
      tools: [],
      totalToolCount: 0,
    },
    {
      name: "researcher",
      depth: 1,
      status: "failed" as const,
      tools: [],
      totalToolCount: 0,
      error: "The source service returned an error",
    },
  ])("collapses $status work", (content) => {
    const markup = renderToStaticMarkup(<SubagentActivityCard content={content} />)
    expect(markup).not.toContain("<details open")
  })

  it("shows the supplied bounded failure as an alert", () => {
    const boundedError = `Bounded failure: ${"x".repeat(380)}`
    const markup = renderToStaticMarkup(
      <SubagentActivityCard
        content={{
          name: "researcher",
          depth: 1,
          status: "failed",
          tools: [],
          totalToolCount: 0,
          error: boundedError,
        }}
      />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain(boundedError)
  })

  it("does not render runtime identifiers, inputs, or outputs", () => {
    const privateContent = {
      name: "researcher",
      depth: 1,
      status: "running" as const,
      tools: [],
      totalToolCount: 0,
      call_id: "CALL-ID-SENTINEL",
      route_id: "ROUTE-ID-SENTINEL",
      input: "INPUT-SENTINEL",
      output: "OUTPUT-SENTINEL",
    }
    const markup = renderToStaticMarkup(<SubagentActivityCard content={privateContent} />)

    expect(markup).not.toMatch(/CALL-ID-SENTINEL|ROUTE-ID-SENTINEL|INPUT-SENTINEL|OUTPUT-SENTINEL/)
  })
})

function descendantElements(element: ReactElement): ReactElement[] {
  const { children } = element.props as { children?: ReactNode }
  const childNodes = Array.isArray(children) ? children : [children]
  return childNodes.flatMap((child) =>
    isValidElement(child) ? [child, ...descendantElements(child)] : [],
  )
}

describe("activity card quality boundaries", () => {
  it("assigns unique identifier-free keys to duplicate todo content", () => {
    const checklist = ActivityChecklist({
      todos: [
        { content: "Review evidence", status: "pending" },
        { content: "Review evidence", status: "in_progress" },
      ],
    })
    const itemKeys = descendantElements(checklist)
      .filter((element) => element.type === "li")
      .map((element) => element.key)

    expect(new Set(itemKeys).size).toBe(itemKeys.length)
  })

  it("assigns unique identifier-free keys to duplicate tool names", () => {
    const card = SubagentActivityCard({
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [
          { name: "searchCorpus", status: "completed" },
          { name: "searchCorpus", status: "running" },
        ],
        totalToolCount: 2,
      },
    })
    const itemKeys = descendantElements(card)
      .filter((element) => element.type === "li")
      .map((element) => element.key)

    expect(new Set(itemKeys).size).toBe(itemKeys.length)
  })

  it("protects long unbroken plan content from overflowing", () => {
    const longContent = "evidence".repeat(60)
    const markup = renderToStaticMarkup(
      <PlanActivityCard content={{ todos: [{ content: longContent, status: "in_progress" }] }} />,
    )

    expect(markup).toContain(longContent)
    expect(markup).toContain("min-width:0")
    expect(markup).toContain("overflow-wrap:anywhere")
  })

  it("protects long unbroken subagent and tool names from overflowing", () => {
    const longName = "researcher".repeat(50)
    const longToolName = "searchCorpus".repeat(50)
    const markup = renderToStaticMarkup(
      <SubagentActivityCard
        content={{
          name: longName,
          depth: 1,
          status: "running",
          tools: [{ name: longToolName, status: "running" }],
          totalToolCount: 1,
        }}
      />,
    )

    expect(markup).toContain(longName)
    expect(markup).toContain(longToolName)
    expect(markup.match(/min-width:0/g)).toHaveLength(2)
    expect(markup.match(/overflow-wrap:anywhere/g)).toHaveLength(2)
  })

  it("retains explicit list semantics for the markerless checklist", () => {
    const markup = renderToStaticMarkup(
      <PlanActivityCard content={{ todos: [{ content: "Review evidence", status: "pending" }] }} />,
    )

    expect(markup).toMatch(/<ol[^>]*role="list"/)
  })

  it("retains explicit list semantics for markerless tools", () => {
    const markup = renderToStaticMarkup(
      <SubagentActivityCard
        content={{
          name: "researcher",
          depth: 1,
          status: "running",
          tools: [{ name: "searchCorpus", status: "running" }],
          totalToolCount: 1,
        }}
      />,
    )

    expect(markup).toMatch(/<ul[^>]*role="list"/)
  })
})

describe("activity renderer registry", () => {
  it("registers the public activity types in order", () => {
    expect(dawnActivityRenderers.map((renderer) => renderer.activityType)).toEqual([
      DAWN_PLAN_ACTIVITY_TYPE,
      DAWN_SUBAGENT_ACTIVITY_TYPE,
    ])
  })

  it("synchronously validates representative content through each renderer", () => {
    const representativeContent = [
      { todos: [{ content: "Write the report", status: "pending" }] },
      {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [{ name: "searchCorpus", status: "running" }],
        totalToolCount: 1,
      },
    ] as const

    dawnActivityRenderers.forEach((renderer, index) => {
      const result = renderer.content["~standard"].validate(representativeContent[index])
      expect(result).not.toBeInstanceOf(Promise)
      if (result instanceof Promise) throw new Error("activity validation must be synchronous")
      expect("value" in result).toBe(true)
    })
  })
})
