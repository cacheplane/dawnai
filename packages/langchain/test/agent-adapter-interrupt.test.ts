import { AIMessage } from "@langchain/core/messages"
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { describe, expect, test } from "vitest"
import { z } from "zod"
import { streamAgent } from "../src/agent-adapter.js"
import { convertSubagentTaskToLangChain } from "../src/subagent-tool-bridge.js"

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
 *
 * Resume is now state-based: after yielding an interrupt, the stream ends
 * cleanly. The caller posts to /threads/:id/resume with the decision, and
 * the server opens a new SSE stream with Command({resume: decision}) as
 * input. The adapter handles Command input directly (no in-process promise).
 */

function makeInterruptErrorString(entries: ReadonlyArray<{ id?: string; value: unknown }>): string {
  return `${JSON.stringify(entries, null, 2)}\n\nGraphInterrupt: ${JSON.stringify(
    entries,
    null,
    2,
  )}\n    at interrupt (file:///.../interrupt.js:70:8)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)`
}

describe("streamAgent — interrupt propagation", () => {
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
      checkpointer: new MemorySaver(),
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
      checkpointer: new MemorySaver(),
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
      checkpointer: new MemorySaver(),
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
      checkpointer: new MemorySaver(),
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
      checkpointer: new MemorySaver(),
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

  test("resume: state-based — second streamAgent call with Command({resume}) re-invokes the graph", async () => {
    const interruptPayload = {
      interruptId: "perm-resume-1",
      type: "permission-request",
      kind: "command",
      detail: { command: "ls", suggestedPattern: "ls" },
    }

    // Mock graph: first streamEvents call emits the stringified GraphInterrupt
    // via on_tool_error; the resume call (second invocation) receives
    // Command({resume}) and emits a normal token + done.
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
    const checkpointer = new MemorySaver()

    // First invocation: yields interrupt then done. Does NOT park.
    const firstChunks: Array<{ type: string; data?: unknown }> = []
    for await (const chunk of streamAgent({
      checkpointer,
      entry: mockRunnable,
      input: { messages: [{ role: "user", content: "test" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId,
      tools: [],
    })) {
      firstChunks.push({ type: chunk.type, data: chunk.data })
    }

    expect(callCount).toBe(1)
    expect(firstChunks.filter((c) => c.type === "interrupt")).toHaveLength(1)
    expect(firstChunks[firstChunks.length - 1]?.type).toBe("done")

    // Second invocation: resume with Command({resume: "once"}).
    const resumeChunks: Array<{ type: string; data?: unknown }> = []
    for await (const chunk of streamAgent({
      checkpointer,
      entry: mockRunnable,
      input: new Command({ resume: "once" }),
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId,
      tools: [],
    })) {
      resumeChunks.push({ type: chunk.type, data: chunk.data })
    }

    expect(callCount).toBe(2)
    expect(observedResumeInput).toBeInstanceOf(Command)
    expect((observedResumeInput as Command).resume).toBe("once")

    expect(resumeChunks.filter((c) => c.type === "token")).toHaveLength(1)
    expect(resumeChunks[resumeChunks.length - 1]?.type).toBe("done")
  })

  test("stream ends cleanly after interrupt (no threadId — no in-process parking)", async () => {
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
      checkpointer: new MemorySaver(),
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

  test("a native child interrupt parks and resumes through the root stream", async () => {
    const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
    const child = new StateGraph(ChildState)
      .addNode("approval", () => {
        const decision = interrupt({ interruptId: "child-permission", kind: "subagent" })
        return { messages: [new AIMessage(`approved:${decision}`)] }
      })
      .addEdge(START, "approval")
      .addEdge("approval", END)
      .compile()
    const task = convertSubagentTaskToLangChain(
      {
        name: "task",
        description: "Delegate.",
        schema: z.object({ subagent: z.string(), input: z.string() }),
        run: () => "placeholder",
      },
      async () => ({
        ok: true,
        child: { routeId: "/parent/subagents/researcher", graph: child },
      }),
    )
    const checkpointer = new MemorySaver()
    const RootState = Annotation.Root({
      messages: Annotation<unknown[]>(),
      result: Annotation<string>(),
    })
    const root = new StateGraph(RootState)
      .addNode("dispatch", async (_state, config) => ({
        result: await task.func({ subagent: "researcher", input: "Review" }, undefined, {
          ...config,
          toolCall: { id: "task-native-resume" },
        }),
      }))
      .addEdge(START, "dispatch")
      .addEdge("dispatch", END)
      .compile({ checkpointer })
    const input = { messages: [{ role: "user", content: "Review" }] }
    const first = []
    for await (const chunk of streamAgent({
      checkpointer,
      entry: root,
      input,
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: "native-root-thread",
      tools: [],
    })) {
      first.push(chunk)
    }
    expect(first.filter(({ type }) => type === "interrupt").map(({ data }) => data)).toEqual([
      { interruptId: "child-permission", kind: "subagent" },
    ])

    const rootState = await root.getState({ configurable: { thread_id: "native-root-thread" } })
    const nativeInterruptId = rootState.tasks[0]?.interrupts[0]?.id
    expect(nativeInterruptId).toEqual(expect.any(String))

    const resumed = []
    for await (const chunk of streamAgent({
      checkpointer,
      entry: root,
      input: new Command({ resume: { [nativeInterruptId as string]: "once" } }),
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: "native-root-thread",
      tools: [],
    })) {
      resumed.push(chunk)
    }
    const output = resumed.findLast(({ type }) => type === "done")?.data as { result?: unknown }
    expect(output.result).toBe("approved:once")
  })
})
