"use client"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useState } from "react"
import {
  MultipleGatesNotice,
  type PermissionDecision,
  type PermissionMetadata,
  PermissionPrompt,
} from "./PermissionPrompt"

/**
 * The permission gates the SERVER is already holding, put back on screen.
 *
 * Reload the page while a run is parked on a gate and the prompt is gone: the
 * interrupt lives in the Dawn server's checkpoint, but the only thing that
 * renders it — `useInterrupt` — is fed exclusively by `onRunFinishedEvent`
 * inside its own `agent.subscribe(…)` effect. There is no public setter and
 * assigning `agent.pendingInterrupts` does not make it render, so the run is
 * stranded: the composer stays blocked and nothing on screen says why. This
 * component is the second source that fixes that, asking the server directly.
 *
 * It renders the same `PermissionPrompt` the live source does, because the
 * endpoint's `value` IS the Dawn envelope `toAguiInterrupt` would have parked
 * under `Interrupt.metadata`. Note the mapping is done HERE rather than with
 * `toAguiInterrupt`: that function is not exported from `@dawn-ai/ag-ui`'s
 * package root (only its `DawnInterruptEnvelope`/`DawnResumeRequest` types
 * are), and widening a package's public API for an example is the wrong
 * direction. Reading `interruptId` and treating the rest as metadata is the
 * whole of what this card needs from it.
 */

/** One entry of `GET /threads/:id/pending_interrupts`. */
export interface ParkedInterrupt {
  readonly interruptId: string
  readonly metadata: PermissionMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The endpoint's body, narrowed to what can be rendered.
 *
 * Total rather than throwing: an entry without a usable `interruptId` cannot
 * be resumed, so a card for it would be a button that can only fail. Dropping
 * it silently leaves the thread exactly as stranded as it already was, which
 * is worse than nothing only if the alternative works — and it cannot.
 */
export function readParkedInterrupts(body: unknown): ParkedInterrupt[] {
  if (!isRecord(body) || !Array.isArray(body.interrupts)) return []
  const parked: ParkedInterrupt[] = []
  for (const entry of body.interrupts) {
    if (!isRecord(entry)) continue
    const value = entry.value
    const interruptId =
      isRecord(value) && typeof value.interruptId === "string" && value.interruptId.length > 0
        ? value.interruptId
        : typeof entry.interruptId === "string" && entry.interruptId.length > 0
          ? entry.interruptId
          : undefined
    if (interruptId === undefined) continue
    parked.push({ interruptId, metadata: (isRecord(value) ? value : {}) as PermissionMetadata })
  }
  return parked
}

export interface HydratedInterruptsProps {
  /** The thread to ask about. Undefined during SSR and before the first effect. */
  readonly threadId: string | undefined
  /** Where a failed resume goes — the same surface `PermissionInterrupt` uses. */
  readonly onError: (error: unknown) => void
  /**
   * `fetch`, injectable so a test does not have to patch a global. Bound to
   * `globalThis` by default: an unbound reference throws "Illegal invocation"
   * in the browser.
   *
   * It is a dependency of the fetching effect, so it must be STABLE — an
   * inline lambda re-issues the request on every render. `Transcript` passes
   * nothing, which is why the default lives inside the effect rather than in
   * the parameter list: a default expression would be a fresh function every
   * render and would loop on its own.
   */
  readonly fetchFn?: typeof fetch
}

export function HydratedInterrupts({ threadId, onError, fetchFn }: HydratedInterruptsProps) {
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()
  const [parked, setParked] = useState<readonly ParkedInterrupt[]>([])
  // Bumped after a decision to re-ask the server: a turn can park on two gates
  // at once, and the second one is only visible once the first is answered.
  const [reloadToken, setReloadToken] = useState(0)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  useEffect(() => {
    // Read, not merely listed as a dependency: `reloadToken` is the whole
    // input this effect takes from a decision, and a lint rule that prunes
    // "unused" dependencies would otherwise strip the re-fetch out.
    void reloadToken
    setParked([])
    if (threadId === undefined) return
    // Client-only by construction: this runs in an effect, so SSR renders the
    // empty list and never issues the request.
    const request = fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
    // Stale-response discipline. The effect re-runs on a thread switch, so its
    // cleanup is exactly the moment thread A's answer stopped being paintable
    // — unlike `AppShell`'s hydrate, whose effect also depends on `agent` and
    // therefore cannot use its own cleanup as the staleness signal. Nothing
    // here depends on `agent`: it is read at click time, not fetch time.
    let cancelled = false
    void (async () => {
      try {
        const response = await request(
          `/api/dawn/threads/${encodeURIComponent(threadId)}/pending_interrupts`,
        )
        // Every failure renders nothing, and each has a different innocent
        // cause: 404 is a thread with no checkpoint row, 409 a thread that has
        // never run or whose route is gone, 403 the proxy refusing a path that
        // is not allowlisted. None of them means "your conversation is
        // broken", and the ordinary answer for a healthy thread that is simply
        // not parked is a 200 with an empty array. A genuine network failure
        // is also silent here on purpose: the page still works, the only lost
        // capability is restoring a prompt that may well not exist, and an
        // error row for it would fire on every load against a stopped dev
        // server — where the transcript's own restore already says so, in a
        // message that is actually about something the user can see.
        if (!response.ok) return
        const body: unknown = await response.json()
        if (cancelled) return
        setParked(readParkedInterrupts(body))
      } catch {
        // See above: unreachable server, aborted request, or a non-JSON body.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [threadId, reloadToken, fetchFn])

  const decide = useCallback(
    (interruptId: string, decision: PermissionDecision) => {
      setResolvingId(interruptId)
      // The public resume seam. Deny is `{ status: "cancelled" }` with NO
      // payload — the same choice `PermissionInterrupt` makes by calling
      // `cancel(id)`, and not merely a stylistic match: the dev runtime's
      // resume validator requires a cancelled entry to have EXACTLY
      // `interruptId` and `status`, so tagging a redundant `payload: "deny"`
      // onto it would be rejected outright.
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
        .finally(() => {
          setResolvingId(null)
          setReloadToken((token) => token + 1)
        })
    },
    [agent, copilotkit, onError],
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
  // 2. Nothing at all renders while a run is in flight. That covers the gap
  //    rule 1 cannot: between clicking a hydrated card and the resumed run
  //    finishing, the server still lists the interrupt as parked (the resume
  //    has not been applied yet) while `pendingInterrupts` has been cleared
  //    for the new run — a re-fetch landing in that window would repaint the
  //    card the user just answered.
  //
  // Together they leave no state in which the same `interruptId` can be on
  // screen twice: while running, this source shows nothing; while stopped, it
  // shows only what the live source is not.
  const liveIds = new Set(agent.pendingInterrupts.map((interrupt) => interrupt.id))
  const visible = agent.isRunning ? [] : parked.filter((entry) => !liveIds.has(entry.interruptId))

  return (
    <>
      <MultipleGatesNotice count={visible.length} />
      {visible.map((entry, index) => (
        <PermissionPrompt
          key={entry.interruptId}
          metadata={entry.metadata}
          isResolving={resolvingId === entry.interruptId}
          onDecide={(decision) => decide(entry.interruptId, decision)}
          autoFocus={index === 0}
        />
      ))}
    </>
  )
}
