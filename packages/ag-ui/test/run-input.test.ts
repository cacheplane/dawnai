import { describe, expect, it } from "vitest"
import { mapRunInput } from "../src/run-input.js"

const base = { threadId: "t", runId: "r", state: {}, messages: [], tools: [], context: [], forwardedProps: {} }

describe("mapRunInput", () => {
  it("extracts the last user message as the Dawn input", () => {
    const result = mapRunInput({
      ...base,
      messages: [
        { id: "1", role: "user", content: "old" },
        { id: "2", role: "assistant", content: "hi" },
        { id: "3", role: "user", content: "new question" },
      ],
    } as never)
    expect(result.resumeDecision).toBeUndefined()
    expect(result.dawnInput).toEqual({ messages: [{ role: "user", content: "new question" }] })
  })

  it("decodes a resume decision from forwardedProps.command.resume", () => {
    const result = mapRunInput({
      ...base,
      forwardedProps: { command: { resume: { interruptId: "perm-1", decision: "once" } } },
    } as never)
    expect(result.resumeDecision).toBe("once")
    expect(result.interruptId).toBe("perm-1")
  })

  it("accepts a bare string decision", () => {
    const result = mapRunInput({
      ...base,
      forwardedProps: { command: { resume: "deny" } },
    } as never)
    expect(result.resumeDecision).toBe("deny")
  })

  it("falls back to empty messages when no user message exists", () => {
    const result = mapRunInput(base as never)
    expect(result.dawnInput).toEqual({ messages: [] })
  })
})
