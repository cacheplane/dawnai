import { describe, expect, it, vi } from "vitest"
import { dispatchSubagent } from "../src/subagent-dispatcher.js"

describe("dispatchSubagent — happy path", () => {
  it("calls the child graph with a fresh state seeded by input and returns the final assistant text", async () => {
    const childFinal = "Final answer from child."
    const childGraph = {
      invoke: vi.fn(async (input: unknown, _config: unknown) => {
        return {
          messages: [
            ...((input as { messages: unknown[] }).messages ?? []),
            { type: "ai", content: childFinal, getType: () => "ai" },
          ],
        }
      }),
    }

    const result = await dispatchSubagent({
      childGraph,
      input: "Do the thing",
      parentConfig: {},
      writer: () => {},
      callId: "call-1",
      childRouteId: "/coordinator/subagents/research",
      subagentName: "research",
    })

    expect(result.finalText).toBe(childFinal)
    expect(childGraph.invoke).toHaveBeenCalledTimes(1)
    const firstArg = childGraph.invoke.mock.calls[0]![0] as { messages: { content: string }[] }
    expect(firstArg.messages[0]!.content).toBe("Do the thing")
  })

  it("emits subagent.start before invocation and subagent.end after", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const childGraph = {
      invoke: vi.fn(async () => ({
        messages: [{ type: "ai", content: "ok", getType: () => "ai" }],
      })),
    }
    await dispatchSubagent({
      childGraph,
      input: "x",
      parentConfig: {},
      writer: (e) => events.push(e),
      callId: "abc",
      childRouteId: "/r",
      subagentName: "r",
    })
    const tags = events.map((e) => e.event)
    expect(tags[0]).toBe("subagent.start")
    expect(tags[tags.length - 1]).toBe("subagent.end")
    expect(events[0]!.data.call_id).toBe("abc")
    expect(events[0]!.data.subagent).toBe("r")
  })
})

describe("dispatchSubagent — depth tracking", () => {
  it("returns depth_exceeded without invoking the child when depth > 3", async () => {
    const childGraph = { invoke: vi.fn() }
    const result = await dispatchSubagent({
      childGraph,
      input: "x",
      parentConfig: { metadata: { dawn: { subagent_depth: 3 } } },
      writer: () => {},
      callId: "c",
      childRouteId: "/r",
      subagentName: "r",
    })
    expect(result.finalText).toMatch(/subagent_depth_exceeded/)
    expect(childGraph.invoke).not.toHaveBeenCalled()
  })

  it("increments depth on the child config", async () => {
    let seenChildConfig: { metadata?: { dawn?: { subagent_depth?: number } } } | undefined
    const childGraph = {
      invoke: vi.fn(async (_input: unknown, config: unknown) => {
        seenChildConfig = config as typeof seenChildConfig
        return { messages: [{ type: "ai", content: "ok", getType: () => "ai" }] }
      }),
    }
    await dispatchSubagent({
      childGraph,
      input: "x",
      parentConfig: { metadata: { dawn: { subagent_depth: 1 } } },
      writer: () => {},
      callId: "c",
      childRouteId: "/r",
      subagentName: "r",
    })
    expect(seenChildConfig?.metadata?.dawn?.subagent_depth).toBe(2)
  })
})

describe("dispatchSubagent — child failure", () => {
  it("returns subagent_failed and emits subagent.end with error when child throws", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const childGraph = {
      invoke: vi.fn(async () => {
        throw new Error("child went boom")
      }),
    }
    const result = await dispatchSubagent({
      childGraph,
      input: "x",
      parentConfig: {},
      writer: (e) => events.push(e),
      callId: "c",
      childRouteId: "/r",
      subagentName: "r",
    })
    expect(result.finalText).toMatch(/subagent_failed/)
    expect(result.finalText).toMatch(/child went boom/)
    const endEvent = events.find((e) => e.event === "subagent.end")!
    expect(endEvent.data.error).toMatch(/child went boom/)
  })
})

