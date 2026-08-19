import { describe, expect, it } from "vitest"
import { readLogicalToolCallId } from "../src/logical-tool-call-id.js"

describe("readLogicalToolCallId", () => {
  it("reads tool_call_id from a ToolMessage-shaped output", () => {
    expect(readLogicalToolCallId({ tool_call_id: "call_a_1", content: "ok" })).toBe("call_a_1")
  })

  it("reads tool_call_id from the ToolMessage inside a Command's update.messages", () => {
    const command = {
      update: {
        todos: [],
        messages: [{ tool_call_id: "call_b_2", content: "ok", name: "writeTodos" }],
      },
    }
    expect(readLogicalToolCallId(command)).toBe("call_b_2")
  })

  it("prefers the last ToolMessage when update.messages has several", () => {
    const command = {
      update: {
        messages: [
          { tool_call_id: "call_old", content: "" },
          { tool_call_id: "call_new", content: "" },
        ],
      },
    }
    expect(readLogicalToolCallId(command)).toBe("call_new")
  })

  it("returns undefined for empty-string ids", () => {
    expect(readLogicalToolCallId({ tool_call_id: "" })).toBeUndefined()
    expect(readLogicalToolCallId({ update: { messages: [{ tool_call_id: "" }] } })).toBeUndefined()
  })

  it("returns undefined for strings, null, undefined, arrays, and id-less records", () => {
    expect(readLogicalToolCallId("plain result")).toBeUndefined()
    expect(readLogicalToolCallId(null)).toBeUndefined()
    expect(readLogicalToolCallId(undefined)).toBeUndefined()
    expect(readLogicalToolCallId([])).toBeUndefined()
    expect(readLogicalToolCallId({ content: "no id" })).toBeUndefined()
    expect(readLogicalToolCallId({ update: { messages: "not-an-array" } })).toBeUndefined()
  })

  it("fails closed on hostile getters", () => {
    const hostile = {}
    Object.defineProperty(hostile, "tool_call_id", {
      enumerable: true,
      get() {
        throw new Error("boom")
      },
    })
    expect(readLogicalToolCallId(hostile)).toBeUndefined()
  })
})
