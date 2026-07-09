import { EventType } from "@ag-ui/core"
import {
  RunStartedEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  RunFinishedEventSchema,
} from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { createAgUiTranslator } from "../src/translate.js"
import type { AgUiEvent } from "../src/types.js"

const opts = { threadId: "t1", runId: "r1" }
const types = (evs: AgUiEvent[]) => evs.map((e) => e.type)

describe("translator: lifecycle + text + tools", () => {
  it("begin() emits a valid RUN_STARTED", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.begin()
    expect(types(evs)).toEqual([EventType.RUN_STARTED])
    expect(() => RunStartedEventSchema.parse(evs[0])).not.toThrow()
  })

  it("maps a token run to START/CONTENT+/END and validates each event", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "token", data: "Hello" }),
      ...t.translate({ type: "token", data: " world" }),
      ...t.translate({ type: "done", output: { messages: [] } }),
    ]
    expect(types(evs)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    TextMessageStartEventSchema.parse(evs[0])
    TextMessageContentEventSchema.parse(evs[1])
    TextMessageContentEventSchema.parse(evs[2])
    TextMessageEndEventSchema.parse(evs[3])
    RunFinishedEventSchema.parse(evs[4])
    const mid = (evs[0] as { messageId: string }).messageId
    expect((evs[1] as { messageId: string }).messageId).toBe(mid)
    expect((evs[3] as { messageId: string }).messageId).toBe(mid)
  })

  it("skips empty token deltas (translator no-ops rather than emit empty content)", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.translate({ type: "token", data: "" })
    expect(evs).toEqual([])
  })

  it("maps tool_call to START/ARGS/END and pairs tool_result by FIFO", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "tool_call", name: "searchCorpus", input: { query: "x" } }),
      ...t.translate({ type: "tool_result", name: "searchCorpus", output: [{ path: "corpus/a.md" }] }),
    ]
    expect(types(evs)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ])
    ToolCallStartEventSchema.parse(evs[0])
    ToolCallArgsEventSchema.parse(evs[1])
    ToolCallEndEventSchema.parse(evs[2])
    ToolCallResultEventSchema.parse(evs[3])
    const id = (evs[0] as { toolCallId: string }).toolCallId
    expect((evs[1] as { toolCallId: string }).toolCallId).toBe(id)
    expect((evs[3] as { toolCallId: string }).toolCallId).toBe(id)
    expect((evs[1] as { delta: string }).delta).toBe(JSON.stringify({ query: "x" }))
  })

  it("preserves upstream tool invocation ids when present", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "tool_call", id: "run-abc", name: "searchCorpus", input: { query: "x" } }),
      ...t.translate({ type: "tool_result", id: "run-abc", name: "searchCorpus", output: "ok" }),
    ]

    expect((evs[0] as { toolCallId: string }).toolCallId).toBe("run-abc")
    expect((evs[1] as { toolCallId: string }).toolCallId).toBe("run-abc")
    expect((evs[3] as { toolCallId: string }).toolCallId).toBe("run-abc")
  })

  it("flushes an open text message before a tool_call", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "token", data: "thinking" }),
      ...t.translate({ type: "tool_call", name: "readDoc", input: { path: "corpus/a.md" } }),
    ]
    expect(types(evs)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ])
  })

  it("maps a done error to RUN_ERROR", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.translate({ type: "done", output: { error: "boom" } })
    expect(types(evs)).toEqual([EventType.RUN_ERROR])
    expect((evs[0] as { message: string }).message).toBe("boom")
  })
})
