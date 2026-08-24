import type { StreamChunk } from "../runtime/stream-types.js"

const DEFAULT_DIGEST_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_SUBSCRIBER_MAX_BYTES = 1 * 1024 * 1024
const DEFAULT_SUBSCRIBER_MAX_FRAMES = 1024
const DEFAULT_MAX_VIEWERS = 16

export interface LiveTurnOpenInput {
  readonly threadId: string
  readonly anchorCheckpointId: string | null
  readonly runStartedAt: string
  readonly resume: boolean
  readonly input: unknown
}

/** The producer's handle to the turn it opened. Inert once the entry is closed or replaced. */
export interface LiveTurnProducer {
  publish(chunk: StreamChunk): void
  /** Fan the terminal `done` chunk to subscribers, mark the entry terminal, then evict it. */
  close(terminal: StreamChunk): void
}

/** A point-in-time copy of a live turn, handed to one attacher. */
export interface LiveTurnAttachment {
  readonly anchorCheckpointId: string | null
  readonly runStartedAt: string
  readonly resume: boolean
  readonly input: unknown
  /** Coalesced digest so far, or null when the digest overflowed (turn_truncated). */
  readonly turn: readonly StreamChunk[] | null
  readonly truncated: boolean
  /** The stored terminal chunk if the turn already ended in the copy window, else null. */
  readonly terminal: StreamChunk | null
  /** Pull frames published after the snapshot; resolves to null after the terminal is delivered. */
  next(): Promise<StreamChunk | null>
  /** Called by the attacher's finally so the hub can drop its subscriber slot. */
  detach(reason?: "overflow" | "capacity"): void
  /** Set by the hub when the subscriber queue overflowed; the attacher emits `event: detached`. */
  readonly overflowed: () => "overflow" | "capacity" | undefined
}

export interface LiveTurnHub {
  /** Force-close any existing entry for the thread, then install a fresh one. Returns the producer handle. */
  open(input: LiveTurnOpenInput): LiveTurnProducer
  /** A point-in-time attachment, or undefined when no live turn exists for the thread. */
  attach(threadId: string, opts?: { readonly maxViewers?: number }): LiveTurnAttachment | undefined
  /** Fan a terminal frame to every subscriber of every entry and clear the map (handler.close()). */
  closeAll(): void
}

export interface LiveTurnHubOptions {
  /** Serialized-bytes cap for the shared digest; overflow drops the digest whole. Default 2 MiB. */
  readonly digestMaxBytes?: number
  /** Per-subscriber queue caps; overflow drops that subscriber only. Default 1 MiB / 1024 frames. */
  readonly subscriberMaxBytes?: number
  readonly subscriberMaxFrames?: number
}

interface Subscriber {
  readonly queue: StreamChunk[]
  queueBytes: number
  wake: (() => void) | null
  dropped: "overflow" | "capacity" | undefined
  terminalDelivered: boolean
}

interface LiveTurn {
  readonly threadId: string
  readonly anchorCheckpointId: string | null
  readonly runStartedAt: string
  readonly resume: boolean
  readonly input: unknown
  digest: StreamChunk[] | null
  digestBytes: number
  truncated: boolean
  terminal: StreamChunk | null
  ended: boolean
  readonly subscribers: Set<Subscriber>
}

const frameBytes = (chunk: StreamChunk): number => JSON.stringify(chunk).length

function subagentCallId(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "subagent.message") return undefined
  const data = (chunk as { readonly data?: unknown }).data
  const callId =
    data && typeof data === "object" ? (data as { callId?: unknown }).callId : undefined
  return typeof callId === "string" ? callId : undefined
}

function mergeSubagent(existing: StreamChunk, incoming: StreamChunk): StreamChunk {
  const ex = (existing as { data?: { text?: unknown; callId?: unknown } }).data ?? {}
  const inc = (incoming as { data?: { text?: unknown } }).data ?? {}
  return {
    type: "subagent.message",
    data: { ...ex, text: `${String(ex.text ?? "")}${String(inc.text ?? "")}` },
  } as StreamChunk
}

/** Coalesce `chunk` into the last digest entry when both are plain `chunk` frames. */
function appendCoalesced(digest: StreamChunk[], chunk: StreamChunk): { added: number } {
  const last = digest[digest.length - 1]
  if (chunk.type === "chunk" && last && last.type === "chunk") {
    const before = frameBytes(last)
    const merged: StreamChunk = {
      type: "chunk",
      data: `${String((last as { data?: unknown }).data ?? "")}${String((chunk as { data?: unknown }).data ?? "")}`,
    }
    digest[digest.length - 1] = merged
    return { added: frameBytes(merged) - before }
  }
  // subagent.message per-callId coalescing.
  const callId = subagentCallId(chunk)
  if (callId !== undefined) {
    const idx = digest.findIndex((e) => subagentCallId(e) === callId)
    const existing = idx >= 0 ? digest[idx] : undefined
    if (idx >= 0 && existing) {
      const before = frameBytes(existing)
      const merged = mergeSubagent(existing, chunk)
      digest[idx] = merged
      return { added: frameBytes(merged) - before }
    }
  }
  digest.push(chunk)
  return { added: frameBytes(chunk) }
}

