import { AIMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  Annotation,
  Command,
  END,
  interrupt,
  isGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  convertSubagentTaskToLangChain,
  type ResolvedSubagentGraph,
  type SubagentResolver,
} from "../src/subagent-tool-bridge.js"

const taskPlaceholder = {
  name: "task",
  description: "Delegate to a subagent.",
  schema: z.object({ subagent: z.string(), input: z.string() }),
  run: vi.fn(),
}

function childResult(text: string): { messages: AIMessage[] } {
  return { messages: [new AIMessage(text)] }
}

function allowedChild(
  graph: ResolvedSubagentGraph["graph"],
  routeId = "/parent/subagents/researcher",
): Awaited<ReturnType<SubagentResolver>> {
  return { ok: true, child: { routeId, graph } }
}

describe("convertSubagentTaskToLangChain", () => {
  it("passes the exact live config and task call id, then appends Dawn depth and stack metadata", async () => {
    let childConfig: RunnableConfig | undefined
    const child = {
      invoke: vi.fn(async (_input: unknown, config: RunnableConfig) => {
        childConfig = config
        return childResult("Final answer from child.")
      }),
    }
    const resolver = vi.fn<SubagentResolver>(async () => allowedChild(child))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    const signal = new AbortController().signal
    const callbacks = []
    const tags = ["live-parent"]
    const parentStack = [{ callId: "outer", name: "planner", routeId: "/planner" }]
    const config = {
      callbacks,
      configurable: { checkpoint_ns: "parent:1", thread_id: "thread-1" },
      metadata: {
        tenant: "acme",
        dawn: { root_sandbox_key: "sandbox-1", subagent_depth: 1, subagent_stack: parentStack },
      },
      signal,
      tags,
      toolCall: { args: {}, id: "task-live-1", name: "task", type: "tool_call" },
    } as RunnableConfig & { toolCall: { id: string } }

    const result = await tool.func(
      { subagent: "researcher", input: "Inspect the evidence" },
      undefined,
      config,
    )

    expect(result).toBe("Final answer from child.")
    expect(resolver).toHaveBeenCalledWith({
      callId: "task-live-1",
      name: "researcher",
      input: "Inspect the evidence",
      config,
    })
    expect(child.invoke).toHaveBeenCalledWith(
      { messages: [{ role: "user", content: "Inspect the evidence" }] },
      expect.any(Object),
    )
    expect(childConfig?.callbacks).toBe(callbacks)
    expect(childConfig?.configurable).toBe(config.configurable)
    expect(childConfig?.signal).toBe(signal)
    expect(childConfig?.tags).toBe(tags)
    expect(childConfig?.metadata).toEqual({
      tenant: "acme",
      dawn: {
        root_sandbox_key: "sandbox-1",
        subagent_depth: 2,
        subagent_stack: [
          ...parentStack,
          {
            callId: "task-live-1",
            name: "researcher",
            routeId: "/parent/subagents/researcher",
          },
        ],
      },
    })
  })

  it("returns a coded E5003 result without resolving or invoking a child beyond depth three", async () => {
    const resolver = vi.fn<SubagentResolver>()
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    const result = await tool.func({ subagent: "researcher", input: "Go deeper" }, undefined, {
      metadata: { dawn: { subagent_depth: 3 } },
      toolCall: { id: "task-depth-4" },
    } as RunnableConfig)

    expect(result).toMatch(/^\[DAWN_E5003\]/)
    expect(resolver).not.toHaveBeenCalled()
  })

  it("returns a guarded resolver denial unchanged", async () => {
    const resolver = vi.fn<SubagentResolver>(async () => ({
      ok: false,
      message: "[DAWN_E3002] Dispatch denied.",
    }))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)

    await expect(
      tool.func({ subagent: "writer", input: "Draft" }, undefined, {
        toolCall: { id: "task-denied" },
      } as RunnableConfig),
    ).resolves.toBe("[DAWN_E3002] Dispatch denied.")
  })

  it("rethrows the exact GraphInterrupt raised by a real child graph", async () => {
    const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
    const child = new StateGraph(ChildState)
      .addNode("pause", () => {
        interrupt({ kind: "child-approval" })
        return {}
      })
      .addEdge(START, "pause")
      .addEdge("pause", END)
      .compile()
    let childError: unknown
    const graph = {
      invoke: async (input: unknown, config: RunnableConfig) => {
        try {
          return await child.invoke(input as never, config)
        } catch (error) {
          childError = error
          throw error
        }
      },
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(graph))
    let bridgeError: unknown
    const RootState = Annotation.Root({ result: Annotation<string>() })
    const root = new StateGraph(RootState)
      .addNode("dispatch", async (_state, config) => {
        try {
          return {
            result: await tool.func({ subagent: "researcher", input: "Pause" }, undefined, {
              ...config,
              toolCall: { id: "task-interrupt" },
            } as RunnableConfig),
          }
        } catch (error) {
          bridgeError = error
          throw error
        }
      })
      .addEdge(START, "dispatch")
      .addEdge("dispatch", END)
      .compile({ checkpointer: new MemorySaver() })

    await root.invoke({}, { configurable: { thread_id: "interrupt-identity" } })

    expect(isGraphInterrupt(bridgeError)).toBe(true)
    expect(bridgeError).toBe(childError)
  })

  it("converts ordinary failures and dispatches start/end custom events", async () => {
    const child = {
      invoke: vi.fn(async () => {
        throw new Error("child went boom")
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
      .addNode("tools", new ToolNode([tool]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile()
    const events: Array<{
      event: string
      data: unknown
    }> = []

    for await (const event of root.streamEvents(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "task",
                args: { subagent: "researcher", input: "Fail normally" },
                id: "task-failure",
                type: "tool_call",
              },
            ],
          }),
        ],
      },
      { version: "v2" },
    )) {
      if (event.event === "on_custom_event" && event.name === "dawn.subagent") {
        events.push({
          event: event.name,
          data: event.data,
        })
      }
      if (event.event === "on_tool_end" && event.name === "task") {
        expect(String((event.data.output as { content?: unknown }).content)).toContain(
          "subagent_failed: child went boom",
        )
      }
    }

    expect(events.map(({ data }) => data)).toEqual([
      {
        phase: "start",
        call_id: "task-failure",
        subagent: "researcher",
        route_id: "/parent/subagents/researcher",
        depth: 1,
      },
      {
        phase: "end",
        call_id: "task-failure",
        subagent: "researcher",
        route_id: "/parent/subagents/researcher",
        depth: 1,
        error: "child went boom",
      },
    ])
  })

  it("rethrows a standard AbortError unchanged without an error-shaped end event", async () => {
    const abortError = new DOMException("Child cancelled", "AbortError")
    const child = {
      invoke: vi.fn(async () => {
        throw abortError
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    const RootState = Annotation.Root({ result: Annotation<string>() })
    const root = new StateGraph(RootState)
      .addNode("dispatch", async (_state, config) => ({
        result: await tool.func({ subagent: "researcher", input: "Cancel" }, undefined, {
          ...config,
          toolCall: { id: "task-cancel" },
        }),
      }))
      .addEdge(START, "dispatch")
      .addEdge("dispatch", END)
      .compile()
    const events: unknown[] = []
    let thrown: unknown

    try {
      for await (const event of root.streamEvents({}, { version: "v2" })) {
        if (event.event === "on_custom_event" && event.name === "dawn.subagent") {
          events.push(event.data)
        }
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(abortError)
    expect(events).toEqual([expect.objectContaining({ phase: "start", call_id: "task-cancel" })])
  })

  it("rethrows child errors unchanged when the inherited signal is aborted", async () => {
    const cancellation = new Error("cancelled by parent")
    const controller = new AbortController()
    controller.abort()
    const child = {
      invoke: vi.fn(async () => {
        throw cancellation
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))

    await expect(
      tool.func({ subagent: "researcher", input: "Cancel" }, undefined, {
        signal: controller.signal,
        toolCall: { id: "task-aborted-signal" },
      } as RunnableConfig),
    ).rejects.toBe(cancellation)
  })

  it("inherits the root checkpointer and resumes a child interrupt from the root thread", async () => {
    const child = interruptingChild()
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    const saver = new MemorySaver()
    const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
      .addNode("tools", new ToolNode([tool]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile({ checkpointer: saver })
    const config = { configurable: { thread_id: "root-thread" } }
    const first = await root.invoke(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "task",
                args: { subagent: "researcher", input: "Review" },
                id: "task-review",
                type: "tool_call",
              },
            ],
          }),
        ],
      },
      config,
    )
    const interruptId = first.__interrupt__?.[0]?.id
    expect(interruptId).toEqual(expect.any(String))

    const namespaces = await checkpointNamespaces(saver, config)
    expect(namespaces.some((namespace) => namespace.startsWith("tools:"))).toBe(true)

    const resumed = await root.invoke(
      new Command({ resume: { [interruptId as string]: "approved" } }),
      config,
    )
    const toolMessage = resumed.messages.at(-1) as { content?: unknown; tool_call_id?: unknown }
    expect(toolMessage.tool_call_id).toBe("task-review")
    expect(toolMessage.content).toBe("child:approved")
  })

  it("gives parallel child calls distinct native interrupt ids and checkpoint namespaces", async () => {
    const child = interruptingChild()
    const seenConfigs: RunnableConfig[] = []
    const graph = {
      invoke: async (input: unknown, config: RunnableConfig) => {
        seenConfigs.push(config)
        return await child.invoke(input as never, config)
      },
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(graph))
    const RootState = Annotation.Root({
      results: Annotation<string[]>({
        reducer: (left, right) => [...left, ...right],
        default: () => [],
      }),
    })
    const call =
      (callId: string, input: string) => async (_state: unknown, config: RunnableConfig) => ({
        results: [
          await tool.func({ subagent: "researcher", input }, undefined, {
            ...config,
            toolCall: { id: callId },
          } as RunnableConfig),
        ],
      })
    const saver = new MemorySaver()
    const root = new StateGraph(RootState)
      .addNode("first", call("task-a", "A"))
      .addNode("second", call("task-b", "B"))
      .addEdge(START, "first")
      .addEdge(START, "second")
      .addEdge("first", END)
      .addEdge("second", END)
      .compile({ checkpointer: saver })
    const config = { configurable: { thread_id: "parallel-root" } }

    const first = await root.invoke({}, config)
    const interruptIds = first.__interrupt__?.map(({ id }) => id) ?? []
    expect(interruptIds).toHaveLength(2)
    expect(new Set(interruptIds).size).toBe(2)
    expect(
      new Set(seenConfigs.slice(0, 2).map((entry) => entry.configurable?.checkpoint_ns as string))
        .size,
    ).toBe(2)

    const namespaces = (await checkpointNamespaces(saver, config)).filter(Boolean)
    expect(new Set(namespaces).size).toBeGreaterThanOrEqual(2)

    const resumed = await root.invoke(
      new Command({
        resume: Object.fromEntries(interruptIds.map((id, index) => [id, `approved-${index}`])),
      }),
      config,
    )
    expect(resumed.results).toEqual(["child:approved-0", "child:approved-1"])
  })
})

function interruptingChild() {
  const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
  return new StateGraph(ChildState)
    .addNode("approval", (state) => {
      const input = (state.messages[0] as { content?: unknown } | undefined)?.content
      const decision = interrupt({ kind: "child-approval", input })
      return { messages: [new AIMessage(`child:${decision}`)] }
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile()
}

async function checkpointNamespaces(saver: MemorySaver, config: RunnableConfig): Promise<string[]> {
  const namespaces: string[] = []
  for await (const checkpoint of saver.list(config)) {
    const namespace = checkpoint.config.configurable?.checkpoint_ns
    if (typeof namespace === "string" && namespace !== "") namespaces.push(namespace)
  }
  return namespaces
}
