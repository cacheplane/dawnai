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

export interface BrowseWindow {
  readonly limit: number
  readonly offset: number
}

export interface BrowsePageResponse {
  readonly records: readonly MemoryRecord[]
  readonly total: number
}

/** Records, total and dataset key are stored TOGETHER and tagged with the revision
 *  that produced them. A total that belongs to a different question is the exact
 *  failure this design exists to prevent. */
export interface BrowseFulfillment {
  readonly revision: number
  readonly datasetKey: string
  readonly records: readonly MemoryRecord[]
  readonly total: number
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

const NO_KIND_ERRORS: BrowseKindErrors = {}

/** `revision: 0` is a revision nothing can fulfil and `datasetKey: ""` is a key no
 *  canonical query produces, so the first `query-changed` a mounted hook dispatches
 *  is the SAME transition as any later one. Mount is not a special case. */
export const INITIAL_BROWSE_STATE: BrowseState = {
  revision: 0,
  datasetKey: "",
  fulfilled: null,
  inFlight: null,
  queuedLoadMore: false,
  initialFailure: null,
  kindErrors: NO_KIND_ERRORS,
}

/** Records held FOR THE DESIRED REVISION. An older revision's records are on screen
 *  but are not a base anything new is built on. */
export function browseResidentCount(state: BrowseState): number {
  return state.fulfilled?.revision === state.revision ? state.fulfilled.records.length : 0
}

export function browseCanLoadMore(state: BrowseState): boolean {
  const fulfilled = state.fulfilled
  if (fulfilled === null || fulfilled.revision !== state.revision) return false
  return (
    fulfilled.records.length < fulfilled.total && fulfilled.records.length < BROWSE_RESIDENT_CAP
  )
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

export function browseDataState(state: BrowseState): PretableDataState {
  const phase = browsePhase(state)
  if (phase !== "error") return { phase }
  const message = state.initialFailure?.message
  // Spread rather than `{ phase, message }`: `exactOptionalPropertyTypes` rejects an
  // explicit `undefined` against `message?: string`.
  return { phase, ...(message === undefined ? {} : { message }) }
}

function noStart(state: BrowseState): BrowseTransition {
  return { state, start: null, abort: false }
}

function starting(state: BrowseState, request: BrowseRequest, abort: boolean): BrowseTransition {
  return { state: { ...state, inFlight: request }, start: request, abort }
}

function initialWindow(): BrowseWindow {
  return { limit: BROWSE_PAGE_SIZE, offset: 0 }
}

/** limit = resident count, clamped: never below one page (an empty result still asks
 *  a real question) and never above the cap the route enforces. */
function refreshWindow(state: BrowseState): BrowseWindow {
  const resident = browseResidentCount(state)
  return {
    limit: Math.min(Math.max(resident, BROWSE_PAGE_SIZE), BROWSE_RESIDENT_CAP),
    offset: 0,
  }
}

/** Never asks past the cap: the resident count is not a multiple of the page size
 *  whenever `dedupeById` has dropped a paging duplicate, so a fixed page would ask for
 *  rows the cap then discards. Callers guard on `browseCanLoadMore`, which is what
 *  keeps the limit above zero. */
function loadMoreWindow(state: BrowseState): BrowseWindow {
  const resident = browseResidentCount(state)
  return { limit: Math.min(BROWSE_PAGE_SIZE, BROWSE_RESIDENT_CAP - resident), offset: resident }
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

/** The store issues a continuation exactly when a window fills its limit, and this
 *  event carries no continuation, so the span is re-derived against the request that
 *  produced it — `inFlight` is the only place that limit is held. Single flight keeps
 *  it populated until the response is applied, so a null here is a broken caller, not a
 *  case with a defensible default: either guess decides rule 3, one by dropping a live
 *  tail and the other by pinning a stale one. */
function refreshFilledItsWindow(state: BrowseState, records: readonly MemoryRecord[]): boolean {
  const issued = state.inFlight
  if (issued === null) {
    throw new Error("browse: a refresh response arrived with no request in flight")
  }
  return records.length >= issued.window.limit
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
        // now, so nothing can mistake them for the answer. Every error slot is
        // dropped — each described a dataset that no longer exists.
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
      if (state.inFlight?.kind === "refresh") return noStart({ ...state, queuedLoadMore: true })
      if (state.inFlight !== null) return noStart(state)
      return starting(
        state,
        { revision: state.revision, kind: "load-more", window: loadMoreWindow(state) },
        false,
      )
    }

    case "response": {
      // THE stale-suppression mechanism: a response whose revision is no longer
      // desired is discarded WHOLE — records, total and continuation together.
      // Aborting is an optimization layered on top; correctness never depends on it.
      if (event.revision !== state.revision) return noStart(state)
      const base = state.fulfilled?.revision === state.revision ? state.fulfilled.records : []
      const records = withinCap(
        event.kind === "refresh"
          ? reconcileRefreshedWindow(base, event.page.records, {
              filled: refreshFilledItsWindow(state, event.page.records),
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
