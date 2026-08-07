/**
 * The compiled-graph cache is keyed by (descriptor, checkpointer) — the two
 * halves of that claim, counted rather than inferred.
 *
 * `createReactAgent` embeds the checkpointer it is handed, so the cache key has
 * to include it or an edge deploy's request N+1 runs against request N's
 * disposed connection (see the sibling
 * `agent-graph-per-request-checkpointer.test.ts`, which proves the runtime half
 * against a real graph). The risk in fixing that is over-correcting into a
 * compile per request on NODE, where one boot-resolved checkpointer serves the
 * whole process — so this file counts `createReactAgent` invocations directly.
 *
 * `createReactAgent` is mocked here precisely BECAUSE it is the thing being
 * counted; the real graph would give us identity but not a call count.
 */

import { agent } from "@dawn-ai/sdk"
import { AIMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"

import { __resetMaterializedAgentsForTests, materializeAgentGraph } from "../src/agent-adapter.js"

/** Installs the mocks and returns the compile counter. */
function countCompilations(): { calls: () => number } {
  const createReactAgent = vi.fn(() => ({
    invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "ok" })),
  }))
  vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
  vi.doMock("@langchain/openai", () => ({
    ChatOpenAI: class {
      constructor(readonly options: Record<string, unknown>) {}
    },
  }))
  return { calls: () => createReactAgent.mock.calls.length }
}

afterEach(() => {
  vi.doUnmock("@langchain/langgraph/prebuilt")
  vi.doUnmock("@langchain/openai")
  __resetMaterializedAgentsForTests()
})

describe("compiled-graph cache keying", () => {
  it("compiles ONCE per process when one checkpointer serves every request (the node path)", async () => {
    const counter = countCompilations()
    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })
    // Exactly what `dawn start` does: one instance resolved at boot, reused by
    // every request for the life of the process.
    const bootCheckpointer: BaseCheckpointSaver = new MemorySaver()

    const graphs: unknown[] = []
    for (let request = 0; request < 5; request++) {
      graphs.push(await materializeAgentGraph({ checkpointer: bootCheckpointer, descriptor }))
    }

    expect(counter.calls()).toBe(1)
    // …and every request got the SAME graph object, not five equal ones.
    expect(new Set(graphs).size).toBe(1)
  })

  it("compiles per checkpointer when each request brings its own (the edge path)", async () => {
    const counter = countCompilations()
    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })

    const graphs: unknown[] = []
    for (let request = 0; request < 3; request++) {
      graphs.push(await materializeAgentGraph({ checkpointer: new MemorySaver(), descriptor }))
    }

    expect(counter.calls()).toBe(3)
    expect(new Set(graphs).size).toBe(3)
  })

  it("still caches per checkpointer when several agents share one process", async () => {
    const counter = countCompilations()
    const chat = agent({ model: "gpt-5-mini", systemPrompt: "Chat." })
    const support = agent({ model: "gpt-5-mini", systemPrompt: "Support." })
    const bootCheckpointer: BaseCheckpointSaver = new MemorySaver()

    for (let request = 0; request < 4; request++) {
      await materializeAgentGraph({ checkpointer: bootCheckpointer, descriptor: chat })
      await materializeAgentGraph({ checkpointer: bootCheckpointer, descriptor: support })
    }

    // One per agent for the whole process — the descriptor is still half the key.
    expect(counter.calls()).toBe(2)
  })

  it("does not cache a checkpointer-less graph (unchanged from before)", async () => {
    const counter = countCompilations()
    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })

    await materializeAgentGraph({ descriptor })
    await materializeAgentGraph({ descriptor })

    expect(counter.calls()).toBe(2)
  })

  it("does not cache a sandboxed graph, checkpointer or not (unchanged from before)", async () => {
    const counter = countCompilations()
    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })
    const bootCheckpointer: BaseCheckpointSaver = new MemorySaver()

    await materializeAgentGraph({ checkpointer: bootCheckpointer, descriptor, sandboxed: true })
    await materializeAgentGraph({ checkpointer: bootCheckpointer, descriptor, sandboxed: true })

    // A sandboxed graph closes over ONE thread's fs/exec backends; sharing it
    // across threads is the one leak a sandbox must never allow.
    expect(counter.calls()).toBe(2)
  })
})
