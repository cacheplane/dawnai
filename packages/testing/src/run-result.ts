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

export interface CommandInterruptDetail {
  readonly command: string
  readonly suggestedPattern: string
}

export interface PathInterruptDetail {
  readonly path: string
  readonly operation: "readFile" | "writeFile" | "listDir"
  readonly suggestedPattern: string
}

export interface ToolInterruptDetail {
  readonly toolName: string
  readonly argsPreview: string
  readonly suggestedPattern: string
}

export interface MemoryInterruptDetail {
  readonly namespace: string
  readonly identity: string
  readonly oldId: string
  readonly oldContent: string
  readonly newContent: string
  readonly suggestedPattern: string
}

export interface SubagentInterruptDetail {
  readonly parentRouteId: string
  readonly subagentName: string
  readonly subagentRouteId: string
  readonly inputPreview: string
  readonly reason?: string
  readonly suggestedPattern: string
}

interface InterruptInfoBase {
  readonly interruptId: string
  readonly callId?: string
}

export type InterruptInfo = InterruptInfoBase &
  (
    | { readonly kind: "command"; readonly detail: CommandInterruptDetail }
    | { readonly kind: "path"; readonly detail: PathInterruptDetail }
    | { readonly kind: "tool"; readonly detail: ToolInterruptDetail }
    | { readonly kind: "memory"; readonly detail: MemoryInterruptDetail }
    | { readonly kind: "subagent"; readonly detail: SubagentInterruptDetail }
  )

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasStringFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, string> {
  return isRecord(value) && fields.every((field) => typeof value[field] === "string")
}

function isCommandInterruptDetail(value: unknown): value is CommandInterruptDetail {
  return hasStringFields(value, ["command", "suggestedPattern"])
}

function isPathInterruptDetail(value: unknown): value is PathInterruptDetail {
  return (
    hasStringFields(value, ["path", "operation", "suggestedPattern"]) &&
    (value.operation === "readFile" ||
      value.operation === "writeFile" ||
      value.operation === "listDir")
  )
}

function isToolInterruptDetail(value: unknown): value is ToolInterruptDetail {
  return hasStringFields(value, ["toolName", "argsPreview", "suggestedPattern"])
}

function isMemoryInterruptDetail(value: unknown): value is MemoryInterruptDetail {
  return hasStringFields(value, [
    "namespace",
    "identity",
    "oldId",
    "oldContent",
    "newContent",
    "suggestedPattern",
  ])
}

function isSubagentInterruptDetail(value: unknown): value is SubagentInterruptDetail {
  return (
    hasStringFields(value, [
      "parentRouteId",
      "subagentName",
      "subagentRouteId",
      "inputPreview",
      "suggestedPattern",
    ]) &&
    (!Object.hasOwn(value, "reason") || typeof value.reason === "string")
  )
}

function parseInterruptInfo(value: unknown): InterruptInfo {
  if (!isRecord(value)) throw new Error("Malformed interrupt envelope")
  if (typeof value.interruptId !== "string" || value.interruptId === "") {
    throw new Error("Malformed interrupt envelope: interruptId must be a non-empty string")
  }
  if (value.callId !== undefined && (typeof value.callId !== "string" || value.callId === "")) {
    throw new Error("Malformed interrupt envelope: callId must be a non-empty string")
  }

  const base: InterruptInfoBase = {
    interruptId: value.interruptId,
    ...(value.callId !== undefined ? { callId: value.callId } : {}),
  }

  switch (value.kind) {
    case "command":
      if (!isCommandInterruptDetail(value.detail)) {
        throw new Error('Malformed "command" interrupt detail')
      }
      return { ...base, kind: value.kind, detail: value.detail }
    case "path":
      if (!isPathInterruptDetail(value.detail)) {
        throw new Error('Malformed "path" interrupt detail')
      }
      return { ...base, kind: value.kind, detail: value.detail }
    case "tool":
      if (!isToolInterruptDetail(value.detail)) {
        throw new Error('Malformed "tool" interrupt detail')
      }
      return { ...base, kind: value.kind, detail: value.detail }
    case "memory":
      if (!isMemoryInterruptDetail(value.detail)) {
        throw new Error('Malformed "memory" interrupt detail')
      }
      return { ...base, kind: value.kind, detail: value.detail }
    case "subagent":
      if (!isSubagentInterruptDetail(value.detail)) {
        throw new Error('Malformed "subagent" interrupt detail')
      }
      return { ...base, kind: value.kind, detail: value.detail }
    default:
      throw new Error(`Unsupported interrupt kind "${String(value.kind)}"`)
  }
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
    if (chunk.type.startsWith("subagent.")) {
      const data = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
      subagentEvents.push({ type: chunk.type, data })
    }

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
        const data = (chunk as unknown as { data?: unknown }).data
        interrupts.push(parseInterruptInfo(data))
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
        break
      }
      case "subagent.tool_call": {
        const d = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
        const callId = String(d.call_id ?? "")
        const run = subagentFor(callId)
        run.toolCalls.push({ name: String(d.tool ?? ""), args: normalizeToolArgs(d.input) })
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
