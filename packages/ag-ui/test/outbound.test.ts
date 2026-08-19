import { ActivitySnapshotEventSchema, EventType, ToolCallResultEventSchema } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { DAWN_PLAN_ACTIVITY_TYPE, DAWN_SUBAGENT_ACTIVITY_TYPE } from "../src/activities.ts"
import { createCounterIdFactory } from "../src/ids.js"
import { toAguiEvents } from "../src/outbound.js"
import { encodeAgUiSse } from "../src/sse.js"
import type { DawnAgentStreamChunk } from "../src/types.js"

const CTX = { threadId: "th-1", runId: "rn-1" }
const CHILD = {
  call_id: "call-1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
} as const

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

  test.each([
    ["function", () => undefined],
    ["symbol", Symbol("result")],
  ])("tool result %s output remains string content through AG-UI SSE", async (_, output) => {
    const expected = String(output)
    const events = await collect([
      { type: "tool_result", data: { id: "run-special", name: "special", output } },
      { type: "done" },
    ])
    const result = ToolCallResultEventSchema.parse(
      events.find((event) => event.type === EventType.TOOL_CALL_RESULT),
    )

    expect(typeof result.content).toBe("string")
    expect(result.content).toBe(expected)

    const dataLine = encodeAgUiSse(result)
      .split("\n")
      .find((line) => line.startsWith("data: "))
    if (dataLine === undefined) throw new Error("SSE frame is missing a data line")
    expect(JSON.parse(dataLine.slice("data: ".length))).toMatchObject({ content: expected })
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
    const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS) as Array<{
      delta: string
    }>
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
      { type: "capability.unknown", data: { arbitrary: true } },
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

  test("plan activity does not flush an open text message", async () => {
    const todos = [{ content: "Search the corpus", status: "in_progress" }] as const
    const events = await collect([
      { type: "token", data: "before" },
      { type: "plan_update", data: { todos } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    const activity = events.find((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    expect(ActivitySnapshotEventSchema.parse(activity)).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "dawn:plan:rn-1",
      activityType: DAWN_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos },
    })
    expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toMatchObject([
      { messageId: "msg-1", delta: "before" },
      { messageId: "msg-1", delta: "after" },
    ])
  })

  test("malformed recognized plan emits no activity, text flush, or run error", async () => {
    const events = await collect([
      { type: "token", data: "before" },
      { type: "plan_update", data: { todos: [{ content: "invalid", status: "unknown" }] } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)).toEqual([])
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toEqual([])
  })

  test("subagent activity exposes only allowlisted progress and never child content", async () => {
    const childTodos = [{ content: "Read the source", status: "in_progress" }] as const
    const events = await collect([
      { type: "token", data: "root-before" },
      { type: "subagent.start", data: CHILD },
      { type: "subagent.plan_update", data: { ...CHILD, todos: childTodos } },
      {
        type: "subagent.tool_call",
        data: {
          ...CHILD,
          id: "child-tool-1",
          tool: "readDoc",
          input: "secret-input",
        },
      },
      {
        type: "subagent.tool_result",
        data: { ...CHILD, id: "child-tool-1", output: "secret-output" },
      },
      { type: "subagent.message", data: { ...CHILD, content: "secret-child-prose" } },
      { type: "subagent.end", data: { ...CHILD, final_message: "secret-final" } },
      { type: "token", data: "root-after" },
      { type: "done" },
    ])

    const activities = events
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => ActivitySnapshotEventSchema.parse(event))
    expect(activities).toEqual([
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "dawn:subagent:call-1",
        activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          tools: [],
          totalToolCount: 0,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "dawn:subagent:call-1",
        activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          todos: childTodos,
          tools: [],
          totalToolCount: 0,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "dawn:subagent:call-1",
        activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          todos: childTodos,
          tools: [{ name: "readDoc", status: "running" }],
          totalToolCount: 1,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "dawn:subagent:call-1",
        activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "running",
          todos: childTodos,
          tools: [{ name: "readDoc", status: "completed" }],
          totalToolCount: 1,
        },
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "dawn:subagent:call-1",
        activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
        replace: true,
        content: {
          name: "researcher",
          depth: 1,
          status: "completed",
          todos: childTodos,
          tools: [{ name: "readDoc", status: "completed" }],
          totalToolCount: 1,
        },
      },
    ])

    const serializedContent = JSON.stringify(activities.map((activity) => activity.content))
    for (const secret of [
      "secret-input",
      "secret-output",
      "secret-child-prose",
      "secret-final",
      CHILD.call_id,
      CHILD.route_id,
      "child-tool-1",
    ]) {
      expect(serializedContent).not.toContain(secret)
    }
    const rootText = events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join("")
    expect(rootText).toBe("root-beforeroot-after")
    expect(rootText).not.toMatch(/secret-input|secret-output|secret-child-prose|secret-final/)
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
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START) as Array<{
      toolCallId: string
    }>
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
      outcome: {
        type: "interrupt",
        interrupts: [
          { id: "perm-1", reason: "command", metadata: { interruptId: "perm-1", kind: "command" } },
        ],
      },
    })
    // exactly one RUN_FINISHED (done after interrupt was ignored)
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1)
  })

  test("delegation approval interrupt before subagent start emits no activity", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "delegate-1", kind: "tool" } },
      { type: "subagent.start", data: CHILD },
      { type: "done" },
    ])

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "delegate-1",
              reason: "tool",
              metadata: { interruptId: "delegate-1", kind: "tool" },
            },
          ],
        },
      },
    ])
  })

  test("child-owned interrupt preserves one running activity and suppresses later child events", async () => {
    const events = await collect([
      { type: "subagent.start", data: CHILD },
      { type: "interrupt", data: { interruptId: "child-approval", kind: "command" } },
      {
        type: "subagent.plan_update",
        data: { ...CHILD, todos: [{ content: "private-late-plan", status: "pending" }] },
      },
      {
        type: "subagent.tool_call",
        data: { ...CHILD, id: "late-tool", tool: "lateTool", input: "private-late-input" },
      },
      { type: "subagent.end", data: { ...CHILD, final_message: "private-late-final" } },
      { type: "done" },
    ])

    const activities = events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    expect(activities).toHaveLength(1)
    expect(ActivitySnapshotEventSchema.parse(activities[0])).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "dawn:subagent:call-1",
      activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [],
        totalToolCount: 0,
      },
    })
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "child-approval",
            reason: "command",
            metadata: { interruptId: "child-approval", kind: "command" },
          },
        ],
      },
    })
    expect(JSON.stringify(events)).not.toMatch(
      /private-late-plan|private-late-input|private-late-final/,
    )
  })

  test("resume replaces a subagent activity with fresh request-local state", async () => {
    const firstRequest = await collect([
      { type: "subagent.start", data: CHILD },
      {
        type: "subagent.plan_update",
        data: { ...CHILD, todos: [{ content: "Old plan", status: "in_progress" }] },
      },
      {
        type: "subagent.tool_call",
        data: { ...CHILD, id: "old-tool", tool: "oldTool", input: "old-input" },
      },
      { type: "interrupt", data: { interruptId: "parked-child", kind: "command" } },
      { type: "done" },
    ])
    const secondRequest = await collect([
      { type: "subagent.start", data: CHILD },
      { type: "subagent.end", data: { ...CHILD, final_message: "private-final" } },
      { type: "done" },
    ])

    const firstActivities = firstRequest
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => ActivitySnapshotEventSchema.parse(event))
    const secondActivities = secondRequest
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => ActivitySnapshotEventSchema.parse(event))
    expect(firstActivities).toHaveLength(3)
    expect(secondActivities).toHaveLength(2)
    expect([...firstActivities, ...secondActivities].map((event) => event.messageId)).toEqual([
      "dawn:subagent:call-1",
      "dawn:subagent:call-1",
      "dawn:subagent:call-1",
      "dawn:subagent:call-1",
      "dawn:subagent:call-1",
    ])
    expect(secondActivities.map((event) => event.content)).toEqual([
      {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [],
        totalToolCount: 0,
      },
      {
        name: "researcher",
        depth: 1,
        status: "completed",
        tools: [],
        totalToolCount: 0,
      },
    ])
    expect(JSON.stringify(secondActivities.map((event) => event.content))).not.toMatch(
      /Old plan|oldTool|old-input|private-final/,
    )
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

  test("collects interleaved interrupts without leaking post-interrupt events or success", async () => {
    const events = await collect([
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "subagent.start", data: { callId: "sibling-call" } },
      { type: "token", data: "must not be emitted" },
      { type: "interrupt", data: { interruptId: "perm-2", kind: "tool" } },
      { type: "done", data: { mustNotBecomeResult: true } },
    ])

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
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
    expect(events.at(-1)).not.toHaveProperty("result")
    expect(events.at(-1)).not.toMatchObject({ outcome: { type: "success" } })
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

  test("nonterminal chunks after an interrupt are suppressed until the outcome", async () => {
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
      {
        type: EventType.RUN_FINISHED,
        threadId: "th-1",
        runId: "rn-1",
        outcome: { type: "success" },
      },
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

describe("orchestration suppression", () => {
  const TODOS = [{ content: "Search the corpus", status: "in_progress" }] as const
  const ORCHESTRATION_CHILD = {
    call_id: "call_task_0_2",
    subagent: "researcher",
    route_id: "/researcher",
    depth: 1,
  } as const

  test("a correlated writeTodos call presents only as a plan activity", async () => {
    const events = await collect([
      {
        type: "tool_call",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", input: { todos: TODOS } },
      },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
  })

  test("a correlated task call presents only as a subagent activity", async () => {
    const events = await collect([
      {
        type: "tool_call",
        data: { id: "call_task_0_2", name: "task", input: { subagent: "researcher" } },
      },
      { type: "subagent.start", data: ORCHESTRATION_CHILD },
      { type: "subagent.end", data: ORCHESTRATION_CHILD },
      { type: "tool_result", data: { id: "call_task_0_2", name: "task", output: "done" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
  })

  test("an uncorrelated writeTodos call keeps its generic frames in source order", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
  })

  test("ordinary tools are never suppressed and keep their order around a suppressed one", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "tool_call",
        data: { id: "call_searchCorpus_0_2", name: "searchCorpus", input: { q: "x" } },
      },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      {
        type: "tool_result",
        data: { id: "call_searchCorpus_0_2", name: "searchCorpus", output: "hit" },
      },
      {
        type: "tool_result",
        data: { id: "call_writeTodos_0_1", name: "writeTodos", output: "ok" },
      },
      { type: "done", data: {} },
    ])

    // The ordinary call's frames reached the mapper before the plan activity,
    // so they stay ahead of it: suppression never reorders the stream.
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
    const start = events.find((event) => event.type === EventType.TOOL_CALL_START)
    expect(start).toMatchObject({ toolCallName: "searchCorpus" })
  })

  test("text framing survives a deferred orchestration call", async () => {
    const events = await collect([
      { type: "token", data: "before" },
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      { type: "plan_update", data: { todos: TODOS, tool_call_id: "call_writeTodos_0_1" } },
      { type: "token", data: "after" },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an ID-less writeTodos call is never suppressed", async () => {
    const events = await collect([
      { type: "tool_call", data: { name: "writeTodos", input: {} } },
      { type: "plan_update", data: { todos: TODOS } },
      { type: "tool_result", data: { name: "writeTodos", output: "ok" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
  })

  test("an incomplete stream flushes held frames before RUN_FINISHED", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("an interrupt drops the frames of the call it belongs to", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "tool", toolCallId: "call_task_0_2" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })
  })

  test("an interrupt drops the frames of the call it belongs to via the envelope's callId", async () => {
    // Dawn's real interrupt envelopes (permission-gate.ts, agent-adapter.ts's
    // projectInterruptValue) carry `callId`, not `toolCallId` — this proves
    // the mapper bridges that vocabulary end to end into the ledger.
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "subagent", callId: "call_task_0_2" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })
  })

  test("an interrupt flushes an unrelated held call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_writeTodos_0_1", name: "writeTodos", input: {} } },
      {
        type: "interrupt",
        data: { interruptId: "int-1", kind: "command", toolCallId: "call_runBash_0_9" },
      },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.find((event) => event.type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: "call_writeTodos_0_1",
    })
  })

  test("an interrupt with no toolCallId flushes every held call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      { type: "interrupt", data: { interruptId: "int-1", kind: "memory" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.find((event) => event.type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: "call_task_0_2",
    })
  })

  test("a malformed interrupt flushes held frames before RUN_ERROR", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } },
      { type: "interrupt", data: { kind: "tool" } },
      { type: "done", data: {} },
    ])

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })

  test("an upstream error flushes held frames before RUN_ERROR", async () => {
    async function* failing(): AsyncGenerator<DawnAgentStreamChunk> {
      yield { type: "tool_call", data: { id: "call_task_0_2", name: "task", input: {} } }
      throw new Error("boom")
    }

    const events = []
    for await (const event of toAguiEvents(failing(), CTX, {
      idFactory: createCounterIdFactory(),
    })) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_ERROR,
    ])
  })
})
