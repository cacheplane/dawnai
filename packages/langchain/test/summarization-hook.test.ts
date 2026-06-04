import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import { buildSummarizationHook } from "../src/summarization/hook.js"

const H = (c: string) => new HumanMessage(c)
const A = (c: string) => new AIMessage(c)

function makeHook(over: Record<string, unknown> = {}) {
  return buildSummarizationHook({
    maxTokens: 100,
    keepRecentTurns: 1,
    model: "fake",
    tokenCounter: (t: string) => t.length, // chars as tokens
    summarize: async () => "SUMMARY",
    ...over,
  } as never)
}

describe("buildSummarizationHook", () => {
  it("returns {} when under the token threshold", async () => {
    const hook = makeHook({ maxTokens: 10_000 })
    const out = await hook({ messages: [H("hi"), A("yo")] })
    expect(out).toEqual({})
  })

  it("returns condensed llmInputMessages + runningSummary when over threshold", async () => {
    const hook = makeHook({ maxTokens: 5, keepRecentTurns: 1 })
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2")]
    const out = await hook({ messages: msgs })
    expect(Array.isArray(out.llmInputMessages)).toBe(true)
    const texts = (out.llmInputMessages as Array<{ content: string }>).map((m) => m.content)
    expect(texts[0]).toContain("SUMMARY")
    expect(texts.slice(1)).toEqual(["u2", "a2"]) // last turn verbatim
    expect(out.runningSummary).toMatchObject({ summary: "SUMMARY", coveredCount: 2 })
  })

  it("incrementally folds only the newly-aged delta (previousSummary + delta)", async () => {
    const summarize = vi.fn(async () => "S2")
    const hook = makeHook({ maxTokens: 5, keepRecentTurns: 1, summarize })
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2"), H("u3"), A("a3")]
    await hook({ messages: msgs, runningSummary: { summary: "S1", coveredCount: 2 } })
    const arg = summarize.mock.calls[0]?.[0] as {
      previousSummary?: string
      messages: Array<{ content: string }>
    }
    expect(arg.previousSummary).toBe("S1")
    expect(arg.messages.map((m) => m.content)).toEqual(["u2", "a2"]) // delta only (toSummarize=[u1,a1,u2,a2], minus covered 2)
  })

  it("falls back to {} when the summarizer throws", async () => {
    const hook = makeHook({
      maxTokens: 5,
      summarize: async () => {
        throw new Error("boom")
      },
    })
    const out = await hook({ messages: [H("u1"), A("a1"), H("u2"), A("a2")] })
    expect(out).toEqual({})
  })

  it("reuses the cached summary with no delta (no summarizer call)", async () => {
    const summarize = vi.fn(async () => "NEW")
    const hook = makeHook({ maxTokens: 5, keepRecentTurns: 1, summarize })
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2")]
    // coveredCount already equals toSummarize length (2) → no delta
    const out = await hook({
      messages: msgs,
      runningSummary: { summary: "CACHED", coveredCount: 2 },
    })
    expect(summarize).not.toHaveBeenCalled()
    const texts = (out.llmInputMessages as Array<{ content: string }>).map((m) => m.content)
    expect(texts[0]).toContain("CACHED")
  })
})
