"use client"
import { useEffect, useState } from "react"

/**
 * Poll `fn` every `intervalMs` while `enabled` and the tab is visible. Always
 * runs one immediate tick on mount and whenever `fn` changes, even when
 * polling is disabled — so filter changes refetch with live mode off.
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
  useEffect(() => {
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
    void tick()
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
