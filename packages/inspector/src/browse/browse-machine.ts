import type { MemoryRecord } from "@dawn-ai/memory/browse"
import type { PretableDataState } from "@pretable/react"
import { dedupeById, reconcileRefreshedWindow } from "./browse-reconcile"

/** Records per window. */
export const BROWSE_PAGE_SIZE = 200

/** Ceiling on what the client keeps resident. DELIBERATELY equal to the route's
 *  `BROWSE_MAX_LIMIT`, so one head refresh can always re-derive the entire resident
 *  span in a single request — which is what makes the convergence guarantee
 *  arithmetic rather than aspirational. */
export const BROWSE_RESIDENT_CAP = 1000

export type BrowseRequestKind = "initial" | "refresh" | "load-more"

/**
 * One window to ask for. KEYSET, not offset: `cursor` is the token the previous
 * response issued, and `null` means the head of the ordering.
 *
 * The Inspector's primary interaction — approve — stamps `updatedAt = now` and hoists
 * a row to position 0 of the default order. An offset walk loses such a row whenever
 * the hoist crosses the seam between two windows: the rows below shift down by one and
 * the next offset steps straight over one that was never fetched. That omission is
 * SILENT — nothing on the client can tell "row absent" from "row does not match". A
 * keyset walk cannot lose it, because a hoisted row moves into territory the walk has
 * already passed; the worst it produces is the same row twice, which arrives with a
 * known id and is dropped by `dedupeById`.
 */
export interface BrowseWindow {
  readonly limit: number
  readonly cursor: string | null
}

export interface BrowsePageResponse {
  readonly records: readonly MemoryRecord[]
  readonly total: number
  /** The token that continues this walk, or null when this window did not fill — which
   *  is the server saying it reached the end of the matching set. The server issues one
   *  whenever the window filled rather than over-fetching a row to prove a further one
   *  exists, so a set whose size is an exact multiple of the limit ends the walk in one
   *  empty window instead of an error. */
  readonly continuation: string | null
}

/** Records, total, continuation and dataset key are stored TOGETHER and tagged with the
 *  revision that produced them. A total — or a continuation — that belongs to a
 *  different question is the exact failure this design exists to prevent: the token
 *  carries a fingerprint of its own query, and the rows it names belong to a set this
 *  client may no longer be showing. */
export interface BrowseFulfillment {
  readonly revision: number
  readonly datasetKey: string
  readonly records: readonly MemoryRecord[]
  readonly total: number
  readonly continuation: string | null
  /** Epoch ms the response was applied — the as-of instant shown while paused. */
  readonly at: number
}

export interface BrowseRequest {
  readonly revision: number
  readonly kind: BrowseRequestKind
  readonly window: BrowseWindow
}

/** One independent slot per request kind, so a succeeding poll tick can never clear
 *  a load-more failure. The mutation slot lives with the consumer that owns the
 *  mutations. */
export interface BrowseKindErrors {
  readonly refresh?: string
  readonly "load-more"?: string
}

export interface BrowseState {
  readonly revision: number
  readonly datasetKey: string
  readonly fulfilled: BrowseFulfillment | null
  readonly inFlight: BrowseRequest | null
  readonly queuedLoadMore: boolean
  readonly initialFailure: { readonly revision: number; readonly message: string } | null
  readonly kindErrors: BrowseKindErrors
}

export type BrowseEvent =
  | { readonly type: "query-changed"; readonly datasetKey: string }
  | { readonly type: "poll-tick" }
  | { readonly type: "load-more-requested" }
  | { readonly type: "retry" }
  | {
      readonly type: "response"
      readonly revision: number
      readonly kind: BrowseRequestKind
      readonly page: BrowsePageResponse
      readonly at: number
    }
  | {
      readonly type: "failure"
      readonly revision: number
      readonly kind: BrowseRequestKind
      readonly message: string
    }

export interface BrowseTransition {
  readonly state: BrowseState
  /** The request the caller must now issue, or null. */
  readonly start: BrowseRequest | null
  /** Whether the caller must abort whatever it had in flight before this event. */
  readonly abort: boolean
}

