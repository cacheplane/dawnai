import { EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { createCounterIdFactory } from "../src/ids.js"
import { toAguiEvents } from "../src/outbound.js"
import type { DawnAgentStreamChunk } from "../src/types.js"

const CTX = { threadId: "th-1", runId: "rn-1" }

async function collect(chunks: DawnAgentStreamChunk[]) {
  const out = []
  for await (const ev of toAguiEvents(toAsync(chunks), CTX, {
    idFactory: createCounterIdFactory(),
  })) {
    out.push(ev)
  }
  return out
}

async function* toAsync(items: DawnAgentStreamChunk[]) {
  for (const item of items) yield item
}

describe("toAguiEvents", () => {
  test("text-only stream: run start, framed message, run finished success", async () => {
    const events = await collect([
      { type: "token", data: "Hel" },
      { type: "token", data: "lo" },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "lo" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        result: {},
        outcome: { type: "success" },
      },
    ])
  })

  test("tool call + result: correlated by upstream id, single args frame", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-abc", name: "greet", input: { name: "World" } } },
      { type: "tool_result", data: { id: "run-abc", name: "greet", output: { greeting: "hi" } } },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      { type: EventType.TOOL_CALL_START, toolCallId: "run-abc", toolCallName: "greet" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "run-abc", delta: '{"name":"World"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "run-abc" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr-1",
        toolCallId: "run-abc",
        content: '{"greeting":"hi"}',
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        result: {},
        outcome: { type: "success" },
      },
    ])
  })

  test("tool call args JSON-serialize string input", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-string", name: "echo", input: "raw" } },
      { type: "done", data: {} },
    ])
    const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS) as { delta: string }
    expect(args.delta).toBe('"raw"')
  })

  test("tool call args JSON-serialize null input", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-null", name: "echo", input: null } },
      { type: "done", data: {} },
    ])
    const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS) as { delta: string }
    expect(args.delta).toBe("null")
  })

  test("tool call args fall back to a string when JSON serialization returns undefined", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-undefined", name: "echo", input: undefined } },
      { type: "tool_call", data: { id: "run-function", name: "echo", input: () => undefined } },
      { type: "done", data: {} },
    ])
    const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS) as Array<{ delta: string }>
    expect(args.map((e) => e.delta)).toEqual(["{}", "{}"])
  })

  test("interleaved text then tool: open message is flushed before the tool call", async () => {
    const events = await collect([
      { type: "token", data: "thinking" },
      { type: "tool_call", data: { id: "run-x", name: "noop", input: {} } },
      { type: "done", data: {} },
    ])
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("unknown non-token chunks flush an open text message before being ignored", async () => {
    const events = await collect([
      { type: "token", data: "hi" },
      { type: "plan_update", data: {} },
      { type: "token", data: "again" },
      { type: "done", data: {} },
    ])
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("repeated calls to the same tool get distinct toolCallIds from their upstream ids", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-1", name: "t", input: {} } },
      { type: "tool_call", data: { id: "run-2", name: "t", input: {} } },
      { type: "done", data: {} },
    ])
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START)
    expect(starts.map((e) => (e as { toolCallId: string }).toolCallId)).toEqual(["run-1", "run-2"])
  })

  test("missing-id tool results reuse pending fallback toolCallIds by tool name in FIFO order", async () => {
    const events = await collect([
      { type: "tool_call", data: { name: "greet", input: {} } },
      { type: "tool_call", data: { name: "greet", input: { again: true } } },
      { type: "tool_result", data: { name: "greet", output: "hi" } },
      { type: "tool_result", data: { name: "greet", output: "again" } },
      { type: "done", data: {} },
    ])
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START) as Array<{ toolCallId: string }>
    const results = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT) as Array<{
      toolCallId: string
      messageId: string
    }>
    expect(starts.map((e) => e.toolCallId)).toEqual(["tc-1", "tc-2"])
    expect(results.map((e) => e.toolCallId)).toEqual(["tc-1", "tc-2"])
    expect(results.map((e) => e.messageId)).toEqual(["tr-1", "tr-2"])
  })

  test("interrupt: emits RUN_FINISHED with an interrupt outcome and stops", async () => {
    const events = await collect([
      { type: "token", data: "hi" },
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "done", data: {} }, // must be ignored after interrupt
    ])
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      outcome: { type: "interrupt", interrupts: [{ id: "perm-1", reason: "command", metadata: { interruptId: "perm-1", kind: "command" } }] },
    })
    // exactly one RUN_FINISHED (done after interrupt was ignored)
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1)
  })

  test("consecutive interrupts are accumulated in order before done", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "interrupt", data: { interruptId: "perm-2", kind: "tool" } },
      { type: "done", data: { ignored: true } },
    ])

    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toEqual([
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "perm-1",
              reason: "command",
              metadata: { interruptId: "perm-1", kind: "command" },
            },
            {
              id: "perm-2",
              reason: "tool",
              metadata: { interruptId: "perm-2", kind: "tool" },
            },
          ],
        },
      },
    ])
  })

  test("natural completion emits accumulated interrupts", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1" } },
      { type: "interrupt", data: { interruptId: "perm-2" } },
    ])

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "perm-1" }, { id: "perm-2" }],
      },
    })
  })

  test("a nonterminal chunk after interrupts emits the interrupt outcome and stops", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1" } },
      { type: "token", data: "must not be emitted" },
      { type: "done" },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({
      outcome: { type: "interrupt", interrupts: [{ id: "perm-1" }] },
    })
  })

  test("an interrupt without a non-empty interruptId terminates with RUN_ERROR", async () => {
    const events = await collect([
      { type: "token", data: "waiting" },
      { type: "interrupt", data: { interruptId: "", kind: "command" } },
      { type: "done" },
    ])

    expect(events.at(-2)).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" })
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "Malformed Dawn interrupt: missing interruptId",
    })
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1)
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(0)
  })

  test("done data is preserved as the successful RUN_FINISHED result", async () => {
    const result = { error: "application value", answer: 42 }
    const events = await collect([{ type: "done", data: result }])

    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      result,
      outcome: { type: "success" },
    })
  })

  test("done without defined data omits the successful result", async () => {
    const events = await collect([{ type: "done" }])
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      { type: EventType.RUN_FINISHED, threadId: "th-1", runId: "rn-1", outcome: { type: "success" } },
    ])
  })

  test("stream that ends without a done chunk still flushes and finishes success", async () => {
    const events = await collect([{ type: "token", data: "x" }])
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("tool_result with a missing upstream id still emits a result with a synthesized toolCallId", async () => {
    const events = await collect([
      { type: "tool_result", data: { name: "greet", output: "hi" } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as {
      toolCallId: string
      messageId: string
      content: string
    }
    expect(result.content).toBe("hi")
    expect(result.toolCallId).toBe("tc-1") // fallback id
    expect(result.messageId).toBe("tr-1")
  })

  test("upstream throw is emitted as RUN_ERROR, not thrown to the consumer", async () => {
    async function* boom(): AsyncGenerator<DawnAgentStreamChunk> {
      yield { type: "token", data: "hi" }
      throw new Error("kaboom")
    }
    const out = []
    for await (const ev of toAguiEvents(boom(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "kaboom" })
    // the open text message was flushed before the error
    expect(out.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(true)
  })
})
