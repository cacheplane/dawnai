import type { StreamChunk } from "@dawn-ai/cli/runtime"

export interface ObservedToolCall {
  readonly name: string
  readonly args: unknown
  readonly id?: string
}

export interface ObservedToolResult {
  readonly name: string
  /** LangChain ToolMessage status, when present. */
  readonly status?: "error" | "success"
  /** The tool result content (string when the tool returned text/JSON). */
  readonly content: unknown
  /** True when the tool reported an error (status === "error"). */
  readonly isError: boolean
}

/** Extract tool results from final conversation messages.
 *
 * Handles two shapes:
 * - Serialized LangChain format: `{ lc:1, type:"constructor", id:[...,"ToolMessage"], kwargs:{name,status,content} }`
 * - Live LangChain instance format: `{ type:"tool", name, status, content, ... }`
 */
export function deriveToolResults(
  messages: ReadonlyArray<Record<string, unknown>>,
): ObservedToolResult[] {
  const results: ObservedToolResult[] = []
  for (const m of messages) {
    // Serialized format: id is the class-path array, name/status/content are in kwargs.
    const id = m.id as unknown
    const isSerializedToolMessage = Array.isArray(id) && id[id.length - 1] === "ToolMessage"
    // Live LangChain instance format: type property is "tool" on the live object.
    const isLiveToolMessage = m.type === "tool"

    if (isSerializedToolMessage) {
      const kwargs = (m.kwargs ?? {}) as { name?: unknown; status?: unknown; content?: unknown }
      const status =
        kwargs.status === "error" || kwargs.status === "success" ? kwargs.status : undefined
      results.push({
        name: typeof kwargs.name === "string" ? kwargs.name : "",
        content: kwargs.content,
        isError: status === "error",
        ...(status ? { status } : {}),
      })
    } else if (isLiveToolMessage) {
      const status =
        m.status === "error" || m.status === "success"
          ? (m.status as "error" | "success")
          : undefined
      results.push({
        name: typeof m.name === "string" ? m.name : "",
        content: m.content,
        isError: status === "error",
        ...(status ? { status } : {}),
      })
    }
  }
  return results
}

export interface InterruptInfo {
  readonly interruptId: string
  readonly kind: string
  readonly detail?: Record<string, unknown>
}

export interface Todo {
  readonly content: string
  readonly status: string
}

export interface SubagentToolCall {
  readonly name: string
  readonly args: unknown
}

export interface SubagentRun {
  readonly callId: string
  readonly name: string
  readonly toolCalls: ReadonlyArray<SubagentToolCall>
  readonly finalMessage?: string
  readonly error?: string
}

export interface SubagentEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

export interface AgentRunResult {
  readonly finalMessage: string
  readonly messages: ReadonlyArray<Record<string, unknown>>
  readonly toolCalls: ReadonlyArray<ObservedToolCall>
  readonly toolResults: ReadonlyArray<ObservedToolResult>
  readonly tokens: ReadonlyArray<string>
  readonly state: Record<string, unknown>
  readonly threadId: string
  readonly interrupts: ReadonlyArray<InterruptInfo>
  readonly planUpdates: ReadonlyArray<{ todos: ReadonlyArray<Todo> }>
  readonly todos: ReadonlyArray<Todo>
  readonly subagents: ReadonlyArray<SubagentRun>
  readonly subagentEvents: ReadonlyArray<SubagentEvent>
  readonly systemPrompt: string
}

function finalMessageFrom(state: Record<string, unknown>): string {
  const messages = Array.isArray(state.messages)
    ? (state.messages as Record<string, unknown>[])
    : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      id?: string[]
      kwargs?: { content?: unknown }
      content?: unknown
      type?: string
    }
    const isAi = (Array.isArray(m.id) && m.id[2] === "AIMessage") || m.type === "ai"
    if (!isAi) continue
    const content = m.kwargs?.content ?? m.content
    if (typeof content === "string") return content
  }
  return ""
}

function normalizeToolArgs(raw: unknown): unknown {
  // LangChain/LangGraph may deliver tool input as:
  //   - an already-parsed object → use as-is
  //   - a JSON string → parse
  //   - { input: '<json-string>' } single-key envelope (LangGraph tool wrapper) → unwrap + parse
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    "input" in raw &&
    Object.keys(raw as object).length === 1 &&
    typeof (raw as { input: unknown }).input === "string"
  ) {
    try {
      return JSON.parse((raw as { input: string }).input)
    } catch {
      return raw
    }
  }
  return raw
}