/** Frozen because `readonly` is erased at runtime and this ONE object is installed on
 *  every state that clears its slots: one widening cast downstream would edit them all.
 *  Same for the initial state below. */
const NO_KIND_ERRORS: BrowseKindErrors = Object.freeze({})

/** `revision: 0` is a revision nothing can fulfil and `datasetKey: ""` is a key no
 *  canonical query produces, so the first `query-changed` a mounted hook dispatches
 *  is the SAME transition as any later one. Mount is not a special case. */
export const INITIAL_BROWSE_STATE: BrowseState = Object.freeze({
  revision: 0,
  datasetKey: "",
  fulfilled: null,
  inFlight: null,
  queuedLoadMore: false,
  initialFailure: null,
  kindErrors: NO_KIND_ERRORS,
})

/** Records held FOR THE DESIRED REVISION. An older revision's records are on screen
 *  but are not a base anything new is built on. */
export function browseResidentCount(state: BrowseState): number {
  return state.fulfilled?.revision === state.revision ? state.fulfilled.records.length : 0
}

/**
 * Whether the forward WALK can still be continued — the server's own statement, taken
 * off the newest fulfilled response's token. The resident cap is deliberately absent:
 * folding it in would make a window 4432 rows short of its own total report as
 * complete.
 *
 * Deliberately NOT `records.length < total`, which reads as the more direct question.
 * The two diverge in both directions, and the token is right in both:
 *
 * - A window that filled exactly at the end of the set issues a token, so this says
 *   "more" while the counts already agree. One further request settles it.
 * - After a hoist, the walk can reach the end while `total` counts rows the walk never
 *   saw — they are at the HEAD, above everything a forward walk can still reach. Only
 *   the head refresh brings those in, and it does so within one poll period while
 *   polling is live. Reporting "more" there would offer a control that cannot deliver
 *   them: the offset walk it replaced did exactly that, re-fetching rows already
 *   resident until a refresh happened to repair the count.
 *
 * So a surface that quotes the loaded count against the total is quoting two numbers
 * that may legitimately be one poll period apart, and this flag answers only "is there
 * anywhere further to walk".
 */
export function browseHasMore(state: BrowseState): boolean {
  const fulfilled = state.fulfilled
  if (fulfilled === null || fulfilled.revision !== state.revision) return false
  return fulfilled.continuation !== null
}

/** Whether another request may be ISSUED. Narrower than `browseHasMore` by the cap,
 *  which stays a request gate: past it the extra rows exist but are unreachable. */
export function browseCanLoadMore(state: BrowseState): boolean {
  return browseHasMore(state) && browseResidentCount(state) < BROWSE_RESIDENT_CAP
}

/** Whether the records ON SCREEN answer a revision other than the desired one.
 *
 *  TWO phases satisfy this — `stale` and `error` with rows — because the phase splits
 *  them by whether an attempt is still running, which is a fact about the REQUEST. The
 *  rows are identical either way: a query change keeps the previous revision's records
 *  (see `query-changed`), and a failed initial fetch for the new revision fulfils
 *  nothing, so they stay. A rule about what the user is looking at — a destructive
 *  action over a selection formed under the previous query — must ask this and never a
 *  phase name, or it lifts the moment the refetch fails.
 *
 *  Empty records are excluded so the name stays literally true: with nothing rendered
 *  there is nothing on screen to be answering the wrong question — those states are
 *  `loading`, or the `error` that has no rows to keep. What is left is exactly `stale`
 *  plus `error`-with-rows, and browse-machine.test pins one of each alongside the two
 *  `false` cases so the flag can never quietly become a synonym for "failed". */
export function browseRowsAreStale(state: BrowseState): boolean {
  const fulfilled = state.fulfilled
  return fulfilled !== null && fulfilled.revision !== state.revision && fulfilled.records.length > 0
}

/**
 * Phase derivation, mechanical.
 *
 * `error` means "the last attempt for the DESIRED revision failed and nothing is
 * fulfilled for that revision" — which covers an initial failure and a query-change
 * failure with an older revision's rows still on screen. A refresh or load-more
 * failure leaves the desired revision fulfilled, so the phase stays `idle` and the
 * failure reaches the user through a banner slot instead: one failure, one channel.
 */