describe("dispatchSubagent — event bubbling", () => {
  it("relays child streamEvents as subagent.* envelopes carrying the parent call_id", async () => {
    const childGraph = {
      invoke: vi.fn(),
      streamEvents: async function* (input: unknown, _config: unknown) {
        yield {
          event: "on_tool_start",
          name: "readFile",
          data: { chunk: { path: "foo.txt" } },
        }
        yield {
          event: "on_tool_end",
          name: "readFile",
          data: { output: "file contents" },
        }
        yield {
          event: "on_chat_model_stream",
          name: "model",
          data: { chunk: { content: "Hello " } },
        }
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: {
            output: {
              messages: [
                ...((input as { messages: unknown[] }).messages ?? []),
                { type: "ai", content: "child final", getType: () => "ai" },
              ],
            },
          },
        }
      },
    }

    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const result = await dispatchSubagent({
      childGraph: childGraph as never,
      input: "x",
      parentConfig: {},
      writer: (e) => events.push(e),
      callId: "call-xyz",
      childRouteId: "/r",
      subagentName: "research",
    })

    expect(result.finalText).toBe("child final")
    const tags = events.map((e) => e.event)
    expect(tags).toContain("subagent.start")
    expect(tags).toContain("subagent.tool_call")
    expect(tags).toContain("subagent.tool_result")
    expect(tags).toContain("subagent.message")
    expect(tags).toContain("subagent.end")
    const toolCallEvent = events.find((e) => e.event === "subagent.tool_call")!
    expect(toolCallEvent.data.call_id).toBe("call-xyz")
    expect(toolCallEvent.data.tool).toBe("readFile")
    const msgEvent = events.find((e) => e.event === "subagent.message")!
    expect(msgEvent.data.chunk).toBe("Hello ")
  })

  it("falls back to invoke() when streamEvents is unavailable (no change from Task 8 behavior)", async () => {
    const childGraph = {
      invoke: vi.fn(async () => ({
        messages: [{ type: "ai", content: "from invoke", getType: () => "ai" }],
      })),
    }
    const result = await dispatchSubagent({
      childGraph,
      input: "x",
      parentConfig: {},
      writer: () => {},
      callId: "c",
      childRouteId: "/r",
      subagentName: "r",
    })
    expect(result.finalText).toBe("from invoke")
    expect(childGraph.invoke).toHaveBeenCalledOnce()
  })
})

describe("dispatchSubagent — dawnStream path", () => {
  it("prefers dawnStream over streamEvents/invoke and bubbles Dawn StreamChunks as subagent.* envelopes", async () => {
    const childGraph = {
      invoke: vi.fn(),
      // streamEvents not provided — confirm dawnStream takes precedence even if it were
      dawnStream: async function* () {
        yield { type: "tool_call", name: "readFile", input: { path: "x.md" } }
        yield { type: "tool_result", name: "readFile", output: "contents" }
        yield { type: "chunk", data: "Hello " }
        yield {
          type: "plan_update",
          data: { todos: [{ content: "do thing", status: "pending" }] },
        }
        yield {
          type: "done",
          output: {
            messages: [{ type: "ai", content: "child final", getType: () => "ai" }],
          },
        }
      },
    }

    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const result = await dispatchSubagent({
      childGraph: childGraph as never,
      input: "x",
      parentConfig: {},
      writer: (e) => events.push(e),
      callId: "C",
      childRouteId: "/r",
      subagentName: "r",
    })

    expect(result.finalText).toBe("child final")
    expect(childGraph.invoke).not.toHaveBeenCalled()

    const tags = events.map((e) => e.event)
    expect(tags).toContain("subagent.tool_call")
    expect(tags).toContain("subagent.tool_result")
    expect(tags).toContain("subagent.message")
    expect(tags).toContain("subagent.plan_update")
    expect(tags).toContain("subagent.end")

    const planEvent = events.find((e) => e.event === "subagent.plan_update")!
    expect(planEvent.data.call_id).toBe("C")
    expect((planEvent.data as { todos?: unknown }).todos).toBeDefined()
  })
})

import { bridgeSubagentTool } from "../src/subagent-tool-bridge.js"

describe("bridgeSubagentTool — wraps run() with dispatcher", () => {
  it("replaces task.run with a closure that dispatches to the resolved child graph", async () => {
    const childGraph = {
      invoke: vi.fn(async (input: unknown) => ({
        messages: [
          ...(input as { messages: unknown[] }).messages,
          { type: "ai", content: "from child", getType: () => "ai" },
        ],
      })),
    }
    const subagentResolver = (leaf: string) => {
      if (leaf === "research") return { routeId: "/parent/subagents/research", graph: childGraph }
      return undefined
    }

    const taskTool = bridgeSubagentTool({ subagentResolver, writer: () => {} })

    expect(taskTool.name).toBe("task")
    const result = await taskTool.run(
      { subagent: "research", input: "go" },
      { signal: new AbortController().signal },
    )

    expect(result).toBe("from child")
    expect(childGraph.invoke).toHaveBeenCalledOnce()
  })

  it("returns subagent_unknown when resolver returns undefined", async () => {
    const taskTool = bridgeSubagentTool({
      subagentResolver: () => undefined,
      writer: () => {},
    })

    const result = await taskTool.run(
      { subagent: "ghost", input: "x" },
      { signal: new AbortController().signal },
    )

    expect(result).toMatch(/subagent_unknown/)
    expect(result).toMatch(/ghost/)
  })

  it("forwards parentConfig when provided", async () => {
    let seenConfig: { metadata?: { dawn?: { subagent_depth?: number } } } | undefined
    const childGraph = {
      invoke: vi.fn(async (_input: unknown, config: unknown) => {
        seenConfig = config as typeof seenConfig
        return { messages: [{ type: "ai", content: "ok", getType: () => "ai" }] }
      }),
    }
    const taskTool = bridgeSubagentTool({
      subagentResolver: () => ({ routeId: "/r", graph: childGraph }),
      writer: () => {},
      parentConfig: { metadata: { dawn: { subagent_depth: 1 } } },
    })

    await taskTool.run({ subagent: "x", input: "y" }, { signal: new AbortController().signal })

    expect(seenConfig?.metadata?.dawn?.subagent_depth).toBe(2)
  })
})
