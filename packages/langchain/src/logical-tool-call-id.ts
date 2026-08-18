/**
 * Recover the model/provider tool-call ID (logical identity) from a tool
 * execution's output, per the amended AG-UI orchestration projection design
 * ("Identity model"). Handles the two root output shapes LangGraph's prebuilt
 * ToolNode produces for Dawn tools:
 *
 *  - a ToolMessage (string-returning tools): `output.tool_call_id`
 *  - a Command ({result, state}-returning tools): the last ToolMessage-shaped
 *    entry in `output.update.messages`
 *
 * Returns undefined — never throws — for anything else, including hostile
 * getters. Callers fall back to the execution run ID.
 */
export function readLogicalToolCallId(output: unknown): string | undefined {
  try {
    if (typeof output !== "object" || output === null) return undefined

    const direct = readId(output)
    if (direct !== undefined) return direct

    const update = (output as { update?: unknown }).update
    if (typeof update !== "object" || update === null) return undefined
    const messages = (update as { messages?: unknown }).messages
    if (!Array.isArray(messages)) return undefined
    for (let index = messages.length - 1; index >= 0; index--) {
      const id = readId(messages[index])
      if (id !== undefined) return id
    }
    return undefined
  } catch {
    return undefined
  }
}

function readId(value: unknown): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined
    const id = (value as { tool_call_id?: unknown }).tool_call_id
    return typeof id === "string" && id !== "" ? id : undefined
  } catch {
    return undefined
  }
}
