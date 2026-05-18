import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyCapabilities, createCapabilityRegistry, createPlanningMarker } from "@dawn-ai/core"
import { type Command, isCommand } from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { convertToolToLangChain } from "../src/tool-converter.js"

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
    const result = await applyCapabilities(registry, routeDir, { routeManifest: { appRoot: routeDir, routes: [] }, descriptor: undefined })
    expect(result.contributions).toEqual([])
  })

  it("contributes writeTodos + todos channel + prompt fragment + transformer when plan.md is present", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir, { routeManifest: { appRoot: routeDir, routes: [] }, descriptor: undefined })

    expect(result.contributions).toHaveLength(1)
    const contrib = result.contributions[0]?.contribution
    expect(contrib?.tools?.map((t) => t.name)).toEqual(["writeTodos"])
    expect(contrib?.stateFields?.map((f) => f.name)).toEqual(["todos"])
    expect(contrib?.promptFragment?.placement).toBe("after_user_prompt")
    expect(contrib?.streamTransformers?.[0]?.observes).toBe("tool_result")
  })

  it("seeds the todos channel from a populated plan.md", async () => {
    writeFileSync(join(routeDir, "plan.md"), "- [ ] survey workspace\n- [x] read AGENTS.md\n")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir, { routeManifest: { appRoot: routeDir, routes: [] }, descriptor: undefined })
    const todosField = result.contributions[0]?.contribution.stateFields?.[0]
    expect(todosField?.default).toEqual([
      { content: "survey workspace", status: "pending" },
      { content: "read AGENTS.md", status: "completed" },
    ])
  })

  it("renders prompt with current todos on each call", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir, { routeManifest: { appRoot: routeDir, routes: [] }, descriptor: undefined })
    const fragment = result.contributions[0]?.contribution.promptFragment
    const r1 = fragment?.render({ todos: [] }) ?? ""
    const r2 = fragment?.render({ todos: [{ content: "x", status: "in_progress" }] }) ?? ""
    expect(r1).toContain("(empty)")
    expect(r2).toContain("[in_progress] x")
  })

  it("transformer emits plan_update when writeTodos result flows through", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir, { routeManifest: { appRoot: routeDir, routes: [] }, descriptor: undefined })
    const transformer = result.contributions[0]?.contribution.streamTransformers?.[0]

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      for await (const out of transformer.transform({
        toolName: "writeTodos",
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

describe("planning capability — state mutation end-to-end", () => {
  it("writeTodos tool returns a Command that updates the todos channel", async () => {
    const routeDir = mkdtempSync(join(tmpdir(), "dawn-planning-state-"))
    writeFileSync(join(routeDir, "plan.md"), "")

    try {
      const registry = createCapabilityRegistry([createPlanningMarker()])
      const result = await applyCapabilities(registry, routeDir, { routeManifest: { appRoot: routeDir, routes: [] }, descriptor: undefined })
      const writeTodos = result.contributions[0]?.contribution.tools?.[0]
      expect(writeTodos?.name).toBe("writeTodos")

      const newTodos = [
        { content: "first task", status: "in_progress" as const },
        { content: "second task", status: "pending" as const },
      ]

      const converted = convertToolToLangChain(writeTodos!)
      const langchainResult = await converted.func(
        { todos: newTodos },
        undefined as unknown as never,
        { signal: new AbortController().signal } as unknown as never,
      )

      expect(isCommand(langchainResult)).toBe(true)
      const cmd = langchainResult as InstanceType<typeof Command>
      const update = cmd.update as Record<string, unknown> & {
        messages?: Array<{ content?: unknown }>
      }
      expect(update.todos).toEqual(newTodos)
      // Confirms the ToolMessage is present so the agent still sees the result
      expect(Array.isArray(update.messages)).toBe(true)
      const msg = update.messages?.[0]
      expect(msg?.content).toBe(JSON.stringify({ todos: newTodos }))
    } finally {
      rmSync(routeDir, { recursive: true, force: true })
    }
  })
})
