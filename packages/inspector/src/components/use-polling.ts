"use client"
import { useEffect, useRef, useState } from "react"

/**
 * Poll `fn` every `intervalMs` while `enabled` and the tab is visible. Runs one
 * immediate tick on mount, whenever `fn` changes, and on resume — including
 * while polling is disabled, so filter changes refetch with live mode off.
 *
 * The one re-run that does NOT tick is the suspension itself, `enabled` going
 * true → false. A caller disables polling to hold a reading STILL, and a final
 * read taken on the way down is taken at the worst instant there is: the caller
 * flips the flag from the same event that starts the writes it wants hidden, so
 * that read lands beside a half-applied change. Suspending silently is what
 * makes the suspension mean what its callers read it to mean.
 *
 * The effect deliberately depends on `fn` identity: callers pass useCallback'd
 * fetchers whose identity changes when filters change, so a filter change
 * refetches immediately. The trade-off is that the interval resets on every
 * filter change — at a ~2s cadence a reset is harmless, and this is far
 * simpler (and correct) versus a ref-to-latest-fn pattern, which keeps the
 * interval alive but silently skips the immediate refetch on filter change.
 *
 * Ticks are not serialized: a slow response can resolve after a newer tick's
 * and overwrite it (last-write-wins). Against a localhost store at a ~2s
 * cadence that window is negligible; add a sequence guard if remote stores
 * ever appear.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
): T | undefined {
  const [value, setValue] = useState<T>()
  /** Whether the previous run of the effect below was polling, to tell a suspension
   *  apart from every other reason the effect re-runs. Seeded with `enabled` so a
   *  StrictMode remount — which re-runs the effect against hook state it did not
   *  reset — reads as "unchanged" and still takes its mount tick. */
  const wasEnabled = useRef(enabled)
  useEffect(() => {
    const suspending = wasEnabled.current && !enabled
    wasEnabled.current = enabled
    let alive = true
    const tick = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const v = await fn()
        if (alive) setValue(v)
      } catch {
        // Fetchers own error surfacing (e.g. an error banner); a failed tick
        // must not kill the polling loop.
      }
    }
    // An `fn` change that arrives ON the suspension is swallowed with it. No caller can
    // reach that today — the only `fn` here is stable for the component's life — and a
    // suspension is the one moment where not fetching is the whole point.
    if (!suspending) void tick()
    if (!enabled) {
      return () => {
        alive = false
      }
    }
    const id = setInterval(tick, intervalMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [fn, intervalMs, enabled])
  return value
}
