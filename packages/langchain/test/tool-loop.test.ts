import { AIMessage } from "@langchain/core/messages"
import { describe, expect, test } from "vitest"
import { executeWithToolLoop } from "../src/tool-loop.js"

describe("executeWithToolLoop", () => {
  test("returns output directly when no tool calls", async () => {
    const mockChain = {
      invoke: async () => new AIMessage({ content: "Hello!" }),
    }

    const result = await executeWithToolLoop({
      chain: mockChain,
      input: { message: "hi" },
      tools: [],
      signal: new AbortController().signal,
    })

    expect(result).toBeInstanceOf(AIMessage)
    expect((result as AIMessage).content).toBe("Hello!")
  })

  test("executes tool calls and feeds results back", async () => {
    let callCount = 0
    const mockChain = {
      invoke: async () => {
        callCount++
        if (callCount === 1) {
          return new AIMessage({
            content: "",
            tool_calls: [{ id: "call_1", name: "greet", args: { name: "World" } }],
          })
        }
        return new AIMessage({ content: "Done! Hello, World!" })
      },
    }

    const tools = [
      {
        name: "greet",
        run: async (input: unknown) => ({
          greeting: `Hello, ${(input as { name: string }).name}!`,
        }),
      },
    ]

    const result = await executeWithToolLoop({
      chain: mockChain,
      input: { message: "greet World" },
      tools,
      signal: new AbortController().signal,
    })

    expect((result as AIMessage).content).toBe("Done! Hello, World!")
    expect(callCount).toBe(2)
  })

  test("limits tool loop iterations to prevent infinite loops", async () => {
    const mockChain = {
      invoke: async () =>
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "noop", args: {} }],
        }),
    }

    const tools = [{ name: "noop", run: async () => ({}) }]

    await expect(
      executeWithToolLoop({
        chain: mockChain,
        input: {},
        tools,
        signal: new AbortController().signal,
        maxIterations: 3,
      }),
    ).rejects.toThrow(/maximum.*iterations/i)
  })
})
