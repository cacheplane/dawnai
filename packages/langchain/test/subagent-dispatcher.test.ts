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
