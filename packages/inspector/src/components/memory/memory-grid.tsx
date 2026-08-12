"use client"
import type { MemoryKind, MemoryRecord, MemoryStatus } from "@dawn-ai/memory"
import {
  type ColumnFilter,
  type PretableColumn,
  type PretableDataState,
  type PretableGrid,
  type PretableProcessingOptions,
  type PretableResultMeta,
  type PretableSortEntry,
  PretableSurface,
  type PretableSurfaceMessages,
  type PretableSurfaceProps,
  type PretableSurfaceState,
  type PretableTelemetry,
} from "@pretable/react"
import { getDensityHeights } from "@pretable/ui"
import { useCallback, useMemo, useState } from "react"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { KINDS, STATUSES } from "./memory-domain"
import { TEST_IDS } from "./test-ids"

/** Row projection handed to pretable — a plain bag so it satisfies `PretableRow`
 *  (MemoryRecord is an interface, so it has no implicit index signature). Each
 *  column's `value` feeds both the rendered cell and the sort comparator, so
 *  `updated` carries the raw ISO string and formats for display. */
export interface GridRow extends Record<string, unknown> {
  id: string
  status: MemoryStatus
  content: string
  namespace: string
  kind: MemoryKind
  confidence: number
  updatedAt: string
}

/** Tallest the grid grows before it scrolls internally; below this it shrinks to
 *  fit so a two-hit search group doesn't reserve a screenful of empty rows. */
const MAX_VIEWPORT_PX = 560

/** Everything but `content` is sized to what it holds — a status badge, a
 *  namespace, a timestamp — and `content` takes whatever is left over, so the
 *  row ends on the container's edge at any window width. It carries the slack
 *  because it's the only column with unbounded text.
 *
 *  Every column declares `type`, and every FILTERABLE column declares
 *  `filterOperators` matching the `BrowseFilter` grammar exactly. That list is
 *  load-bearing, not cosmetic: Pretable appends `isEmpty`/`isNotEmpty` to every
 *  type's menu by default and no `BrowseFilter` arm expresses them (correctly —
 *  every browse field is NOT NULL), so an unpruned menu would offer two
 *  operators the server ignores. `operatorsForType` INTERSECTS this list with
 *  the per-type set, so a name that is not valid for the declared `type` is
 *  dropped — and a list that intersects to nothing dev-warns and falls back to
 *  the full menu. Change `type` and you must re-check this list.
 *
 *  Browse renders this list DIRECTLY, so every affordance declared here is one the
 *  store answers — `SEARCH_COLUMNS` below is the only masked view, because search
 *  results carry no server authority to mask against. Exported so a test can pin
 *  every declared operator AND every sortable column against `toBrowseQuery`'s
 *  arms — either one with no arm throws on the user's click. */
