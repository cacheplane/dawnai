import type { StreamChunk } from "@dawn-ai/cli/runtime"

export interface ObservedToolCall {
  readonly name: string
  readonly args: unknown
  readonly id?: string
}

export interface AgentRunResult {
  readonly finalMessage: string
  readonly messages: ReadonlyArray<Record<string, unknown>>
  readonly toolCalls: ReadonlyArray<ObservedToolCall>
  readonly tokens: ReadonlyArray<string>
  readonly state: Record<string, unknown>
  readonly threadId: string
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
      default:
        break
    }
  }

  return {
    threadId,
    tokens,
    toolCalls,
    state,
    messages: Array.isArray(state.messages) ? (state.messages as Record<string, unknown>[]) : [],
    finalMessage: finalMessageFrom(state),
  }
}
