import { createSubagentsMarker } from "@dawn-ai/core"
import { convertSubagentTaskToLangChain, streamAgent } from "@dawn-ai/langchain"
import { AIMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { describe, expect, it, vi } from "vitest"

import { buildGuardedSubagentResolver } from "../src/lib/runtime/execute-route.js"

const signal = new AbortController().signal

function entry(rule: { readonly action: "allow" | "deny" }, name = "researcher") {
  return {
    description: "Researches.",
    name,
    routeId: "/parent/subagents/researcher",
    rule,
    source: "convention" as const,
  }
}

describe("guarded CLI subagent resolution", () => {
  it("dispatches convention-only children under the default allow rule", async () => {
    const prepareChild = vi.fn(async () => ({
      routeId: "/parent/subagents/researcher",
      graph: { invoke: vi.fn() },
    }))
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry: [entry({ action: "allow" })],
    })

    await expect(
      resolver({ callId: "call-1", config: { signal }, input: "Inspect", name: "researcher" }),
    ).resolves.toMatchObject({
      ok: true,
      child: { routeId: "/parent/subagents/researcher" },
    })
    expect(prepareChild).toHaveBeenCalledTimes(1)
  })

  it("uses explicit aliases without retaining the replaced convention leaf", async () => {
    const prepareChild = vi.fn(async () => ({
      routeId: "/parent/subagents/researcher",
      graph: { invoke: vi.fn() },
    }))
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry: [{ ...entry({ action: "allow" }, "analyst"), source: "explicit" }],
    })
    const config = { signal } as RunnableConfig

    await expect(
      resolver({ callId: "call-1", config, input: "Inspect", name: "analyst" }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      resolver({ callId: "call-2", config, input: "Inspect", name: "researcher" }),
    ).resolves.toEqual({
      ok: false,
      message: "[DAWN_E5003] No subagent named 'researcher' is available.",
    })
  })

  it("returns E3002 through the task bridge without preparing or starting a child", async () => {
    const prepareChild = vi.fn()
    const deniedEntry = entry({ action: "deny" })
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry: [deniedEntry],
    })
    const marker = createSubagentsMarker()
    const contribution = await marker.load("/parent", {
      subagentRegistry: [{ ...deniedEntry, rule: { action: "allow" } }],
    } as never)
    const placeholder = contribution.tools?.[0]
    expect(placeholder).toBeDefined()
    const task = convertSubagentTaskToLangChain(placeholder as never, resolver)
    const graph = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
      .addNode("tools", new ToolNode([task]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile()
    const input = {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              args: { input: "Inspect", subagent: "researcher" },
              id: "call-denied",
              name: "task",
              type: "tool_call",
            },
          ],
        }),
      ],
    }
    const rawEvents: unknown[] = []
    let rawResult = ""

    for await (const event of graph.streamEvents(input, {
      configurable: { thread_id: "thread-denied" },
      version: "v2",
    })) {
      if (event.event === "on_custom_event" && event.name === "dawn.subagent") {
        rawEvents.push(event.data)
      }
      if (event.event === "on_tool_end" && event.name === "task") {
        rawResult = String((event.data.output as { content?: unknown }).content)
      }
    }

    const projected = []
    const projectedGraph = {
      invoke: graph.invoke.bind(graph),
      streamEvents: (_input: unknown, config: Record<string, unknown>) =>
        graph.streamEvents(input, { ...config, version: "v2" }),
    }
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: projectedGraph,
      input: {},
      routeParamNames: [],
      signal,
      threadId: "thread-denied-projected",
      tools: [],
    })) {
      projected.push(chunk)
    }

    expect(rawResult).toContain("[DAWN_E3002] Delegation to subagent 'researcher' is denied.")
    expect(rawEvents).toEqual([])
    expect(projected).not.toContainEqual(expect.objectContaining({ type: "subagent.start" }))
    expect(prepareChild).not.toHaveBeenCalled()
  })
})
