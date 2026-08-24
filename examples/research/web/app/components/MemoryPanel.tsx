"use client"
import { useAgent } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useRef, useState } from "react"
import { neutralButton } from "./ui"

/**
 * The memory candidates the agent has proposed, and the two decisions on them.
 *
 * `remember()` writes with `status: "candidate"` — nothing the agent proposes
 * becomes a real memory until a human says so. Without this panel that review
 * only exists in the `dawn memory` CLI, so the workbench could show the tool
 * call that proposed a memory and then nothing at all. This is the other half.
 *
 * Three endpoints, and they are the whole surface (see `lib/proxy-allowlist.ts`
 * — the proxy forwards these and nothing else):
 *
 * - `GET  /api/dawn/memory/candidates`             -> `{ candidates }`
 * - `POST /api/dawn/memory/candidates/:id/approve` -> `{ record, action, superseded }`
 * - `POST /api/dawn/memory/candidates/:id/reject`  -> `{ ok: true }`
 *
 * Neither POST takes a body.
 */

/**
 * The fields of `MemoryRecord` (`packages/memory/src/types.ts`) this panel
 * reads, and only those.
 *
 * Deliberately a local, narrower type rather than the package's: this app
 * does not depend on `@dawn-ai/memory` (the record arrives as JSON over the
 * proxy), and re-declaring the whole record here would be a second copy to
 * keep in sync for fields nothing renders.
 */
export interface MemoryCandidate {
  readonly id: string
  readonly content: string
  readonly namespace: string
  readonly tags?: readonly string[]
  readonly confidence?: number
}

/** What `POST …/approve` did, as the server reports it. */
export type ApproveAction = "activated" | "superseded" | "deduped"

/**
 * How long a transient outcome line stays on screen, in ms.
 *
 * It needs a timer at all because the row it describes is gone by the time it
 * appears: approving the only candidate empties the panel, and a message
 * anchored to a list that is now empty would otherwise sit there forever (or,
 * if the panel simply stopped rendering, be swallowed entirely — which is the
 * one outcome the plan is explicit about not swallowing). Long enough to read
 * a short sentence you were not looking for, short enough that the rail is
 * quiet again before you next glance at it.
 */
export const OUTCOME_LIFETIME_MS = 8000

/** Shown when a read fails for a reason that is not "the server is down". */
export const LOAD_FAILURE_NOTICE = "Couldn’t load memory candidates."

/** Shown when a decision does not land. The candidate is still there. */
export const DECISION_FAILURE_NOTICE = "Couldn’t save that decision — nothing changed."

/**
 * At most this many candidates are listed; the rest are counted.
 *
 * The rail is `w-64` and already owns one scroll region (the thread list). A
 * second one here would compete with it — two independently scrolling columns
 * stacked in 256px is worse than not showing the fourth candidate — so the
 * section is bounded by content instead: three rows, then an honest line about
 * the remainder. The count in the summary is always the true total.
 */
const MAX_VISIBLE = 3

export interface MemoryPanelViewProps {
  readonly candidates: readonly MemoryCandidate[]
  readonly onApprove: (id: string) => void
  readonly onReject: (id: string) => void
  /**
   * True while a decision is in flight. Disables BOTH actions on EVERY row,
   * not just the row that was clicked: a decision is followed by a re-read of
   * the whole list, so a second click during that window is acting on a list
   * that is already known to be stale.
   */
  readonly isBusy: boolean
  /** The transient outcome of the last decision, if it was worth reporting. */
  readonly outcome: string | null
  /** A sticky quiet line for a read that failed. Cleared by the next success. */
  readonly loadFailure: string | null
}

/** "1 earlier memory" / "2 earlier memories". */
export function describeApprove(action: ApproveAction, supersededCount: number): string | null {
  if (action === "deduped") return "Already remembered — nothing changed."
  if (action !== "superseded" || supersededCount === 0) {
    // A plain activation says nothing: the row disappearing from a list of
    // three is the feedback, and a line confirming what the click obviously
    // did is the kind of noise that makes a panel easy to stop reading.
    return null
  }
  const noun = supersededCount === 1 ? "memory" : "memories"
  return `Replaced ${supersededCount} earlier ${noun}.`
}