export function browsePhase(state: BrowseState): PretableDataState["phase"] {
  if (state.fulfilled?.revision === state.revision) {
    if (state.inFlight?.kind === "refresh") return "refreshing"
    if (state.inFlight?.kind === "load-more") return "loading-more"
    return "idle"
  }
  // A retry in flight is a fresh attempt, not the held failure: the failure is only
  // "the LAST attempt" while there is no attempt running.
  if (state.inFlight === null && state.initialFailure?.revision === state.revision) {
    return "error"
  }
  // Rows on screen answer the previous question (`stale`); nothing on screen means
  // there is nothing to be stale about (`loading`).
  return (state.fulfilled?.records.length ?? 0) > 0 ? "stale" : "loading"
}

/** One object per message-less phase. A consumer holds this as a dependency, and the
 *  2 s cadence walks `idle → refreshing → idle` forever: a fresh object on the way back
 *  reports a change that did not happen. Keyed over the whole phase union, so a phase
 *  added upstream fails to compile rather than falling through. */
const PHASE_DATA_STATES: Readonly<Record<PretableDataState["phase"], PretableDataState>> =
  Object.freeze({
    idle: Object.freeze({ phase: "idle" as const }),
    loading: Object.freeze({ phase: "loading" as const }),
    stale: Object.freeze({ phase: "stale" as const }),
    refreshing: Object.freeze({ phase: "refreshing" as const }),
    "loading-more": Object.freeze({ phase: "loading-more" as const }),
    error: Object.freeze({ phase: "error" as const }),
  })

/** Keyed on the failure rather than the state: message-equality suppression already
 *  holds that object still across a repeating failure, so the banner keeps one identity
 *  for as long as it says the same thing. */
const ERROR_DATA_STATES = new WeakMap<object, PretableDataState>()

export function browseDataState(state: BrowseState): PretableDataState {
  const phase = browsePhase(state)
  const failure = state.initialFailure
  if (phase !== "error" || failure === null) return PHASE_DATA_STATES[phase]
  const held = ERROR_DATA_STATES.get(failure)
  if (held !== undefined) return held
  const derived: PretableDataState = Object.freeze({ phase, message: failure.message })
  ERROR_DATA_STATES.set(failure, derived)
  return derived
}

function noStart(state: BrowseState): BrowseTransition {
  return { state, start: null, abort: false }
}

function starting(state: BrowseState, request: BrowseRequest, abort: boolean): BrowseTransition {
  return { state: { ...state, inFlight: request }, start: request, abort }
}

function initialWindow(): BrowseWindow {
  return { limit: BROWSE_PAGE_SIZE, cursor: null }
}

/** limit = resident count, clamped: never below one page (an empty result still asks
 *  a real question) and never above the cap the route enforces. HEAD-anchored, which
 *  is the whole of the refresh: it re-derives the resident span from the top of the
 *  current ordering, so it is the one request that can see a hoist. */
function refreshWindow(state: BrowseState): BrowseWindow {
  const resident = browseResidentCount(state)
  return {
    limit: Math.min(Math.max(resident, BROWSE_PAGE_SIZE), BROWSE_RESIDENT_CAP),
    cursor: null,
  }
}

/** Continues from the NEWEST fulfilled token — a refresh's, once one has landed, since
 *  the refresh has already re-derived and moved past the span the previous load-more
 *  ended in.
 *
 *  Never asks past the cap: the resident count is not a multiple of the page size
 *  whenever `dedupeById` has dropped a paging duplicate, so a fixed page would ask for
 *  rows the cap then discards. Callers guard on `browseCanLoadMore`, which is what
 *  keeps the limit above zero AND the token non-null — hence the throw rather than a
 *  head window for the null case: a `cursor: null` here would silently re-fetch rows
 *  already resident, and the click would land on a control that appears to do nothing
 *  for as long as the state persists. */
