import { describe, expect, test } from "vitest"
import { hydrateThreadState } from "./hydrate.js"
import { buildTranscriptItems, userText } from "./transcript.js"

const STATE = {
  values: {
    context: "",
    messages: [
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: { content: "What are common agent architectures?", id: "m1" },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "",
          id: "m2",
          tool_calls: [
            {
              name: "searchCorpus",
              args: { query: "agent architectures" },
              id: "call_searchCorpus_0_0",
              type: "tool_call",
            },
          ],
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          content: '[{"path":"corpus/agent-architectures.md","score":2}]',
          tool_call_id: "call_searchCorpus_0_0",
          name: "searchCorpus",
          id: "m3",
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { content: "ReAct and plan-and-execute are common.", id: "m4", tool_calls: [] },
      },
    ],
    todos: [
      { content: "Search the corpus", status: "completed" },
      { content: "Read the best sources", status: "in_progress" },
    ],
  },
}

describe("hydrateThreadState", () => {
  test("maps each LangChain envelope to its transcript role", () => {
    const { messages } = hydrateThreadState(STATE)
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
  })

  test("stringifies tool-call args, because /state gives an object and the transcript wants a string", () => {
    const { messages } = hydrateThreadState(STATE)
    const assistant = messages[1]
    expect(assistant).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_searchCorpus_0_0",
          type: "function",
          function: { name: "searchCorpus", arguments: '{"query":"agent architectures"}' },
        },
      ],
    })
  })

  test("uses the tool message content directly — there is no second envelope on this path", () => {
    const { messages } = hydrateThreadState(STATE)
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_searchCorpus_0_0",
      content: '[{"path":"corpus/agent-architectures.md","score":2}]',
    })
  })

  test("re-seeds the plan from the checkpointed todos", () => {
    expect(hydrateThreadState(STATE).todos).toEqual([
      { content: "Search the corpus", status: "completed" },
      { content: "Read the best sources", status: "in_progress" },
    ])
  })

  test("feeds buildTranscriptItems: text, then a paired tool card", () => {
    const items = buildTranscriptItems(hydrateThreadState(STATE).messages)
    expect(items.map((item) => item.kind)).toEqual(["user", "toolCall", "assistant"])
    expect(items[1]).toMatchObject({
      kind: "toolCall",
      toolResult: { toolCallId: "call_searchCorpus_0_0" },
    })
  })

  test("gives every message an id, minting one when the envelope has none", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
      },
    })
    expect(messages[0]?.id).toBe("hydrated-1")
  })

  test("mints ids that are stable across repeat hydrations of the same payload", () => {
    const payload = {
      values: {
        messages: [
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "a" } },
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "b" } },
        ],
      },
    }
    const first = hydrateThreadState(payload).messages.map((message) => message.id)
    const second = hydrateThreadState(payload).messages.map((message) => message.id)
    expect(first).toEqual(second)
    expect(first).toEqual(["hydrated-1", "hydrated-2"])
  })

  test("passes array content through untouched for HumanMessage, so userText's narrowing still applies", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "HumanMessage"],
            kwargs: {
              content: [
                { type: "text", text: "look at this" },
                { type: "image", source: "irrelevant" },
              ],
              id: "u1",
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "user" })
    const userMessage = messages[0] as { content: unknown }
    expect(userText(userMessage.content)).toBe("look at this")
    const items = buildTranscriptItems(messages)
    expect(items).toEqual([{ kind: "user", id: messages[0]?.id, text: "look at this" }])
  })

  test("flattens content-block arrays for AIMessageChunk instead of emptying the message", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: [
                { type: "text", text: "Here is the answer." },
                { type: "tool_use", id: "ignored", name: "ignored" },
              ],
              id: "a1",
              tool_calls: [],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", content: "Here is the answer." })
    const items = buildTranscriptItems(messages)
    expect(items).toEqual([{ kind: "assistant", id: "a1", text: "Here is the answer." }])
  })

  test("treats non-chunk AIMessage the same as AIMessageChunk", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessage"],
            kwargs: { content: "final answer", id: "a2", tool_calls: [] },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", content: "final answer" })
  })

  test("drops entries it does not understand instead of throwing", () => {
    const { messages, todos } = hydrateThreadState({
      values: {
        messages: [
          null,
          "nonsense",
          { lc: 1, type: "constructor", id: ["x", "y", "SystemMessage"], kwargs: { content: "s" } },
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
        todos: "not an array",
      },
    })
    expect(messages.map((message) => message.role)).toEqual(["user"])
    expect(todos).toEqual([])
  })

  test("drops a ToolMessage with no tool_call_id, which nothing could ever pair", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "ToolMessage"],
            kwargs: { content: "result", id: "t1", name: "searchCorpus" },
          },
        ],
      },
    })
    expect(messages).toEqual([])
  })

  test("degrades to empty rather than throwing on a malformed payload", () => {
    expect(hydrateThreadState(null)).toEqual({ messages: [], todos: [] })
    expect(hydrateThreadState({})).toEqual({ messages: [], todos: [] })
    expect(hydrateThreadState({ values: {} })).toEqual({ messages: [], todos: [] })
  })

  test("the empty result is a fresh array each call, since AbstractAgent mutates messages in place", () => {
    const a = hydrateThreadState(null)
    const b = hydrateThreadState({})
    expect(a.messages).not.toBe(b.messages)
    expect(a.todos).not.toBe(b.todos)
    ;(a.messages as unknown[]).push("leaked")
    expect(b.messages).toEqual([])
  })

  test("drops a tool call with no id, which nothing could ever pair", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ name: "searchCorpus", args: {} }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [] })
  })

  test("drops a tool call with a non-string name", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ id: "call_1", name: 42, args: {} }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [] })
  })

  test("defaults tool-call arguments to an empty object when args is absent", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ id: "call_1", name: "searchCorpus" }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ function: { arguments: "{}" } }],
    })
  })

  test("toTodos filters non-record entries, invalid statuses, and empty content", () => {
    const { todos } = hydrateThreadState({
      values: {
        messages: [],
        todos: [
          null,
          "nonsense",
          { content: "", status: "pending" },
          { content: "   ", status: "pending" },
          { content: "valid", status: "not-a-status" },
          { content: "valid", status: "pending" },
        ],
      },
    })
    expect(todos).toEqual([{ content: "valid", status: "pending" }])
  })
})
