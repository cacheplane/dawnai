import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"

describe("streamAgent — tool-call id correlation", () => {
  test("tool_call and tool_result chunks carry the invocation run_id as data.id", async () => {
    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_tool_start",
          name: "greet",
          run_id: "run-xyz",
          data: { input: { name: "World" } },
        }
        yield {
          event: "on_tool_end",
          name: "greet",
          run_id: "run-xyz",
          data: { output: { greeting: "Hello, World!" } },
        }
        yield { event: "on_chain_end", name: "LangGraph", data: { output: { messages: [] } } }
      },
    }

    const chunks: Array<{ type: string; data: unknown }> = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: mockRunnable,
      input: { messages: [{ role: "user", content: "greet" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push({ type: chunk.type, data: chunk.data })
    }

    const call = chunks.find((c) => c.type === "tool_call")
    const result = chunks.find((c) => c.type === "tool_result")
    if (!call || !result) throw new Error("Expected correlated tool call and result chunks")
    const callId = (call.data as { id?: string }).id
    const resultId = (result.data as { id?: string }).id
    expect(callId).toBe("run-xyz")
    expect(resultId).toBe("run-xyz")
    // start and end of the same invocation share the id
    expect(callId).toBe(resultId)
  })
})
