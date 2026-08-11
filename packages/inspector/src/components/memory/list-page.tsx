"use client"
import type { MemoryKind, MemoryRecord, MemoryStats, MemoryStatus } from "@dawn-ai/memory"
import type { ColumnFilter } from "@pretable/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { canonicalBrowseQuery } from "../../browse/canonical-query"
import { useMemoryBrowse } from "../../browse/use-memory-browse"
import { Badge } from "../ui/badge"
import { Input } from "../ui/input"
import { usePolling } from "../use-polling"
import { BrowseErrorBanners, type BrowseErrorEntry, BrowseStatusBar } from "./browse-chrome"
import { BulkBar } from "./bulk-bar"
import { resolveFilter, toFilter, type ValueSet } from "./column-filters"
import { DetailSheet } from "./detail-sheet"
import { FacetRail } from "./facet-rail"
import { KINDS, MemoryGrid, STATUSES } from "./memory-grid"
import { TimelineView } from "./timeline-view"

interface SearchResponse {
  readonly groups: readonly {
    readonly namespace: string
    readonly records: readonly MemoryRecord[]
  }[]
  readonly hybrid?: boolean
}

/** Each source owns its own error slot — a stats success must not clear a search
 *  failure's banner. The browse REQUEST kinds (refresh, load-more) keep their own
 *  slots inside `useMemoryBrowse`, and a bulk mutation's failures stay with the bar
 *  that lists which ids failed and why. */
type ErrorSource = "stats" | "search"

/** Timeline window presets → milliseconds back from now ("all" = unbounded). */
const WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const
type TimelineWindow = keyof typeof WINDOWS | "all"

const selectClass =
  "h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-300"

