/**
 * Capability coverage e2e — dogfoods @dawn-ai/testing against the REAL chat
 * example app (and the real coordinator route), in-process, with a mocked LLM.
 *
 * Each scenario reads the live capability behavior of the chat/coordinator
 * routes (memory, skills, planning, permissions, subagents) and asserts the
 * harness surfaces it. Tool names / interrupt envelopes / task input keys were
 * confirmed against source before writing the assertions:
 *
 *  - memory     → AGENTS.md auto-injected under "# Memory"; AGENTS.md line
 *                 "# Workspace memory" is rendered into the system prompt.
 *  - skills     → skills/ dir autowires; prompt heading "# Skills"; tool readSkill({name}).
 *  - planning   → plan.md autowires; tool writeTodos({todos:[{content,status}]});
 *                 emits plan_update.
 *  - permissions→ runBash({command}); non-allow-listed command emits interrupt
 *                 kind "command" with detail {command}; resume({decision:"once"}).
 *  - subagents  → coordinator dispatches via task({subagent,input}); child seeded
 *                 with user message == the `input` value; subagent.start carries
 *                 name "research".
 *
 * NOTE: the chat and coordinator harnesses each start their own aimock server
 * and set process.env.OPENAI_BASE_URL. Because that env var is process-global
 * and the per-descriptor LLM cache binds to whatever URL is live at first use,
 * only ONE harness may be alive at a time. We therefore construct each harness
 * in beforeAll and tear it down in afterAll (which resets the materialized-agent
 * cache), rather than holding both open at module scope.
 */
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, it } from "vitest"
import {
  type AgentHarness,
  createAgentHarness,
  expectInterrupt,
  expectNoInterrupt,
  expectPlan,
  expectSubagent,
  expectSystemPrompt,
  expectToolCalled,
  script,
} from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))

describe("chat capabilities", () => {
  let chat: AgentHarness
  beforeAll(async () => {
    chat = await createAgentHarness({ appRoot, route: "/chat#agent" })
  })
  afterAll(() => chat.close())

  // ── Scenario 1: memory (agents-md) ───────────────────────────────────────
  it("memory: AGENTS.md is auto-injected into the system prompt", async () => {
    chat.reset()
    const run = await chat.run({
      input: "what tooling conventions apply here?",
      fixtures: script()
        .user("what tooling conventions apply here?")
        .replies("Tools are camelCase: listDir, readFile, writeFile, runBash."),
    })
    // Confirmed present in workspace/AGENTS.md (first heading line).
    expectSystemPrompt(run).toContain("# Workspace memory")
  }, 60_000)

  // ── Scenario 2: skills ───────────────────────────────────────────────────
  it("skills: # Skills heading present + readSkill loads a named skill", async () => {
    chat.reset()
    const run = await chat.run({
      input: "how should I recover from a failed tool call?",
      fixtures: script()
        .user("how should I recover from a failed tool call?")
        .callsTool("readSkill", { name: "recover-from-failure" })
        .replies("Read the error first, don't blindly retry."),
    })
    // Confirmed heading in packages/core/src/capabilities/built-in/skills.ts.
    expectSystemPrompt(run).toContain("# Skills")
    expectToolCalled(run, "readSkill").withArgs({ name: "recover-from-failure" })
  }, 60_000)

  // ── Scenario 3: planning ─────────────────────────────────────────────────
  it("planning: writeTodos emits a plan_update captured as todos", async () => {
    chat.reset()
    const run = await chat.run({
      input: "draft an outline for the docs",
      fixtures: script()
        .user("draft an outline for the docs")
        .callsTool("writeTodos", {
          todos: [{ content: "Draft the outline", status: "in_progress" }],
        })
        .replies("Outline drafting is in progress."),
    })
    expectPlan(run).toHaveTodo("Draft the outline")
    expectPlan(run).toHaveStatus("Draft the outline", "in_progress")
  }, 60_000)

  // ── Scenario 4: permissions (HITL) ───────────────────────────────────────
  it("permissions: non-allow-listed runBash command interrupts, then resumes", async () => {
    chat.reset()
    // First turn: model asks to run a command NOT on the allow-list.
    const run = await chat.run({
      input: "check the latest react version on npm",
      fixtures: script()
        .user("check the latest react version on npm")
        .callsTool("runBash", { command: "npm view react version" })
        .replies("React's latest version is shown above."),
    })
    // Confirmed: workspace capability emits interrupt kind "command" with
    // detail { command, suggestedPattern } for bash gate "unknown" in interactive mode.
    expectInterrupt(run).ofKind("command").withDetail({ command: "npm view react version" })

    // Resume with a one-time approval; the gate releases and runBash executes.
    const resumed = await chat.resume({ decision: "once" })
    expectToolCalled(resumed, "runBash")
  }, 60_000)

  it("permissions: allow-listed ls runs without an interrupt", async () => {
    chat.reset()
    const run = await chat.run({
      input: "list the workspace files",
      fixtures: script()
        .user("list the workspace files")
        .callsTool("runBash", { command: "ls" })
        .replies("Listed the workspace."),
    })
    expectNoInterrupt(run)
    expectToolCalled(run, "runBash").withArgs({ command: "ls" })
  }, 60_000)
})

// ── Scenario 5: subagents (coordinator route) ──────────────────────────────
describe("coordinator capabilities", () => {
  let coordinator: AgentHarness
  beforeAll(async () => {
    coordinator = await createAgentHarness({ appRoot, route: "/coordinator#agent" })
  })
  afterAll(() => coordinator.close())

  it("subagents: task dispatches to the research subagent", async () => {
    coordinator.reset()
    const childQuestion = "What conventions are documented in AGENTS.md?"
    const run = await coordinator.run({
      input: "research the workspace conventions and summarize",
      fixtures: script()
        // Parent: dispatch to the research subagent.
        .user("research the workspace conventions and summarize")
        .callsTool("task", { subagent: "research", input: childQuestion })
        .replies("Research complete: tools use camelCase names.")
        // Child: the dispatcher seeds the child's user message with the `input`
        // value passed to task(), so the fixture matches on that text.
        .user(childQuestion)
        .replies("Workspace tools use camelCase names: listDir, readFile, writeFile, runBash."),
    })
    expectSubagent(run, "research").called()
    expectSubagent(run, "research").finalMessageContains("camelCase")
  }, 60_000)
})
