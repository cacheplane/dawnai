"use client"
import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import type { ColumnFilter, PretableGrid, PretableSortEntry } from "@pretable/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { canonicalBrowseQuery } from "../../browse/canonical-query"
import { useMemoryBrowse } from "../../browse/use-memory-browse"
import { Badge } from "../ui/badge"
import { Input } from "../ui/input"
import { usePolling } from "../use-polling"
import { BrowseErrorBanners, type BrowseErrorEntry, BrowseStatusBar } from "./browse-chrome"
import { loadMoreState } from "./browse-window"
import { BulkBar } from "./bulk-bar"
import { DetailSheet } from "./detail-sheet"
import { FacetRail } from "./facet-rail"
import { LoadMoreFooter } from "./load-more-footer"
import { STATUSES } from "./memory-domain"
import { type GridRow, MemoryGrid } from "./memory-grid"
import { TimelineView } from "./timeline-view"
import { capSortEntries, MAX_BROWSE_SORT_ENTRIES, toBrowseQuery } from "./to-browse-query"

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

/** The window's lower bound, read from the clock ONCE per pin. Callers must hold the
 *  result in state: `since` is part of the dataset identity, and a `Date.now()`
 *  re-read on a later render would mint a new identity and refetch forever. */
function sinceFor(window: TimelineWindow): string | undefined {
  return window === "all" ? undefined : new Date(Date.now() - WINDOWS[window]).toISOString()
}

/** Inactive states are keyed on `aria-disabled`, never on a `searching` branch:
 *  these controls are deliberately never natively `disabled` (that removes them
 *  from the tab order and hides the reason with them), so without a rule keyed on
 *  the marker they render identically to the active ones and still answer hover. */
const INACTIVE_CLASS = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50"

const selectClass = `h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-300 ${INACTIVE_CLASS}`

/** The sentence the load-more footer renders beside itself and points its OWN
 *  `aria-describedby` at — it owns a reason element because it sits far down the
 *  page from the note below. The header controls point at `#browse-scope-note`
 *  instead, which additionally names WHICH controls are inert. Two elements, and
 *  both must carry "not applied to search": `aria-describedby` is the only channel
 *  a keyboard or AT user has for the reason, since `aria-disabled` is what keeps
 *  these controls reachable in the first place. */
const BROWSE_ONLY_REASON = "Not applied to search"

