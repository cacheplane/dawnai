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

/**
 * Format a chunk as an SSE event line. The `event:` line is the chunk's
 * `type`, and `data:` is the JSON-serialized payload.
 *
 * The payload shape depends on the chunk:
 *  - Chunks that carry their payload in a single `data` field (the built-in
 *    `chunk` event and any capability-contributed event) emit that `data`
 *    value directly, NOT wrapped in another `{ data: ... }` object.
 *  - Chunks with named fields (`tool_call`, `tool_result`, `done`) emit the
 *    remaining named fields as an object.
 *
 * Without this distinction, `{ type: "plan_update", data: { todos: [...] } }`
 * would serialize to `data: { "data": { "todos": [...] } }` — one level too
 * deep. The double-wrap was a real bug observed in live smoke testing.
 */
export function toSseEvent(chunk: StreamChunk): string {
  const payload = isDataOnlyChunk(chunk) ? chunk.data : omitType(chunk)
  return `event: ${chunk.type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function isDataOnlyChunk(
  chunk: StreamChunk,
): chunk is { readonly type: string; readonly data: unknown } {
  // The only built-in shape with a `data` field is the `chunk` event; all
  // capability-contributed types are typed as `{ type: string; data: unknown }`
  // by construction. Discriminate by checking that `data` is the only non-`type`
  // own-enumerable key.
  const keys = Object.keys(chunk).filter((k) => k !== "type")
  return keys.length === 1 && keys[0] === "data"
}

function omitType(chunk: StreamChunk): Record<string, unknown> {
  const { type: _, ...rest } = chunk
  return rest
}
