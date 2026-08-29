/**
 * Real-graph pins for logical-identity tool projection (design Part A).
 *
 * Runs an actual createReactAgent graph under streamEvents v2 and pins the
 * upstream shapes the agent-adapter re-key depends on:
 *   - on_chat_model_end carries output.tool_calls with {id, name, args}
 *   - on_tool_end (string tool) carries a ToolMessage with tool_call_id
 *   - on_tool_end (Command tool) carries a Command whose update.messages
 *     contains that ToolMessage
 * If these fail after a LangChain upgrade, the projection re-key is broken
 * upstream — fix the adapter, do not delete the pins.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { createReactAgent } from "@langchain/langgraph/prebuilt"
import { describe, expect, it } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"
import { materializeStateSchema } from "../src/state-adapter.js"
import { convertToolToLangChain } from "../src/tool-converter.js"

class SequencedChatModel extends BaseChatModel {
  private cursor = 0
  constructor(private readonly responses: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "sequenced-fake"
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const msg = this.responses[this.cursor]
    this.cursor += 1
    if (!msg) throw new Error("SequencedChatModel ran out of canned responses")
    return {
      generations: [
        {
          text: typeof msg.content === "string" ? msg.content : "",
          message: msg,
        },
      ],
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
}

interface RawEvent {
  readonly event: string
  readonly name: string
  readonly run_id: string
  // biome-ignore lint/suspicious/noExplicitAny: raw upstream surface under test
  readonly data: any
}

async function collectRawEvents(graph: object): Promise<RawEvent[]> {
  // createReactAgent's streamEvents signature is generic over its input, which
  // makes it contravariantly incompatible with any concrete parameter type;
  // the adapter under test makes this same structural cast internally.
  const streamable = graph as {
    streamEvents: (input: unknown, options: Record<string, unknown>) => AsyncIterable<unknown>
  }
  const events: RawEvent[] = []
  for await (const event of streamable.streamEvents(
    { messages: [{ role: "user", content: "go" }] },
    { version: "v2", configurable: { thread_id: "spike-thread" } },
  )) {
    events.push(event as RawEvent)
  }
  return events
}

function scriptedModel(toolCallId: string, toolName: string, args: Record<string, unknown>) {
  return new SequencedChatModel([
    new AIMessage({
      content: "",
      tool_calls: [{ id: toolCallId, name: toolName, args, type: "tool_call" }],
    }),
    new AIMessage({ content: "final answer" }),
  ])
}

describe("real-graph pins for logical tool identity", () => {
  it("on_chat_model_end exposes output.tool_calls with id/name/args at the root", async () => {
    const probe = convertToolToLangChain({
      name: "probe",
      run: async () => ({ result: "probe-ok" }),
    })
    const graph = createReactAgent({
      llm: scriptedModel("call_probe_1", "probe", { q: "x" }),
      tools: [probe],
      checkpointer: new MemorySaver(),
      // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
    } as any)

    const events = await collectRawEvents(graph)
    const modelEnds = events.filter((e) => e.event === "on_chat_model_end")
    expect(modelEnds.length).toBeGreaterThanOrEqual(2)

    const withCalls = modelEnds
      .map((e) => e.data?.output?.tool_calls)
      .filter((calls: unknown) => Array.isArray(calls) && calls.length > 0)
    expect(withCalls).toHaveLength(1)
    expect(withCalls[0]).toMatchObject([{ id: "call_probe_1", name: "probe", args: { q: "x" } }])
  })

  it("on_tool_end for a string tool exposes a ToolMessage with the model's tool_call_id", async () => {
    const probe = convertToolToLangChain({
      name: "probe",
      run: async () => ({ result: "probe-ok" }),
    })
    const graph = createReactAgent({
      llm: scriptedModel("call_probe_1", "probe", { q: "x" }),
      tools: [probe],
      checkpointer: new MemorySaver(),
      // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
    } as any)

    const events = await collectRawEvents(graph)
    const toolEnds = events.filter((e) => e.event === "on_tool_end" && e.name === "probe")
    expect(toolEnds).toHaveLength(1)
    const output = toolEnds[0]?.data?.output
    expect(output?.tool_call_id).toBe("call_probe_1")
    expect(String(output?.content)).toBe("probe-ok")
  })

  it("on_tool_end for a Command tool exposes the ToolMessage inside update.messages", async () => {
    const writeTodos = convertToolToLangChain({
      name: "writeTodos",
      run: (input: unknown) => {
        const todos = (input as { todos: unknown }).todos
        return { result: { todos }, state: { todos } }
      },
    })
    const graph = createReactAgent({
      llm: scriptedModel("call_writeTodos_1", "writeTodos", {
        todos: [{ content: "first", status: "in_progress" }],
      }),
      tools: [writeTodos],
      stateSchema: materializeStateSchema([{ name: "todos", reducer: "replace", default: [] }]),
      checkpointer: new MemorySaver(),
      // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
    } as any)

    const events = await collectRawEvents(graph)
    const toolEnds = events.filter((e) => e.event === "on_tool_end" && e.name === "writeTodos")
    expect(toolEnds).toHaveLength(1)
    const output = toolEnds[0]?.data?.output
    const messages = output?.update?.messages
    expect(Array.isArray(messages)).toBe(true)
    const toolMessage = messages.find(
      (m: { tool_call_id?: unknown }) => typeof m?.tool_call_id === "string",
    )
    expect(toolMessage?.tool_call_id).toBe("call_writeTodos_1")
  })

  async function collectAgentChunks(graph: unknown) {
    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: graph as never,
      input: { messages: [{ role: "user", content: "go" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: "spike-thread-e2e",
      tools: [],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  it("streamAgent keys root tool chunks by the model's tool-call id (string tool)", async () => {
    const probe = convertToolToLangChain({
      name: "probe",
      run: async () => ({ result: "probe-ok" }),
    })
    const graph = createReactAgent({
      llm: scriptedModel("call_probe_1", "probe", { q: "x" }),
      tools: [probe],
      checkpointer: new MemorySaver(),
      // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
    } as any)

    const chunks = await collectAgentChunks(graph)
    const toolCalls = chunks.filter((c) => c.type === "tool_call")
    const toolResults = chunks.filter((c) => c.type === "tool_result")
    expect(toolCalls).toEqual([
      { type: "tool_call", data: { id: "call_probe_1", name: "probe", input: { q: "x" } } },
    ])
    expect(toolResults).toHaveLength(1)
    expect((toolResults[0]?.data as { id?: unknown } | undefined)?.id).toBe("call_probe_1")
  })

  it("streamAgent keys root tool chunks by the model's tool-call id (Command tool)", async () => {
    const writeTodos = convertToolToLangChain({
      name: "writeTodos",
      run: (input: unknown) => {
        const todos = (input as { todos: unknown }).todos
        return { result: { todos }, state: { todos } }
      },
    })
    const graph = createReactAgent({
      llm: scriptedModel("call_writeTodos_1", "writeTodos", {
        todos: [{ content: "first", status: "in_progress" }],
      }),
      tools: [writeTodos],
      stateSchema: materializeStateSchema([{ name: "todos", reducer: "replace", default: [] }]),
      checkpointer: new MemorySaver(),
      // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options
    } as any)

    const chunks = await collectAgentChunks(graph)
    const toolCalls = chunks.filter((c) => c.type === "tool_call")
    const toolResults = chunks.filter((c) => c.type === "tool_result")
    expect(toolCalls).toHaveLength(1)
    expect((toolCalls[0]?.data as { id?: unknown } | undefined)?.id).toBe("call_writeTodos_1")
    expect(toolResults).toHaveLength(1)
    expect((toolResults[0]?.data as { id?: unknown } | undefined)?.id).toBe("call_writeTodos_1")
  })
})
