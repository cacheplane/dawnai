export type StreamChunk =
  | { readonly type: "chunk"; readonly data: unknown }
  | { readonly type: "tool_call"; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly name: string; readonly output: unknown }
  | { readonly type: "done"; readonly output: unknown }
  // Capability-contributed event types (e.g. plan_update from the planning capability).
  // The langchain layer widened AgentStreamChunk["type"] to allow arbitrary strings;
  // pass them through verbatim with their literal type as the SSE event name.
  | { readonly type: string; readonly data: unknown }

export function toNdjsonLine(chunk: StreamChunk): string {
  return JSON.stringify(chunk)
}

export function toSseEvent(chunk: StreamChunk): string {
  return `event: ${chunk.type}\ndata: ${JSON.stringify(omitType(chunk))}\n\n`
}

function omitType(chunk: StreamChunk): Record<string, unknown> {
  const { type: _, ...rest } = chunk
  return rest
}
