import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { countMessagesTokens, defaultTokenCounter } from "../src/summarization/token-counter.js"

describe("defaultTokenCounter", () => {
  it("counts tokens for a plain string", async () => {
    const n = await defaultTokenCounter("hello world this is a test")
    expect(n).toBeGreaterThan(3)
    expect(n).toBeLessThan(15)
  })
})

describe("countMessagesTokens", () => {
  it("sums an injected counter across message contents incl. tool calls", async () => {
    const counter = (t: string) => t.length // chars as tokens, deterministic
    const messages = [
      new HumanMessage("abc"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "t", args: { k: "v" } }] }),
      new ToolMessage({ content: "result", tool_call_id: "1" }),
    ]
    const total = await countMessagesTokens(messages, counter)
    expect(total).toBeGreaterThan(9) // "abc"(3) + serialized tool_call + "result"(6)
  })

  it("awaits an async counter", async () => {
    const counter = async (t: string) => t.length
    const total = await countMessagesTokens([new HumanMessage("hello")], counter)
    expect(total).toBe(5)
  })
})