export const COLUMNS: PretableColumn<GridRow>[] = [
  {
    id: "status",
    header: "status",
    widthPx: 104,
    type: "enum",
    filterable: true,
    filterOperators: ["isAnyOf", "isNoneOf"],
    options: STATUSES.map((value) => ({ value })),
    value: (row) => row.status,
    render: ({ row }) => <Badge variant={row.status}>{row.status}</Badge>,
  },
  {
    id: "content",
    header: "content",
    type: "text",
    filterable: true,
    filterOperators: ["contains", "notContains", "equals", "notEquals", "startsWith", "endsWith"],
    // Design §14 Q2: the sort whitelist has no `content` field, so a sortable
    // header here would emit an orderBy the store rejects — and byte-order text
    // sorting over memory bodies is rarely what anyone wanted anyway. Search is
    // the ranked path.
    sortable: false,
    flex: 1,
    minWidthPx: 240,
    value: (row) => row.content,
    // Cells are flex containers, and text-overflow does nothing on one — so the
    // ellipsis has to live on an inner box. min-w-0 lets it shrink below its
    // text width; without it the flex item refuses to and the text just clips.
    render: ({ formattedValue }) => <span className="min-w-0 truncate">{formattedValue}</span>,
  },
  {
    id: "namespace",
    header: "namespace",
    widthPx: 190,
    type: "text",
    filterable: true,
    // Machine identifiers: byte-exact and case-sensitive on both backends, and
    // `startsWith` is served sargably as a range. `contains` is deliberately
    // absent — the store has no substring index for namespaces.
    filterOperators: ["equals", "startsWith"],
    value: (row) => row.namespace,
  },
  {
    id: "kind",
    header: "kind",
    widthPx: 100,
    type: "enum",
    filterable: true,
    filterOperators: ["isAnyOf", "isNoneOf"],
    options: KINDS.map((value) => ({ value })),
    value: (row) => row.kind,
  },
  {
    id: "confidence",
    header: "confidence",
    widthPx: 100,
    type: "number",
    filterable: true,
    filterOperators: ["equals", "notEquals", "gt", "gte", "lt", "lte", "between"],
    value: (row) => row.confidence,
    format: ({ value }) => Number(value).toFixed(2),
  },
  {
    id: "updated",
    header: "updated",
    widthPx: 180,
    // `date` gives the funnel a real date input, whose value is the
    // "YYYY-MM-DD" day `toBrowseQuery` maps onto the store's UTC day buckets.
    type: "date",
    filterable: true,
    filterOperators: ["on", "before", "after", "dateBetween"],
    value: (row) => row.updatedAt,
    format: ({ value }) => new Date(String(value)).toLocaleString(),
  },
]

/** Per-column cell styling, keyed by column id. */
const CELL_CLASS: Partial<Record<string, string>> = {
  content: "overflow-hidden",
  namespace: "font-mono text-xs",
  confidence: "tabular-nums",
}

/**
 * Browse sends status/kind to the server, so the engine must DISPLAY the funnel
 * state without re-applying it — and `resultMeta.total` is silently ignored (with a
 * dev warning) under engine filter authority, so external authority is what makes
 * the honest total reachable at all.
 *
 * Sort is external for the same reason: ordering a server-selected window locally
 * answers with the wrong SAMPLE — the top of a recency-biased window, re-ranked —
 * under a truthful-looking `aria-sort`. So a header click emits INTENT that the
 * page turns into the query's `orderBy`, and the rows keep answering the previous
 * order until the response lands.
 */
const SERVER_PROCESSING: PretableProcessingOptions = { filter: "external", sort: "external" }

/** The search results are a ranked per-namespace top-N the STORE chose, and they
 *  arrive with no server authority behind them — so a funnel here would be applied
 *  by the engine to the rows that happen to be loaded, narrowing the sample rather
 *  than the store, under a header that looks exactly like the browse grid's. The
 *  `content` funnel is the one that tempts most and is exactly what search already
 *  answers, ranked, across everything.
 *
 *  Sorting is left alone: a group IS its whole result set, so ordering it locally
 *  answers the question the header asks. */
const SEARCH_COLUMNS: PretableColumn<GridRow>[] = COLUMNS.map((column) => ({
  ...column,
  filterable: false,
}))

/** Room the body-state block itself needs to stay legible when there are no rows
 *  to give the viewport its height. The block is an overlay inset below the sticky
 *  header, so the header's height is not part of it. */
const MIN_BODY_STATE_PX = 160

/** Announcement copy only. The visible loading/empty/error blocks come from
 *  `renderBodyState`, which pretable prefers over `loadingStateMessage` and
 *  `emptyStateMessage` whenever it is supplied — and it always is here. */
