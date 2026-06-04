import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { defaultSummarize } from "../src/summarization/summarize.js"

describe("defaultSummarize", () => {
  it("builds a prompt with previousSummary + messages and returns the model text", async () => {
    let seenPrompt = ""
    const result = await defaultSummarize({
      messages: [new HumanMessage("user asked about X"), new AIMessage("assistant answered Y")],
      model: "gpt-4o-mini",
      previousSummary: "Earlier: greeted.",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "Updated summary: greeted, discussed X then Y."
      },
    })
    expect(seenPrompt).toContain("Earlier: greeted.")
    expect(seenPrompt).toContain("user asked about X")
    expect(seenPrompt).toContain("assistant answered Y")
    expect(result).toBe("Updated summary: greeted, discussed X then Y.")
  })

  it("omits the previous-summary preamble when none is given", async () => {
    let seenPrompt = ""
    await defaultSummarize({
      messages: [new HumanMessage("just one message")],
      model: "gpt-4o-mini",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "summary"
      },
    })
    expect(seenPrompt).toContain("just one message")
    // no "Existing running summary" preamble
    expect(seenPrompt).not.toContain("Existing running summary")
  })
})