/**
 * A candidate's content, short enough to sit inside a control's name.
 *
 * Truncated because an accessible name is read out in full: a two-sentence
 * memory turns "Approve" into a paragraph, and the distinguishing part is at
 * the front. The ellipsis is the character, not three dots, so a screen
 * reader does not say "dot dot dot".
 */
const LABEL_LIMIT = 60

function shortLabel(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim()
  return collapsed.length <= LABEL_LIMIT ? collapsed : `${collapsed.slice(0, LABEL_LIMIT - 1)}…`
}

/**
 * The panel, as pure props.
 *
 * Split out from the container for the reason every other component in this
 * app is: the branching (empty, populated, over the cap, busy, failed) is
 * assertable with `renderToStaticMarkup` and nothing else has to exist for it.
 */
export function MemoryPanelView({
  candidates,
  onApprove,
  onReject,
  isBusy,
  outcome,
  loadFailure,
}: MemoryPanelViewProps) {
  // Empty is the NORMAL state — most sessions never propose a memory — so the
  // panel's resting appearance is nothing at all, not a heading over "No
  // candidates". A permanent empty box in a 256px rail is a permanent
  // suggestion that something is missing.
  if (candidates.length === 0) {
    if (outcome === null && loadFailure === null) return null
    return (
      <div className="shrink-0 border-t border-wb-border px-4 pt-3">
        {/* Same `role="status"` as the populated case below, and for the same
            reason: this is the branch a supersede of the LAST candidate lands
            in, so it is the one that most needs announcing. */}
        <p role="status" className="text-[11px] leading-4 text-wb-muted">
          {outcome ?? loadFailure}
        </p>
      </div>
    )
  }

  const visible = candidates.slice(0, MAX_VISIBLE)
  const hidden = candidates.length - visible.length

  return (
    <section
      aria-label="Memory candidates"
      aria-busy={isBusy}
      className="shrink-0 border-t border-wb-border px-3 pt-3"
    >
      {/*
        A native `<details>`, open by default: a candidate the user never sees
        is the same as no panel, and collapsing is theirs to ask for. Native
        rather than a `useState` toggle so the pure view stays stateless —
        the tests render it with `renderToStaticMarkup` and never have to
        drive a disclosure to reach the rows underneath.
      */}
      <details open className="group">
        {/*
          `list-none` hides the platform marker (which is a filled triangle on
          the left, at a size that fights an 11px uppercase label), so the
          disclosure needs its own affordance or "Memory · 2" reads as a plain
          heading. Same idea as the packaged activity cards: one glyph, rotated
          by CSS on the open state. `group-open:` needs the `group` class on
          the `<details>`, which is why it is there.
        */}
        <summary className="wb-focus flex cursor-pointer list-none items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-wb-muted">
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ▸
          </span>
          Memory · {candidates.length}
        </summary>
        <ul className="mt-2 space-y-2">
          {visible.map((candidate) => (
            <li
              key={candidate.id}
              className="rounded-wb border border-wb-border bg-wb-surface px-2.5 py-2"
            >
              {/* `title` carries the full text for the clamped case; the clamp
                  is what keeps three candidates from pushing the thread list
                  off the bottom of the rail. */}
              <p
                className="line-clamp-3 break-words text-[12px] leading-4"
                title={candidate.content}
              >
                {candidate.content}
              </p>
              <p className="mt-1 truncate text-[11px] leading-4 text-wb-muted">
                {candidate.namespace}
                {typeof candidate.confidence === "number"
                  ? ` · confidence ${candidate.confidence}`
                  : ""}
              </p>
              <div className="mt-1.5 flex gap-1.5">
                {/*
                  Three rows of identically-labelled buttons: "Approve" alone
                  is useless to anyone navigating by control, who gets
                  "Approve, button" three times with nothing to tell them
                  apart. The visible label stays short; `aria-label` carries
                  which candidate it acts on.
                */}
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Approve: ${shortLabel(candidate.content)}`}
                  onClick={() => onApprove(candidate.id)}
                  className={`${neutralButton("sm")} disabled:opacity-50`}
                >
                  Approve
                </button>
                {/*
                  "Delete", not "Reject": the endpoint is
                  `…/reject`, but what it does is a hard delete — the row is
                  gone from the store and `{"ok":true}` comes back even for an
                  id that never existed. Naming the button after the effect
                  rather than after the route is the whole of the warning
                  (a confirm dialog in a dev tool this size is not).
                */}
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Delete permanently: ${shortLabel(candidate.content)}`}
                  onClick={() => onReject(candidate.id)}
                  className={`${neutralButton("sm")} disabled:opacity-50`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {hidden > 0 ? (
          <p className="mt-2 px-1 text-[11px] leading-4 text-wb-muted">
            {hidden} more not shown — review the rest with{" "}
            {/* `<code>` is how the rest of this app names a command (see
                `ConnectScreen`); backticks in JSX text would render as
                literal backticks. */}
            <code className="text-[11px]">dawn memory list</code>.
          </p>
        ) : null}
        {/*
          A live region, and an ALWAYS-PRESENT one whose text is swapped — not
          an element that appears when there is something to say. Screen
          readers announce changes to a region that was already in the
          accessibility tree far more reliably than they announce a region
          being inserted, and "Replaced 1 earlier memory" is the one outcome
          this panel exists not to swallow. Its visual default is the
          permanence note, so the slot is never empty.

          `aria-live` is not spelled out: `role="status"` implies
          `aria-live="polite"` plus `aria-atomic="true"`, and polite is right —
          this must not interrupt the answer being read.
        */}
        <p role="status" className="mt-2 px-1 pb-3 text-[11px] leading-4 text-wb-muted">
          {outcome ??
            loadFailure ??
            (isBusy ? "Saving…" : "Approving stores the memory. Deleting is permanent.")}
        </p>
      </details>
    </section>
  )
}

/** The candidates out of a `GET /memory/candidates` body, defensively. */
function readCandidates(body: unknown): readonly MemoryCandidate[] {
  const list = (body as { candidates?: unknown } | null)?.candidates
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is MemoryCandidate =>
      typeof (entry as MemoryCandidate | null)?.id === "string" &&
      typeof (entry as MemoryCandidate).content === "string",
  )
}

/** The approve outcome out of its response body, defensively. */
function readApproveOutcome(body: unknown): string | null {
  const parsed = body as { action?: unknown; superseded?: unknown } | null
  const action = parsed?.action
  if (action !== "activated" && action !== "superseded" && action !== "deduped") return null
  const superseded = Array.isArray(parsed?.superseded) ? parsed.superseded.length : 0
  return describeApprove(action, superseded)
}

/**
 * The fetching half.
 *
 * Reads on mount, after every decision, and at the end of every run — the last
 * one because `remember()` lands during a run, so a memory proposed in the
 * answer you are reading should be reviewable without a reload.
 * `onRunFinishedEvent` is a distinct `AgentSubscriber` callback in the
 * installed `@ag-ui/client@0.0.57`, and a finished run is the first moment the
 * write is certainly in the store.
 */
export function MemoryPanel() {
  const { agent } = useAgent()
  const [candidates, setCandidates] = useState<readonly MemoryCandidate[]>([])
  const [outcome, setOutcome] = useState<string | null>(null)
  const [loadFailure, setLoadFailure] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  // Stale-response discipline, and an AbortController is not enough on its
  // own: the re-read after a decision is fired from a `.finally()` that owns
  // no signal, so an in-flight read has to be able to recognize that a newer
  // one has already started. Every read takes a ticket; only the latest ticket
  // may paint. The mounted flag is the second half, for a read that resolves
  // after this component is gone.
  const readTicketRef = useRef(0)
  // RE-ARMED on setup, not just cleared on cleanup. Next 16's App Router runs
  // StrictMode by default (this app sets no `reactStrictMode` key), and
  // StrictMode's dev double-invoke is setup -> cleanup -> setup: a flag whose
  // only write is `= false` in the cleanup latches false forever on the second
  // setup. Every `isCurrent()` would then be permanently false and this panel
  // would render NOTHING in dev — candidates fetched, nothing painted, and
  // `isBusy` stuck on after the first decision. Verified in jsdom against a
  // non-Strict control.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    readTicketRef.current += 1
    const ticket = readTicketRef.current
    const isCurrent = () =>
      isMountedRef.current && readTicketRef.current === ticket && signal?.aborted !== true
    try {
      const response = await fetch("/api/dawn/memory/candidates", signal ? { signal } : {})
      // 502 is the proxy's one dedicated "I cannot reach Dawn" signal (see
      // `route.ts`), and it belongs to another surface: the connect screen
      // owns this during "checking" and after a failed hydrate, and while the
      // shell is up a run failure is the surface. Either way a second
      // "couldn't load" line in the rail would compete. See the error-surface
      // note at the top of `AppShell.tsx`.
      //
      // The list is left as it was — but the notice is CLEARED, because a
      // stale "couldn't load" from an earlier non-502 failure would otherwise
      // sit under a list this read just chose not to touch, saying the last
      // thing that went wrong rather than what is true now.
      if (response.status === 502) {
        if (isCurrent()) setLoadFailure(null)
        return
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      if (!isCurrent()) return
      setCandidates(readCandidates(body))
      setLoadFailure(null)
    } catch {
      if (!isCurrent()) return
      // Quiet and muted, NOT a `RunError` row: nothing about the conversation
      // is broken, the rest of the app works, and a red alert in the rail for
      // a failed background read of a review queue is out of proportion to it.
      setLoadFailure(LOAD_FAILURE_NOTICE)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
    }
  }, [load])

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunFinishedEvent: () => {
        void load()
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [agent, load])

  // The outcome line is transient by construction: every new one restarts the
  // clock, and the timer is cleared on unmount so it cannot write into state
  // that is gone.
  useEffect(() => {
    if (outcome === null) return
    const id = setTimeout(() => {
      setOutcome(null)
    }, OUTCOME_LIFETIME_MS)
    return () => {
      clearTimeout(id)
    }
  }, [outcome])

  const decide = useCallback(
    (id: string, route: "approve" | "reject") => {
      setIsBusy(true)
      setOutcome(null)
      void fetch(`/api/dawn/memory/candidates/${encodeURIComponent(id)}/${route}`, {
        method: "POST",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          // Reject's body is `{ ok: true }` and says nothing worth showing;
          // the row disappearing is the feedback, and the button already said
          // what it does.
          if (route !== "approve") return
          const body: unknown = await response.json()
          if (isMountedRef.current) setOutcome(readApproveOutcome(body))
        })
        .catch(() => {
          if (isMountedRef.current) setOutcome(DECISION_FAILURE_NOTICE)
        })
        // Re-read either way. On success the list has changed; on failure the
        // candidate is still there and the panel should say so by showing it.
        .finally(() => {
          void load().finally(() => {
            if (isMountedRef.current) setIsBusy(false)
          })
        })
    },
    [load],
  )

  const approve = useCallback(
    (id: string) => {
      decide(id, "approve")
    },
    [decide],
  )
  const reject = useCallback(
    (id: string) => {
      decide(id, "reject")
    },
    [decide],
  )

  return (
    <MemoryPanelView
      candidates={candidates}
      onApprove={approve}
      onReject={reject}
      isBusy={isBusy}
      outcome={outcome}
      loadFailure={loadFailure}
    />
  )
}
