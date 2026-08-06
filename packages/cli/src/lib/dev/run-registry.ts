/**
 * Process-local registry of in-flight runs, keyed by thread id.
 *
 * Dawn has no `run_id`. A thread runs at most one run at a time — enforced by
 * `begin` refusing an already-running thread — so the thread id *is* the run
 * identity. Without that guarantee a second run would overwrite the first's
 * entry and orphan its controller, producing exactly the unkillable run this
 * registry exists to prevent.
 *
 * Deliberately in-memory and handler-scoped rather than persisted on
 * `ThreadsStore`: an AbortController is not serializable, and gating on the
 * persisted `status` column would let a process that crashes mid-run brick the
 * thread forever (the stale "busy" would reject every later run). A fresh
 * process starts with an empty registry, so a crash self-heals.
 *
 * Single-replica only; see docs/superpowers/specs/2026-08-06-ap-run-cancellation.md.
 */

export interface RunHandle {
  /** Composed shutdown-or-cancel signal. Hand this to the route, not the raw shutdown signal. */
  readonly signal: AbortSignal
  /** True only when cancelled through the registry — server shutdown does not set this. */
  readonly cancelled: boolean
  /** Idempotent, and safe to call from a `finally` block. */
  release(): void
}

export interface RunRegistry {
  /** Claims the thread's run slot. Returns undefined when a run is already in flight. */
  begin(threadId: string, shutdownSignal: AbortSignal): RunHandle | undefined
  /** Aborts the in-flight run. Returns false when there is nothing to cancel. */
  cancel(threadId: string, reason?: string): boolean
  has(threadId: string): boolean
}

export function createRunRegistry(): RunRegistry {
  const entries = new Map<string, AbortController>()

  return {
    begin(threadId, shutdownSignal) {
      // Synchronous check-and-set: two concurrent requests that both reach
      // this point can never both win, because nothing awaits in between.
      if (entries.has(threadId)) return undefined
      const controller = new AbortController()
      entries.set(threadId, controller)
      let released = false
      return {
        signal: AbortSignal.any([shutdownSignal, controller.signal]),
        get cancelled() {
          return controller.signal.aborted
        },
        release() {
          if (released) return
          released = true
          // Identity guard: never clear a slot a later run has claimed.
          if (entries.get(threadId) === controller) entries.delete(threadId)
        },
      }
    },
    cancel(threadId, reason = "Run cancelled") {
      const controller = entries.get(threadId)
      if (!controller) return false
      if (!controller.signal.aborted) controller.abort(new Error(reason))
      return true
    },
    has(threadId) {
      return entries.has(threadId)
    },
  }
}
