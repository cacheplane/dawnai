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
  browseCanLoadMore,
  browseDataState,
  browsePhase,
  browseReduce,
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
  return body as BrowsePageResponse
}

export interface UseMemoryBrowseOptions {
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
  readonly records: readonly MemoryRecord[]
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
  readonly canLoadMore: boolean
  loadMore(): void
  refresh(): void
  retry(): void
}

export function useMemoryBrowse(options: UseMemoryBrowseOptions): UseMemoryBrowseResult {
  const { query, live } = options
  const pollIntervalMs = options.pollIntervalMs ?? BROWSE_POLL_INTERVAL_MS
  const datasetKey = useMemo(() => datasetKeyOf(query), [query])

  const [state, setState] = useState<BrowseState>(INITIAL_BROWSE_STATE)

  // Render-time mirrors of values the async paths read. Each is a pure copy of
  // something this render already holds, so a re-render can only re-copy the same
  // thing — the pattern is safe precisely because nothing else writes them.
  const queryRef = useRef(query)
  queryRef.current = query
  const fetchRef = useRef<BrowseFetcher>(fetchBrowsePage)
  fetchRef.current = options.fetchPage ?? fetchBrowsePage
  const nowRef = useRef<() => number>(Date.now)
  nowRef.current = options.now ?? Date.now

  // The machine's state lives in a ref as well as in `useState`: dispatches arrive
  // from timers and promise callbacks that must read the CURRENT state, not the one
  // their closure captured.
  const stateRef = useRef<BrowseState>(INITIAL_BROWSE_STATE)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)
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
    const controller = new AbortController()
    controllerRef.current = controller
    void fetchRef.current(browseSearchParams(current, request.window), controller.signal).then(
      (page) => {
        if (controller.signal.aborted || !mountedRef.current) return
        if (controllerRef.current === controller) controllerRef.current = null
        dispatchRef.current({
          type: "response",
          revision: request.revision,
          kind: request.kind,
          page,
          at: nowRef.current(),
        })
      },
      (error: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return
        if (controllerRef.current === controller) controllerRef.current = null
        dispatchRef.current({
          type: "failure",
          revision: request.revision,
          kind: request.kind,
          message: error instanceof Error ? error.message : String(error),
        })
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
    mountedRef.current = true
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
      mountedRef.current = false
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

  const tickRef = useRef(() => {})
  tickRef.current = () => dispatch({ type: "poll-tick" })

  useEffect(() => {
    if (paused) return
    // Resuming — live back on, tab visible again, a retry that succeeded — ticks NOW
    // rather than up to one interval later. On mount the initial request is already
    // in flight, so the machine skips this tick.
    tickRef.current()
    const id = setInterval(() => tickRef.current(), pollIntervalMs)
    return () => clearInterval(id)
  }, [paused, pollIntervalMs])

  const loadMore = useCallback(() => dispatch({ type: "load-more-requested" }), [dispatch])
  const refresh = useCallback(() => dispatch({ type: "poll-tick" }), [dispatch])
  const retry = useCallback(() => dispatch({ type: "retry" }), [dispatch])

  const fulfilled = state.fulfilled
  const resultMeta = useMemo<PretableResultMeta>(
    () =>
      fulfilled === null
        ? UNKNOWN_TOTAL_META
        : {
            // The FULFILLED key, never the desired one: the grid must clear selection
            // and focus when the new answer LANDS, not when the question changes — a
            // selection over the old rows is still valid for the old rows.
            datasetKey: fulfilled.datasetKey,
            total: { kind: "exact", count: fulfilled.total },
          },
    [fulfilled],
  )
  const dataState = useMemo(() => browseDataState(state), [state])

  return {
    records: fulfilled?.records ?? NO_RECORDS,
    dataState,
    resultMeta,
    total: fulfilled?.total ?? null,
    errors: state.kindErrors,
    updatedAt: fulfilled?.at ?? null,
    paused,
    canLoadMore: browseCanLoadMore(state),
    loadMore,
    refresh,
    retry,
  }
}
