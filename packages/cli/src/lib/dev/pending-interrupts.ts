import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"

export type PermissionDecision = "once" | "always" | "deny"

export interface DawnResumeEntry {
  readonly interruptId: string
  readonly status: "resolved" | "cancelled"
  readonly payload?: unknown
}

export interface PendingInterrupt {
  readonly aliases: readonly string[]
  readonly interruptId: string
  readonly resumeKey: string | null
  /**
   * The `__interrupt__` write's own `value` payload, verbatim — for a
   * permission prompt, `{ interruptId, type, kind, detail }`. This is the
   * renderable content a client that reloaded needs to put the prompt back on
   * screen from durable state alone; parsing it for ids and then discarding it
   * is what made a parked prompt undisplayable after a reconnect. `undefined`
   * when the write carries no `value` key at all.
   *
   * Not narrowed to a record: a payload that is not one (`null`, a string, an
   * array) is still listed here verbatim, and only sets the snapshot's
   * `malformed` flag. Since a malformed set is still listed and `malformed` is
   * not on the wire, such a payload does reach the client — dropping it would
   * be a wire change, so it is pinned by test rather than left incidental.
   *
   * Optional because this interface is public API (`@dawn-ai/cli/runtime`): a
   * required field would stop external code from constructing the literal. The
   * parse always sets the key, so `Object.hasOwn(i, "value")` is always true.
   */
  readonly value?: unknown
}

export interface PendingInterruptSnapshot {
  readonly interrupts: readonly PendingInterrupt[]
  readonly malformed: boolean
}

export interface PendingResumeClaims {
  tryClaim(threadId: string): (() => void) | undefined
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

/**
 * Parse the `__interrupt__` pending writes out of a checkpoint tuple the
 * caller already holds.
 *
 * Split out of `readPendingInterrupts` so a caller that needs the tuple for
 * something else too — channel values *and* pending interrupts — pays for one
 * `getTuple` instead of two. Pure: no I/O, no checkpointer.
 */
export function parsePendingInterrupts(tuple: CheckpointTuple): PendingInterruptSnapshot {
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
    // Kept verbatim for GET /threads/:id/pending_interrupts: this is the
    // permission prompt a reconnecting client re-renders.
    const payload = value.value
    const innerValue = isRecord(payload) ? payload : undefined
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
    interrupts.push({ aliases, interruptId, resumeKey, value: payload })
  }

  const interruptIds = new Set<string>()
  const resumeKeys = new Set<string>()
  const aliases = new Set<string>()
  for (const interrupt of interrupts) {
    if (interruptIds.has(interrupt.interruptId)) malformed = true
    interruptIds.add(interrupt.interruptId)
    if (interrupt.resumeKey) {
      if (resumeKeys.has(interrupt.resumeKey)) malformed = true
      resumeKeys.add(interrupt.resumeKey)
    }
    for (const alias of interrupt.aliases) {
      if (aliases.has(alias)) malformed = true
      aliases.add(alias)
    }
  }

  return { interrupts, malformed }
}

export async function readPendingInterrupts(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<PendingInterruptSnapshot | null> {
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  })
  if (!tuple) return null
  return parsePendingInterrupts(tuple)
}

export function createPendingResumeClaims(): PendingResumeClaims {
  const claimedThreadIds = new Set<string>()
  return {
    tryClaim(threadId) {
      if (claimedThreadIds.has(threadId)) return undefined
      claimedThreadIds.add(threadId)
      let released = false
      return () => {
        if (released) return
        released = true
        claimedThreadIds.delete(threadId)
      }
    },
  }
}

export function resolvePendingResume(
  resume: readonly DawnResumeEntry[] | undefined,
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
