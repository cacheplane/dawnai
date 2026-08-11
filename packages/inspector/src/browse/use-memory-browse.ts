"use client"
import type { MemoryRecord } from "@dawn-ai/memory/browse"
import type { PretableDataState, PretableResultMeta } from "@pretable/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type BrowseEvent,
  type BrowseKindErrors,
  type BrowsePageResponse,
  type BrowseRequest,
  type BrowseState,
  browseDataState,
  browseHasMore,
  browsePhase,
  browseReduce,
  browseRowsAreStale,
  INITIAL_BROWSE_STATE,
} from "./browse-machine"
import {
  browseMatchesNothing,
  browseSearchParams,
  type CanonicalBrowseQuery,
  datasetKeyOf,
} from "./canonical-query"

export const BROWSE_POLL_INTERVAL_MS = 2000

const NO_RECORDS: readonly MemoryRecord[] = []
const EMPTY_PAGE: BrowsePageResponse = { records: NO_RECORDS, total: 0 }
const UNKNOWN_TOTAL_META: PretableResultMeta = { total: { kind: "unknown" } }

export type BrowseFetcher = (
  params: URLSearchParams,
  signal: AbortSignal,
) => Promise<BrowsePageResponse>

/** A 200 is not a page. An unparseable body, an HTML error page from a proxy, a JSON
 *  object shaped like something else — each reaches the reducer as a page it then
 *  destructures, and the throw lands in a promise handler rather than here. Checked at
 *  the boundary, the same body becomes an ordinary request failure with a banner. */
function isBrowsePage(body: unknown): body is BrowsePageResponse {
  if (body === null || typeof body !== "object") return false
  const page = body as { records?: unknown; total?: unknown }
  return Array.isArray(page.records) && typeof page.total === "number"
}

/** GET one browse window, surfacing the API's `{error}` body as the thrown message. */
export async function fetchBrowsePage(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<BrowsePageResponse> {
  const response = await fetch(`/api/memory/list?${params}`, { signal })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `request failed (${response.status})`
    throw new Error(message)
  }
  if (!isBrowsePage(body)) throw new Error(`not a browse page (${response.status})`)
  return body
}

export interface UseMemoryBrowseInput {
  /** MEMOIZE the canonical query. A fresh object per render is harmless (the dataset
   *  key decides), but a `since` recomputed from `Date.now()` on every render would
   *  bump the desired revision on every render and refetch forever. */
  readonly query: CanonicalBrowseQuery
  readonly live: boolean
  readonly pollIntervalMs?: number
  readonly fetchPage?: BrowseFetcher
  readonly now?: () => number
}

export interface UseMemoryBrowseResult {
  readonly rows: readonly MemoryRecord[]
  /** `rows` answer a revision other than the desired one. Gate anything that ACTS on
   *  what is displayed on this, not on `dataState.phase`: `stale` and `error`-with-rows
   *  are the same picture, and only this one covers both. */
  readonly rowsAreStale: boolean
  readonly dataState: PretableDataState
  readonly resultMeta: PretableResultMeta
  /** Matching population for the FULFILLED revision, or null when nothing is
   *  fulfilled. Never the desired revision's — that number does not exist yet. */
  readonly total: number | null
  readonly errors: BrowseKindErrors
  /** Epoch ms of the newest fulfilled response, or null. */
  readonly updatedAt: number | null
  /** Polling is suspended: live off, tab hidden, or a held error. */
  readonly paused: boolean
  /** The server holds matching records that are not resident. NOT a promise that
   *  `loadMore` will fetch them: past the resident cap this stays true while the
   *  machine refuses the request, so a consumer that offers a control must gate it on
   *  the loaded count as well — and say which of the two it is refusing on. */
  readonly hasMore: boolean
  loadMore(): void
  refresh(): void
  retry(): void
}

