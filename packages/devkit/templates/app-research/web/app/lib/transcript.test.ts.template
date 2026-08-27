import { describe, expect, test } from "vitest"
import { buildTranscriptItems, type TranscriptMessage, userText } from "./transcript"

function toolCall(id: string, name: string) {
  return { id, type: "function" as const, function: { name, arguments: '{"path":"corpus/a.md"}' } }
}

describe("userText", () => {
  test("passes a plain string through", () => {
    expect(userText("hello")).toBe("hello")
  })

  test("joins the text parts of multimodal content and drops the rest", () => {
    expect(
      userText([
        { type: "text", text: "look at " },
        { type: "image", source: { type: "url", value: "https://example.test/x.png" } },
        { type: "text", text: "this" },
      ]),
    ).toBe("look at this")
  })

  test("yields nothing rather than [object Object] for content it cannot read", () => {
    expect(userText(undefined)).toBe("")
    expect(userText([{ type: "image" }])).toBe("")
  })
})

describe("buildTranscriptItems", () => {
  test("keeps user and assistant turns in order", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "hello" },
    ])
    expect(items).toEqual([
      { kind: "user", id: "m1", text: "hi" },
      { kind: "assistant", id: "m2", text: "hello" },
    ])
  })

  test("pairs each tool call with the tool message that answers it", () => {
    const messages: readonly TranscriptMessage[] = [
      { id: "m1", role: "assistant", toolCalls: [toolCall("call-1", "readDoc")] },
      { id: "m2", role: "tool", toolCallId: "call-1", content: "the doc" },
    ]
    const items = buildTranscriptItems(messages)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      kind: "toolCall",
      id: "call-1",
      toolCall: toolCall("call-1", "readDoc"),
      toolResult: messages[1],
    })
  })

  test("leaves a still-running tool call unpaired instead of guessing", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "assistant", toolCalls: [toolCall("call-1", "runBash")] },
      { id: "m2", role: "tool", toolCallId: "some-other-call", content: "unrelated" },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).not.toHaveProperty("toolResult")
  })

  test("emits an assistant message's text before its tool calls, in call order", () => {
    const items = buildTranscriptItems([
      {
        id: "m1",
        role: "assistant",
        content: "Searching the corpus.",
        toolCalls: [toolCall("call-1", "searchCorpus"), toolCall("call-2", "readDoc")],
      },
    ])
    expect(items.map((item) => item.kind)).toEqual(["assistant", "toolCall", "toolCall"])
    expect(items.map((item) => item.id)).toEqual(["m1", "call-1", "call-2"])
  })

  test("drops empty text so a streaming placeholder is not an empty bubble", () => {
    expect(buildTranscriptItems([{ id: "m1", role: "assistant", content: "" }])).toEqual([])
    expect(buildTranscriptItems([{ id: "m1", role: "assistant" }])).toEqual([])
  })

  test("carries an activity message through with its type and content intact", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "activity", activityType: "dawn.plan", content: { todos: [] } },
    ])
    expect(items).toEqual([
      { kind: "activity", id: "m1", activityType: "dawn.plan", content: { todos: [] } },
    ])
  })

  test("keeps reasoning but drops system and developer prompt plumbing", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "system", content: "you are a research agent" },
      { id: "m2", role: "developer", content: "internal" },
      { id: "m3", role: "reasoning", content: "considering the corpus" },
    ])
    expect(items).toEqual([{ kind: "reasoning", id: "m3", text: "considering the corpus" }])
  })

  test("pairs a tool result that arrives before its call", () => {
    // Ordering is not guaranteed by the transport, and an unpaired call renders
    // as permanently running.
    const items = buildTranscriptItems([
      { id: "m1", role: "tool", toolCallId: "call-1", content: "done" },
      { id: "m2", role: "assistant", toolCalls: [toolCall("call-1", "task")] },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveProperty("toolResult")
  })
})
