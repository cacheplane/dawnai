"use client"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ParkedInterrupt, ThreadSource } from "../lib/thread-source"
import { type PermissionDecision, PermissionPrompt } from "./PermissionPrompt"

/**
 * The permission gates the SERVER is already holding, put back on screen.
 *
 * Reload the page while a run is parked on a gate and the prompt is gone: the
 * interrupt lives in the Dawn server's checkpoint, but the only thing that
 * renders it — `useInterrupt` — is fed exclusively by `onRunFinishedEvent`
 * inside its own `agent.subscribe(…)` effect. There is no public setter and
 * assigning `agent.pendingInterrupts` does not make it render, so the run is
 * stranded: the composer stays blocked and nothing on screen says why. This
 * component is the second source that fixes that, asking the backend through
 * `ThreadSource` — the same seam the transcript's own restore goes through.
 *
 * It deliberately does NOT write what it finds onto `agent.pendingInterrupts`.
 * That would look like it unified the two sources, but the server's id for an
 * interrupt can be one of two aliases (`innerId ?? outerId`, plus an `aliases`
 * list it keeps for exactly that reason), and seeding CopilotKit's own state
 * with an id its resume path did not mint risks a set-mismatch rejection on
 * the next real run. The count is reported UP instead, via `onPendingChange`,
 * and the composer's block is computed from both sources at the top.
 */

export interface HydratedInterruptsProps {
  /** The thread to ask about. Undefined during SSR and before the first effect. */
  readonly threadId: string | undefined
  /** Where the parked gates are read from. Null during SSR. */
  readonly threadSource: ThreadSource | null
  /** Where a failed resume goes — the same surface `PermissionInterrupt` uses. */
  readonly onError: (error: unknown) => void
  /**
   * How many gates this source is showing, reported on every change and 0 on
   * unmount or thread change.
   *
   * The feature only half-works without it. `AppShell` computes
   * `isAwaitingApproval` from `agent.pendingInterrupts`, which is EMPTY after
   * a reload — so a hydrated card would render "Permission required" over a
   * live composer, and sending from there starts a fresh run with no resume
   * against a parked checkpoint: `Thread has N pending interrupt(s) not
   * addressed by resume`, thrown after the user's message is already in the
   * transcript. That is the exact failure `Composer`'s own doc gives as the
   * reason the flag exists; this prop is what makes the flag true for the
   * source it cannot see.
   */
  readonly onPendingChange?: (count: number) => void
}

