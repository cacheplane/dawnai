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

    // Without a real LLM key, materialization will fail on ChatOpenAI/network
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