export function createLiveTurnHub(options?: LiveTurnHubOptions): LiveTurnHub {
  const digestMaxBytes = options?.digestMaxBytes ?? DEFAULT_DIGEST_MAX_BYTES
  const subMaxBytes = options?.subscriberMaxBytes ?? DEFAULT_SUBSCRIBER_MAX_BYTES
  const subMaxFrames = options?.subscriberMaxFrames ?? DEFAULT_SUBSCRIBER_MAX_FRAMES
  const entries = new Map<string, LiveTurn>()

  const deliver = (turn: LiveTurn, chunk: StreamChunk): void => {
    for (const sub of turn.subscribers) {
      if (sub.dropped) continue
      const size = frameBytes(chunk)
      if (sub.queue.length + 1 > subMaxFrames || sub.queueBytes + size > subMaxBytes) {
        sub.dropped = "overflow"
        sub.queue.length = 0
        sub.queueBytes = 0
        sub.wake?.()
        continue
      }
      sub.queue.push(chunk)
      sub.queueBytes += size
      sub.wake?.()
    }
  }

  const forceClose = (turn: LiveTurn): void => {
    if (!turn.ended) {
      turn.ended = true
      turn.terminal = turn.terminal ?? { type: "done", output: null }
      deliver(turn, turn.terminal)
    }
    for (const sub of turn.subscribers) sub.wake?.()
  }

  return {
    open(input) {
      const existing = entries.get(input.threadId)
      if (existing) {
        forceClose(existing)
        if (entries.get(input.threadId) === existing) entries.delete(input.threadId)
      }
      const turn: LiveTurn = {
        threadId: input.threadId,
        anchorCheckpointId: input.anchorCheckpointId,
        runStartedAt: input.runStartedAt,
        resume: input.resume,
        input: input.input,
        digest: [],
        digestBytes: 0,
        truncated: false,
        terminal: null,
        ended: false,
        subscribers: new Set(),
      }
      entries.set(input.threadId, turn)
      return {
        publish(chunk) {
          if (entries.get(input.threadId) !== turn || turn.ended) return
          if (turn.digest !== null) {
            const { added } = appendCoalesced(turn.digest, chunk)
            turn.digestBytes += added
            if (turn.digestBytes > digestMaxBytes) {
              turn.digest = null
              turn.truncated = true
            }
          }
          deliver(turn, chunk)
        },
        close(terminal) {
          if (entries.get(input.threadId) !== turn || turn.ended) return
          turn.ended = true
          turn.terminal = terminal
          deliver(turn, terminal)
          if (entries.get(input.threadId) === turn) entries.delete(input.threadId)
        },
      }
    },

    attach(threadId, opts) {
      const turn = entries.get(threadId)
      if (!turn) return undefined
      const maxViewers = opts?.maxViewers ?? DEFAULT_MAX_VIEWERS
      if (turn.subscribers.size >= maxViewers) {
        return {
          anchorCheckpointId: turn.anchorCheckpointId,
          runStartedAt: turn.runStartedAt,
          resume: turn.resume,
          input: turn.input,
          turn: null,
          truncated: turn.truncated,
          terminal: null,
          async next() {
            return null
          },
          detach() {},
          overflowed: () => "capacity",
        }
      }
      // One synchronous section: copy digest + terminal, register subscriber.
      const snapshotTurn = turn.digest === null ? null : [...turn.digest]
      const snapshotTerminal = turn.terminal
      const sub: Subscriber = {
        queue: [],
        queueBytes: 0,
        wake: null,
        dropped: undefined,
        terminalDelivered: false,
      }
      turn.subscribers.add(sub)
      return {
        anchorCheckpointId: turn.anchorCheckpointId,
        runStartedAt: turn.runStartedAt,
        resume: turn.resume,
        input: turn.input,
        turn: snapshotTurn,
        truncated: turn.truncated,
        terminal: snapshotTerminal,
        async next() {
          for (;;) {
            if (sub.dropped) return null
            const chunk = sub.queue.shift()
            if (chunk) {
              sub.queueBytes -= frameBytes(chunk)
              if (chunk.type === "done") sub.terminalDelivered = true
              return chunk
            }
            // Nothing queued. Terminate once the turn has ended and this subscriber
            // will never receive (or has already received) the terminal frame:
            // - attached before the terminal was stored: wait for it to drain via the queue
            //   (terminalDelivered flips true above when it does).
            // - attached after the terminal was already stored (snapshotTerminal !== null):
            //   the terminal was never queued for us (it predates our subscription), so
            //   there is nothing more to drain.
            if (turn.ended && (sub.terminalDelivered || snapshotTerminal !== null)) return null
            await new Promise<void>((resolve) => {
              sub.wake = resolve
            })
            sub.wake = null
          }
        },
        detach() {
          turn.subscribers.delete(sub)
        },
        overflowed: () => sub.dropped,
      }
    },

    closeAll() {
      for (const turn of entries.values()) forceClose(turn)
      entries.clear()
    },
  }
}