export function useMemoryBrowse(input: UseMemoryBrowseInput): UseMemoryBrowseResult {
  const { query, live } = input
  const pollIntervalMs = input.pollIntervalMs ?? BROWSE_POLL_INTERVAL_MS
  const datasetKey = useMemo(() => datasetKeyOf(query), [query])

  const [state, setState] = useState<BrowseState>(INITIAL_BROWSE_STATE)

  // Mirrors of the input the async paths read, seeded from the mounting render and
  // written on COMMIT thereafter — NEVER during render. A render React throws away (a
  // transition that suspends), or a dispatch that lands between a commit and its
  // effect flush, would otherwise build params from a query no state ever matched
  // while tagging them with the revision the state still holds — and `browseReduce`
  // ACCEPTS that response, merging one question's rows and total under the other's
  // dataset key. Lagging a render behind within one key is harmless: the key is the
  // JSON of exactly the fields `browseSearchParams` reads.
  const queryRef = useRef(query)
  const fetchRef = useRef<BrowseFetcher>(input.fetchPage ?? fetchBrowsePage)
  const nowRef = useRef<() => number>(input.now ?? Date.now)
  useEffect(() => {
    queryRef.current = query
    fetchRef.current = input.fetchPage ?? fetchBrowsePage
    nowRef.current = input.now ?? Date.now
  })

  // The machine's state lives in a ref as well as in `useState`: dispatches arrive
  // from timers and promise callbacks that must read the CURRENT state, not the one
  // their closure captured.
  const stateRef = useRef<BrowseState>(INITIAL_BROWSE_STATE)
  const controllerRef = useRef<AbortController | null>(null)
  // `dispatch` calls `startRequest` and `startRequest` calls back into `dispatch`, so
  // one of the two has to reach the other through a ref rather than a closure. This
  // one keeps `startRequest` dependency-free, which is what makes `dispatch` stable
  // for the hook's whole lifetime — the interval below depends on that.
  const dispatchRef = useRef<(event: BrowseEvent) => void>(() => {})

  const startRequest = useCallback((request: BrowseRequest) => {
    const current = queryRef.current
    if (browseMatchesNothing(current)) {
      // Answered locally, without a request — see `browseMatchesNothing`.
      dispatchRef.current({
        type: "response",
        revision: request.revision,
        kind: request.kind,
        page: EMPTY_PAGE,
        at: nowRef.current(),
      })
      return
    }
    const failureOf = (error: unknown): BrowseEvent => ({
      type: "failure",
      revision: request.revision,
      kind: request.kind,
      message: error instanceof Error ? error.message : String(error),
    })
    // The reducer asserts its invariants by throwing, and it runs SYNCHRONOUSLY inside
    // these handlers. An escaping throw resolves nothing and never reaches the
    // assignment that clears `inFlight`, so single flight would then skip every later
    // tick, retry and load-more: the hook stops forever, silently, as an unhandled
    // rejection. The failure branch cannot throw, so one recovery is enough.
    const settle = (event: BrowseEvent) => {
      try {
        dispatchRef.current(event)
      } catch (error) {
        dispatchRef.current(failureOf(error))
      }
    }
    const controller = new AbortController()
    controllerRef.current = controller
    void fetchRef.current(browseSearchParams(current, request.window), controller.signal).then(
      (page) => {
        // The reducer discards a superseded response WHOLE on its own revision check,
        // so this is not what makes the answer right; it is what keeps an aborted
        // request from costing anything more, the clock read included.
        if (controller.signal.aborted) return
        if (controllerRef.current === controller) controllerRef.current = null
        settle({
          type: "response",
          revision: request.revision,
          kind: request.kind,
          page,
          at: nowRef.current(),
        })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (controllerRef.current === controller) controllerRef.current = null
        settle(failureOf(error))
      },
    )
  }, [])

  const dispatch = useCallback(
    (event: BrowseEvent) => {
      const transition = browseReduce(stateRef.current, event)
      if (transition.abort && controllerRef.current !== null) {
        controllerRef.current.abort()
        controllerRef.current = null
      }
      stateRef.current = transition.state
      setState(transition.state)
      if (transition.start !== null) startRequest(transition.start)
    },
    [startRequest],
  )
  dispatchRef.current = dispatch

  // Mount and every canonical-query change are the SAME transition: bump the desired
  // revision, abort what was in flight, fetch the first window.
  useEffect(() => {
    const current = stateRef.current
    if (current.datasetKey !== datasetKey) {
      dispatch({ type: "query-changed", datasetKey })
    } else if (
      current.inFlight === null &&
      current.fulfilled === null &&
      current.initialFailure === null
    ) {
      // Re-arm after a StrictMode remount: the cleanup below aborted the mount
      // request without producing a response or a failure, so nothing else would
      // ever move this hook out of `loading`.
      dispatch({ type: "retry" })
    }
    return () => {
      if (controllerRef.current !== null) {
        controllerRef.current.abort()
        controllerRef.current = null
        // Ref only — a setState after unmount is pointless, and the branch above
        // reads this ref to decide whether a remount must re-arm.
        stateRef.current = { ...stateRef.current, inFlight: null, queuedLoadMore: false }
      }
    }
  }, [datasetKey, dispatch])

  const [tabVisible, setTabVisible] = useState(true)
  useEffect(() => {
    const sync = () => setTabVisible(document.visibilityState !== "hidden")
    sync()
    document.addEventListener("visibilitychange", sync)
    return () => document.removeEventListener("visibilitychange", sync)
  }, [])

  const phase = browsePhase(state)
  // A held error suspends polling until `retry()` succeeds: without that, the error
  // presentation would flicker on a 2 s cadence.
  const paused = !live || !tabVisible || phase === "error"

  useEffect(() => {
    if (paused) return
    // Resuming — live back on, tab visible again, a retry that succeeded — ticks NOW
    // rather than up to one interval later. On mount the initial request is already
    // in flight, so the machine skips this tick.
    dispatch({ type: "poll-tick" })
    const id = setInterval(() => dispatch({ type: "poll-tick" }), pollIntervalMs)
    return () => clearInterval(id)
  }, [paused, pollIntervalMs, dispatch])

  const loadMore = useCallback(() => dispatch({ type: "load-more-requested" }), [dispatch])
  // The same event the interval sends, so a press that lands while anything is in
  // flight is SKIPPED by single flight rather than queued: nothing here distinguishes
  // user intent from a timer, and the phase is already `refreshing`, so the press
  // leaves no trace on screen either.
  const refresh = useCallback(() => dispatch({ type: "poll-tick" }), [dispatch])
  const retry = useCallback(() => dispatch({ type: "retry" }), [dispatch])

  const fulfilled = state.fulfilled
  // Keyed on the two VALUES published rather than on the fulfillment that carries them:
  // every response allocates a fresh one, so a 2 s cadence would hand the grid a new
  // `resultMeta` — and with it a dataset pivot — for an answer that did not change.
  const fulfilledKey = fulfilled === null ? null : fulfilled.datasetKey
  const fulfilledTotal = fulfilled === null ? null : fulfilled.total
  const resultMeta = useMemo<PretableResultMeta>(
    () =>
      fulfilledKey === null || fulfilledTotal === null
        ? UNKNOWN_TOTAL_META
        : {
            // The FULFILLED key, never the desired one: the grid must clear selection
            // and focus when the new answer LANDS, not when the question changes — a
            // selection over the old rows is still valid for the old rows.
            datasetKey: fulfilledKey,
            total: { kind: "exact", count: fulfilledTotal },
          },
    [fulfilledKey, fulfilledTotal],
  )
  const dataState = browseDataState(state)

  return {
    rows: fulfilled?.records ?? NO_RECORDS,
    rowsAreStale: browseRowsAreStale(state),
    dataState,
    resultMeta,
    total: fulfilled?.total ?? null,
    errors: state.kindErrors,
    updatedAt: fulfilled?.at ?? null,
    paused,
    hasMore: browseHasMore(state),
    loadMore,
    refresh,
    retry,
  }
}
