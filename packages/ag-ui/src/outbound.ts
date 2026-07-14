import type {
  Interrupt,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { createDefaultIdFactory, type IdFactory } from "./ids.js"
import { toAguiInterrupt } from "./interrupts.js"
import {
  asToolCallData,
  asToolResultData,
  type DawnAgentStreamChunk,
  type RunContext,
} from "./types.js"

/** The AG-UI events this mapper can emit. */
export type AguiOutboundEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent

export interface ToAguiOptions {
  readonly idFactory?: IdFactory
}

function stringifyArgs(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "{}"
  } catch {
    return "{}"
  }
}

function stringifyContent(output: unknown): string {
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    const serialized = JSON.stringify(output)
    return typeof serialized === "string" ? serialized : String(output)
  } catch {
    return String(output)
  }
}

/**
 * Map a Dawn agent stream (`token | tool_call | tool_result | interrupt |
 * done`) to an AG-UI event stream. Stateful: it frames assistant text and tool
 * calls that Dawn emits implicitly, and it never throws into the consumer - an
 * upstream error becomes a `RUN_ERROR` event and a clean return.
 */
export async function* toAguiEvents(
  chunks: AsyncIterable<DawnAgentStreamChunk>,
  ctx: RunContext,
  options: ToAguiOptions = {},
): AsyncGenerator<AguiOutboundEvent> {
  const nextId = options.idFactory ?? createDefaultIdFactory()
  let openMessageId: string | null = null
  const pendingFallbackToolCallIds = new Map<string, string[]>()
  const pendingInterrupts: Interrupt[] = []

  function* flushText(): Generator<TextMessageEndEvent> {
    if (openMessageId !== null) {
      yield { type: EventType.TEXT_MESSAGE_END, messageId: openMessageId }
      openMessageId = null
    }
  }

  yield { type: EventType.RUN_STARTED, threadId: ctx.threadId, runId: ctx.runId }

  try {
    for await (const chunk of chunks) {
      if (chunk.type !== "interrupt" && pendingInterrupts.length > 0) {
        yield {
          type: EventType.RUN_FINISHED,
          threadId: ctx.threadId,
          runId: ctx.runId,
          outcome: { type: "interrupt", interrupts: pendingInterrupts },
        }
        return
      }

      switch (chunk.type) {
        case "token": {
          const delta = typeof chunk.data === "string" ? chunk.data : ""
          if (delta.length === 0) break
          if (openMessageId === null) {
            openMessageId = nextId("message")
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: openMessageId,
              role: "assistant",
            }
          }
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: openMessageId, delta }
          break
        }
        case "tool_call": {
          yield* flushText()
          const tc = asToolCallData(chunk.data)
          if (!tc) break
          const toolCallId = tc.id ?? nextId("toolCall")
          if (tc.id === undefined) {
            const pending = pendingFallbackToolCallIds.get(tc.name)
            if (pending) {
              pending.push(toolCallId)
            } else {
              pendingFallbackToolCallIds.set(tc.name, [toolCallId])
            }
          }
          yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: tc.name }
          yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: stringifyArgs(tc.input) }
          yield { type: EventType.TOOL_CALL_END, toolCallId }
          break
        }
        case "tool_result": {
          yield* flushText()
          const tr = asToolResultData(chunk.data)
          if (!tr) break
          const pending = tr.id === undefined ? pendingFallbackToolCallIds.get(tr.name) : undefined
          const toolCallId = tr.id ?? pending?.shift() ?? nextId("toolCall")
          if (pending?.length === 0) pendingFallbackToolCallIds.delete(tr.name)
          const messageId = nextId("toolResult")
          yield {
            type: EventType.TOOL_CALL_RESULT,
            messageId,
            toolCallId,
            content: stringifyContent(tr.output),
          }
          break
        }
        case "interrupt": {
          yield* flushText()
          const interrupt = toAguiInterrupt(chunk.data)
          if (interrupt === null) {
            yield {
              type: EventType.RUN_ERROR,
              message: "Malformed Dawn interrupt: missing interruptId",
            }
            return
          }
          pendingInterrupts.push(interrupt)
          break
        }
        case "done": {
          yield* flushText()
          yield {
            type: EventType.RUN_FINISHED,
            threadId: ctx.threadId,
            runId: ctx.runId,
            ...(Object.hasOwn(chunk, "data") && chunk.data !== undefined
              ? { result: chunk.data }
              : {}),
            outcome: { type: "success" },
          }
          return
        }
        default:
          yield* flushText()
          // Unknown/capability chunk types (e.g. plan_update) have no v1
          // AG-UI mapping - ignore them.
          break
      }
    }
    // Stream ended without an explicit done/interrupt: flush and finish.
    yield* flushText()
    if (pendingInterrupts.length > 0) {
      yield {
        type: EventType.RUN_FINISHED,
        threadId: ctx.threadId,
        runId: ctx.runId,
        outcome: { type: "interrupt", interrupts: pendingInterrupts },
      }
      return
    }
    yield {
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: { type: "success" },
    }
  } catch (err) {
    yield* flushText()
    yield { type: EventType.RUN_ERROR, message: err instanceof Error ? err.message : String(err) }
  }
}
