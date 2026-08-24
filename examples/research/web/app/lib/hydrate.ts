import type { TranscriptMessage } from "./transcript.js"

/**
 * Turn `GET /threads/:id/state` into the message shapes the transcript already
 * renders, so a restored thread and a live one go through one path.
 *
 * THE WIRE SHAPES HERE ARE NOT THE AG-UI ONES. The stream delivers tool args as
 * a JSON string nested under `input` and tool results as a serialized
 * `ToolMessage` envelope — both introduced by the adapter on the way out
 * (`packages/langchain/src/agent-adapter.ts` → `packages/ag-ui/src/outbound.ts`).
 * The checkpoint has neither: `tool_calls[].args` is a real object and
 * `ToolMessage.kwargs.content` is the tool's own output string. So this file
 * converts, and `ToolCallCard`'s two unwrapping branches stay untouched for the
 * live path.
 *
 * Everything degrades to empty rather than throwing. A thread whose checkpoint
 * this cannot read should show an empty transcript you can talk to, never a
 * blank screen.
 */

/** The checkpointed plan. Structurally `DawnPlanActivityContent["todos"]`. */
export interface HydratedTodo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}

export interface HydratedThread {
  readonly messages: readonly TranscriptMessage[]
  readonly todos: readonly HydratedTodo[]
}

const EMPTY: HydratedThread = { messages: [], todos: [] }
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  if (!isRecord(state)) return EMPTY
  const values = state.values
  if (!isRecord(values)) return EMPTY

  // Seeded per call (not module-level): ids only need to be unique within one
  // hydration, and a per-call counter makes them deterministic across repeat
  // hydrations of the same thread (e.g. Task 3 re-hydrating on every thread
  // switch). A module-level counter would mint a fresh id each time and churn
  // React keys for no reason.
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
    if (className === null || !isRecord(entry)) continue
    const kwargs = entry.kwargs
    if (!isRecord(kwargs)) continue
    const content = typeof kwargs.content === "string" ? kwargs.content : ""

    // `AIMessageChunk`, not `AIMessage`: the runtime streams, so that is the
    // class the checkpoint holds. Matching only `AIMessage` silently hydrates
    // nothing, which is a blank transcript with green tests.
    if (className === "HumanMessage") {
      messages.push({ content, id: messageId(kwargs), role: "user" })
    } else if (className === "AIMessage" || className === "AIMessageChunk") {
      messages.push({
        content,
        id: messageId(kwargs),
        role: "assistant",
        toolCalls: toToolCalls(kwargs),
      })
    } else if (className === "ToolMessage") {
      const toolCallId = kwargs.tool_call_id
      if (typeof toolCallId !== "string") continue
      messages.push({ content, id: messageId(kwargs), role: "tool", toolCallId })
    }
    // System and developer envelopes are prompt plumbing; `transcript.ts` drops
    // them on the live path too.
  }

  return { messages, todos: toTodos(values.todos) }
}
