import { expect, it } from "vitest"
import {
  expectFinalMessage,
  expectInterrupt,
  expectNoInterrupt,
  expectPlan,
  expectState,
  expectStreamedTokens,
  expectSubagent,
  expectSystemPrompt,
  expectToolCalled,
} from "../src/matchers.js"
import type { AgentRunResult } from "../src/run-result.js"

const base: AgentRunResult = {
  threadId: "t",
  tokens: ["Found ", "2."],
  toolCalls: [{ name: "applyFilter", args: { status: "open" }, id: "call_1" }],
  finalMessage: "Found 2 items.",
  messages: [{}, {}, {}, {}],
  state: { messages: [{}, {}, {}, {}], runningSummary: { summary: "s" } },
  interrupts: [],
  planUpdates: [],
  todos: [],
  subagents: [],
  subagentEvents: [],
  systemPrompt: "",
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

import { expectOffloaded } from "../src/matchers.js"

it("expectOffloaded asserts the tool output was offloaded to a stub", () => {
  const run = {
    ...base,
    messages: [
      {
        id: ["lc", "messages", "ToolMessage"],
        kwargs: {
          name: "generateReport",
          content: "Tool output offloaded — 50000 chars. Full output saved to: tool-outputs/x.txt",
        },
      },
    ],
    state: { messages: [] },
  } as unknown as AgentRunResult
  expectOffloaded(run, "generateReport")
  expect(() => expectOffloaded(run, "applyFilter")).toThrow()
})

// ── capability matchers ────────────────────────────────────────────────────
const withInterrupt: AgentRunResult = {
  ...base,
  interrupts: [{ interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } }],
}
const withSubagent: AgentRunResult = {
  ...base,
  subagents: [
    {
      callId: "c1",
      name: "research",
      toolCalls: [{ name: "webSearch", args: { q: "x" } }],
      finalMessage: "found it",
    },
  ],
  subagentEvents: [
    { type: "subagent.start", data: { call_id: "c1", subagent: "research" } },
    { type: "subagent.tool_call", data: { call_id: "c1", tool: "webSearch", input: { q: "x" } } },
    { type: "subagent.end", data: { call_id: "c1", final_message: "found it" } },
  ],
}
const withPlan: AgentRunResult = {
  ...base,
  planUpdates: [
    { todos: [{ content: "Write tests", status: "pending" }] },
    { todos: [{ content: "Write tests", status: "completed" }] },
  ],
  todos: [{ content: "Write tests", status: "completed" }],
}
const withSystemPrompt: AgentRunResult = {
  ...base,
  systemPrompt: "You are a helpful assistant.",
}

it("expectInterrupt.ofKind passes for matching kind", () => {
  expectInterrupt(withInterrupt).ofKind("command")
})
it("expectInterrupt.ofKind throws for wrong kind", () => {
  expect(() => expectInterrupt(withInterrupt).ofKind("approval")).toThrow()
})
it("expectInterrupt.withDetail passes for matching detail subset", () => {
  expectInterrupt(withInterrupt).withDetail({ command: "rm -rf tmp" })
})
it("expectInterrupt.withDetail throws when detail doesn't match", () => {
  expect(() => expectInterrupt(withInterrupt).withDetail({ command: "other" })).toThrow()
})
it("expectInterrupt throws when there are no interrupts", () => {
  expect(() => expectInterrupt(base).ofKind("command")).toThrow()
})
it("expectNoInterrupt passes when there are no interrupts", () => {
  expectNoInterrupt(base)
})
it("expectNoInterrupt throws when there is an interrupt", () => {
  expect(() => expectNoInterrupt(withInterrupt)).toThrow()
})

it("expectSubagent.called passes for a known subagent name", () => {
  expectSubagent(withSubagent).called("research")
})
it("expectSubagent.called throws for unknown name", () => {
  expect(() => expectSubagent(withSubagent).called("unknown")).toThrow()
})
it("expectSubagent.calledTool passes when the subagent used the tool", () => {
  expectSubagent(withSubagent).calledTool("webSearch")
})
it("expectSubagent.calledTool throws when tool not called", () => {
  expect(() => expectSubagent(withSubagent).calledTool("readFile")).toThrow()
})
it("expectSubagent.finalMessageContains passes when message contains text", () => {
  expectSubagent(withSubagent).finalMessageContains("found it")
})
it("expectSubagent.finalMessageContains throws when text not found", () => {
  expect(() => expectSubagent(withSubagent).finalMessageContains("nope")).toThrow()
})

it("expectPlan.toHaveTodo passes when todo content exists", () => {
  expectPlan(withPlan).toHaveTodo("Write tests")
})
it("expectPlan.toHaveTodo throws when todo content not found", () => {
  expect(() => expectPlan(withPlan).toHaveTodo("Deploy")).toThrow()
})
it("expectPlan.toHaveStatus passes for matching content+status", () => {
  expectPlan(withPlan).toHaveStatus("Write tests", "completed")
})
it("expectPlan.toHaveStatus throws for wrong status", () => {
  expect(() => expectPlan(withPlan).toHaveStatus("Write tests", "pending")).toThrow()
})

it("expectSystemPrompt.toContain passes when text is in systemPrompt", () => {
  expectSystemPrompt(withSystemPrompt).toContain("helpful assistant")
})
it("expectSystemPrompt.toContain throws when text not found", () => {
  expect(() => expectSystemPrompt(withSystemPrompt).toContain("evil robot")).toThrow()
})
