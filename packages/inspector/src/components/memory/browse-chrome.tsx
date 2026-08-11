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
 * One line per failing source, in a single live region.
 *
 * Keyed by SOURCE and not by message: two sources failing with the same text must
 * not collide as React keys, and a source that succeeds must clear only its own
 * line. The retry control appears only for browse-request failures — the error
 * PHASE's retry lives in the grid's body-state block instead, so exactly one retry
 * control is ever on screen.
 */
export function BrowseErrorBanners({
  errors,
  onRetry,
}: {
  errors: readonly BrowseErrorEntry[]
  onRetry?: (() => void) | undefined
}) {
  if (errors.length === 0) return null
  return (
    <div
      role="alert"
      className="mb-3 space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {errors.map((entry) => (
        <div key={entry.source} data-testid={`error-${entry.source}`}>
          {entry.message}
        </div>
      ))}
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
 * `total` is the matching population for the FULFILLED revision, so before the
 * first response the bar says only what it knows. `asOf` is non-null only while
 * polling is paused: a live grid stamping "updated 14:32:07" two seconds before it
 * changes again is noise, while a paused one that says nothing is a lie by
 * omission. With nothing fulfilled there is no instant to quote, so the caller
 * passes null and the stamp stays off.
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
