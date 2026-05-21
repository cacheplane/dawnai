import { describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"

describe("streamAgent — interrupt propagation", () => {
  test("yields {type: 'interrupt', data} when LangGraph surfaces __interrupt__ in on_chain_end output", async () => {
    // Mock runnable that mimics LangGraph 1.x's streamEvents v2 output: when
    // a node calls `interrupt(payload)`, the graph halts and its final
    // on_chain_end event carries `__interrupt__: [{value: payload, ...}, ...]`.
    const interruptPayload = {
      interruptId: "perm-test-1",
      type: "permission-request",
      kind: "command",
      detail: { command: "ls", suggestedPattern: "ls" },
    }

    const mockRunnable = {
      invoke: async () => ({ __interrupt__: [{ value: interruptPayload }] }),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { __interrupt__: [{ value: interruptPayload, id: "abc" }] } },
        }
      },
    }

    const chunks: Array<{ type: string; data: unknown }> = []
    for await (const chunk of streamAgent({
      entry: mockRunnable,
      input: { messages: [{ role: "user", content: "test" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push({ type: chunk.type, data: chunk.data })
    }

    const interruptChunks = chunks.filter((c) => c.type === "interrupt")
    expect(interruptChunks).toHaveLength(1)
    expect(interruptChunks[0]?.data).toEqual(interruptPayload)

    // The final `done` chunk should still fire, carrying the full output.
    const doneChunks = chunks.filter((c) => c.type === "done")
    expect(doneChunks).toHaveLength(1)
  })

  test("does not yield an interrupt chunk when output lacks __interrupt__", async () => {
    const mockRunnable = {
      invoke: async () => ({ messages: [] }),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { messages: [{ content: "hi" }] } },
        }
      },
    }

    const chunks: Array<{ type: string }> = []
    for await (const chunk of streamAgent({
      entry: mockRunnable,
      input: { messages: [{ role: "user", content: "test" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push({ type: chunk.type })
    }

    expect(chunks.filter((c) => c.type === "interrupt")).toHaveLength(0)
  })
})
