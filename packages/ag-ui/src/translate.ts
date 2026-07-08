import { EventType } from "@ag-ui/core"
import type { AgUiEvent, DawnStreamChunk, TranslatorOptions } from "./types.js"

let counter = 0
/** Deterministic-per-process id (no Math.random/Date — safe for tests). */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}_${counter}`
}

export interface AgUiTranslator {
  /** Emit RUN_STARTED. Call once before feeding chunks. */
  begin(): AgUiEvent[]
  /** Translate one Dawn chunk into zero or more AG-UI events. */
  translate(chunk: DawnStreamChunk): AgUiEvent[]
  /** Emit a terminal RUN_FINISHED if the stream ended without a `done` chunk. */
  end(): AgUiEvent[]
}

export function createAgUiTranslator(options: TranslatorOptions): AgUiTranslator {
  const { threadId, runId } = options
  let activeTextId: string | null = null
  const pendingToolCalls = new Map<string, string[]>()
  let finished = false
  let state: Record<string, unknown> = {}

  function flushText(): AgUiEvent[] {
    if (activeTextId === null) return []
    const id = activeTextId
    activeTextId = null
    return [{ type: EventType.TEXT_MESSAGE_END, messageId: id }]
  }

  function toText(chunk: DawnStreamChunk): AgUiEvent[] {
    const text = typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? "")
    if (text.length === 0) return []
    const out: AgUiEvent[] = []
    if (activeTextId === null) {
      activeTextId = nextId("msg")
      out.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: activeTextId,
        role: "assistant",
      })
    }
    out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: activeTextId, delta: text })
    return out
  }

  function toToolCall(chunk: DawnStreamChunk): AgUiEvent[] {
    const name = chunk.name ?? "tool"
    const toolCallId = nextId("call")
    const queue = pendingToolCalls.get(name) ?? []
    queue.push(toolCallId)
    pendingToolCalls.set(name, queue)
    return [
      ...flushText(),
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name },
      { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(chunk.input ?? {}) },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ]
  }

  function toToolResult(chunk: DawnStreamChunk): AgUiEvent[] {
    const name = chunk.name ?? "tool"
    const queue = pendingToolCalls.get(name) ?? []
    const toolCallId = queue.shift() ?? nextId("call")
    pendingToolCalls.set(name, queue)
    const content =
      typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output ?? null)
    return [
      ...flushText(),
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: nextId("msg"),
        toolCallId,
        content,
        role: "tool",
      },
    ]
  }

  function toDone(chunk: DawnStreamChunk): AgUiEvent[] {
    finished = true
    const out = flushText()
    const output = chunk.output
    if (output && typeof output === "object" && "error" in output) {
      out.push({
        type: EventType.RUN_ERROR,
        message: String((output as { error: unknown }).error),
      })
      return out
    }
    out.push({ type: EventType.RUN_FINISHED, threadId, runId, result: output })
    return out
  }

  return {
    begin() {
      return [{ type: EventType.RUN_STARTED, threadId, runId }]
    },
    translate(chunk) {
      switch (chunk.type) {
        case "token":
        case "chunk":
          return toText(chunk)
        case "tool_call":
          return toToolCall(chunk)
        case "tool_result":
          return toToolResult(chunk)
        case "done":
          return toDone(chunk)
        case "plan_update": {
          const flushed = flushText()
          const data = (chunk.data ?? {}) as Record<string, unknown>
          state = { ...state, ...data }
          return [...flushed, { type: EventType.STATE_SNAPSHOT, snapshot: state }]
        }
        case "interrupt": {
          return [
            ...flushText(),
            { type: EventType.CUSTOM, name: "on_interrupt", value: chunk.data ?? {} },
          ]
        }
        default: {
          const flushed = flushText()
          if (chunk.type.startsWith("subagent.")) {
            return [
              ...flushed,
              { type: EventType.CUSTOM, name: `dawn.${chunk.type}`, value: chunk.data ?? {} },
            ]
          }
          if (chunk.data && typeof chunk.data === "object") {
            state = { ...state, ...(chunk.data as Record<string, unknown>) }
            return [...flushed, { type: EventType.STATE_SNAPSHOT, snapshot: state }]
          }
          return flushed
        }
      }
    },
    end() {
      if (finished) return []
      finished = true
      return [...flushText(), { type: EventType.RUN_FINISHED, threadId, runId }]
    },
  }
}
