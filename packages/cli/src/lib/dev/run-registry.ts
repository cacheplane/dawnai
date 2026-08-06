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
 * The shutdown-or-cancel composition is a manual listener rather than
 * `AbortSignal.any`: a composed signal is retained for the lifetime of its
 * *source* signals, and the shutdown signal lives as long as the process, so
 * one `AbortSignal.any` per run leaks without bound across the process's
 * lifetime (measured: ~92 MB retained per 200k runs on Node 24). The manual
 * listener is removed on `release()`, so it does not accumulate.
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
  interface Entry {
    readonly controller: AbortController
    cancel(reason: string): void
  }
  const entries = new Map<string, Entry>()

  return {
    begin(threadId, shutdownSignal) {
      // Synchronous check-and-set: two concurrent requests that both reach
      // this point can never both win, because nothing awaits in between.
      if (entries.has(threadId)) return undefined

      const controller = new AbortController()
      let cancelled = false

      // Deliberately a manual listener rather than AbortSignal.any: a composed
      // signal is retained for the lifetime of its SOURCE, and the shutdown
      // signal lives as long as the process. With one composition per run that
      // leaks without bound (measured: 92 MB per 200k runs on Node 24).
      const onShutdown = () => controller.abort(shutdownSignal.reason)
      if (shutdownSignal.aborted) controller.abort(shutdownSignal.reason)
      else shutdownSignal.addEventListener("abort", onShutdown, { once: true })

      const entry: Entry = {
        controller,
        cancel(reason) {
          cancelled = true
          if (!controller.signal.aborted) controller.abort(new Error(reason))
        },
      }
      entries.set(threadId, entry)

      let released = false
      return {
        signal: controller.signal,
        get cancelled() {
          return cancelled
        },
        release() {
          if (released) return
          released = true
          shutdownSignal.removeEventListener("abort", onShutdown)
          // Identity guard: never clear a slot a later run has claimed.
          if (entries.get(threadId) === entry) entries.delete(threadId)
        },
      }
    },
    cancel(threadId, reason = "Run cancelled") {
      const entry = entries.get(threadId)
      if (!entry) return false
      entry.cancel(reason)
      return true
    },
    has(threadId) {
      return entries.has(threadId)
    },
  }
}
