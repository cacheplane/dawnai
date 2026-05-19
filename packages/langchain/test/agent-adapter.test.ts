import { agent } from "@dawn-ai/sdk"
import { AIMessage } from "@langchain/core/messages"
import { describe, expect, test, vi } from "vitest"
import { executeAgent } from "../src/agent-adapter.js"

describe("executeAgent with DawnAgent descriptors", () => {
  test("DawnAgent descriptor is recognized and does not throw invoke error", async () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    // Without a real LLM key, materialization will fail on provider construction
    // or network call.
    // but the error should NOT be "Agent entry must expose invoke(input)"
    const error = await executeAgent({
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("must expose invoke")
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
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize inferred non-OpenAI provider")
        }
      },
    }))

    const descriptor = agent({
      model: "claude-sonnet-4-5",
      systemPrompt: "You are helpful.",
    })

    const error = await executeAgent({
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
    expect((error as Error).message).not.toContain("ChatOpenAI")
    expect((error as Error).message).not.toContain("must expose invoke")
  })

  test("legacy agent with invoke() still works", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Legacy!" })),
    }

    const result = await executeAgent({
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
})
