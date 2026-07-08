import type { Interrupt } from "@ag-ui/core"

/**
 * The interrupt envelope Dawn's capabilities emit inside an `interrupt` chunk
 * (`entry.value` from LangGraph). Always carries `interruptId`; other keys are
 * capability-specific and preserved verbatim.
 */
export interface DawnInterruptEnvelope {
  readonly interruptId: string
  readonly kind?: string
  readonly message?: string
  readonly toolCallId?: string
  readonly [key: string]: unknown
}

/** A resume instruction addressed to one open Dawn interrupt. */
export interface DawnResumeRequest {
  readonly interruptId: string
  readonly status: "resolved" | "cancelled"
  readonly payload?: unknown
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Map a Dawn interrupt envelope to an AG-UI `Interrupt`. The full envelope is
 * preserved under `metadata` so no capability-specific information is lost on
 * the way to the client.
 */
export function toAguiInterrupt(data: unknown): Interrupt {
  const env = isPlainRecord(data) && typeof data.interruptId === "string" ? data : {}
  const interruptId = typeof env.interruptId === "string" ? env.interruptId : ""
  const reason = typeof env.kind === "string" ? env.kind : "interrupt"
  return {
    id: interruptId,
    reason,
    ...(typeof env.message === "string" ? { message: env.message } : {}),
    ...(typeof env.toolCallId === "string" ? { toolCallId: env.toolCallId } : {}),
    metadata: env,
  }
}

/**
 * Map AG-UI resume entries to Dawn resume requests. Vocabulary-agnostic: the
 * consumer decides how a `{ status, payload }` becomes Dawn's per-interrupt
 * decision. We only guarantee `interruptId` survives.
 */
export function fromAguiResume(
  resume: ReadonlyArray<{
    interruptId: string
    status: "resolved" | "cancelled"
    payload?: unknown
  }>,
): DawnResumeRequest[] {
  return resume.map((entry) => ({
    interruptId: entry.interruptId,
    status: entry.status,
    ...(Object.hasOwn(entry, "payload") ? { payload: entry.payload } : {}),
  }))
}
