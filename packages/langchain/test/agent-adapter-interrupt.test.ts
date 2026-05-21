import { Command } from "@langchain/langgraph"
import { afterEach, describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"
import { __resetPendingForTests, getPending } from "../src/pending-interrupts.js"

/**
 * These tests mimic the real LangGraph 1.x streamEvents v2 shape:
 *
 *   When a tool calls `interrupt(payload)` inside a node, LangGraph throws a
 *   `GraphInterrupt`. The tool error surfaces via streamEvents as an
 *   `on_tool_error` event whose `data.error` is a *stringified* form of the
 *   error — `JSON.stringify(interrupts, null, 2) + "\n\nGraphInterrupt: ..."`.
 *   The `on_chain_end` for the top-level `LangGraph` chain that follows does
 *   NOT include `__interrupt__` in this code path (that key only appears on
 *   the invoke/stream return value, not in streamEvents).
 *
 * The adapter must detect the interrupt from the `on_tool_error` event by
 * parsing the leading JSON array out of the error string. The legacy
 * `__interrupt__`-on-chain-end path is still supported as a defensive
 * fallback in case a future LangGraph version surfaces interrupts that way.
 */

function makeInterruptErrorString(
  entries: ReadonlyArray<{ id?: string; value: unknown }>,
): string {
  return `${JSON.stringify(entries, null, 2)}\n\nGraphInterrupt: ${JSON.stringify(
    entries,
    null,
    2,
  )}\n    at interrupt (file:///.../interrupt.js:70:8)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)`
}

describe("streamAgent — interrupt propagation", () => {
  afterEach(() => {
    __resetPendingForTests()
  })

  test("yields {type: 'interrupt', data} when on_tool_error surfaces a stringified GraphInterrupt", async () => {
    const interruptPayload = {
      interruptId: "perm-test-1",
      type: "permission-request",
      kind: "command",
      detail: { command: "ls", suggestedPattern: "ls" },
    }

    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_tool_start",
          name: "runBash",
          data: { input: { command: "ls" } },
        }
        yield {
          event: "on_tool_error",
          name: "runBash",
          data: {
            error: makeInterruptErrorString([{ id: "abc", value: interruptPayload }]),
          },
        }
        // LangGraph keeps the iterator alive after parking — the final
        // on_chain_end fires with the regular output (no __interrupt__).
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { messages: [] } },
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

    // The final `done` chunk should still fire (no threadId → no resume).
    const doneChunks = chunks.filter((c) => c.type === "done")
    expect(doneChunks).toHaveLength(1)
  })

  test("yields interrupt when GraphInterrupt is surfaced as a live error object", async () => {
    // Defensive: if a future LangGraph version stops stringifying the error
    // and passes the live GraphInterrupt instance through, we must still
    // detect it via .name + .interrupts.
    const interruptPayload = { interruptId: "live-1", type: "permission-request" }
    const liveError = Object.assign(new Error("GraphInterrupt"), {
      name: "GraphInterrupt",
      interrupts: [{ id: "live-a", value: interruptPayload }],
    })

    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_tool_error",
          name: "runBash",
          data: { error: liveError },
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

    expect(chunks.filter((c) => c.type === "interrupt")).toHaveLength(1)
    expect(chunks.find((c) => c.type === "interrupt")?.data).toEqual(interruptPayload)
  })

  test("yields interrupt when __interrupt__ appears on on_chain_end output (legacy fallback)", async () => {
    const interruptPayload = { interruptId: "legacy-1", type: "permission-request" }
    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: {
            output: { __interrupt__: [{ value: interruptPayload, id: "legacy-a" }] },
          },
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

    expect(chunks.filter((c) => c.type === "interrupt")).toHaveLength(1)
    expect(chunks.find((c) => c.type === "interrupt")?.data).toEqual(interruptPayload)
  })

  test("does not yield an interrupt chunk when no interrupt is surfaced", async () => {
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

  test("does not treat ordinary tool errors (non-GraphInterrupt) as interrupts", async () => {
    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_tool_error",
          name: "runBash",
          data: { error: "Error: boom\n    at foo (bar.js:1:1)" },
        }
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { messages: [] } },
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

    // Mock graph: first streamEvents call emits the stringified GraphInterrupt
    // via on_tool_error; the resume call emits a normal token + done.
    let callCount = 0
    let observedResumeInput: unknown
    const mockRunnable = {
      invoke: async () => ({ messages: [] }),
      streamEvents: async function* (input: unknown, _options: Record<string, unknown>) {
        callCount++
        if (callCount === 1) {
          yield {
            event: "on_tool_error",
            name: "runBash",
            data: {
              error: makeInterruptErrorString([{ id: "abc", value: interruptPayload }]),
            },
          }
          yield {
            event: "on_chain_end",
            name: "LangGraph",
            data: { output: { messages: [] } },
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

    // Poll for the pending entry to appear after the interrupt yields.
    for (let i = 0; i < 50 && !getPending(threadId); i++) {
      await new Promise((r) => setTimeout(r, 0))
    }

    const pending = getPending(threadId)
    expect(pending).toBeDefined()
    // Pending map uses the workspace capability's payload interruptId (the
    // same value the SSE envelope emits), NOT LangGraph's outer entry.id.
    expect(pending?.interruptId).toBe("perm-resume-1")

    pending?.resolve("once")
    await consumer

    expect(callCount).toBe(2)
    expect(observedResumeInput).toBeInstanceOf(Command)
    expect((observedResumeInput as Command).resume).toBe("once")

    expect(getPending(threadId)).toBeUndefined()

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
          event: "on_tool_error",
          name: "runBash",
          data: {
            error: makeInterruptErrorString([{ id: "x", value: interruptPayload }]),
          },
        }
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: { output: { messages: [] } },
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
