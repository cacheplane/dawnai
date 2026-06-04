import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { splitForSummary } from "../src/summarization/split.js"

const H = (c: string) => new HumanMessage(c)
const A = (c: string) => new AIMessage(c)
const AT = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "t", args: {} }] })
const T = (id: string) => new ToolMessage({ content: "r", tool_call_id: id })

describe("splitForSummary", () => {
  it("keeps the last N turns verbatim and summarizes the rest", () => {
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2"), H("u3"), A("a3")]
    const { toSummarize, recent } = splitForSummary(msgs, 2)
    expect(recent.map((m) => m.content as string)).toEqual(["u2", "a2", "u3", "a3"])
    expect(toSummarize.map((m) => m.content as string)).toEqual(["u1", "a1"])
  })

  it("never splits a tool round (recent starts on a HumanMessage, whole round kept)", () => {
    const msgs = [H("u1"), A("a1"), H("u2"), AT("c1"), T("c1"), A("done")]
    const { toSummarize, recent } = splitForSummary(msgs, 1)
    expect((recent[0] as HumanMessage).content).toBe("u2")
    expect(recent).toHaveLength(4) // H,AT,T,A — entire turn incl. tool round
    expect(toSummarize.map((m) => m.content as string)).toEqual(["u1", "a1"])
  })

  it("keeps everything as recent when there are fewer turns than keepRecentTurns", () => {
    const msgs = [H("u1"), A("a1")]
    const { toSummarize, recent } = splitForSummary(msgs, 5)
    expect(toSummarize).toEqual([])
    expect(recent).toEqual(msgs)
  })

  it("returns all-to-summarize, none-recent when keepRecentTurns is 0", () => {
    const msgs = [H("u1"), A("a1")]
    const { toSummarize, recent } = splitForSummary(msgs, 0)
    expect(recent).toEqual([])
    expect(toSummarize).toEqual(msgs)
  })

  it("handles leading non-human messages before the first turn", () => {
    // e.g. a leading system-ish/AI message before any human turn
    const msgs = [A("preamble"), H("u1"), A("a1"), H("u2"), A("a2")]
    const { toSummarize, recent } = splitForSummary(msgs, 1)
    expect((recent[0] as HumanMessage).content).toBe("u2")
    expect(toSummarize.map((m) => m.content as string)).toEqual(["preamble", "u1", "a1"])
  })
})