function loadMoreWindow(state: BrowseState): BrowseWindow {
  // The DESIRED revision's fulfillment or nothing, and BOTH numbers come from it: a
  // token read off an older fulfillment would continue the previous question's walk
  // into this one's rows, and a count read off a different one would size the window
  // against a set the token does not belong to.
  const fulfilled = state.fulfilled?.revision === state.revision ? state.fulfilled : null
  const cursor = fulfilled?.continuation ?? null
  if (fulfilled === null || cursor === null) {
    throw new Error("browse: a load-more was started with no continuation to walk from")
  }
  return {
    limit: Math.min(BROWSE_PAGE_SIZE, BROWSE_RESIDENT_CAP - fulfilled.records.length),
    cursor,
  }
}

/** The cap is enforced HERE because this is the only place the resident set grows, and
 *  it grows by more than a window: reconciliation rule 3 retains a tail the refresh
 *  limit never asked for. Past the cap the refresh limit stops growing, so a row there
 *  falls outside every future window — and `supersede` demotes without touching
 *  `updatedAt`, so it cannot re-enter the head span either, and renders active for
 *  good. Dropping from the far end keeps what a later window can still re-cover. */
function withinCap(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return records.length <= BROWSE_RESIDENT_CAP ? records : records.slice(0, BROWSE_RESIDENT_CAP)
}

/** Success clears only ITS OWN slot. */
function clearedError(
  state: BrowseState,
  kind: BrowseRequestKind,
): Pick<BrowseState, "initialFailure" | "kindErrors"> {
  if (kind === "initial") {
    return { initialFailure: null, kindErrors: state.kindErrors }
  }
  if (state.kindErrors[kind] === undefined) {
    return { initialFailure: state.initialFailure, kindErrors: state.kindErrors }
  }
  const next: BrowseKindErrors = {
    ...(kind !== "refresh" && state.kindErrors.refresh !== undefined
      ? { refresh: state.kindErrors.refresh }
      : {}),
    ...(kind !== "load-more" && state.kindErrors["load-more"] !== undefined
      ? { "load-more": state.kindErrors["load-more"] }
      : {}),
  }
  return { initialFailure: state.initialFailure, kindErrors: next }
}

/** Failure records against the kind that failed. Message-equality suppression keeps
 *  the SAME object when a repeating tick fails the same way, so a 2 s cadence cannot
 *  re-render — or re-announce — a banner that has not changed. */
function recordedFailure(
  state: BrowseState,
  kind: BrowseRequestKind,
  message: string,
): Pick<BrowseState, "initialFailure" | "kindErrors"> {
  if (kind === "initial") {
    const previous = state.initialFailure
    if (previous !== null && previous.revision === state.revision && previous.message === message) {
      return { initialFailure: previous, kindErrors: state.kindErrors }
    }
    return { initialFailure: { revision: state.revision, message }, kindErrors: state.kindErrors }
  }
  if (state.kindErrors[kind] === message) {
    return { initialFailure: state.initialFailure, kindErrors: state.kindErrors }
  }
  const kindErrors: BrowseKindErrors =
    kind === "refresh"
      ? { ...state.kindErrors, refresh: message }
      : { ...state.kindErrors, "load-more": message }
  return { initialFailure: state.initialFailure, kindErrors }
}

/** A queued load-more runs when the tick it waited on settles — success OR failure.
 *  The queue clears either way: it was intent about a request that has had its turn. */
function drainQueuedLoadMore(settled: BrowseState): BrowseTransition {
  if (!settled.queuedLoadMore) return noStart(settled)
  const drained: BrowseState = { ...settled, queuedLoadMore: false }
  if (!browseCanLoadMore(drained)) return noStart(drained)
  return starting(
    drained,
    { revision: drained.revision, kind: "load-more", window: loadMoreWindow(drained) },
    false,
  )
}

