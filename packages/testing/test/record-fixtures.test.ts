import { describe, expect, it } from "vitest"
import { type Recording, recordingsToFixtures } from "../src/record-fixtures.js"

function userReq(text: string): Recording["request"] {
  return { messages: [{ role: "user", content: text }] }
}
function toolRoundReq(userText: string): Recording["request"] {
  return {
    messages: [
      { role: "user", content: userText },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "greet", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "ok", tool_call_id: "call_x" },
    ],
  }
}

describe("recordingsToFixtures", () => {
  it("maps a text-only single call to one fixture (turn 0, no tool result)", () => {
    const recordings: Recording[] = [
      { request: userReq("hello"), response: { content: "Hi there" } },
    ]
    expect(recordingsToFixtures(recordings)).toEqual([
      {
        match: { userMessage: "hello", turnIndex: 0, hasToolResult: false },
        response: { content: "Hi there" },
      },
    ])
  })

  it("maps a tool round (2 calls) to turn 0 toolCall + turn 1 reply with hasToolResult", () => {
    const recordings: Recording[] = [
      {
        request: userReq("greet me"),
        response: { toolCalls: [{ id: "call_x", name: "greet", arguments: { who: "me" } }] },
      },
      { request: toolRoundReq("greet me"), response: { content: "Hello, me" } },
    ]
    expect(recordingsToFixtures(recordings)).toEqual([
      {
        match: { userMessage: "greet me", turnIndex: 0, hasToolResult: false },
        response: { toolCalls: [{ id: "call_x", name: "greet", arguments: { who: "me" } }] },
      },
      {
        match: { userMessage: "greet me", turnIndex: 1, hasToolResult: true },
        response: { content: "Hello, me" },
      },
    ])
  })

  it("uses the FIRST user message as userMessage even when later messages exist", () => {
    const recordings: Recording[] = [
      { request: toolRoundReq("original prompt"), response: { content: "done" } },
    ]
    const [fx] = recordingsToFixtures(recordings)
    expect(fx?.match.userMessage).toBe("original prompt")
  })
})
