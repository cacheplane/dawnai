import { describe, expect, it, vi } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { llmJudge } from "../src/llm-judge.js"
import { normalizeScore } from "../src/score.js"

function run(finalMessage: string): AgentRunResult {
  return {
    finalMessage, messages: [], toolCalls: [], tokens: [], state: {}, threadId: "t",
    interrupts: [], planUpdates: [], todos: [], subagents: [], subagentEvents: [], systemPrompt: "",
  }
}

function fakeFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  )
}

describe("llmJudge", () => {
  it("parses a {score,reason} verdict from the model", async () => {
    const fetchImpl = fakeFetch('{"score":0.8,"reason":"close enough"}')
    const s = llmJudge({ criteria: "Answer reflects {{expected}}", fetchImpl, baseUrl: "http://x/v1", apiKey: "k" })
    const v = normalizeScore(await s.score(run("hello"), { input: "hi", expected: "hello" }))
    expect(v.score).toBe(0.8)
    expect(v.reason).toBe("close enough")
    // criteria interpolated + output included in the user message sent to the model
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(JSON.stringify(body.messages)).toContain("hello")
  })
  it("scores 0 with a reason when the verdict is unparseable", async () => {
    const s = llmJudge({ criteria: "x", fetchImpl: fakeFetch("not json"), baseUrl: "http://x/v1", apiKey: "k" })
    const v = normalizeScore(await s.score(run("y"), { input: "i" }))
    expect(v.score).toBe(0)
    expect(v.reason).toMatch(/parse|verdict/i)
  })
  it("carries its threshold", () => {
    expect(llmJudge({ criteria: "x", threshold: 0.7 }).threshold).toBe(0.7)
  })
})