export function browseReduce(state: BrowseState, event: BrowseEvent): BrowseTransition {
  switch (event.type) {
    case "query-changed": {
      const revision = state.revision + 1
      const request: BrowseRequest = { revision, kind: "initial", window: initialWindow() }
      return {
        // Records are KEPT: they answer the previous question and stay on screen
        // (phase `stale`) until the new one is answered. Their revision is behind
        // now, so nothing can mistake them for the answer — and the continuation
        // travels with them, so bumping the revision is what drops it: every gate
        // that would send it (`browseHasMore`, `browseCanLoadMore`) demands the
        // fulfilled revision be the desired one. Every error slot is dropped — each
        // described a dataset that no longer exists.
        state: {
          ...state,
          revision,
          datasetKey: event.datasetKey,
          inFlight: request,
          queuedLoadMore: false,
          initialFailure: null,
          kindErrors: NO_KIND_ERRORS,
        },
        start: request,
        abort: state.inFlight !== null,
      }
    }

    case "poll-tick": {
      // Single flight: a tick that comes due while ANYTHING is in flight is skipped
      // and the next tick covers it. That is the whole of the "tick due during
      // loading-more" rule — the interleaving case is removed, not handled.
      if (state.inFlight !== null) return noStart(state)
      if (state.fulfilled?.revision !== state.revision) return noStart(state)
      return starting(
        state,
        { revision: state.revision, kind: "refresh", window: refreshWindow(state) },
        false,
      )
    }

    case "retry": {
      if (state.inFlight !== null) return noStart(state)
      // Re-attempt the failed kind under the CURRENT desired revision: if the query
      // moved on while the banner was up, that IS the new query's initial fetch.
      if (state.fulfilled?.revision !== state.revision) {
        return starting(
          state,
          { revision: state.revision, kind: "initial", window: initialWindow() },
          false,
        )
      }
      // The banner outlives its request: a load-more slot is cleared only by a
      // load-more success, so the set can complete — or reach the cap — under a
      // failure that is still on screen. Re-attempting then would ask for rows past
      // the cap.
      if (state.kindErrors["load-more"] !== undefined && browseCanLoadMore(state)) {
        return starting(
          state,
          { revision: state.revision, kind: "load-more", window: loadMoreWindow(state) },
          false,
        )
      }
      return starting(
        state,
        { revision: state.revision, kind: "refresh", window: refreshWindow(state) },
        false,
      )
    }

    case "load-more-requested": {
      if (!browseCanLoadMore(state)) return noStart(state)
      // User intent is never silently dropped: a load-more asked for during a poll
      // tick is QUEUED and runs when the tick settles.
      if (state.inFlight?.kind === "refresh") {
        return noStart(state.queuedLoadMore ? state : { ...state, queuedLoadMore: true })
      }
      if (state.inFlight !== null) return noStart(state)
      return starting(
        state,
        { revision: state.revision, kind: "load-more", window: loadMoreWindow(state) },
        false,
      )
    }

    case "response": {
      // THE stale-suppression mechanism: a response whose revision is no longer
      // desired is discarded WHOLE — records and total together.
      // Aborting is an optimization layered on top; correctness never depends on it.
      if (event.revision !== state.revision) return noStart(state)
      const base = state.fulfilled?.revision === state.revision ? state.fulfilled.records : []
      const records = withinCap(
        event.kind === "refresh"
          ? reconcileRefreshedWindow(base, event.page.records, {
              // The RESPONSE states its own span: the server issues a token exactly
              // when the window filled, so rule 3 reads the fact off the answer rather
              // than re-deriving it from the limit of the request. Two derivations of
              // one fact can disagree, and this one decides whether a tail beyond the
              // span is retained or dropped out from under the user.
              filled: event.page.continuation !== null,
            })
          : event.kind === "load-more"
            ? dedupeById(base, event.page.records)
            : event.page.records,
      )
      return drainQueuedLoadMore({
        ...state,
        inFlight: null,
        fulfilled: {
          revision: state.revision,
          datasetKey: state.datasetKey,
          records,
          total: event.page.total,
          // The newest token, whatever the kind: a refresh mints one from its own last
          // row, and continuing from an older one would resume a walk the refresh has
          // already moved past.
          continuation: event.page.continuation,
          at: event.at,
        },
        ...clearedError(state, event.kind),
      })
    }

    case "failure": {
      if (event.revision !== state.revision) return noStart(state)
      return drainQueuedLoadMore({
        ...state,
        inFlight: null,
        ...recordedFailure(state, event.kind, event.message),
      })
    }
  }
}