const BROWSE_MESSAGES: PretableSurfaceMessages = {
  dataErrorAnnouncement: ({ message }) =>
    message === undefined ? "Could not load memories." : `Could not load memories: ${message}`,
  staleAnnouncement: () => "Updating results…",
  focusedRowRemovedAnnouncement: () => "The focused memory was removed.",
  resultsAnnouncement: ({ loaded, total, added, scope }) => {
    // `scope: "all"` means the loaded records ARE the population and `total`
    // restates them — say one number. Every other case keeps the qualifier the
    // total carries, so "of about" never hardens into a count nobody promised.
    const population =
      scope === "all"
        ? ""
        : total.kind === "exact"
          ? ` of ${total.count.toLocaleString()} matching`
          : total.kind === "estimate"
            ? ` of about ${total.count.toLocaleString()} matching`
            : total.atLeast === undefined
              ? ""
              : ` of more than ${total.atLeast.toLocaleString()} matching`
    const head = `${loaded.toLocaleString()} loaded${population}.`
    return added === undefined ? head : `Loaded ${added.toLocaleString()} more. ${head}`
  },
  moreRowsBoundaryAnnouncement: ({ loadedCount, total }) =>
    total === undefined
      ? `End of the ${loadedCount.toLocaleString()} loaded memories.`
      : `End of the ${loadedCount.toLocaleString()} loaded memories, of ${total.toLocaleString()} matching.`,
}

function statusClass(status: MemoryStatus): string {
  if (status === "candidate") return "bg-amber-50"
  if (status === "superseded") return "text-zinc-400 line-through"
  return ""
}

/** Module-level so their identities are stable — the grid reapplies controlled
 *  state on every render, and fresh objects each time would churn it. Both
 *  modes stay controlled so switching to a namespace facet clears grouping. */
const GROUP_BY_NAMESPACE = ["namespace"]
const FLAT_ROWS: string[] = []

/** Module-level so its identity is stable — `usePretable` keys the grid on it. */
function rowIdOf(row: GridRow): string {
  return row.id
}

function toRow(record: MemoryRecord): GridRow {
  return {
    id: record.id,
    status: record.status,
    content: record.content,
    namespace: record.namespace,
    kind: record.kind,
    confidence: record.confidence,
    updatedAt: record.updatedAt,
  }
}

/**
 * Row ids → the engine's cell-range selection. Used to PRUNE a selection after a bulk
 * run. Applied imperatively through `grid.setSelection` rather than through controlled
 * `state.selection` on purpose: `usePretable` latches a controlled selection across a
 * `datasetKey` pivot, and the prune has to land whether or not the dataset moved.
 *
 * A TICKED row is a range spanning the first and last DRAWN columns — `getColumns()`,
 * which is what `toggleRowSelection` and the header checkbox both span, and the only
 * span the surface counts as a whole row. Hard-coding the first and last columns of
 * `COLUMNS` instead produces an INDETERMINATE row: the drawn set is not that list.
 * The checkbox column is prepended to it, the derived group column joins it whenever
 * the page groups by namespace, and `hideGroupedColumns` takes `namespace` back out
 * again — so a short span leaves the box `mixed`, the row absent from
 * `onRowSelectionChange`, and the bulk bar gone with it.
 */
export function buildRowSelection(
  rowIds: readonly string[],
  drawnColumnIds: readonly string[],
): NonNullable<PretableSurfaceState["selection"]> {
  const first = drawnColumnIds[0]
  const last = drawnColumnIds[drawnColumnIds.length - 1]
  if (first === undefined || last === undefined) return { ranges: [], anchor: null }
  return {
    ranges: rowIds.map((rowId) => ({
      startRowId: rowId,
      endRowId: rowId,
      startColumnId: first,
      endColumnId: last,
    })),
    anchor: rowIds.length > 0 ? { rowId: rowIds[0] as string, columnId: first } : null,
  }
}