export function HydratedInterrupts({
  threadId,
  threadSource,
  onError,
  onPendingChange,
}: HydratedInterruptsProps) {
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()
  const [parked, setParked] = useState<readonly ParkedInterrupt[]>([])
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  // The thread whose answer may still be painted. Written from the effect
  // below, not during render, and it — not the AbortController — is what makes
  // a stale response harmless: the re-fetch after a decision is fired from a
  // `.finally()` that owns no signal, so abort alone would leave that one read
  // free to paint thread A's gates into thread B.
  const renderedThreadIdRef = useRef(threadId)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (threadId === undefined || threadSource === null) return
      try {
        const found = await threadSource.pendingInterrupts(threadId, signal)
        if (signal?.aborted === true || renderedThreadIdRef.current !== threadId) return
        setParked(found)
      } catch {
        // Silent by design — see `pendingInterrupts` in `thread-source.ts` for
        // why an unreachable server is not a user-facing error here. This also
        // absorbs the AbortError from the cleanup below.
      }
    },
    [threadId, threadSource],
  )

  useEffect(() => {
    renderedThreadIdRef.current = threadId
    // Cleared ONLY here. This effect re-runs on a thread change and nothing
    // else (`load`'s identity is a function of the same two values), so a
    // re-fetch after a decision leaves the surviving cards mounted rather than
    // unmounting and remounting them — which would flicker them and drop focus
    // to <body> in the middle of a decision.
    setParked([])
    if (threadId === undefined) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
    }
  }, [threadId, load])

  const decide = useCallback(
    (interruptId: string, decision: PermissionDecision) => {
      setResolvingId(interruptId)
      // The public resume seam. Deny is `{ status: "cancelled" }` with NO
      // payload, for three reasons that agree: it is the same thing the live
      // source says by calling `cancel(id)`; `resolvePendingResume`
      // (`packages/cli/src/lib/dev/pending-interrupts.ts`) maps
      // `status === "cancelled"` straight to "deny" and never looks at the
      // payload; and it is the only shape `isDawnResumeBody` accepts on the
      // `POST /threads/:id/resume` endpoint, whose exact-key check rejects a
      // cancelled entry carrying a third key. This app resumes through the
      // AG-UI handler rather than that endpoint, so the last one is not the
      // reason — it is the confirmation that this spelling is the portable one.
      Promise.resolve()
        .then(() =>
          copilotkit.runAgent({
            agent,
            resume: [
              decision === "deny"
                ? { interruptId, status: "cancelled" as const }
                : { interruptId, payload: decision, status: "resolved" as const },
            ],
          }),
        )
        .catch((error: unknown) => {
          // `runAgent` does not reject when the RUN fails — it emits through
          // `onError`, which `AppShell` subscribes to. It can still reject
          // before the run starts (an unaddressed pending interrupt, say), and
          // from an onClick that would otherwise be an unhandled rejection
          // with nothing on screen.
          onError(error)
        })
        // Re-ask the server: a turn can park on two gates at once, and the
        // second is only actionable once the first is answered. `resolvingId`
        // is held until that read lands so the answered card stays dimmed
        // instead of flicking back to looking clickable in the gap.
        .finally(() => {
          void load().finally(() => {
            setResolvingId(null)
          })
        })
    },
    [agent, copilotkit, load, onError],
  )

  // The no-double-render rule, and it is two rules because they close
  // different windows.
  //
  // 1. Anything the LIVE source is holding is filtered out by id. Both sets
  //    come from the same event: `agent.pendingInterrupts` is written while
  //    RUN_FINISHED is applied, and `useInterrupt`'s pending state is written
  //    from `onRunFinishedEvent` for that same event — so an interrupt the
  //    live card is showing is necessarily in this set, and the filter cannot
  //    miss it.
  // 2. While a run is in flight, the ONLY thing that can render is the card
  //    the user just answered, still dimmed. That covers the gap rule 1
  //    cannot: between the click and the resumed run finishing, the server
  //    still lists every gate as parked (the resume has not been applied yet)
  //    while `pendingInterrupts` has been cleared for the new run, so a
  //    re-fetch landing in that window would repaint gates the live source is
  //    about to own. Keeping the answered one is not a hole in rule 1 — rule 1
  //    guarantees the live source is not holding that id, because a run that
  //    is still going has not delivered any interrupt yet.
  //
  // Together they leave no state in which the same `interruptId` is on screen
  // twice: while running, only the answered card; while stopped, only what the
  // live source is not holding.
  const liveIds = new Set(agent.pendingInterrupts.map((interrupt) => interrupt.id))
  const visible = agent.isRunning
    ? parked.filter((entry) => entry.interruptId === resolvingId)
    : parked.filter((entry) => !liveIds.has(entry.interruptId))

  const pendingCount = visible.length
  useEffect(() => {
    onPendingChange?.(pendingCount)
    return () => {
      onPendingChange?.(0)
    }
  }, [pendingCount, onPendingChange])

  // No `MultipleGatesNotice` here, unlike the live source, and it is not an
  // omission. A turn's gates all arrive in ONE `RUN_FINISHED` (see
  // `packages/ag-ui/src/outbound.ts`), so a group is never split across the two
  // sources in a resting state: either the live source holds all of them, or —
  // after a reload — this one does. What a per-source count could get wrong is
  // therefore only the transient it already hides, and a second copy of the
  // notice that says "2" while the live source says "2" about the same two
  // gates would be strictly worse than the silence.
  return (
    <>
      {visible.map((entry) => (
        <PermissionPrompt
          key={entry.interruptId}
          focusKey={entry.interruptId}
          metadata={entry.metadata}
          isResolving={resolvingId === entry.interruptId}
          onDecide={(decision) => decide(entry.interruptId, decision)}
          // NEVER takes the keyboard. The live card follows the user's own
          // send, so moving focus to it answers something they just did; this
          // one appears unbidden a moment after the page loads, and grabbing
          // focus then yanks the caret out of whatever they had started typing
          // (WCAG 3.2.5 Change on Request). `role="alert"` announces it
          // without moving anything.
          autoFocus={false}
        />
      ))}
    </>
  )
}
