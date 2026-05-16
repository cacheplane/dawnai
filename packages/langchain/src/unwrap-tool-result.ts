/**
 * Result of unwrapping a tool's return value.
 *
 * - `content` is the string that becomes the ToolMessage content the agent sees.
 *   Built rules:
 *     • If the tool returned a wrapped `{result}` shape and `result` is a string,
 *       `content` is that string verbatim (no JSON quoting).
 *     • If `result` is any other value, `content` is `JSON.stringify(result)`.
 *     • If the tool returned a plain value (no wrapper), `content` is
 *       `JSON.stringify(value)`.
 *
 * - `stateUpdates` is the partial state-channel update object to apply, or
 *   undefined if the tool didn't request any state mutation.
 */
export interface UnwrappedToolResult {
  readonly content: string
  readonly stateUpdates: Record<string, unknown> | undefined
}

/**
 * Detect whether a tool's return value uses the Dawn wrapper shape
 * `{result, state?}` and split it into the agent-facing `content` and the
 * optional `stateUpdates` for the route's state channels.
 *
 * The wrapper shape is recognized strictly: the value must be a non-null
 * plain object whose own enumerable keys are exactly `result`, or exactly
 * `result` and `state`. Any other shape (including objects with extra keys,
 * missing `result`, or arrays) falls through to plain-return handling.
 *
 * Edge case: if a tool returns `{result: undefined}`, the wrapper IS detected
 * structurally but the resulting `content` would be the string "undefined"
 * (JSON.stringify(undefined) === undefined). We treat this as plain — capability
 * authors should never return undefined as the agent-facing result.
 */
export function unwrapToolResult(value: unknown): UnwrappedToolResult {
  if (!isWrapperShape(value)) {
    return { content: JSON.stringify(value), stateUpdates: undefined }
  }

  const { result, state } = value as { result: unknown; state?: unknown }

  // Defensive: if result is undefined, fall back to plain (the wrapper shape
  // was structurally present but the content would be meaningless).
  if (result === undefined) {
    return { content: JSON.stringify(value), stateUpdates: undefined }
  }

  const content = typeof result === "string" ? result : JSON.stringify(result)
  const stateUpdates =
    state !== undefined && state !== null && typeof state === "object"
      ? (state as Record<string, unknown>)
      : undefined

  return { content, stateUpdates }
}

function isWrapperShape(
  value: unknown,
): value is { result: unknown; state?: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (keys.length === 1) return keys[0] === "result"
  if (keys.length === 2) return keys.includes("result") && keys.includes("state")
  return false
}
