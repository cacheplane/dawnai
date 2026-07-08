import type { RunAgentInput } from "@ag-ui/core"

export type ResumeDecision = "once" | "always" | "deny"

export interface MappedRunInput {
  readonly dawnInput: { readonly messages: ReadonlyArray<{ role: string; content: string }> }
  readonly resumeDecision?: ResumeDecision
  readonly interruptId?: string
}

function coerceDecision(value: unknown): ResumeDecision | undefined {
  if (value === "once" || value === "always" || value === "deny") return value
  return undefined
}

/**
 * Map an AG-UI RunAgentInput onto a Dawn run. HITL resume rides on
 * forwardedProps.command.resume (the @ag-ui/langgraph convention); otherwise
 * the newest user message becomes the turn's input (Dawn keeps history in its
 * checkpoint keyed by threadId).
 */
export function mapRunInput(input: RunAgentInput): MappedRunInput {
  const resume = (input.forwardedProps as { command?: { resume?: unknown } } | undefined)?.command
    ?.resume
  if (resume !== undefined) {
    if (typeof resume === "string") {
      const decision = coerceDecision(resume)
      return decision
        ? { dawnInput: { messages: [] }, resumeDecision: decision }
        : { dawnInput: { messages: [] } }
    }
    if (resume && typeof resume === "object") {
      const r = resume as { decision?: unknown; interruptId?: unknown }
      const decision = coerceDecision(r.decision)
      const interruptId = typeof r.interruptId === "string" ? r.interruptId : undefined
      return {
        dawnInput: { messages: [] },
        ...(decision ? { resumeDecision: decision } : {}),
        ...(interruptId ? { interruptId } : {}),
      }
    }
  }

  const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
  const content =
    lastUser && typeof lastUser.content === "string" ? lastUser.content : lastUser ? "" : undefined
  return {
    dawnInput: { messages: content === undefined ? [] : [{ role: "user", content }] },
  }
}