export function MemoryGrid({
  records,
  onSelect,
  onTickedChange,
  groupByNamespace = false,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  dataState,
  resultMeta,
  emptyMessage,
  onRetry,
  onGridReady,
}: {
  records: readonly MemoryRecord[]
  onSelect: (id: string) => void
  /** Opt into the checkbox column by passing this — the ticked ids, in
   *  rendered order, for bulk actions. Omitted where bulk actions make no
   *  sense (the grouped search results). */
  onTickedChange?: (ids: string[]) => void
  /** Nest rows under one expandable header per namespace. Worth it only when
   *  looking at every namespace at once — scoped to one, every row would sit
   *  under a single group. */
  groupByNamespace?: boolean
  /** Funnel state to display, and where changes go. WHETHER funnels are offered
   *  is decided by `dataState` (see `SEARCH_COLUMNS`), not by these — omitting
   *  them in browse mode leaves the funnels uncontrolled, which under external
   *  filter authority means a tick that displays and reaches nothing. */
  filters?: Record<string, ColumnFilter>
  onFiltersChange?: (next: Record<string, ColumnFilter>) => void
  /** Ordered sort intent to display, and where changes go. Under server
   *  authority this is display state only — the model order is the order the
   *  server returned. Omitting them does NOT remove the sort control: the engine
   *  keeps its own sort state and reorders the loaded rows, which is what the
   *  search results want. */
  sort?: PretableSortEntry[]
  onSortChange?: (next: PretableSortEntry[]) => void
  /** Supply to turn lifecycle presentation ON: body blocks, the phase attribute,
   *  phase announcements, and external processing authority. Omit it — as the
   *  search results do — and the grid behaves exactly as it did before.
   *
   *  WHETHER it is supplied must be stable for the mount, though its value may
   *  change freely: presence selects `columns` and `processing`, which pretable
   *  treats as create-time config and rebuilds the grid around, discarding
   *  selection, focus, measured heights and column layout. */
  dataState?: PretableDataState
  /** The matching population and the dataset identity, always for the FULFILLED
   *  revision. */
  resultMeta?: PretableResultMeta
  /** Body copy for the empty block. "Nothing stored" and "nothing matches what you
   *  asked for" are different answers; only the caller knows which applies. */
  emptyMessage?: string
  /** Retry affordance for the error blocks. The design routes it through the
   *  body-state slot rather than a second banner, so exactly one retry control is
   *  ever on screen. */
  onRetry?: () => void
  /** Receives the engine instance — once per ENGINE, not once per mount: pretable
   *  rebuilds the engine around create-time config, and every caller holding the
   *  previous instance would be holding a dead one if it did not re-fire. The page
   *  uses it to clear the checkbox selection after a bulk run — the only selection
   *  change that is neither a user gesture nor a dataset pivot. */
  onGridReady?: (grid: PretableGrid<GridRow>) => void
}) {
  const rows = useMemo(() => records.map(toRow), [records])

  const surfaceState = useMemo(
    () => ({
      rowGroups: groupByNamespace ? GROUP_BY_NAMESPACE : FLAT_ROWS,
      ...(filters ? { filters } : {}),
      ...(sort ? { sort } : {}),
    }),
    [groupByNamespace, filters, sort],
  )

  // The engine reports the exact height of all rows; until the first layout
  // effect lands, estimate from the theme's density so the initial paint is
  // close (a too-short first guess would virtualize rows away for one frame).
  const [contentHeight, setContentHeight] = useState<number>()
  const onTelemetryChange = useCallback((telemetry: PretableTelemetry) => {
    setContentHeight(telemetry.totalHeight)
  }, [])
  const density = getDensityHeights()
  const viewportHeight = Math.max(
    Math.min(
      (contentHeight ?? rows.length * density.rowHeight) + density.headerHeight,
      MAX_VIEWPORT_PX,
    ),
    dataState !== undefined && rows.length === 0 ? MIN_BODY_STATE_PX + density.headerHeight : 0,
  )

  // Typed against the prop rather than inline in the JSX spread below: a spread
  // gets no contextual type, so an inline callback's parameter would have to be
  // hand-declared, and a hand-declared one silently accepts a shape the library
  // has since renamed.
  const renderBodyState: NonNullable<PretableSurfaceProps<GridRow>["renderBodyState"]> = ({
    kind,
    errorMessage,
  }) => {
    if (kind === "loading") {
      return (
        <p data-testid="browse-loading" className="p-4 text-sm text-zinc-400">
          Loading memories…
        </p>
      )
    }
    if (kind === "empty") {
      return (
        <p data-testid="browse-empty" className="p-4 text-sm text-zinc-400">
          {emptyMessage ?? "No memories."}
        </p>
      )
    }
    const message = errorMessage ?? "Could not load memories."
    // One node, reused by both blocks below — they are mutually exclusive kinds, so
    // the id is never ambiguous in a rendered tree.
    const retry = onRetry ? (
      <Button
        variant="outline"
        className="h-7 px-2"
        data-testid={TEST_IDS.retryInitial}
        onClick={onRetry}
      >
        Retry
      </Button>
    ) : null
    // `error-strip` means rows survived the failure and are still on screen
    // answering the previous question, so the block sits ABOVE them as a band
    // rather than covering the body — same failure, a different claim about what
    // is underneath.
    return kind === "error-strip" ? (
      <div
        data-testid="browse-error-strip"
        className="mb-2 flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700"
      >
        <span>{message}</span>
        {retry}
      </div>
    ) : (
      <div
        data-testid="browse-error"
        className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        <span>{message}</span>
        {retry}
      </div>
    )
  }

  return (
    <PretableSurface<GridRow>
      ariaLabel="Memories"
      // Browse renders the declaration UNMASKED — every affordance `COLUMNS`
      // declares is one the store answers, `content`'s `sortable: false` included.
      // Search is the mode that has to mask.
      columns={dataState === undefined ? SEARCH_COLUMNS : COLUMNS}
      rows={rows}
      getRowId={rowIdOf}
      viewportHeight={viewportHeight}
      // One controlled `state`: a second `state` prop would clobber the first,
      // silently ungrouping the moment a filter was applied.
      state={surfaceState}
      // All four together or none: `renderBodyState` is what makes the lifecycle
      // copy in `BROWSE_MESSAGES` reachable, and `SERVER_PROCESSING` is what makes
      // `resultMeta.total` reachable. Splitting them would leave a half-wired mode.
      {...(dataState === undefined
        ? {}
        : {
            dataState,
            processing: SERVER_PROCESSING,
            messages: BROWSE_MESSAGES,
            renderBodyState,
          })}
      {...(resultMeta === undefined ? {} : { resultMeta })}
      {...(onTickedChange
        ? {
            rowSelectionColumn: { enabled: true, headerCheckbox: true } as const,
            onRowSelectionChange: onTickedChange,
          }
        : {})}
      {...(onFiltersChange ? { onFiltersChange } : {})}
      {...(onSortChange ? { onSortChange } : {})}
      {...(onGridReady ? { onGridReady } : {})}
      // Strict ARIA grid tabbing — the default wraps Tab inside the grid, which
      // traps keyboard focus on a page that has a search box and a detail sheet.
      tabBehavior="exit"
      getRowClassName={() => "cursor-pointer"}
      getBodyCellClassName={({ column, row }) =>
        `${CELL_CLASS[column.id] ?? ""} ${statusClass(row.status)}`.trim()
      }
      getBodyCellProps={({ column, formattedValue }) =>
        column.id === "content" ? { title: formattedValue } : undefined
      }
      // Row activation is pretable's own concern since 0.0.3: click and
      // Enter/Space both arrive here, and cell-range gestures correctly don't.
      onRowActivate={({ rowId }) => onSelect(rowId)}
      onTelemetryChange={onTelemetryChange}
      // Lowercase labels to match the rest of the Inspector chrome; pretable's
      // own default renders the column name plus a ▲/▼ glyph.
      renderHeaderCell={({ label, sortDirection }) => (
        <span className="flex items-center gap-1">
          {label}
          {sortDirection ? (
            <span aria-hidden="true">{sortDirection === "asc" ? "▲" : "▼"}</span>
          ) : null}
        </span>
      )}
    />
  )
}
