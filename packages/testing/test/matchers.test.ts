import { expect, it } from "vitest"
import { expectFinalMessage, expectState, expectStreamedTokens, expectToolCalled } from "../src/matchers.js"
import type { AgentRunResult } from "../src/run-result.js"

const base: AgentRunResult = {
  threadId: "t",
  tokens: ["Found ", "2."],
  toolCalls: [{ name: "applyFilter", args: { status: "open" }, id: "call_1" }],
  finalMessage: "Found 2 items.",
  messages: [{}, {}, {}, {}],
  state: { messages: [{}, {}, {}, {}], runningSummary: { summary: "s" } },
}

it("expectToolCalled passes for a called tool and withArgs subset", () => {
  expectToolCalled(base, "applyFilter").withArgs({ status: "open" })
})
it("expectToolCalled .never() throws when the tool WAS called", () => {
  expect(() => expectToolCalled(base, "applyFilter").never()).toThrow()
})
it("expectToolCalled throws for an uncalled tool", () => {
  expect(() => expectToolCalled(base, "readFile")).toThrow(/readFile/)
})
it("expectFinalMessage.toContain", () => {
  expectFinalMessage(base).toContain("Found 2")
  expect(() => expectFinalMessage(base).toContain("nope")).toThrow()
})
it("expectStreamedTokens passes when tokens present", () => {
  expectStreamedTokens(base)
  expect(() => expectStreamedTokens({ ...base, tokens: [] })).toThrow()
})
it("expectState messages length + field", () => {
  expectState(base).messages.toHaveLength(4)
  expectState(base).field("runningSummary").toBeTruthy()
  expect(() => expectState(base).messages.toHaveLength(2)).toThrow()
})
