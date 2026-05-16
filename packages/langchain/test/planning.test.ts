import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyCapabilities, createCapabilityRegistry, createPlanningMarker } from "@dawn-ai/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

describe("planning capability — end-to-end shape", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-planning-e2e-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("contributes nothing when plan.md is absent", async () => {
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
  })

  it("contributes write_todos + todos channel + prompt fragment + transformer when plan.md is present", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)

    expect(result.contributions).toHaveLength(1)
    const contrib = result.contributions[0]?.contribution
    expect(contrib?.tools?.map((t) => t.name)).toEqual(["write_todos"])
    expect(contrib?.stateFields?.map((f) => f.name)).toEqual(["todos"])
    expect(contrib?.promptFragment?.placement).toBe("after_user_prompt")
    expect(contrib?.streamTransformers?.[0]?.observes).toBe("tool_result")
  })

  it("seeds the todos channel from a populated plan.md", async () => {
    writeFileSync(join(routeDir, "plan.md"), "- [ ] survey workspace\n- [x] read AGENTS.md\n")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const todosField = result.contributions[0]?.contribution.stateFields?.[0]
    expect(todosField?.default).toEqual([
      { content: "survey workspace", status: "pending" },
      { content: "read AGENTS.md", status: "completed" },
    ])
  })

  it("renders prompt with current todos on each call", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    const r1 = fragment?.render({ todos: [] }) ?? ""
    const r2 = fragment?.render({ todos: [{ content: "x", status: "in_progress" }] }) ?? ""
    expect(r1).toContain("(empty)")
    expect(r2).toContain("[in_progress] x")
  })

  it("transformer emits plan_update when write_todos result flows through", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const transformer = result.contributions[0]?.contribution.streamTransformers?.[0]

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      for await (const out of transformer.transform({
        toolName: "write_todos",
        toolOutput: { todos: [{ content: "x", status: "pending" }] },
      })) {
        events.push(out)
      }
    }
    expect(events).toEqual([
      { event: "plan_update", data: { todos: [{ content: "x", status: "pending" }] } },
    ])
  })
})