export function ListPage() {
  const [namespace, setNamespace] = useState<string>()
  // The grid's own vocabulary, held verbatim. The ValueSet round-trip this
  // replaced existed only because the store could not express operators; it can
  // now, so there is exactly ONE translation (`toBrowseQuery`) and it happens
  // where the request is built.
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({})
  const [sort, setSort] = useState<PretableSortEntry[]>([])
  const [sortCapped, setSortCapped] = useState(false)
  const [query, setQuery] = useState("")
  const [view, setView] = useState<"list" | "timeline">("list")
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow>("all")
  const [timelineSince, setTimelineSince] = useState<string>()
  const chooseTimelineWindow = useCallback((next: TimelineWindow) => {
    setTimelineWindow(next)
    setTimelineSince(sinceFor(next))
  }, [])
  /** Re-pin on ENTRY as well as on the select. The label names a window ending NOW,
   *  and the instant behind it was taken whenever the select last moved — leave and
   *  return and "24h" would describe a window that closed hours ago, kept warm by
   *  live polling. Entry only, so re-clicking the button you are already on is not a
   *  refetch. */
  const chooseView = useCallback(
    (next: "list" | "timeline") => {
      if (next === "timeline" && view !== "timeline") setTimelineSince(sinceFor(timelineWindow))
      setSortCapped(false)
      setView(next)
    },
    [view, timelineWindow],
  )
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

  /** The cap notice explains ONE sort click, so every OTHER control that moves the
   *  query retires it — left standing it would explain an action several steps in the
   *  past, about a column the user can no longer see declined. That is why these are
   *  wrappers and not the setters themselves. */
  const handleFiltersChange = useCallback((next: Record<string, ColumnFilter>) => {
    setSortCapped(false)
    setFilters(next)
  }, [])

  const chooseNamespace = useCallback((next: string | undefined) => {
    setSortCapped(false)
    setNamespace(next)
  }, [])

  /** Pretable's shift-click appends the new key at the LOWEST priority, so a
   *  fourth key is the one declined and the ordering the user already built
   *  survives. The notice is what keeps that honest: the control did something,
   *  and the page says what. */
  const handleSortChange = useCallback((next: PretableSortEntry[]) => {
    setSortCapped(next.length > MAX_BROWSE_SORT_ENTRIES)
    // Copied, not aliased: `capSortEntries` hands back its ARGUMENT when the sort
    // already fits, and that array is pretable's.
    setSort([...capSortEntries(next)])
  }, [])

  const browseQuery = useMemo(() => {
    const intent = toBrowseQuery(filters, sort)
    return canonicalBrowseQuery({
      view,
      // EXACT namespace, not a prefix: the rail selects one namespace and the
      // server answers that question itself, so the rows and `total` describe the
      // same set with no client-side narrowing after the fact.
      ...(namespace === undefined ? {} : { namespace }),
      // Funnels travel between the views — they narrow the same question either one
      // asks, and the rail that sets `namespace` is on screen in both. The header
      // sort does NOT: `orderBy` decides which rows the window holds, not just their
      // order, and `TimelineView` re-sorts what arrives by event time. Carried over,
      // it would swap the sample under an unchanged window label, for a control that
      // view does not show.
      ...(intent.filters === undefined ? {} : { filters: intent.filters }),
      ...(view === "list" && intent.orderBy !== undefined ? { orderBy: intent.orderBy } : {}),
      ...(view === "timeline" && timelineSince !== undefined ? { since: timelineSince } : {}),
    })
  }, [filters, sort, namespace, view, timelineSince])

  // Search replaces the browse view entirely, so browse stops polling behind it.
  const browse = useMemoryBrowse({ query: browseQuery, live: live && !query })
  const { refresh: refreshBrowse, retry: retryBrowse } = browse
  const browsePhase = browse.dataState.phase
  // The hook's own `total`, not a second derivation out of `resultMeta` — both gate
  // on the same fulfillment, and this component already reads `browse.total` for the
  // status bar and the grouping gate. Two derivations of one number is how two
  // surfaces end up quoting different populations for the same answer.
  const loadedTotal = browse.total ?? undefined
  const footerState = loadMoreState({
    phase: browse.dataState.phase,
    loaded: browse.rows.length,
    hasMore: browse.hasMore,
  })

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
  // The engine owns selection; clearing it here is one call, and every other
  // clear happens on its own: a query change pivots `datasetKey`, and the engine
  // drops selection, focus and group expansion as part of that single emit.
  const gridRef = useRef<PretableGrid<GridRow> | null>(null)
  const browseRegionRef = useRef<HTMLDivElement>(null)
  const handleGridReady = useCallback((grid: PretableGrid<GridRow>) => {
    gridRef.current = grid
  }, [])
  // An empty selection, not `clearSelection()`: that one COLLAPSES the selection onto
  // the focused cell whenever focus sits on a data cell — which a row click always
  // leaves it doing — so the row keeps a one-column span and paints an indeterminate
  // box, and the bar that owned the clear is already gone by then.
  const clearTicked = useCallback(() => {
    gridRef.current?.setSelection({ ranges: [], anchor: null })
    setTicked([])
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
  const filtersActive = Object.keys(filters).length > 0 || namespace !== undefined
  // "Nothing stored" and "nothing matches what you asked for" are different answers;
  // telling a filtered view to go run its agent sends you looking for a bug that
  // isn't there.
  const emptyMessage = filtersActive
    ? "No memories match these filters."
    : "No memories yet — run your agent and watch them appear."
  const searching = query.length > 0
  const dataState = browse.dataState
  // The browse grid is MOUNTED in every view (Flow 10) and VISIBLE in only one of
  // them. Everything keyed on this reads "the grid is in the document, and nobody
  // can see it or reach it".
  const browseSurfaceHidden = searching || view === "timeline"
  // The grid's body-state block owns the error PHASE only while the grid is
  // VISIBLE; hidden, that block is in the document and unreadable, and this entry
  // is the failure's only channel. A retry offered for THIS entry can never sit
  // beside the grid's own, because the condition that produces it is the one that
  // hides the block.
  const hiddenSurfaceFailure =
    browseSurfaceHidden && dataState.phase === "error"
      ? (dataState.message ?? "Could not load memories.")
      : undefined
  // Pretable's live region is portaled to <body> — OUTSIDE the hidden region — and
  // its announcement effect fires on every phase transition with no visibility
  // gate. The facet stays active during a search, so the hidden grid really does
  // refetch, and an unfrozen phase would read a count for a population nobody can
  // see at the exact moment `BrowseStatusBar` is withholding the same number from
  // sighted users. Rows are NOT frozen: they announce nothing, and the grid has to
  // be current the instant it is revealed.
  const lastVisibleDataState = useRef(dataState)
  useEffect(() => {
    if (!browseSurfaceHidden) lastVisibleDataState.current = dataState
  })
  const gridDataState = browseSurfaceHidden ? lastVisibleDataState.current : dataState

  // `hidden` is `display: none`, which destroys the scroll box: the element comes
  // back at 0 while the engine's snapshot still holds the offset it had, so the
  // virtualizer paints the rows for that offset over a viewport at the top — a
  // blank body until some later scroll event resyncs the two. The engine is the
  // authority on where the browse is, so re-assert it on the way back in. Writing
  // `scrollTop` fires a scroll event, which is how the engine learns it agreed.
  useEffect(() => {
    if (browseSurfaceHidden) return
    const viewport = browseRegionRef.current?.querySelector<HTMLElement>(
      "[data-pretable-scroll-viewport]",
    )
    const scrollTop = gridRef.current?.getSnapshot().viewport.scrollTop
    if (!viewport || scrollTop === undefined) return
    viewport.scrollTop = scrollTop
  }, [browseSurfaceHidden])

  const browseRequestFailed =
    browse.errors.refresh !== undefined || browse.errors["load-more"] !== undefined
  const errorEntries: BrowseErrorEntry[] = [
    ...Object.entries(errors).flatMap(([source, message]) =>
      message ? [{ source, message }] : [],
    ),
    ...(hiddenSurfaceFailure === undefined
      ? []
      : [{ source: "browse", message: hiddenSurfaceFailure }]),
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
                aria-disabled={searching ? "true" : undefined}
                {...(searching ? { "aria-describedby": "browse-scope-note" } : {})}
                onClick={() => {
                  if (searching) return
                  chooseView(v)
                }}
                className={`h-9 px-3 text-sm ${INACTIVE_CLASS} ${
                  view === v
                    ? "bg-zinc-900 text-white"
                    : `bg-white text-zinc-600 ${searching ? "" : "hover:bg-zinc-50"}`
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
              aria-disabled={searching ? "true" : undefined}
              {...(searching ? { "aria-describedby": "browse-scope-note" } : {})}
              onChange={(e) => {
                if (searching) return
                chooseTimelineWindow(e.target.value as TimelineWindow)
              }}
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
            onChange={(e) => {
              // Search replaces the surface the notice describes, and the notice
              // explains ONE header click — left standing it comes back when the
              // search clears, explaining an action several steps in the past.
              setSortCapped(false)
              setQuery(e.target.value)
            }}
            className="w-64"
          />
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            live
          </label>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <FacetRail stats={stats} selected={namespace} onSelect={chooseNamespace} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          <BrowseErrorBanners
            errors={errorEntries}
            {...(browseRequestFailed || hiddenSurfaceFailure !== undefined
              ? { onRetry: retryBrowse }
              : {})}
          />
          {searching ? null : (
            <BrowseStatusBar
              loaded={browse.rows.length}
              total={browse.total}
              phase={browsePhase}
              asOf={browse.paused ? browse.updatedAt : null}
            />
          )}
          {/* Named one at a time, and only the ones THIS view shows — a note listing
              a control the user cannot see reads as one more thing that broke.
              §8.2 asks for the browse funnels themselves to be `aria-disabled` +
              focusable + described here; they live inside the grid, and the grid is
              inside the hidden region below, so they are unreachable rather than
              reachable-and-marked. That meets the requirement's purpose (nothing
              looks active while it is ignored) but not its letter, and this note is
              what carries the reason in their place — which is why it has to name
              the column filters the search request drops. */}
          <p
            id="browse-scope-note"
            hidden={!searching}
            className="mb-2 text-xs text-zinc-500"
            data-testid="browse-scope-note"
          >
            Search ranks active memories, and the namespace facet applies to it. Column filters, the
            view toggle
            {view === "timeline" ? ", the timeline window" : ""} and the load-more control are not
            applied to search.
          </p>
          {searching ? (
            search && search.groups.length > 0 ? (
              <div className="space-y-4">
                {search.groups.map((group) => (
                  <section key={group.namespace}>
                    <h2 className="mb-1.5 font-mono text-xs font-medium text-zinc-500">
                      {group.namespace}
                    </h2>
                    {/* No dataState, so the grid picks SEARCH_COLUMNS: sorting a
                        group locally is honest (a group IS its whole result set)
                        but filtering it is not — these rows are the store's
                        ranked top-8, not everything that matches. */}
                    <MemoryGrid records={group.records} onSelect={setSelectedId} />
                  </section>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-zinc-400">No matches.</p>
            )
          ) : null}
          {/* Wrapped so a test can scope to this surface: the timeline draws the SAME
              rows as the hidden grid beside it, and its lifecycle block carries the
              same test id, so both are in the document at once. */}
          {searching || view === "list" ? null : (
            <div data-testid="timeline-region">
              {/* TimelineView owns its empty state ("No episodes in this window.") —
                  but that copy is an ANSWER, so it must not stand in for one that has
                  not arrived, or for one that failed. */}
              {browsePhase === "loading" ? (
                <p data-testid="browse-loading" className="p-4 text-sm text-zinc-400">
                  Loading memories…
                </p>
              ) : hiddenSurfaceFailure !== undefined && browse.rows.length === 0 ? null : (
                <TimelineView records={browse.rows} onSelect={setSelectedId} />
              )}
            </div>
          )}
          {/* The browse surface stays MOUNTED across EVERY view switch (Flow 10).
              Hiding rather than unmounting keeps the engine-owned selection, focus,
              scroll offset and id-keyed measured row heights alive, and `hidden`
              also takes the whole subtree out of the tab order — so nothing inside
              it can be a control that looks active while it is being ignored.

              The price is that these rows are in the document alongside whichever
              surface replaced them, and the search results overlap them by
              construction. Invisible and outside the a11y tree, but NOT outside a
              document-wide text query: anything asserting on row text has to scope
              itself to the surface it means, or the hidden copy will answer. */}
          <div data-testid="browse-region" hidden={browseSurfaceHidden} ref={browseRegionRef}>
            {sortCapped ? (
              <p role="status" className="mb-2 text-xs text-zinc-500" data-testid="sort-cap-notice">
                {`Sorting is limited to ${MAX_BROWSE_SORT_ENTRIES} columns. The extra column was not added.`}
              </p>
            ) : null}
            <MemoryGrid
              onGridReady={handleGridReady}
              records={browse.rows}
              onSelect={setSelectedId}
              onTickedChange={setTicked}
              // Only while looking at everything: scoped to one namespace by the
              // rail, every row would sit under a single group header. A partial
              // window no longer withholds the structure — the counts say
              // "loaded" and claim nothing about the population.
              groupByNamespace={namespace === undefined}
              // Both are server-side: the funnels and the headers only decide the
              // query, and these props are what the grid DISPLAYS while it waits.
              filters={filters}
              onFiltersChange={handleFiltersChange}
              sort={sort}
              onSortChange={handleSortChange}
              dataState={gridDataState}
              resultMeta={browse.resultMeta}
              emptyMessage={emptyMessage}
              onRetry={retryBrowse}
            />
          </div>
          {/* Browse-only chrome that stays MOUNTED and VISIBLE in every view, because
              unmounting it drops keyboard focus to <body>. It pages `browse.rows`,
              which is exactly what the timeline draws, so it stays LIVE there and
              says it does not apply only during a search. */}
          <LoadMoreFooter
            state={footerState}
            loaded={browse.rows.length}
            total={loadedTotal}
            onLoadMore={browse.loadMore}
            browseOnlyReason={searching ? BROWSE_ONLY_REASON : undefined}
          />
        </main>
      </div>
      {/* Acting on rows a newly-desired query is about to replace is exactly the
          ambiguity this design bans, so the bar is withheld while the visible
          rows answer the previous query. */}
      {ticked.length > 0 && browsePhase !== "stale" ? (
        <BulkBar
          ticked={ticked}
          records={browse.rows}
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
