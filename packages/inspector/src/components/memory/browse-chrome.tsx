"use client"
import type { PretableDataState } from "@pretable/react"
import { Button } from "../ui/button"

export interface BrowseErrorEntry {
  /** The slot this failure belongs to. Independent per source, so one source's
   *  success can never clear another's failure. */
  readonly source: string
  readonly message: string
}

/**
 * One line per failing source, with the lines — and only the lines — in a live
 * region.
 *
 * Keyed by SOURCE and not by message: two sources failing with the same text must
 * not collide as React keys, and a source that succeeds must clear only its own
 * line. `role="alert"` is atomic, so the retry control sits outside the region;
 * within it, the button's label would be announced as part of the failure text.
 *
 * Callers pass `onRetry` only for a failure this banner is the sole channel for: the
 * browse REQUEST kinds always, and the error PHASE only while the grid's own
 * body-state block cannot be read. MOUNTED is not the test — the browse grid stays
 * mounted behind a search and behind the timeline, where its block is in the
 * document and hidden; VISIBLE is. The two retries must never be on screen
 * together — a rule this component cannot enforce.
 */
export function BrowseErrorBanners({
  errors,
  onRetry,
}: {
  errors: readonly BrowseErrorEntry[]
  onRetry?: () => void
}) {
  if (errors.length === 0) return null
  return (
    <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <div role="alert" className="space-y-1">
        {errors.map((entry) => (
          <div key={entry.source} data-testid={`error-${entry.source}`}>
            {entry.message}
          </div>
        ))}
      </div>
      {onRetry ? (
        <Button variant="outline" className="mt-1 h-7 px-2" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Counts and freshness.
 *
 * `total` is the matching population for the FULFILLED revision, and null until the
 * first response lands. `asOf` is the caller's decision, not this component's: it
 * passes an instant only while polling is paused, and null whenever no revision has
 * been fulfilled.
 */
export function BrowseStatusBar({
  loaded,
  total,
  phase,
  asOf,
}: {
  loaded: number
  total: number | null
  phase: PretableDataState["phase"]
  asOf: number | null
}) {
  return (
    <p
      data-testid="browse-status"
      data-phase={phase}
      className="mb-2 flex items-center gap-3 text-xs text-zinc-500"
    >
      <span>
        {total === null
          ? `${loaded.toLocaleString()} loaded`
          : `${loaded.toLocaleString()} loaded of ${total.toLocaleString()} matching`}
      </span>
      {phase === "stale" ? <span>Updating results…</span> : null}
      {asOf === null ? null : <span>{`Updated ${new Date(asOf).toLocaleTimeString()}`}</span>}
    </p>
  )
}
