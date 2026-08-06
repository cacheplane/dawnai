import { agent } from "@dawn-ai/sdk"
import { AIMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test, vi } from "vitest"
import {
  __resetMaterializedAgentsForTests,
  executeAgent,
  materializeAgentGraph,
  streamAgent,
} from "../src/agent-adapter.ts"

async function collectCustomEvents(
  metadata?: Record<string, unknown>,
  extraCapabilityPayloads: readonly unknown[] = [],
) {
  const inheritedEvent = Object.assign(Object.create({ event: "inherited" }), {
    data: "invalid",
  })
  const entry = {
    invoke: vi.fn(),
    async *streamEvents() {
      yield {
        event: "on_tool_end",
        run_id: "tool-1",
        name: "writeTodos",
        data: { output: { todos: ["legacy"] } },
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-1",
        name: "dawn.capability",
        data: { event: "plan_update", data: { todos: ["one"] } },
        ...(metadata ? { metadata } : {}),
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-2",
        name: "dawn.capability",
        data: { event: 42, data: "invalid" },
        ...(metadata ? { metadata } : {}),
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-3",
        name: "dawn.capability",
        data: inheritedEvent,
        ...(metadata ? { metadata } : {}),
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-4",
        name: "other.event",
        data: { event: "ignored", data: "invalid" },
        ...(metadata ? { metadata } : {}),
      }
      for (const [index, data] of extraCapabilityPayloads.entries()) {
        yield {
          event: "on_custom_event",
          run_id: `custom-extra-${index}`,
          name: "dawn.capability",
          data,
          ...(metadata ? { metadata } : {}),
        }
      }
      yield {
        event: "on_chain_end",
        run_id: "root",
        name: "LangGraph",
        data: { output: { ok: true } },
      }
    },
  }
  const chunks = []
  for await (const chunk of streamAgent({
    checkpointer: new MemorySaver(),
    entry,
    input: { question: "hi" },
    routeParamNames: [],
    signal: new AbortController().signal,
    streamTransformers: [
      {
        observes: "tool_result",
        transform: async function* () {
          yield { event: "plan_update", data: { todos: ["legacy"] } }
        },
      },
    ],
    tools: [],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe("capability custom events", () => {
  test("maps a valid root capability payload and ignores malformed payloads", async () => {
    await expect(collectCustomEvents()).resolves.toEqual([
      {
        type: "tool_result",
        data: { id: "tool-1", name: "writeTodos", output: { todos: ["legacy"] } },
      },
      { type: "plan_update", data: { todos: ["one"] } },
      { type: "done", data: { ok: true } },
    ])
  })

  test("namespaces a child capability payload from Dawn subagent metadata", async () => {
    const chunks = await collectCustomEvents({
      dawn: {
        subagent_stack: [{ callId: "call-1", name: "researcher", routeId: "/researcher" }],
      },
    })

    expect(chunks[1]).toEqual({
      type: "subagent.plan_update",
      data: { todos: ["one"] },
    })
  })

  test("projects only safe non-reserved capability event names", async () => {
    const invalidNames = [
      "line\nbreak",
      "line\rbreak",
      "control\u0007bell",
      "has space",
      "chunk",
      "token",
      "tool_call",
      "tool_result",
      "interrupt",
      "done",
      "subagent.plan_update",
    ]
    const chunks = await collectCustomEvents(undefined, [
      { event: "memory.plan-updated", data: "accepted" },
      ...invalidNames.map((event) => ({ event, data: "rejected" })),
    ])

    expect(chunks).toEqual([
      {
        type: "tool_result",
        data: { id: "tool-1", name: "writeTodos", output: { todos: ["legacy"] } },
      },
      { type: "plan_update", data: { todos: ["one"] } },
      { type: "memory.plan-updated", data: "accepted" },
      { type: "done", data: { ok: true } },
    ])
  })
})

describe("executeAgent with DawnAgent descriptors", () => {
  test("does not reuse a compiled graph when stream transformers change", async () => {
    const createReactAgent = vi.fn(() => ({ invoke: vi.fn() }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {},
    }))
    __resetMaterializedAgentsForTests()

    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "Test." })
    const tool = { name: "probe", run: async () => "ok" }
    const firstTransformer = {
      observes: "tool_result" as const,
      transform: async function* () {
        yield { event: "first", data: 1 }
      },
    }
    const secondTransformer = {
      observes: "tool_result" as const,
      transform: async function* () {
        yield { event: "second", data: 2 }
      },
    }

    try {
      const first = await materializeAgentGraph({
        checkpointer: new MemorySaver(),
        descriptor,
        streamTransformers: [firstTransformer],
        tools: [tool],
      })
      const second = await materializeAgentGraph({
        checkpointer: new MemorySaver(),
        descriptor,
        streamTransformers: [secondTransformer],
        tools: [tool],
      })

      expect(createReactAgent).toHaveBeenCalledTimes(2)
      expect(second).not.toBe(first)
    } finally {
      __resetMaterializedAgentsForTests()
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    }
  })

  test("DawnAgent descriptor is recognized and does not throw invoke error", async () => {
    let openAIModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        openAIModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "OpenAI!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        readonly options: Record<string, unknown>

        constructor(options: Record<string, unknown>) {
          this.options = options
        }
      },
    }))

    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    expect((result as AIMessage).content).toBe("OpenAI!")
    expect((openAIModel as { options: Record<string, unknown> }).options).toEqual({
      model: "gpt-4o-mini",
    })
  })

  test("DawnAgent descriptor explicit provider overrides model inference", async () => {
    let groqModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        groqModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Groq!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize explicit Groq provider")
        }
      },
    }))
    vi.doMock("@langchain/groq", () => ({
      ChatGroq: class {
        readonly options: Record<string, unknown>

        constructor(options: Record<string, unknown>) {
          this.options = options
        }
      },
    }))

    const descriptor = agent({
      provider: "groq",
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
      vi.doUnmock("@langchain/groq")
    })

    expect((result as AIMessage).content).toBe("Groq!")
    expect((groqModel as { options: Record<string, unknown> }).options).toEqual({
      model: "gpt-4o-mini",
    })
  })

  test("DawnAgent descriptor rejects explicit falsy invalid provider", async () => {
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize invalid explicit provider")
        }
      },
    }))

    const descriptor = agent({
      provider: "" as never,
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const error = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })
      .catch((e: Error) => e)
      .finally(() => {
        vi.doUnmock("@langchain/openai")
      })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Unsupported agent provider ""')
    expect((error as Error).message).not.toContain("ChatOpenAI")
  })

  test("DawnAgent descriptor infers non-OpenAI provider from model", async () => {
    let anthropicModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        anthropicModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Anthropic!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize inferred non-OpenAI provider")
        }
      },
    }))
    vi.doMock("@langchain/anthropic", () => ({
      ChatAnthropic: class {
        readonly options: Record<string, unknown>

        constructor(options: Record<string, unknown>) {
          this.options = options
        }
      },
    }))

    const descriptor = agent({
      model: "claude-sonnet-4-5",
      systemPrompt: "You are helpful.",
    })

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
      vi.doUnmock("@langchain/anthropic")
    })

    expect((result as AIMessage).content).toBe("Anthropic!")
    expect((anthropicModel as { options: Record<string, unknown> }).options).toEqual({
      model: "claude-sonnet-4-5",
    })
  })

  test("legacy agent with invoke() still works", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Legacy!" })),
    }

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: mockAgent,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })

    expect(mockAgent.invoke).toHaveBeenCalled()
    expect((result as AIMessage).content).toBe("Legacy!")
  })

  test("route params are separated from agent input", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "ok" })),
    }

    await executeAgent({
      checkpointer: new MemorySaver(),
      entry: mockAgent,
      input: { tenant: "acme", question: "hello" },
      routeParamNames: ["tenant"],
      signal: new AbortController().signal,
      tools: [],
    })

    const call = mockAgent.invoke.mock.calls[0]
    const invokeInput = call?.[0] as { messages: Array<{ content: string }> }
    const invokeConfig = call?.[1] as { configurable?: Record<string, unknown> }
    expect(invokeInput?.messages[0]?.content).toBe("hello")
    expect(invokeConfig?.configurable).toEqual({ tenant: "acme" })
  })

  test("recursionLimit from the descriptor is passed into the graph config", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage({ content: "ok" }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn(() => ({ invoke })),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor(public options: Record<string, unknown>) {}
      },
    }))

    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
      recursionLimit: 123,
    })

    await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    const invokeConfig = invoke.mock.calls[0]?.[1] as { recursionLimit?: number }
    expect(invokeConfig?.recursionLimit).toBe(123)
  })

  test("no recursionLimit leaves the graph config default (unset)", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage({ content: "ok" }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn(() => ({ invoke })),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor(public options: Record<string, unknown>) {}
      },
    }))

    const descriptor = agent({ model: "gpt-4o-mini", systemPrompt: "You are helpful." })

    await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    const invokeConfig = invoke.mock.calls[0]?.[1] as { recursionLimit?: number }
    expect(invokeConfig?.recursionLimit).toBeUndefined()
  })
})