export async function collectRunResult(
  stream: AsyncIterable<StreamChunk>,
  threadId: string,
): Promise<AgentRunResult> {
  const tokens: string[] = []
  const toolCalls: ObservedToolCall[] = []
  let state: Record<string, unknown> = {}

  const interrupts: InterruptInfo[] = []
  const planUpdates: { todos: ReadonlyArray<Todo> }[] = []
  let todos: ReadonlyArray<Todo> = []
  const subagentEvents: SubagentEvent[] = []

  // In-progress subagent runs keyed by call_id
  const subagentMap = new Map<
    string,
    {
      callId: string
      name: string
      toolCalls: SubagentToolCall[]
      finalMessage?: string
      error?: string
    }
  >()
  const finishedSubagents: SubagentRun[] = []

  function subagentFor(callId: string): {
    callId: string
    name: string
    toolCalls: SubagentToolCall[]
    finalMessage?: string
    error?: string
  } {
    let run = subagentMap.get(callId)
    if (!run) {
      run = { callId, name: callId, toolCalls: [] }
      subagentMap.set(callId, run)
    }
    return run
  }

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "chunk":
        if (typeof chunk.data === "string") tokens.push(chunk.data)
        break
      case "tool_call": {
        // chunk.name and chunk.input are typed on the tool_call variant
        const c = chunk as unknown as { name: string; input?: unknown; id?: string }
        const entry: ObservedToolCall =
          c.id !== undefined
            ? { name: c.name, args: normalizeToolArgs(c.input), id: c.id }
            : { name: c.name, args: normalizeToolArgs(c.input) }
        toolCalls.push(entry)
        break
      }
      case "done": {
        const out = (chunk as unknown as { output?: unknown }).output
        if (out && typeof out === "object") state = out as Record<string, unknown>
        break
      }
      case "interrupt": {
        const d = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
        const info: InterruptInfo =
          d.detail !== undefined
            ? {
                interruptId: String(d.interruptId ?? ""),
                kind: String(d.kind ?? ""),
                detail: d.detail as Record<string, unknown>,
              }
            : { interruptId: String(d.interruptId ?? ""), kind: String(d.kind ?? "") }
        interrupts.push(info)
        break
      }
      case "plan_update": {
        const d = (chunk as unknown as { data?: { todos?: unknown[] } }).data ?? {}
        const rawTodos = Array.isArray(d.todos) ? d.todos : []
        const update = { todos: rawTodos as ReadonlyArray<Todo> }
        planUpdates.push(update)
        todos = update.todos
        break
      }
      case "subagent.start": {
        const d = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
        const callId = String(d.call_id ?? "")
        const run = subagentFor(callId)
        run.name = String(d.subagent ?? callId)
        subagentEvents.push({ type: chunk.type, data: d })
        break
      }
      case "subagent.tool_call": {
        const d = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
        const callId = String(d.call_id ?? "")
        const run = subagentFor(callId)
        run.toolCalls.push({ name: String(d.tool ?? ""), args: normalizeToolArgs(d.input) })
        subagentEvents.push({ type: chunk.type, data: d })
        break
      }
      case "subagent.end": {
        const d = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
        const callId = String(d.call_id ?? "")
        const run = subagentFor(callId)
        if (d.final_message !== undefined) {
          run.finalMessage = String(d.final_message)
        }
        if (d.error !== undefined) {
          run.error = String(d.error)
        }
        subagentMap.delete(callId)
        const finished: SubagentRun =
          run.finalMessage !== undefined && run.error !== undefined
            ? {
                callId: run.callId,
                name: run.name,
                toolCalls: run.toolCalls,
                finalMessage: run.finalMessage,
                error: run.error,
              }
            : run.finalMessage !== undefined
              ? {
                  callId: run.callId,
                  name: run.name,
                  toolCalls: run.toolCalls,
                  finalMessage: run.finalMessage,
                }
              : run.error !== undefined
                ? { callId: run.callId, name: run.name, toolCalls: run.toolCalls, error: run.error }
                : { callId: run.callId, name: run.name, toolCalls: run.toolCalls }
        finishedSubagents.push(finished)
        subagentEvents.push({ type: chunk.type, data: d })
        break
      }
      default:
        break
    }
  }

  const finalMessages = Array.isArray(state.messages)
    ? (state.messages as Record<string, unknown>[])
    : []
  return {
    threadId,
    tokens,
    toolCalls,
    toolResults: deriveToolResults(finalMessages),
    state,
    messages: finalMessages,
    finalMessage: finalMessageFrom(state),
    interrupts,
    planUpdates,
    todos,
    subagents: finishedSubagents,
    subagentEvents,
    systemPrompt: "",
  }
}
