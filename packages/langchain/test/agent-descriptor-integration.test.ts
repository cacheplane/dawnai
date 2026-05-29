import { agent } from "@dawn-ai/sdk"
import { AIMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test, vi } from "vitest"
import { executeAgent } from "../src/agent-adapter.js"

describe("agent() descriptor integration", () => {
  test("DawnAgent descriptor is recognized and does not throw invoke error", async () => {
    let openAIModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        openAIModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Descriptor!" })),
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
      systemPrompt: "You are a test assistant.",
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

    expect((result as AIMessage).content).toBe("Descriptor!")
    expect((openAIModel as { options: Record<string, unknown> }).options).toEqual({
      model: "gpt-4o-mini",
    })
  })

  test("DawnAgent with tools passes tools to materialized agent", async () => {
    let agentTools: readonly unknown[] | undefined

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { tools?: readonly unknown[] }) => {
        agentTools = options.tools
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Tool ready!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {},
    }))

    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "Use tools.",
    })

    const tools = [
      {
        name: "lookup",
        description: "Look up data",
        run: async (_input: unknown) => ({ result: "found" }),
      },
    ]

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { query: "test" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools,
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    expect((result as AIMessage).content).toBe("Tool ready!")
    expect(agentTools).toHaveLength(1)
  })
})
