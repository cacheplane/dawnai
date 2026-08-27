/**
 * Defensive parsing of the Agent Protocol attach stream's `state` payload,
 * plus the client-side inverse of the server's `toSseEvent` (see
 * `packages/cli/src/lib/runtime/stream-types.ts`).
 *
 * This module is deliberately structural: it never imports the server's
 * internal types, and every field is read with a runtime guard and a safe
 * default so a malformed or version-skewed payload degrades gracefully
 * instead of crashing the CLI.
 */

/** One parked interrupt on the durable path. */
export interface AttachInterrupt {
  readonly interruptId: string
  readonly resumeKey: string
  readonly value: unknown
}

/** The reducer-shaped view of a `state` frame, regardless of durable/live path. */
export interface AttachState {
  readonly live: boolean
  readonly status: string
  readonly anchor: string | null
  readonly runStartedAt: string | null
  readonly resume: boolean
  readonly values: unknown
  readonly input: unknown
  readonly turn: unknown[] | null
  readonly truncated: boolean
  readonly interrupts: readonly AttachInterrupt[]
}

/** A projected turn-stream event, ready to hand to the renderer. */
export interface ProjectedChunk {
  readonly event: string
  readonly data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = Object.hasOwn(record, key) ? record[key] : undefined
  return typeof value === "string" ? value : null
}

function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = Object.hasOwn(record, key) ? record[key] : undefined
  return typeof value === "boolean" ? value : fallback
}

function parseInterrupt(value: unknown): AttachInterrupt | null {
  if (!isRecord(value)) return null
  const interruptId = readString(value, "interruptId")
  const resumeKey = readString(value, "resumeKey")
  if (interruptId === null || resumeKey === null) return null
  return { interruptId, resumeKey, value: Object.hasOwn(value, "value") ? value.value : undefined }
}

function parseInterrupts(value: unknown): AttachInterrupt[] {
  if (!Array.isArray(value)) return []
  const interrupts: AttachInterrupt[] = []
  for (const item of value) {
    const parsed = parseInterrupt(item)
    if (parsed) interrupts.push(parsed)
  }
  return interrupts
}

/** Parse a `state` frame's payload defensively. Never throws. */
export function parseStateFrame(payload: unknown): AttachState {
  const record = isRecord(payload) ? payload : {}
  const turnValue = Object.hasOwn(record, "turn") ? record.turn : undefined
  return {
    live: readBoolean(record, "live", false),
    status: readString(record, "status") ?? "unknown",
    anchor: readString(record, "anchor"),
    runStartedAt: readString(record, "run_started_at"),
    resume: readBoolean(record, "resume", false),
    values: Object.hasOwn(record, "values") ? record.values : null,
    input: Object.hasOwn(record, "input") ? record.input : null,
    turn: Array.isArray(turnValue) ? turnValue : null,
    truncated: readBoolean(record, "turn_truncated", false),
    interrupts: parseInterrupts(
      Object.hasOwn(record, "interrupts") ? record.interrupts : undefined,
    ),
  }
}

/**
 * The client-side inverse of the server's `toSseEvent`: a chunk whose only
 * non-`type` own key is `data` emits that value unwrapped, and every other
 * chunk emits its remaining own fields as an object. `type` is read with
 * `Object.hasOwn` and the rest built from `Object.entries` so a `__proto__`
 * key present in the wire JSON cannot influence the projection.
 */
export function projectTurnChunk(chunk: unknown): ProjectedChunk {
  if (!isRecord(chunk) || !Object.hasOwn(chunk, "type") || typeof chunk.type !== "string") {
    return { event: "message", data: chunk }
  }
  const event = chunk.type
  const restEntries = Object.entries(chunk).filter(([key]) => key !== "type")
  if (restEntries.length === 1 && restEntries[0]?.[0] === "data") {
    return { event, data: restEntries[0][1] }
  }
  return { event, data: Object.fromEntries(restEntries) }
}
