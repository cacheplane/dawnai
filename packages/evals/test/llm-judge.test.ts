import type { AgentRunResult } from "@dawn-ai/testing"
import { describe, expect, it, vi } from "vitest"
import { llmJudge } from "../src/llm-judge.js"
import { normalizeScore } from "../src/score.js"

function run(finalMessage: string): AgentRunResult {
  return {
    finalMessage,
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
  }
}

// Typed with the arguments `llmJudge` actually calls it with, not `() =>`.
// Inferred from a zero-arg lambda, `mock.calls[0]` is the empty tuple and
// reading `[1]` off it is a type error over a value that is really there —
// which is how the assertion below came to cast an argument it already knew.
function fakeFetch(content: string) {
  return vi.fn(
    async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  )
}

describe("llmJudge", () => {
  it("parses a {score,reason} verdict from the model", async () => {
    const fetchImpl = fakeFetch('{"score":0.8,"reason":"close enough"}')
    const s = llmJudge({
      criteria: "Answer reflects {{expected}}",
      fetchImpl,
      baseUrl: "http://x/v1",
      apiKey: "k",
    })
    const v = normalizeScore(await s.score(run("hello"), { input: "hi", expected: "hello" }))
    expect(v.score).toBe(0.8)
    expect(v.reason).toBe("close enough")
    // criteria interpolated + output included in the user message sent to the model
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string)
    expect(JSON.stringify(body.messages)).toContain("hello")
  })
  it("scores 0 with a reason when the verdict is unparseable", async () => {
    const s = llmJudge({
      criteria: "x",
      fetchImpl: fakeFetch("not json"),
      baseUrl: "http://x/v1",
      apiKey: "k",
    })
    const v = normalizeScore(await s.score(run("y"), { input: "i" }))
    expect(v.score).toBe(0)
    expect(v.reason).toMatch(/parse|verdict/i)
  })
  it("carries its threshold", () => {
    expect(llmJudge({ criteria: "x", threshold: 0.7 }).threshold).toBe(0.7)
  })
})
