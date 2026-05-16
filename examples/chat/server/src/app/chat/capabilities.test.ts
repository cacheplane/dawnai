/**
 * Verifies that Dawn's capability autowiring engine, when run against this
 * chat route's directory, produces the expected contributions:
 *
 * - planning (because src/app/chat/plan.md is present) → write_todos tool,
 *   todos state channel, planning prompt fragment, plan_update transformer.
 * - agents-md (always-on) → memory prompt fragment that reads
 *   <process.cwd()>/workspace/AGENTS.md on every render.
 *
 * These are example-level integration tests that exercise the framework's
 * autowiring against the actual route's filesystem layout, without spinning
 * up a real LLM. The framework-side unit tests for each marker live in
 * @dawn-ai/core; this file just confirms the example wires together.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applyCapabilities,
  createAgentsMdMarker,
  createCapabilityRegistry,
  createPlanningMarker,
} from "@dawn-ai/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const ROUTE_DIR = dirname(fileURLToPath(import.meta.url))

describe("chat route — autowired capabilities", () => {
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "chat-route-caps-"))
    originalCwd = process.cwd()
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workDir, { recursive: true, force: true })
  })

  it("includes both planning and agents-md contributions for the chat route", async () => {
    const registry = createCapabilityRegistry([
      createPlanningMarker(),
      createAgentsMdMarker(),
    ])
    const result = await applyCapabilities(registry, ROUTE_DIR)

    expect(result.errors).toEqual([])
    expect(result.contributions.map((c) => c.markerName)).toEqual([
      "planning",
      "agents-md",
    ])
  })

  it("planning contribution comes from this route's plan.md", async () => {
    expect(existsSync(resolve(ROUTE_DIR, "plan.md"))).toBe(true)

    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, ROUTE_DIR)
    const planning = result.contributions[0]?.contribution

    expect(planning?.tools?.map((t) => t.name)).toEqual(["write_todos"])
    expect(planning?.stateFields?.map((f) => f.name)).toEqual(["todos"])
    expect(planning?.promptFragment?.placement).toBe("after_user_prompt")
  })

  it("agents-md fragment renders memory from <cwd>/workspace/AGENTS.md", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(
      join(workDir, "workspace", "AGENTS.md"),
      "Project convention: tools are camelCase.",
    )

    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, ROUTE_DIR)
    const fragment = result.contributions[0]?.contribution.promptFragment
    const rendered = fragment?.render({}) ?? ""

    expect(rendered).toContain("# Memory")
    expect(rendered).toContain("Project convention: tools are camelCase.")
  })

  it("agents-md fragment is empty when workspace/AGENTS.md is absent", async () => {
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, ROUTE_DIR)
    const fragment = result.contributions[0]?.contribution.promptFragment
    expect(fragment?.render({})).toBe("")
  })

  it("closes the feedback loop: rewriting AGENTS.md changes the next render", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const path = join(workDir, "workspace", "AGENTS.md")

    writeFileSync(path, "Iteration 1: tools should be camelCase")
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, ROUTE_DIR)
    const fragment = result.contributions[0]?.contribution.promptFragment

    const first = fragment?.render({}) ?? ""
    expect(first).toContain("Iteration 1")

    // Simulate the agent calling writeFile to update its memory.
    writeFileSync(path, "Iteration 2: never modify generated files in .dawn/")
    const second = fragment?.render({}) ?? ""

    expect(second).toContain("Iteration 2")
    expect(second).not.toContain("Iteration 1")
  })

  it("planning prompt re-renders todos from live state on each call", async () => {
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, ROUTE_DIR)
    const fragment = result.contributions[0]?.contribution.promptFragment

    const empty = fragment?.render({ todos: [] }) ?? ""
    expect(empty).toContain("(empty)")

    const populated =
      fragment?.render({
        todos: [
          { content: "investigate the bug", status: "in_progress" },
          { content: "write a regression test", status: "pending" },
        ],
      }) ?? ""

    expect(populated).toContain("[in_progress] investigate the bug")
    expect(populated).toContain("[pending] write a regression test")
  })
})
