import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { memoryFresh, memoryIsolated, memoryRecalled } from "../src/scorers.js"
import { normalizeScore } from "../src/score.js"

function run(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    finalMessage: "",
    messages: [],
    toolCalls: [],
    toolResults: [],
    tokens: [],
    state: {},
    threadId: "t",
    interrupts: [],
    planUpdates: [],
    todos: [],
    subagents: [],
    subagentEvents: [],
    systemPrompt: "",
    ...partial,
  }
}

const noCase = { input: "" }

function recallResult(content: string) {
  return { name: "recall", content, isError: false } as const
}

describe("memoryRecalled", () => {
  it("scores 1 when all expected ids appear in recall tool output", async () => {
    const r = run({
      toolResults: [recallResult('{"id":"mem-1","value":"foo"}'), recallResult('{"id":"mem-2","value":"bar"}')],
    })
    const result = normalizeScore(await memoryRecalled(["mem-1", "mem-2"]).score(r, noCase))
    expect(result.score).toBe(1)
  })

  it("scores 0 with reason when any expected id is missing", async () => {
    const r = run({
      toolResults: [recallResult('{"id":"mem-1","value":"foo"}')],
    })
    const result = normalizeScore(await memoryRecalled(["mem-1", "mem-2"]).score(r, noCase))
    expect(result.score).toBe(0)
    expect(result.reason).toContain("mem-2")
  })

  it("scores 0 when no recall results at all", async () => {
    const r = run({ toolResults: [] })
    const result = normalizeScore(await memoryRecalled(["mem-1"]).score(r, noCase))
    expect(result.score).toBe(0)
  })

  it("ignores tool results from other tools", async () => {
    const r = run({
      toolResults: [
        { name: "store", content: "mem-1", isError: false },
        recallResult("mem-2"),
      ],
    })
    const result = normalizeScore(await memoryRecalled(["mem-1", "mem-2"]).score(r, noCase))
    expect(result.score).toBe(0)
    expect(result.reason).toContain("mem-1")
  })
})

describe("memoryFresh", () => {
  it("scores 1 when finalMessage contains the expected value", async () => {
    const r = run({ finalMessage: "Your updated preference is dark mode." })
    const result = normalizeScore(await memoryFresh("dark mode").score(r, noCase))
    expect(result.score).toBe(1)
  })

  it("scores 0 when finalMessage does not contain the expected value", async () => {
    const r = run({ finalMessage: "Your preference is light mode." })
    const result = normalizeScore(await memoryFresh("dark mode").score(r, noCase))
    expect(result.score).toBe(0)
    expect(result.reason).toContain("dark mode")
  })
})

describe("memoryIsolated", () => {
  it("scores 1 when forbidden string is absent from recall outputs and finalMessage", async () => {
    const r = run({
      finalMessage: "Here is your data.",
      toolResults: [recallResult('{"id":"user-A","value":"hello"}')],
    })
    const result = normalizeScore(await memoryIsolated("user-B-secret").score(r, noCase))
    expect(result.score).toBe(1)
  })

  it("scores 0 when forbidden string leaks in a recall tool output", async () => {
    const r = run({
      finalMessage: "Here is your data.",
      toolResults: [recallResult('{"id":"user-B-secret","value":"leaked"}')],
    })
    const result = normalizeScore(await memoryIsolated("user-B-secret").score(r, noCase))
    expect(result.score).toBe(0)
    expect(result.reason).toContain("user-B-secret")
  })

  it("scores 0 when forbidden string leaks in finalMessage", async () => {
    const r = run({
      finalMessage: "Your data: user-B-secret was found.",
      toolResults: [],
    })
    const result = normalizeScore(await memoryIsolated("user-B-secret").score(r, noCase))
    expect(result.score).toBe(0)
  })
})
