import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createPlanningMarker } from "../../src/capabilities/built-in/planning.js"

describe("createPlanningMarker", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-planning-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("does not detect when plan.md is absent", async () => {
    const marker = createPlanningMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("detects when plan.md is present (empty)", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    expect(await marker.detect(routeDir)).toBe(true)
  })

  it("contributes a write_todos tool when loaded", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.tools?.[0]?.name).toBe("write_todos")
  })

  it("contributes a todos state field when loaded", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.stateFields?.[0]?.name).toBe("todos")
    expect(contribution.stateFields?.[0]?.reducer).toBe("replace")
    expect(contribution.stateFields?.[0]?.default).toEqual([])
  })

  it("seeds the todos state field from plan.md content", async () => {
    writeFileSync(join(routeDir, "plan.md"), "- [ ] one\n- [x] two\n")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.stateFields?.[0]?.default).toEqual([
      { content: "one", status: "pending" },
      { content: "two", status: "completed" },
    ])
  })

  it("contributes a prompt fragment for the planning instructions", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    const rendered = contribution.promptFragment?.render({ todos: [] }) ?? ""
    expect(rendered).toContain("# Planning")
    expect(rendered).toContain("write_todos")
  })

  it("renders the current todos in the prompt fragment", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const rendered =
      contribution.promptFragment?.render({
        todos: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "pending" },
        ],
      }) ?? ""
    expect(rendered).toContain("[in_progress] first")
    expect(rendered).toContain("[pending] second")
  })

  it("contributes a stream transformer that maps write_todos results to plan_update events", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const transformer = contribution.streamTransformers?.[0]
    expect(transformer?.observes).toBe("tool_result")

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      const newTodos = [{ content: "x", status: "pending" }]
      for await (const out of transformer.transform({
        toolName: "write_todos",
        toolOutput: { todos: newTodos },
      })) {
        events.push(out)
      }
    }

    expect(events).toEqual([
      { event: "plan_update", data: { todos: [{ content: "x", status: "pending" }] } },
    ])
  })

  it("stream transformer reads todos from a Command-shaped toolOutput (post-2c bridge)", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const transformer = contribution.streamTransformers?.[0]

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      const newTodos = [{ content: "from command", status: "in_progress" }]
      // Simulate the shape that arrives after tool-converter wraps a
      // {result, state} return into a Command — the toolOutput's `update`
      // carries the state mutation.
      for await (const out of transformer.transform({
        toolName: "write_todos",
        toolOutput: { update: { todos: newTodos } },
      })) {
        events.push(out)
      }
    }

    expect(events).toEqual([
      {
        event: "plan_update",
        data: { todos: [{ content: "from command", status: "in_progress" }] },
      },
    ])
  })

  it("stream transformer ignores tool results from other tools", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const transformer = contribution.streamTransformers?.[0]
    const events: Array<unknown> = []
    if (transformer) {
      for await (const out of transformer.transform({
        toolName: "some_other_tool",
        toolOutput: { whatever: true },
      })) {
        events.push(out)
      }
    }
    expect(events).toEqual([])
  })
})
