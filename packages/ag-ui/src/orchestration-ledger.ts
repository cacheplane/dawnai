import type { DawnActivityCorrelation, OrchestrationToolName } from "./activities.js"
import type { AguiOutboundEvent } from "./outbound.js"

/**
 * Built-in tools whose generic frames a semantic activity can replace.
 *
 * Typed as a total record over `OrchestrationToolName` so that adding a member
 * to that union (in `activities.ts`) is a compile error here rather than a
 * silent loss of suppression for the new tool.
 */
const ORCHESTRATION_TOOLS: Record<OrchestrationToolName, true> = {
  writeTodos: true,
  task: true,
}
const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(ORCHESTRATION_TOOLS))

/** Bounds on everything the ledger may retain for one run. */
export const MAX_TRACKED_CALLS = 16
export const MAX_DEFERRED_EVENTS = 256
export const MAX_RETAINED_CHARS = 1_048_576

export interface OrchestrationLedger {
  /**
   * `name` is deliberately widened to `string`: it is the tool name as the
   * model reported it, not a value this package produced. Anything outside
   * `OrchestrationToolName` simply fails open to the generic frames.
   */
  onToolCall(
    id: string | undefined,
    name: string,
    frames: readonly AguiOutboundEvent[],
  ): AguiOutboundEvent[]
  onActivity(
    event: AguiOutboundEvent,
    correlation: DawnActivityCorrelation | undefined,
  ): AguiOutboundEvent[]
  /** `name` is widened to `string` for the same reason as `onToolCall`. */
  onToolResult(id: string | undefined, name: string, event: AguiOutboundEvent): AguiOutboundEvent[]
  onPassthrough(event: AguiOutboundEvent): AguiOutboundEvent[]
  settle(interruptToolCallId?: string): AguiOutboundEvent[]
}

/**
 * A held call. Two facts decide its fate, and each has exactly one home:
 * membership in the `unresolved` map says whether it still blocks the ledger,
 * and `frames` says what it will emit when it drains. Discarding frames is
 * therefore an explicit act (empty the array); every other path emits what it
 * still holds, which is what makes the drain fail open by construction.
 */
interface CandidateEntry {
  readonly kind: "candidate"
  readonly id: string
  readonly name: string
  frames: readonly AguiOutboundEvent[]
}

interface PassthroughEntry {
  readonly kind: "passthrough"
  readonly event: AguiOutboundEvent
}

type LedgerEntry = CandidateEntry | PassthroughEntry

/**
 * Shallow size accounting: sum the lengths of the event's own string-valued
 * properties.
 *
 * `Object.values` does invoke top-level own getters — what the shallow walk
 * avoids is recursing into foreign structures, not running accessors. The
 * consequence for callers: an object-valued payload (notably
 * `ACTIVITY_SNAPSHOT.content`) measures as ZERO, so `MAX_RETAINED_CHARS`
 * bounds retained *strings* only and `MAX_DEFERRED_EVENTS` is the real
 * backstop against large object payloads.
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
 *
 * The deferral window is bounded in SIZE but not in TIME: a correlation is
 * expected within the same burst of chunks as the call it belongs to, and a
 * candidate whose correlation never arrives keeps deferring every subsequent
 * event until its own result arrives, a bound trips, or the run settles.
 */
export function createOrchestrationLedger(): OrchestrationLedger {
  const entries: LedgerEntry[] = []
  const unresolved = new Map<string, CandidateEntry>()
  const suppressed = new Map<string, string>()
  let suppressionDisabled = false
  let deferredEvents = 0
  let retainedChars = 0

  function count(events: readonly AguiOutboundEvent[], sign: 1 | -1): void {
    deferredEvents += sign * events.length
    for (const event of events) retainedChars += sign * measureEvent(event)
  }

  /** Start counting these events against the bounds. */
  function hold(events: readonly AguiOutboundEvent[]): void {
    count(events, 1)
  }

  /** Stop counting these events: they are being emitted or discarded. */
  function release(events: readonly AguiOutboundEvent[]): void {
    count(events, -1)
  }

  function isResolved(entry: LedgerEntry): boolean {
    return entry.kind === "passthrough" || !unresolved.has(entry.id)
  }

  /** Emit the resolved prefix of the ledger. */
  function drainHead(): AguiOutboundEvent[] {
    const out: AguiOutboundEvent[] = []
    while (entries.length > 0) {
      const entry = entries[0]
      if (entry === undefined || !isResolved(entry)) break
      entries.shift()
      if (entry.kind === "passthrough") {
        release([entry.event])
        out.push(entry.event)
        continue
      }
      release(entry.frames)
      // Whatever frames survive here are emitted; suppression discards them at
      // the moment it commits, not at drain time.
      out.push(...entry.frames)
      entry.frames = []
    }
    return out
  }

  /** Fail open: nothing stays held, and no new call is considered. */
  function failOpen(options: { readonly forgetSuppressed: boolean }): AguiOutboundEvent[] {
    suppressionDisabled = true
    // Emptying the map resolves every candidate, so one drain empties the
    // list. Never loop on `drainHead` — it makes no progress against an
    // unresolved head, and a hung stream is worse than a duplicate frame.
    unresolved.clear()
    if (options.forgetSuppressed) suppressed.clear()
    return drainHead()
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
      hold([event])
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
      const candidate: CandidateEntry = { kind: "candidate", id, name, frames }
      entries.push(candidate)
      unresolved.set(id, candidate)
      hold(frames)
      if (!overBounds()) return []
      return failOpen({ forgetSuppressed: false })
    },

    onActivity(event, correlation) {
      if (correlation !== undefined) {
        const candidate = unresolved.get(correlation.toolCallId)
        if (candidate !== undefined && candidate.name === correlation.toolName) {
          release(candidate.frames)
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
      // Resolving without touching `frames` is the fallback: they will emit.
      if (candidate !== undefined && candidate.name === name) unresolved.delete(id)
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
          // actionable context. This rests on an external guarantee nothing in
          // this file can check: the langchain agent adapter keys root
          // tool-call events by the model's LOGICAL tool-call id, which a
          // resume replays unchanged. If that keying ever changes, this drop
          // becomes a lost call rather than a deduplicated one.
          release(candidate.frames)
          candidate.frames = []
        }
      }
      // Emptying the map resolves every remaining candidate; see `failOpen`
      // for why this is a single drain and not a loop.
      unresolved.clear()
      const out = drainHead()
      suppressed.clear()
      return out
    },
  }
}
