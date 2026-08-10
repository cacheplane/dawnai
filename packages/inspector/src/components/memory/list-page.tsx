"use client"
import type { MemoryKind, MemoryRecord, MemoryStats, MemoryStatus } from "@dawn-ai/memory"
import type { ColumnFilter } from "@pretable/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge } from "../ui/badge"
import { Input } from "../ui/input"
import { usePolling } from "../use-polling"
import { BulkBar } from "./bulk-bar"
import { resolveFilter, toFilter, type ValueSet } from "./column-filters"
import { DetailSheet } from "./detail-sheet"
import { FacetRail } from "./facet-rail"
import { KINDS, MemoryGrid, STATUSES } from "./memory-grid"
import { TimelineView } from "./timeline-view"

interface ListResponse {
  readonly records: readonly MemoryRecord[]
  readonly total: number
}
interface SearchResponse {
  readonly groups: readonly {
    readonly namespace: string
    readonly records: readonly MemoryRecord[]
  }[]
  readonly hybrid?: boolean
}

/** Each fetcher owns its own error slot — a stats success must not clear a
 *  search failure's banner (they poll on independent cadences). */
type ErrorSource = "stats" | "list" | "search"

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
  const [refreshKey, setRefreshKey] = useState(0)
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

  const pageFn = useCallback(() => {
    // refreshKey exists only to change this callback's identity after a
    // mutation, so usePolling re-runs its immediate tick.
    void refreshKey
    const params = new URLSearchParams({ limit: "200" })
    if (namespace) params.set("namespacePrefix", namespace)
    for (const value of status ?? []) params.append("status", value)
    // Timeline is an episode view — default the kind filter to episodic there
    // (the kind funnel still overrides), and thread the client-computed window.
    const effectiveKind = kind ?? (view === "timeline" ? (["episodic"] as const) : undefined)
    for (const value of effectiveKind ?? []) params.append("kind", value)
    if (view === "timeline" && timelineWindow !== "all") {
      params.set("since", new Date(Date.now() - WINDOWS[timelineWindow]).toISOString())
    }
    // A set narrowed to nothing matches nothing. Over HTTP a param that appears
    // zero times is *absent*, so the request would come back unfiltered —
    // answer it here instead of asking a question that means the opposite.
    if (status?.length === 0 || effectiveKind?.length === 0) {
      return Promise.resolve<ListResponse>({ records: [], total: 0 })
    }
    return fetchJson<ListResponse>("list", `/api/memory/list?${params}`)
  }, [fetchJson, namespace, status, kind, view, timelineWindow, refreshKey])

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

  const stats = usePolling(statsFn, 2000, live)
  const page = usePolling(pageFn, 2000, live && !query)

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
    setRefreshKey((k) => k + 1)
  }, [])
  // The grid keeps its own checkbox state, so clearing here would leave the
  // boxes ticked. Remounting it (see `key` below) is what actually resets both.
  const [gridEpoch, setGridEpoch] = useState(0)
  const clearTicked = useCallback(() => {
    setTicked([])
    setGridEpoch((n) => n + 1)
  }, [])
  const handleBulkDone = useCallback(
    ({ failed }: { failed: number }) => {
      // Keep the selection when anything failed: clearing it unmounts the bar,
      // and the report of what went wrong goes with it.
      if (failed === 0) clearTicked()
      setRefreshKey((k) => k + 1)
    },
    [clearTicked],
  )

  const byStatus = stats?.byStatus ?? {}
  // The list API narrows by namespace PREFIX (server-side); a selected facet is
  // an exact namespace, so filter the fetched page exactly — otherwise picking
  // route=/chat would also show route=/chat2.
  const pageRecords = namespace
    ? (page?.records ?? []).filter((rec) => rec.namespace === namespace)
    : (page?.records ?? [])
  const searching = query.length > 0
  // Keyed by source, not message — two fetchers failing with the same message
  // must not produce duplicate React keys (or stacked repeats).
  const errorEntries = Object.entries(errors).filter((entry): entry is [ErrorSource, string] =>
    Boolean(entry[1]),
  )

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
          {errorEntries.length > 0 ? (
            <div
              role="alert"
              className="mb-3 space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {errorEntries.map(([source, message]) => (
                <div key={source}>{message}</div>
              ))}
            </div>
          ) : null}
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
            // TimelineView owns its empty state ("No episodes in this window.").
            <TimelineView records={pageRecords} onSelect={setSelectedId} />
          ) : pageRecords.length > 0 ? (
            <MemoryGrid
              key={gridEpoch}
              records={pageRecords}
              onSelect={setSelectedId}
              onTickedChange={setTicked}
              // Filtering is server-side: the funnels only decide the query.
              filters={filters}
              onFiltersChange={handleFiltersChange}
            />
          ) : status !== undefined || kind !== undefined || namespace !== undefined ? (
            // "Nothing stored" and "nothing matches what you asked for" are
            // different answers; telling a filtered view to go run its agent
            // sends you looking for a bug that isn't there.
            <p className="py-8 text-center text-sm text-zinc-400" data-testid="no-matches">
              No memories match these filters.
            </p>
          ) : (
            <p className="py-8 text-center text-sm text-zinc-400">
              No memories yet — run your agent and watch them appear.
            </p>
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
