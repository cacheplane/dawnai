import type { TranscriptMessage } from "./transcript.js"

/**
 * Turn `GET /threads/:id/state` into the message shapes the transcript already
 * renders, so a restored thread and a live one go through one path.
 *
 * THE WIRE SHAPES HERE ARE NOT THE AG-UI ONES. On the live stream, a root tool
 * call's args are announced as a real object from `on_chat_model_end`
 * (`packages/langchain/src/agent-adapter.ts:493`) OR, on the resume-replay
 * path, as the `{input}` shape LangGraph's own `on_tool_start` event carries
 * (`agent-adapter.ts:582`) — either way, `@dawn-ai/ag-ui`'s outbound layer
 * (`packages/ag-ui/src/outbound.ts`'s `stringifyArgs`) is what serializes that
 * to the JSON string the transcript's `ToolCallCard` receives. Tool results go
 * out as a serialized `ToolMessage` envelope the same way. The checkpoint has
 * neither: `tool_calls[].args` is a real object and `ToolMessage.kwargs.content`
 * is the tool's own output string. So this file converts, and `ToolCallCard`'s
 * two unwrapping branches stay untouched for the live path.
 *
 * `ToolMessage.kwargs.status` (LangChain's own success/error flag) is
 * deliberately dropped: the live path carries no error state for a tool
 * result either, so this keeps the two paths at parity rather than inventing
 * a signal the renderer cannot act on.
 *
 * Everything degrades to empty rather than throwing. A thread whose checkpoint
 * this cannot read should show an empty transcript you can talk to, never a
 * blank screen.
 *
 * That degradation has one failure mode worth naming, which is why
 * `rawMessageCount` exists: if the wire shape ever drifts — LangChain renames a
 * class, the serialization gains a wrapper — every branch below misses, this
 * returns no messages, and `AppShell` cannot tell that apart from a thread that
 * has never run. Every conversation would restore blank and nothing would say
 * so. `rawMessageCount` is the raw denominator that makes the difference
 * visible: entries in `values.messages` BEFORE any filtering, so
 * `rawMessageCount > 0` with zero mapped messages is exactly "there was history
 * here and this file could not read it".
 */

/** The checkpointed plan. Structurally `DawnPlanActivityContent["todos"]`. */
export interface HydratedTodo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}

export interface HydratedThread {
  readonly messages: readonly TranscriptMessage[]
  readonly todos: readonly HydratedTodo[]
  /**
   * How many entries `values.messages` held before any filtering — including
   * the ones dropped as unrecognized. Compare it against `messages.length` to
   * tell "this thread never ran" (0) apart from "this thread has history this
   * file could not read" (> 0, with `messages` empty). See the file header.
   */
  readonly rawMessageCount: number
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Flattens LangChain content-block arrays to displayable text, matching
 * `contentText` in `packages/cli/src/lib/runtime/record-episode.ts`. Anthropic
 * models emit array content whenever a turn carries tool calls, so this is the
 * live hazard for `AIMessageChunk`. It is defence-in-depth for `ToolMessage`:
 * Dawn's own tool loop always produces a plain string via `unwrapToolResult`,
 * but a checkpoint from a user's own model/tool wiring should not go blank
 * just because it didn't.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== "object") continue
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text)
  }
  return parts.join(" ")
}

/** The LangChain class name, which is the only discriminator on the wire. */
function envelopeClass(entry: unknown): string | null {
  if (!isRecord(entry)) return null
  const id = entry.id
  if (!Array.isArray(id)) return null
  const last = id.at(-1)
  return typeof last === "string" ? last : null
}

function toToolCalls(
  kwargs: Record<string, unknown>,
): NonNullable<Extract<TranscriptMessage, { role: "assistant" }>["toolCalls"]> {
  const raw = kwargs.tool_calls
  if (!Array.isArray(raw)) return []
  const calls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []
  for (const call of raw) {
    if (!isRecord(call)) continue
    const id = call.id
    const name = call.name
    // A call with no id can never be paired with its result, so it would render
    // as a permanently-running tool. Dropping it is the honest outcome.
    if (typeof id !== "string" || id.length === 0) continue
    if (typeof name !== "string") continue
    calls.push({
      function: { arguments: JSON.stringify(call.args ?? {}), name },
      id,
      type: "function" as const,
    })
  }
  return calls
}

function toTodos(raw: unknown): readonly HydratedTodo[] {
  if (!Array.isArray(raw)) return []
  const todos: HydratedTodo[] = []
  for (const todo of raw) {
    if (!isRecord(todo)) continue
    const { content, status } = todo
    if (typeof content !== "string" || content.trim().length === 0) continue
    if (typeof status !== "string" || !TODO_STATUSES.has(status)) continue
    todos.push({ content, status: status as HydratedTodo["status"] })
  }
  return todos
}

export function hydrateThreadState(state: unknown): HydratedThread {
  if (!isRecord(state)) return { messages: [], rawMessageCount: 0, todos: [] }
  const values = state.values
  if (!isRecord(values)) return { messages: [], rawMessageCount: 0, todos: [] }

  // Seeded per call (not module-level): ids only need to be unique within one
  // hydration. A per-call counter makes them stable across repeat hydrations
  // of the same thread (e.g. Task 3 re-hydrating on every thread switch) —
  // stability across calls is chosen deliberately over global uniqueness,
  // which a module-level counter would give but only by minting a fresh id
  // every time and churning React keys for no reason.
  let mintedIds = 0
  const messageId = (kwargs: Record<string, unknown>): string => {
    const id = kwargs.id
    if (typeof id === "string" && id.length > 0) return id
    mintedIds += 1
    return `hydrated-${mintedIds}`
  }

  const messages: TranscriptMessage[] = []
  const rawMessages = Array.isArray(values.messages) ? values.messages : []
  for (const entry of rawMessages) {
    const className = envelopeClass(entry)
    // `envelopeClass` already returns null for anything that isn't a record,
    // so this `isRecord` re-check is unreachable in practice; it exists only
    // so TS narrows `entry` for the `entry.kwargs` access below.
    if (className === null || !isRecord(entry)) continue
    const kwargs = entry.kwargs
    if (!isRecord(kwargs)) continue

    // `AIMessageChunk`, not `AIMessage`: the runtime streams, so that is the
    // class the checkpoint holds. Matching only `AIMessage` silently hydrates
    // nothing, which is a blank transcript with green tests.
    if (className === "HumanMessage") {
      // Passed through UNTOUCHED: `TranscriptMessage`'s user variant types
      // `content` as `unknown` specifically so multimodal arrays survive, and
      // `userText` in transcript.ts already narrows them. Coercing to a
      // string here would defeat a narrowing the transcript already does.
      messages.push({ content: kwargs.content, id: messageId(kwargs), role: "user" })
    } else if (className === "AIMessage" || className === "AIMessageChunk") {
      messages.push({
        content: contentText(kwargs.content),
        id: messageId(kwargs),
        role: "assistant",
        toolCalls: toToolCalls(kwargs),
      })
    } else if (className === "ToolMessage") {
      const toolCallId = kwargs.tool_call_id
      if (typeof toolCallId !== "string") continue
      messages.push({
        content: contentText(kwargs.content),
        id: messageId(kwargs),
        role: "tool",
        toolCallId,
      })
    }
    // System and developer envelopes are prompt plumbing; `transcript.ts` drops
    // them on the live path too.
  }

  return { messages, rawMessageCount: rawMessages.length, todos: toTodos(values.todos) }
}
