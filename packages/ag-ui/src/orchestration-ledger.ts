import type { AguiOutboundEvent } from "./outbound.js"

/** Built-in tools whose generic frames a semantic activity can replace. */
const ORCHESTRATION_TOOL_NAMES = new Set(["writeTodos", "task"])

/** Bounds on everything the ledger may retain for one run. */
export const MAX_TRACKED_CALLS = 16
export const MAX_DEFERRED_EVENTS = 256
export const MAX_RETAINED_CHARS = 1_048_576

export interface OrchestrationCorrelation {
  readonly toolCallId: string
  readonly toolName: string
}

export interface OrchestrationLedger {
  onToolCall(
    id: string | undefined,
    name: string,
    frames: readonly AguiOutboundEvent[],
  ): AguiOutboundEvent[]
  onActivity(
    event: AguiOutboundEvent,
    correlation: OrchestrationCorrelation | undefined,
  ): AguiOutboundEvent[]
  onToolResult(id: string | undefined, name: string, event: AguiOutboundEvent): AguiOutboundEvent[]
  onPassthrough(event: AguiOutboundEvent): AguiOutboundEvent[]
  settle(interruptToolCallId?: string): AguiOutboundEvent[]
}

type CandidateState = "unresolved" | "suppressed" | "fallback"

interface CandidateEntry {
  readonly kind: "candidate"
  readonly id: string
  readonly name: string
  state: CandidateState
  frames: readonly AguiOutboundEvent[]
}

interface PassthroughEntry {
  readonly kind: "passthrough"
  readonly event: AguiOutboundEvent
}

type LedgerEntry = CandidateEntry | PassthroughEntry

/**
 * Shallow size accounting. The adapter constructs every event it hands us, so
 * only its own string fields can grow: no recursive walk of foreign objects is
 * needed (and none is done — a hostile getter must not be able to run here).
 */
function measureEvent(event: AguiOutboundEvent): number {
  let total = 0
  for (const value of Object.values(event as Record<string, unknown>)) {
    if (typeof value === "string") total += value.length
  }
  return total
}

/**
 * Request-local buffer that lets one semantic activity stand in for the
 * generic tool frames of the built-in call that produced it.
 *
 * It fails open in every direction: a call it cannot correlate, a bound it
 * cannot respect, or a terminal boundary it reaches with work outstanding all
 * end with the original frames emitted in source order. The only events it
 * ever discards are the frames and result of a call whose activity has
 * already been emitted — and, at an interrupt, the frames of the call that
 * interrupt belongs to, because the resumed run re-presents that same call
 * under the same logical id.
 */
export function createOrchestrationLedger(): OrchestrationLedger {
  const entries: LedgerEntry[] = []
  const unresolved = new Map<string, CandidateEntry>()
  const suppressed = new Map<string, string>()
  let suppressionDisabled = false
  let deferredEvents = 0
  let retainedChars = 0

  function countHeld(events: readonly AguiOutboundEvent[], sign: 1 | -1): void {
    deferredEvents += sign * events.length
    for (const event of events) retainedChars += sign * measureEvent(event)
  }

  function isResolved(entry: LedgerEntry): boolean {
    return entry.kind === "passthrough" || entry.state !== "unresolved"
  }

  /** Emit the resolved prefix of the ledger. */
  function drainHead(): AguiOutboundEvent[] {
    const out: AguiOutboundEvent[] = []
    while (entries.length > 0) {
      const entry = entries[0]
      if (entry === undefined || !isResolved(entry)) break
      entries.shift()
      if (entry.kind === "passthrough") {
        countHeld([entry.event], -1)
        out.push(entry.event)
        continue
      }
      countHeld(entry.frames, -1)
      if (entry.state === "fallback") out.push(...entry.frames)
      entry.frames = []
    }
    return out
  }

  /** Fail open: nothing stays held, and no new call is considered. */
  function failOpen(options: { readonly forgetSuppressed: boolean }): AguiOutboundEvent[] {
    suppressionDisabled = true
    for (const candidate of unresolved.values()) candidate.state = "fallback"
    unresolved.clear()
    if (options.forgetSuppressed) suppressed.clear()
    const out: AguiOutboundEvent[] = []
    while (entries.length > 0) out.push(...drainHead())
    return out
  }

  function overBounds(): boolean {
    return (
      unresolved.size + suppressed.size > MAX_TRACKED_CALLS ||
      deferredEvents > MAX_DEFERRED_EVENTS ||
      retainedChars > MAX_RETAINED_CHARS
    )
  }

  function route(events: readonly AguiOutboundEvent[]): AguiOutboundEvent[] {
    if (entries.length === 0) return [...events]
    for (const event of events) {
      entries.push({ kind: "passthrough", event })
      countHeld([event], 1)
    }
    const drained = drainHead()
    if (!overBounds()) return drained
    return [...drained, ...failOpen({ forgetSuppressed: false })]
  }

  return {
    onToolCall(id, name, frames) {
      if (id !== undefined && id !== "" && (unresolved.has(id) || suppressed.has(id))) {
        // A colliding id makes every decision about it ambiguous.
        return [...failOpen({ forgetSuppressed: true }), ...route(frames)]
      }
      if (
        suppressionDisabled ||
        id === undefined ||
        id === "" ||
        !ORCHESTRATION_TOOL_NAMES.has(name)
      ) {
        return route(frames)
      }
      const candidate: CandidateEntry = {
        kind: "candidate",
        id,
        name,
        state: "unresolved",
        frames,
      }
      entries.push(candidate)
      unresolved.set(id, candidate)
      countHeld(frames, 1)
      if (!overBounds()) return []
      return failOpen({ forgetSuppressed: false })
    },

    onActivity(event, correlation) {
      if (correlation !== undefined) {
        const candidate = unresolved.get(correlation.toolCallId)
        if (candidate !== undefined && candidate.name === correlation.toolName) {
          candidate.state = "suppressed"
          countHeld(candidate.frames, -1)
          candidate.frames = []
          unresolved.delete(candidate.id)
          suppressed.set(candidate.id, candidate.name)
        }
      }
      return route([event])
    },

    onToolResult(id, name, event) {
      if (id === undefined || id === "") return route([event])
      if (suppressed.get(id) === name) {
        suppressed.delete(id)
        return []
      }
      const candidate = unresolved.get(id)
      if (candidate !== undefined && candidate.name === name) {
        candidate.state = "fallback"
        unresolved.delete(id)
      }
      return route([event])
    },

    onPassthrough(event) {
      return route([event])
    },

    settle(interruptToolCallId) {
      for (const candidate of unresolved.values()) {
        if (candidate.id === interruptToolCallId) {
          // The resumed run re-presents this same call under this same id, so
          // flushing here would leave the client holding a duplicate the
          // resume can never reconcile. The interrupt itself carries the
          // actionable context.
          countHeld(candidate.frames, -1)
          candidate.frames = []
          candidate.state = "suppressed"
          continue
        }
        candidate.state = "fallback"
      }
      unresolved.clear()
      const out: AguiOutboundEvent[] = []
      while (entries.length > 0) out.push(...drainHead())
      suppressed.clear()
      return out
    },
  }
}
