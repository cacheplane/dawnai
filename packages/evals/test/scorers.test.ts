import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { contains, custom, exactMatch, jsonEquals, regex, toolCalled, tokensUnder } from "../src/scorers.js"
import { normalizeScore } from "../src/score.js"

function run(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    finalMessage: "",
    messages: [],
    toolCalls: [],
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

describe("built-in scorers", () => {
  it("contains scores 1 when finalMessage includes the substring, else 0", async () => {
    expect(normalizeScore(await contains("Found").score(run({ finalMessage: "Found 2" }), noCase)).score).toBe(1)
    expect(normalizeScore(await contains("Found").score(run({ finalMessage: "none" }), noCase)).score).toBe(0)
  })
  it("regex matches finalMessage", async () => {
    expect(normalizeScore(await regex(/\d+ items/).score(run({ finalMessage: "3 items" }), noCase)).score).toBe(1)
  })
  it("exactMatch compares finalMessage to case.expected", async () => {
    expect(normalizeScore(await exactMatch().score(run({ finalMessage: "ok" }), { input: "", expected: "ok" })).score).toBe(1)
    expect(normalizeScore(await exactMatch().score(run({ finalMessage: "ok" }), { input: "", expected: "no" })).score).toBe(0)
  })
  it("jsonEquals deep-compares parsed finalMessage to case.expected", async () => {
    const r = run({ finalMessage: '{"a":1,"b":[2,3]}' })
    expect(normalizeScore(await jsonEquals().score(r, { input: "", expected: { a: 1, b: [2, 3] } })).score).toBe(1)
  })
  it("toolCalled scores 1 when the named tool was called", async () => {
    const r = run({ toolCalls: [{ name: "applyFilter", args: { status: "open" } }] })
    expect(normalizeScore(await toolCalled("applyFilter").score(r, noCase)).score).toBe(1)
    expect(normalizeScore(await toolCalled("applyFilter", { withArgs: { status: "open" } }).score(r, noCase)).score).toBe(1)
    expect(normalizeScore(await toolCalled("applyFilter", { withArgs: { status: "closed" } }).score(r, noCase)).score).toBe(0)
    expect(normalizeScore(await toolCalled("missing").score(r, noCase)).score).toBe(0)
  })
  it("tokensUnder scores 1 when streamed token count is under the budget", async () => {
    expect(normalizeScore(await tokensUnder(5).score(run({ tokens: ["a", "b"] }), noCase)).score).toBe(1)
    expect(normalizeScore(await tokensUnder(1).score(run({ tokens: ["a", "b"] }), noCase)).score).toBe(0)
  })
  it("custom wraps an async function and carries name + threshold", async () => {
    const s = custom(async (r) => (r.toolCalls.length <= 2 ? 1 : 0), { name: "few-tools", threshold: 1 })
    expect(s.name).toBe("few-tools")
    expect(s.threshold).toBe(1)
    expect(normalizeScore(await s.score(run({}), noCase)).score).toBe(1)
  })
})
