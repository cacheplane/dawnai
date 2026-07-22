import type { DawnResumeRequest } from "@dawn-ai/ag-ui"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

export type PermissionDecision = "once" | "always" | "deny"

export interface PendingInterrupt {
  readonly aliases: readonly string[]
  readonly interruptId: string
  readonly resumeKey: string | null
}

export interface PendingInterruptSnapshot {
  readonly interrupts: readonly PendingInterrupt[]
  readonly malformed: boolean
}

export type ResumeResolution =
  | { readonly ok: true; readonly mode: "turn" }
  | {
      readonly ok: true
      readonly mode: "resume"
      readonly resume: Readonly<Record<string, PermissionDecision>>
    }
  | {
      readonly ok: false
      readonly status: 400 | 409
      readonly code:
        | "interrupt_set_mismatch"
        | "invalid_resume_payload"
        | "malformed_checkpoint"
        | "resume_required"
        | "stale_interrupt"
      readonly message: string
    }

export async function readPendingInterrupts(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<PendingInterruptSnapshot | null> {
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  })
  if (!tuple) return null

  const interrupts: PendingInterrupt[] = []
  let malformed = false
  for (const write of tuple.pendingWrites ?? []) {
    if (!Array.isArray(write) || write[1] !== "__interrupt__") continue
    if (write.length < 3 || !isRecord(write[2])) {
      malformed = true
      continue
    }

    const value = write[2]
    const hasInnerValue = Object.hasOwn(value, "value")
    const innerValue = isRecord(value.value) ? value.value : undefined
    if (hasInnerValue && !innerValue) malformed = true

    const rawInnerId = innerValue?.interruptId
    const innerId = asIdentifier(rawInnerId)
    if (rawInnerId !== undefined && !innerId) malformed = true

    const outerId = asIdentifier(value.id)
    const interruptId = innerId ?? outerId
    if (!interruptId) {
      malformed = true
      continue
    }

    const resumeKey = outerId && RESUME_KEY_PATTERN.test(outerId) ? outerId : null
    if (!resumeKey) malformed = true

    const aliases = innerId && outerId && innerId !== outerId ? [innerId, outerId] : [interruptId]
    interrupts.push({ aliases, interruptId, resumeKey })
  }

  const interruptIds = new Set<string>()
  const resumeKeys = new Set<string>()
  for (const interrupt of interrupts) {
    if (interruptIds.has(interrupt.interruptId)) malformed = true
    interruptIds.add(interrupt.interruptId)
    if (interrupt.resumeKey) {
      if (resumeKeys.has(interrupt.resumeKey)) malformed = true
      resumeKeys.add(interrupt.resumeKey)
    }
  }

  return { interrupts, malformed }
}

export function resolveAgUiResume(
  resume: readonly DawnResumeRequest[] | undefined,
  snapshot: PendingInterruptSnapshot,
): ResumeResolution {
  const pendingById = new Map(snapshot.interrupts.map((entry) => [entry.interruptId, entry]))
  const resumeKeys = snapshot.interrupts.map((entry) => entry.resumeKey)
  if (
    snapshot.malformed ||
    pendingById.size !== snapshot.interrupts.length ||
    resumeKeys.some((key) => key === null) ||
    new Set(resumeKeys).size !== resumeKeys.length
  ) {
    return resumeError(
      409,
      "malformed_checkpoint",
      "Pending checkpoint interrupts cannot be addressed safely",
    )
  }

  const pending = snapshot.interrupts
  if (!resume || resume.length === 0) {
    if (pending.length === 0) return { ok: true, mode: "turn" }
    return resumeError(409, "resume_required", "Pending interrupts require resume entries")
  }

  if (pending.length === 0) {
    return resumeError(409, "stale_interrupt", "No pending interrupts match the resume entries")
  }

  const resumeIds = new Set(resume.map((entry) => entry.interruptId))
  if (
    resumeIds.size !== resume.length ||
    resume.length !== pending.length ||
    resume.some((entry) => !pendingById.has(entry.interruptId))
  ) {
    return resumeError(
      409,
      "interrupt_set_mismatch",
      "Resume entries must exactly match pending interrupts",
    )
  }

  const resumeMap: Record<string, PermissionDecision> = {}
  for (const entry of resume) {
    const decision = entry.status === "cancelled" ? "deny" : entry.payload
    if (!isPermissionDecision(decision)) {
      return resumeError(
        400,
        "invalid_resume_payload",
        "Resolved resume entries require a once, always, or deny payload",
      )
    }

    const pendingEntry = pendingById.get(entry.interruptId)
    if (!pendingEntry) {
      return resumeError(
        409,
        "interrupt_set_mismatch",
        "Resume entries must exactly match pending interrupts",
      )
    }
    if (!pendingEntry.resumeKey) {
      return resumeError(
        409,
        "malformed_checkpoint",
        "Pending checkpoint interrupts cannot be addressed safely",
      )
    }
    resumeMap[pendingEntry.resumeKey] = decision
  }

  return { ok: true, mode: "resume", resume: resumeMap }
}

const RESUME_KEY_PATTERN = /^[0-9a-f]{32}$/

function asIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === "once" || value === "always" || value === "deny"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resumeError(
  status: 400 | 409,
  code: Extract<ResumeResolution, { ok: false }>["code"],
  message: string,
): ResumeResolution {
  return { ok: false, status, code, message }
}
