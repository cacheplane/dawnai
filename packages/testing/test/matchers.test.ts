import { describe, expect, it } from "vitest"
import {
  expectFinalMessage,
  expectInterrupt,
  expectNoInterrupt,
  expectNoToolErrors,
  expectPlan,
  expectState,
  expectStreamedTokens,
  expectSubagent,
  expectSystemPrompt,
  expectToolCalled,
  expectToolSequence,
} from "../src/matchers.js"
import { createSafeRegexTester } from "../src/regex-safety.js"
import type { AgentRunResult } from "../src/run-result.js"

const base: AgentRunResult = {
  threadId: "t",
  tokens: ["Found ", "2."],
  toolCalls: [{ name: "applyFilter", args: { status: "open" }, id: "call_1" }],
  toolResults: [],
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
  interrupts: [
    {
      interruptId: "perm-1",
      kind: "command",
      detail: { command: "rm -rf tmp", suggestedPattern: "rm -rf tmp" },
    },
  ],
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
it("expectInterrupt chains ofKind then withDetail", () => {
  expectInterrupt(withInterrupt).ofKind("command").withDetail({ command: "rm -rf tmp" })
})
it("expectNoInterrupt passes when there are no interrupts", () => {
  expectNoInterrupt(base)
})
it("expectNoInterrupt throws when there is an interrupt", () => {
  expect(() => expectNoInterrupt(withInterrupt)).toThrow()
})

it("expectSubagent.called passes for a known subagent name", () => {
  expectSubagent(withSubagent, "research").called()
})
it("expectSubagent.called throws for unknown name", () => {
  expect(() => expectSubagent(withSubagent, "unknown").called()).toThrow()
})
it("expectSubagent.calledTool passes when the subagent used the tool", () => {
  expectSubagent(withSubagent, "research").calledTool("webSearch")
})
it("expectSubagent.calledTool throws when tool not called", () => {
  expect(() => expectSubagent(withSubagent, "research").calledTool("readFile")).toThrow()
})
it("expectSubagent.calledTool throws when subagent not dispatched", () => {
  expect(() => expectSubagent(withSubagent, "unknown").calledTool("webSearch")).toThrow()
})
it("expectSubagent.finalMessageContains passes when message contains text", () => {
  expectSubagent(withSubagent, "research").finalMessageContains("found it")
})
it("expectSubagent.finalMessageContains throws when text not found", () => {
  expect(() => expectSubagent(withSubagent, "research").finalMessageContains("nope")).toThrow()
})
it("expectSubagent.finalMessageContains throws when subagent not dispatched", () => {
  expect(() => expectSubagent(withSubagent, "unknown").finalMessageContains("found it")).toThrow()
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

it("expectPlan.toHaveLength", () => {
  expectPlan(withPlan).toHaveLength(1)
  expect(() => expectPlan(withPlan).toHaveLength(999)).toThrow()
})
it("expectSystemPrompt.toMatch", () => {
  expectSystemPrompt(withSystemPrompt).toMatch(/helpful/)
  expect(() => expectSystemPrompt(withSystemPrompt).toMatch(/nope-xyz/)).toThrow()
})

it("expectToolSequence passes for an in-order subsequence", () => {
  const run = {
    ...base,
    toolCalls: [
      { name: "a", args: {} },
      { name: "x", args: {} },
      { name: "b", args: {} },
      { name: "c", args: {} },
    ],
  }
  expectToolSequence(run, ["a", "b", "c"])
})

it("expectToolSequence throws for out-of-order tools", () => {
  const run = {
    ...base,
    toolCalls: [
      { name: "b", args: {} },
      { name: "a", args: {} },
    ],
  }
  expect(() => expectToolSequence(run, ["a", "b"])).toThrow(/expected tool sequence/)
})

it("expectToolSequence strict requires contiguity", () => {
  const run = {
    ...base,
    toolCalls: [
      { name: "a", args: {} },
      { name: "x", args: {} },
      { name: "b", args: {} },
    ],
  }
  expect(() => expectToolSequence(run, ["a", "b"], { strict: true })).toThrow()
  expectToolSequence(run, ["a", "x", "b"], { strict: true })
})

it("expectNoToolErrors passes when no tool errored", () => {
  const run = {
    ...base,
    toolResults: [
      { name: "searchCorpus", status: "success" as const, content: "ok", isError: false },
    ],
  }
  expectNoToolErrors(run)
})

it("expectNoToolErrors throws and names the failed tool", () => {
  const run = {
    ...base,
    toolResults: [
      {
        name: "readDoc",
        status: "error" as const,
        content: "Error: ENOENT no such file\n next line",
        isError: true,
      },
    ],
  }
  expect(() => expectNoToolErrors(run)).toThrow(/readDoc.*ENOENT/)
})

it("expectNoToolErrors treats a HITL interrupt as NOT a tool error", () => {
  const run: AgentRunResult = {
    ...base,
    interrupts: [
      {
        interruptId: "p1",
        kind: "command",
        detail: { command: "x", suggestedPattern: "x" },
      },
    ],
    toolResults: [],
  }
  expectNoToolErrors(run)
})

const publicRegexMatchers = [
  {
    match(input: string, expression: RegExp) {
      expectFinalMessage({ ...base, finalMessage: input }).toMatch(expression)
    },
    name: "expectFinalMessage.toMatch",
  },
  {
    match(input: string, expression: RegExp) {
      expectSystemPrompt({ ...base, systemPrompt: input }).toMatch(expression)
    },
    name: "expectSystemPrompt.toMatch",
  },
]

describe.each(publicRegexMatchers)("$name safety policy", ({ match }) => {
  it("rejects structurally unsafe expressions", () => {
    const matchUnsafeExpression = () => match("a", /^(a+)+$/u)

    expect(matchUnsafeExpression).toThrow(TypeError)
    expect(matchUnsafeExpression).toThrow("Regular expression is unsafe for synchronous matching")
  })

  it("rejects oversized inputs before evaluation", () => {
    const matchOversizedInput = () => match("a".repeat(65_537), /^a+$/u)

    expect(matchOversizedInput).toThrow(RangeError)
    expect(matchOversizedInput).toThrow("Regular expression input exceeds 65536 UTF-16 code units")
  })

  it("preserves ordinary flags and matching semantics", () => {
    match("12 ITEMS", /\d+ items/iu)
    expect(() => match("none", /\d+ items/iu)).toThrow()
  })

  it.each([
    { createExpression: () => /items/gu, name: "global" },
    { createExpression: () => /items/uy, name: "sticky" },
  ])(
    "keeps $name expressions deterministic without changing caller state",
    ({ createExpression }) => {
      const expression = createExpression()
      expression.lastIndex = 2

      match("items", expression)
      match("items", expression)
      expect(expression.lastIndex).toBe(2)
    },
  )
})

describe("private regex safety adapter", () => {
  it("rejects structurally unsafe expressions with the exact error", () => {
    const createTester = () => createSafeRegexTester(/^(a+)+$/u)

    expect(createTester).toThrow(TypeError)
    expect(createTester).toThrow("Regular expression is unsafe for synchronous matching")
  })

  it.each([
    { expected: true, input: "12 ITEMS", name: "matching input" },
    { expected: false, input: "none", name: "non-matching input" },
  ])("preserves ordinary flags for $name", ({ expected, input }) => {
    const test = createSafeRegexTester(/\d+ items/iu)

    expect(test(input)).toBe(expected)
  })

  it("accepts 65,536 UTF-16 code units", () => {
    const test = createSafeRegexTester(/^a+$/u)

    expect(test("a".repeat(65_536))).toBe(true)
  })

  it("rejects 65,537 UTF-16 code units with the exact error", () => {
    const test = createSafeRegexTester(/^a+$/u)
    const testOversizedInput = () => test("a".repeat(65_537))

    expect(testOversizedInput).toThrow(RangeError)
    expect(testOversizedInput).toThrow("Regular expression input exceeds 65536 UTF-16 code units")
  })

  it.each([
    { expression: /items/gu, name: "global" },
    { expression: /items/uy, name: "sticky" },
  ])("keeps $name expressions deterministic without changing caller state", ({ expression }) => {
    expression.lastIndex = 2
    const test = createSafeRegexTester(expression)

    expect(test("items")).toBe(true)
    expect(test("items")).toBe(true)
    expect(expression.lastIndex).toBe(2)
  })
})
