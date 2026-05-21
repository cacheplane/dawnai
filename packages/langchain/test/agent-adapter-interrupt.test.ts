import { Command } from "@langchain/langgraph"
import { afterEach, describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"
import { __resetPendingForTests, getPending } from "../src/pending-interrupts.js"

describe("streamAgent — interrupt propagation", () => {
  afterEach(() => {
    __resetPendingForTests()
  })

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

  test("resume: parks on interrupt, re-invokes with Command({resume}) when pending.resolve fires", async () => {
    const interruptPayload = {
      interruptId: "perm-resume-1",
      type: "permission-request",
      kind: "command",
      detail: { command: "ls", suggestedPattern: "ls" },
    }

    // Mock graph: first streamEvents call emits __interrupt__; subsequent
    // calls (carrying a Command({resume: ...})) emit a normal token + done.
    let callCount = 0
    let observedResumeInput: unknown
    const mockRunnable = {
      invoke: async () => ({ messages: [] }),
      streamEvents: async function* (input: unknown, _options: Record<string, unknown>) {
        callCount++
        if (callCount === 1) {
          yield {
            event: "on_chain_end",
            name: "LangGraph",
            data: {
              output: { __interrupt__: [{ value: interruptPayload, id: "abc" }] },
            },
          }
          return
        }
        observedResumeInput = input
        yield {
          event: "on_chat_model_stream",
          name: "model",
          data: { chunk: { content: "ok" } },
        }
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { messages: [{ content: "done" }] } },
        }
      },
    }

    const threadId = "thread-resume-test"

    // Consume the stream from a worker. It will park at the interrupt,
    // waiting for pending.resolve to fire.
    const chunks: Array<{ type: string; data?: unknown }> = []
    const consumer = (async () => {
      for await (const chunk of streamAgent({
        entry: mockRunnable,
        input: { messages: [{ role: "user", content: "test" }] },
        routeParamNames: [],
        signal: new AbortController().signal,
        threadId,
        tools: [],
      })) {
        chunks.push({ type: chunk.type, data: chunk.data })
      }
    })()

    // Poll for the pending entry to appear (set by the adapter after it
    // yields the interrupt chunk). The yield happens on the same tick, but
    // the pending Promise registration is the next microtask.
    for (let i = 0; i < 50 && !getPending(threadId); i++) {
      await new Promise((r) => setTimeout(r, 0))
    }

    const pending = getPending(threadId)
    expect(pending).toBeDefined()
    expect(pending?.interruptId).toBe("abc")

    // Fire the decision — this should cause the adapter to re-invoke the
    // graph with Command({resume: "once"}) and complete the stream.
    pending?.resolve("once")
    await consumer

    expect(callCount).toBe(2)
    // The resume invocation must have been called with a Command instance
    // carrying our decision.
    expect(observedResumeInput).toBeInstanceOf(Command)
    expect((observedResumeInput as Command).resume).toBe("once")

    // Pending entry must be cleared.
    expect(getPending(threadId)).toBeUndefined()

    // Stream shape: interrupt → token → done.
    const types = chunks.map((c) => c.type)
    expect(types).toContain("interrupt")
    expect(types).toContain("token")
    expect(types[types.length - 1]).toBe("done")
  })

  test("resume without threadId ends the stream after interrupt (no replay)", async () => {
    const interruptPayload = { interruptId: "p-noresume", type: "x" }
    let callCount = 0
    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        callCount++
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { __interrupt__: [{ value: interruptPayload, id: "x" }] } },
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
      // intentionally no threadId
    })) {
      chunks.push({ type: chunk.type })
    }

    expect(callCount).toBe(1)
    expect(chunks.filter((c) => c.type === "interrupt")).toHaveLength(1)
    expect(chunks[chunks.length - 1]?.type).toBe("done")
  })
})
