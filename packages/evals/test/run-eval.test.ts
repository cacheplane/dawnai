import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { runEval } from "../src/run-eval.js"
import { contains, toolCalled } from "../src/scorers.js"
import { gate } from "../src/gate.js"

function run(finalMessage: string, toolCalls: AgentRunResult["toolCalls"] = []): AgentRunResult {
  return {
    finalMessage, messages: [], toolCalls, tokens: [], state: {}, threadId: "t",
    interrupts: [], planUpdates: [], todos: [], subagents: [], subagentEvents: [], systemPrompt: "",
  }
}

describe("runEval", () => {
  it("scores every case×scorer, aggregates, and applies the gate", async () => {
    const report = await runEval(
      {
        name: "filter",
        dataset: [
          { name: "open", input: "filter open", expected: "Found 2" },
          { name: "none", input: "filter none", expected: "none" },
        ],
        scorers: [contains("Found"), toolCalled("applyFilter", { threshold: 1 })],
        gate: gate.perScorer(),
      },
      {
        runCase: async (c) =>
          c.name === "open"
            ? run("Found 2", [{ name: "applyFilter", args: {} }])
            : run("nothing here"),
      },
    )
    expect(report.cases).toHaveLength(2)
    expect(report.byScorer.find((s) => s.scorer.startsWith("contains"))?.mean).toBe(0.5)
    // applyFilter only called for "open" → mean 0.5 < threshold 1 → gate fails
    expect(report.passed).toBe(false)
    expect(report.gated).toBe(true)
  })

  it("a thrown scorer scores 0 with the error in reason and does not abort", async () => {
    const report = await runEval(
      {
        name: "e",
        dataset: [{ input: "x" }],
        scorers: [
          { name: "boom", score: () => { throw new Error("kaboom") } },
          contains("x"),
        ],
        threshold: 0,
      },
      { runCase: async () => run("x marks") },
    )
    const boom = report.cases[0]!.scores.find((s) => s.scorer === "boom")!
    expect(boom.score).toBe(0)
    expect(boom.reason).toMatch(/kaboom/)
    expect(report.passed).toBe(true) // threshold 0
  })

  it("is informational (passes) when no gate or threshold is set", async () => {
    const report = await runEval(
      { name: "e", dataset: [{ input: "x" }], scorers: [contains("z")] },
      { runCase: async () => run("no match") },
    )
    expect(report.mean).toBe(0)
    expect(report.gated).toBe(false)
    expect(report.passed).toBe(true)
  })
})
