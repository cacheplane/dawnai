/**
 * The edge half of the compiled-graph cache: with a distinct checkpointer per
 * request, every checkpointer call a turn makes must land on THAT request's
 * instance — zero on a prior request's.
 *
 * This is the failure the per-request store seam exists to prevent. On
 * Cloudflare workerd a Postgres connection is bound to the I/O context of the
 * request that opened it; reused by the next request it hangs for ~30s. So
 * "request 2 wrote through request 1's connection" is not a tidiness complaint,
 * it is half of all requests failing.
 *
 * Nothing is mocked here except the model: this runs the REAL `createReactAgent`
 * graph over a REAL `MemorySaver`, because the claim is about which object the
 * compiled graph reaches for at run time, and a fake graph could not be wrong
 * about that.
 *
 * SHAPE OF THE FIXTURE. Both requests' checkpointers are counting proxies over
 * ONE shared `MemorySaver` — one database, two connections, exactly as a
 * deployed worker has. That is what makes the test meaningful: turn 2 can read
 * turn 1's history through its OWN connection, so "no cross-request calls" and
 * "the conversation still accumulates" are proved at the same time, and neither
 * can be satisfied by breaking the other.
 */

import { agent } from "@dawn-ai/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { __resetMaterializedAgentsForTests, streamAgent } from "../src/agent-adapter.js"

// ---------------------------------------------------------------------------
// A scripted model, shared across every instance the adapter constructs.
//
// The cursor is module-level on purpose: the fix compiles a NEW graph (and so a
// new model) per request, and the conversation has to keep advancing across
// that boundary rather than restarting at response #1.
// ---------------------------------------------------------------------------

const script: AIMessage[] = []
let cursor = 0
/** Every message list the model was asked to complete, in order. */
const seenPrompts: BaseMessage[][] = []

class ScriptedChatModel extends BaseChatModel {
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  _llmType(): string {
    return "scripted-fake"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    seenPrompts.push(messages)
    const message = script[cursor]
    cursor += 1
    if (!message) throw new Error(`ScriptedChatModel ran out of responses at ${cursor - 1}`)
    return {
      generations: [{ text: typeof message.content === "string" ? message.content : "", message }],
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: BaseChatModel's bindTools signature is loose
  bindTools(_tools: any): any {
    return this
  }
}

// ---------------------------------------------------------------------------
// One "connection" per request: a counting proxy over the shared saver.
// ---------------------------------------------------------------------------

interface Connection {
  /** `<method>` per checkpointer call made through this connection. */
  readonly calls: string[]
  readonly checkpointer: BaseCheckpointSaver
  /** Any call that arrived after `close()` — the workerd-hang shape. */
  readonly useAfterClose: string[]
  readonly close: () => void
}

function openConnection(database: MemorySaver): Connection {
  const calls: string[] = []
  const useAfterClose: string[] = []
  let closed = false

  const checkpointer = new Proxy(database, {
    get(target, property) {
      // Bind the receiver to the real saver so its private fields resolve as
      // they would without the proxy.
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const name = String(property)
        calls.push(name)
        if (closed) useAfterClose.push(name)
        return (value as (...rest: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as unknown as BaseCheckpointSaver

  return {
    calls,
    checkpointer,
    close: () => {
      closed = true
    },
    useAfterClose,
  }
}

const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })

const tools = [
  {
    name: "note",
    description: "Records a note",
    run: async (input: unknown) => `noted: ${(input as { note?: string }).note ?? ""}`,
  },
]

function toolCall(id: string, note: string): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ args: { note }, id, name: "note" }] })
}

/** Drives one turn to completion through its own connection. */
async function runTurn(connection: Connection, message: string): Promise<void> {
  for await (const _chunk of streamAgent({
    checkpointer: connection.checkpointer,
    entry: descriptor,
    input: { messages: [{ content: message, role: "user" }] },
    routeParamNames: [],
    signal: new AbortController().signal,
    threadId: "thread-edge-1",
    tools,
  })) {
    // Drain: the turn is only over when the generator is.
  }
}

beforeEach(() => {
  script.length = 0
  seenPrompts.length = 0
  cursor = 0
  __resetMaterializedAgentsForTests()
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ScriptedChatModel }))
})

afterEach(() => {
  vi.doUnmock("@langchain/openai")
  __resetMaterializedAgentsForTests()
})

describe("per-request checkpointer, across turns of one thread", () => {
  it("routes every call of a turn to that turn's own checkpointer", async () => {
    const database = new MemorySaver()

    script.push(
      toolCall("call-note-1", "apples"),
      new AIMessage({ content: "Noted apples." }),
      toolCall("call-note-2", "pears"),
      new AIMessage({ content: "Noted pears." }),
    )

    // ---- Request 1 ----
    const first = openConnection(database)
    await runTurn(first, "add apples")
    const firstTurnCalls = first.calls.length
    first.close()

    // Turn 1 really did drive the graph through its checkpointer, so the
    // cross-request assertion below is not vacuously true.
    expect(firstTurnCalls).toBeGreaterThan(0)

    // ---- Request 2, same thread, its own connection ----
    const second = openConnection(database)
    await runTurn(second, "add pears")
    second.close()

    // THE CLAIM, counted per instance rather than "the right one was used at
    // least once": turn 2 made calls, all of them on its own connection, and
    // request 1's connection was not touched once after it closed.
    expect(second.calls.length).toBeGreaterThan(0)
    expect(first.useAfterClose).toEqual([])
    expect(first.calls.length).toBe(firstTurnCalls)

    // Both turns ran to completion against the scripted model…
    expect(cursor).toBe(4)
    // …and turn 2 read turn 1's history back through its own connection: the
    // last prompt carries the whole conversation, so the graph was neither
    // starting blank nor reading through a stale instance.
    const lastPrompt = JSON.stringify(seenPrompts.at(-1))
    expect(lastPrompt).toContain("add apples")
    expect(lastPrompt).toContain("noted: apples")
    expect(lastPrompt).toContain("add pears")
  })

  it("keeps one turn's checkpointer out of another agent's turn", async () => {
    // Two routes served in one process: the second agent's turn must not reach
    // for the first agent's connection either.
    const database = new MemorySaver()
    const other = agent({ model: "gpt-5-mini", systemPrompt: "Different agent." })

    script.push(new AIMessage({ content: "one" }), new AIMessage({ content: "two" }))

    const first = openConnection(database)
    for await (const _chunk of streamAgent({
      checkpointer: first.checkpointer,
      entry: descriptor,
      input: { messages: [{ content: "hello", role: "user" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: "thread-a",
      tools: [],
    })) {
      // drain
    }
    const firstTurnCalls = first.calls.length
    first.close()

    const second = openConnection(database)
    for await (const _chunk of streamAgent({
      checkpointer: second.checkpointer,
      entry: other,
      input: { messages: [{ content: "hello", role: "user" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: "thread-b",
      tools: [],
    })) {
      // drain
    }
    second.close()

    expect(second.calls.length).toBeGreaterThan(0)
    expect(first.useAfterClose).toEqual([])
    expect(first.calls.length).toBe(firstTurnCalls)
  })
})
