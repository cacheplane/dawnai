import { describe, expect, test } from "vitest"
import { hydrateThreadState } from "./hydrate.js"

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

  test("gives every message an id, minting one when the envelope has none", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
      },
    })
    expect(messages[0]?.id).toBeTypeOf("string")
    expect(messages[0]?.id).not.toBe("")
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

  test("degrades to empty rather than throwing on a malformed payload", () => {
    expect(hydrateThreadState(null)).toEqual({ messages: [], todos: [] })
    expect(hydrateThreadState({})).toEqual({ messages: [], todos: [] })
    expect(hydrateThreadState({ values: {} })).toEqual({ messages: [], todos: [] })
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
})