export function ListPage() {
  const [namespace, setNamespace] = useState<string>()
  // undefined = unfiltered, [] = matches nothing — the same distinction the
  // store's BrowseQuery draws, so an emptied funnel cannot read as "show all".
  const [status, setStatus] = useState<ValueSet<MemoryStatus>>(undefined)
  const [kind, setKind] = useState<ValueSet<MemoryKind>>(undefined)
  const [query, setQuery] = useState("")
  const [view, setView] = useState<"list" | "timeline">("list")
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow>("all")
  const [live, setLive] = useState(true)
  const [selectedId, setSelectedId] = useState<string>()
  const [ticked, setTicked] = useState<readonly string[]>([])
  const [errors, setErrors] = useState<Partial<Record<ErrorSource, string>>>({})
  const [search, setSearch] = useState<SearchResponse>()

  const setError = useCallback((source: ErrorSource, message: string | undefined) => {
    setErrors((prev) => (prev[source] === message ? prev : { ...prev, [source]: message }))
  }, [])

  /** Fetch JSON; on failure surface the API's {error} body in this source's
   *  banner slot, on success clear only that slot. */
  const fetchJson = useCallback(
    async <T,>(source: ErrorSource, url: string): Promise<T> => {
      let res: Response
      try {
        res = await fetch(url)
      } catch (err) {
        setError(source, err instanceof Error ? err.message : String(err))
        throw err
      }
      const body: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        const message =
          body &&
          typeof body === "object" &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `request failed (${res.status})`
        setError(source, message)
        throw new Error(message)
      }
      setError(source, undefined)
      return body as T
    },
    [setError],
  )

  const statsFn = useCallback(
    () => fetchJson<MemoryStats>("stats", "/api/memory/stats"),
    [fetchJson],
  )

  const filters = useMemo(() => {
    const next: Record<string, ColumnFilter> = {}
    const statusFilter = toFilter(status, STATUSES)
    if (statusFilter) next.status = statusFilter
    const kindFilter = toFilter(kind, KINDS)
    if (kindFilter) next.kind = kindFilter
    return next
  }, [status, kind])

  const handleFiltersChange = useCallback((next: Record<string, ColumnFilter>) => {
    setStatus(resolveFilter(next.status, STATUSES))
    setKind(resolveFilter(next.kind, KINDS))
  }, [])

  // PINNED at the moment the window changes, not recomputed per render: `since` is
  // part of the dataset identity, so a fresh `Date.now()` on every render would bump
  // the desired revision on every render and refetch forever.
  const since = useMemo(
    () =>
      view === "timeline" && timelineWindow !== "all"
        ? new Date(Date.now() - WINDOWS[timelineWindow]).toISOString()
        : undefined,
    [view, timelineWindow],
  )

  const browseQuery = useMemo(
    () =>
      canonicalBrowseQuery({
        view,
        ...(namespace === undefined ? {} : { namespace }),
        ...(status === undefined ? {} : { status }),
        ...(kind === undefined ? {} : { kind }),
        ...(since === undefined ? {} : { since }),
      }),
    [view, namespace, status, kind, since],
  )

  // Search replaces the browse view entirely, so browse stops polling behind it.
  const browse = useMemoryBrowse({ query: browseQuery, live: live && !query })
  const { refresh: refreshBrowse, retry: retryBrowse } = browse
  const browsePhase = browse.dataState.phase

  // `refreshBrowse` is the same poll tick the interval sends, so single flight DROPS it
  // whenever a request is already running — and with `live` off there is no next tick
  // to cover the skip, which leaves the row a mutation just changed on screen for good.
  // Hold the intent instead and spend it once the browse can take it.
  const [refreshRequested, setRefreshRequested] = useState(0)
  const refreshServed = useRef(0)
  const requestRefresh = useCallback(() => setRefreshRequested((n) => n + 1), [])
  useEffect(() => {
    // `idle` is exactly the state a poll tick starts a request from: the desired
    // revision is fulfilled and nothing is in flight.
    if (refreshServed.current === refreshRequested || browsePhase !== "idle") return
    refreshServed.current = refreshRequested
    refreshBrowse()
  }, [refreshRequested, browsePhase, refreshBrowse])

  const stats = usePolling(statsFn, 2000, live)

  // Search is fetched once per (debounced) query change, never polled — a
  // hybrid store would call the embedder on every search request.
  useEffect(() => {
    if (!query) {
      setSearch(undefined)
      setError("search", undefined)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query })
      if (namespace) params.set("namespace", namespace)
      fetchJson<SearchResponse>("search", `/api/memory/search?${params}`)
        .then((result) => {
          if (alive) setSearch(result)
        })
        .catch(() => {
          // Drop stale results — showing matches for a previous query beside a
          // failure banner would misattribute them to the current one.
          if (alive) setSearch(undefined)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, namespace, fetchJson, setError])

  // Stable identities: DetailSheet subscribes a window keydown listener keyed
  // on onClose — inline closures would re-subscribe it every poll tick.
  const closeSheet = useCallback(() => setSelectedId(undefined), [])
  const handleMutated = useCallback(() => {
    setSelectedId(undefined)
    requestRefresh()
  }, [requestRefresh])
  // The grid keeps its own checkbox state, so clearing here would leave the
  // boxes ticked. Remounting it (see `key` below) is what actually resets both.
  const [gridEpoch, setGridEpoch] = useState(0)
  const clearTicked = useCallback(() => {
    setTicked([])
    setGridEpoch((n) => n + 1)
  }, [])
  const handleBulkDone = useCallback(
    ({ failed }: { failed: number }) => {
      // Keep the selection when anything failed: clearing it unmounts the bar, and the
      // bar is the only channel carrying WHICH ids failed and why.
      if (failed === 0) clearTicked()
      requestRefresh()
    },
    [clearTicked, requestRefresh],
  )

  const byStatus = stats?.byStatus ?? {}
  // Filtering here would make "N loaded of M matching" a lie the moment a facet was
  // clicked: the request carries the EXACT namespace, so the rows and `total` already
  // describe the same set.
  const pageRecords = browse.records
  // Group headers count the rows the grid HOLDS. On a truncated window that count is
  // an artifact of where the cap fell, so group only when the window is the whole
  // answer; the facet rail stays the honest navigator for anything larger.
  const pageIsComplete = browse.total !== null && pageRecords.length >= browse.total
  const filtersActive = status !== undefined || kind !== undefined || namespace !== undefined
  // "Nothing stored" and "nothing matches what you asked for" are different answers;
  // telling a filtered view to go run its agent sends you looking for a bug that
  // isn't there.
  const emptyMessage = filtersActive
    ? "No memories match these filters."
    : "No memories yet — run your agent and watch them appear."
  const searching = query.length > 0
  const dataState = browse.dataState
  // The grid's body-state block owns the error PHASE, and the timeline has no such
  // block — this entry is the only channel a timeline failure has. Exactly one of the
  // two surfaces is mounted, so one failure still gets one retry control.
  const timelineFailure =
    !searching && view === "timeline" && dataState.phase === "error"
      ? (dataState.message ?? "Could not load memories.")
      : undefined
  const browseRequestFailed =
    browse.errors.refresh !== undefined || browse.errors["load-more"] !== undefined
  const errorEntries: BrowseErrorEntry[] = [
    ...Object.entries(errors).flatMap(([source, message]) =>
      message ? [{ source, message }] : [],
    ),
    ...(timelineFailure === undefined ? [] : [{ source: "browse", message: timelineFailure }]),
    ...(browse.errors.refresh === undefined
      ? []
      : [{ source: "refresh", message: `Refresh failed: ${browse.errors.refresh}` }]),
    ...(browse.errors["load-more"] === undefined
      ? []
      : [{ source: "load-more", message: `Loading more failed: ${browse.errors["load-more"]}` }]),
  ]

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3">
        <h1 className="text-sm font-semibold">Memory Inspector</h1>
        <div className="flex items-center gap-1.5">
          {STATUSES.map((s) => (
            <Badge key={s} variant={s}>
              {byStatus[s] ?? 0} {s}
            </Badge>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset carries form semantics and default chrome; this is a segmented view toggle, for which role=group on a div is the standard pattern */}
          <div
            role="group"
            aria-label="View"
            className="flex overflow-hidden rounded-md border border-zinc-200"
          >
            {(["list", "timeline"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`h-9 px-3 text-sm ${
                  view === v ? "bg-zinc-900 text-white" : "bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          {view === "timeline" ? (
            <select
              aria-label="Window"
              value={timelineWindow}
              onChange={(e) => setTimelineWindow(e.target.value as TimelineWindow)}
              className={selectClass}
            >
              {(["24h", "7d", "30d", "all"] as const).map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          ) : null}
          <Input
            type="search"
            aria-label="Search memories"
            placeholder="Search memories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-64"
          />
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            live
          </label>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <FacetRail stats={stats} selected={namespace} onSelect={setNamespace} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          <BrowseErrorBanners
            errors={errorEntries}
            {...(browseRequestFailed || timelineFailure !== undefined
              ? { onRetry: retryBrowse }
              : {})}
          />
          {searching ? null : (
            <BrowseStatusBar
              loaded={pageRecords.length}
              total={browse.total}
              phase={browsePhase}
              asOf={browse.paused ? browse.updatedAt : null}
            />
          )}
          {searching ? (
            search && search.groups.length > 0 ? (
              <div className="space-y-4">
                {search.groups.map((group) => (
                  <section key={group.namespace}>
                    <h2 className="mb-1.5 font-mono text-xs font-medium text-zinc-500">
                      {group.namespace}
                    </h2>
                    <MemoryGrid records={group.records} onSelect={setSelectedId} />
                  </section>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-zinc-400">No matches.</p>
            )
          ) : view === "timeline" ? (
            // TimelineView owns its empty state ("No episodes in this window.") — but
            // that copy is an ANSWER, so it must not stand in for one that has not
            // arrived, or for one that failed.
            browsePhase === "loading" ? (
              <p data-testid="browse-loading" className="p-4 text-sm text-zinc-400">
                Loading memories…
              </p>
            ) : timelineFailure !== undefined && pageRecords.length === 0 ? null : (
              <TimelineView records={pageRecords} onSelect={setSelectedId} />
            )
          ) : (
            <MemoryGrid
              key={gridEpoch}
              records={pageRecords}
              onSelect={setSelectedId}
              onTickedChange={setTicked}
              // Only while looking at everything: scoped to one namespace by the
              // rail, every row would sit under a single group header.
              groupByNamespace={namespace === undefined && pageIsComplete}
              // Filtering is server-side: the funnels only decide the query.
              filters={filters}
              onFiltersChange={handleFiltersChange}
              dataState={dataState}
              resultMeta={browse.resultMeta}
              emptyMessage={emptyMessage}
              onRetry={retryBrowse}
            />
          )}
        </main>
      </div>
      {ticked.length > 0 ? (
        <BulkBar
          ticked={ticked}
          records={pageRecords}
          onDone={handleBulkDone}
          onClear={clearTicked}
        />
      ) : null}
      {selectedId ? (
        // key remounts the sheet when the selection changes — otherwise record
        // A's conflict callout/error state would bleed into record B's sheet.
        <DetailSheet
          key={selectedId}
          id={selectedId}
          onClose={closeSheet}
          onMutated={handleMutated}
        />
      ) : null}
    </div>
  )
}
