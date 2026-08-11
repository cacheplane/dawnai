"use client"
import type { MemoryRecord } from "@dawn-ai/memory"
import { useState } from "react"
import { Button } from "../ui/button"
import { type MemoryVerb, mutateMemories } from "./actions"
import { TEST_IDS } from "./test-ids"

/**
 * Acts on the rows ticked in the grid. Approve is offered only for the
 * candidates in the selection — approving anything else is not a thing the
 * store can do — while forget applies to whatever is ticked.
 */
export function BulkBar({
  ticked,
  records,
  onDone,
  onClear,
}: {
  ticked: readonly string[]
  /** The rows currently on screen, to tell candidates from the rest. */
  records: readonly MemoryRecord[]
  /** `failed` is how many of the attempted ids errored — the selection is kept
   *  when any did, so the failures stay on screen to be read and retried. */
  onDone: (outcome: { failed: number }) => void
  onClear: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<{ attempted: number; errors: string[] }>()

  const candidateIds = ticked.filter(
    (id) => records.find((r) => r.id === id)?.status === "candidate",
  )

  const run = async (ids: readonly string[], verb: MemoryVerb) => {
    setBusy(true)
    setFailures(undefined)
    const results = await mutateMemories(ids, verb)
    setBusy(false)
    const errors = results.flatMap((r) => (r.error ? [`${r.id}: ${r.error}`] : []))
    // Some may still have succeeded, so refresh either way — but say plainly
    // how many did not, rather than reporting a clean sweep.
    if (errors.length > 0) setFailures({ attempted: ids.length, errors })
    onDone({ failed: errors.length })
  }

  return (
    // Floats over the list rather than sitting in the flow: appearing on the
    // first tick would otherwise push every row down, and the next click would
    // land on the row above the one aimed at.
    <div
      data-testid={TEST_IDS.bulkBar}
      className="fixed bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-md border border-zinc-300 bg-white px-3 py-2 shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-zinc-700">{ticked.length} selected</span>
        <span className="flex-1" />
        {candidateIds.length > 0 ? (
          <Button disabled={busy} onClick={() => void run(candidateIds, "approve")}>
            {`Approve ${candidateIds.length}`}
          </Button>
        ) : null}
        {candidateIds.length > 0 ? (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Reject (delete) ${candidateIds.length} candidate(s)?`)) {
                void run(candidateIds, "reject")
              }
            }}
          >
            {`Reject ${candidateIds.length}`}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Permanently forget ${ticked.length} memor(ies)?`)) {
              void run(ticked, "forget")
            }
          }}
        >
          {`Forget ${ticked.length}`}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onClear}>
          Clear
        </Button>
      </div>
      {failures ? (
        <div data-testid={TEST_IDS.bulkError} role="alert" className="mt-2 text-xs text-red-700">
          <p className="font-medium">
            {`${failures.errors.length} of ${failures.attempted} failed`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {failures.errors.map((message) => (
              <li key={message} className="font-mono">
                {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
