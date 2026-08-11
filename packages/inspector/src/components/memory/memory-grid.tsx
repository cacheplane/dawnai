"use client"
import type { MemoryKind, MemoryRecord, MemoryStatus } from "@dawn-ai/memory"
import {
  type ColumnFilter,
  type PretableBodyStateKind,
  type PretableColumn,
  type PretableDataState,
  type PretableProcessingOptions,
  type PretableResultMeta,
  PretableSurface,
  type PretableSurfaceMessages,
  type PretableTelemetry,
} from "@pretable/react"
import { getDensityHeights } from "@pretable/ui"
import { useCallback, useMemo, useState } from "react"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"

/** Row projection handed to pretable — a plain bag so it satisfies `PretableRow`
 *  (MemoryRecord is an interface, so it has no implicit index signature). Each
 *  column's `value` feeds both the rendered cell and the sort comparator, so
 *  `updated` carries the raw ISO string and formats for display. */
interface GridRow extends Record<string, unknown> {
  id: string
  status: MemoryStatus
  content: string
  namespace: string
  kind: MemoryKind
  confidence: number
  updatedAt: string
}

/** The closed sets the funnels offer, and what `isNoneOf` is complemented
 *  against. Kept here beside the columns that use them. */
export const STATUSES: readonly MemoryStatus[] = ["candidate", "active", "superseded"]
export const KINDS: readonly MemoryKind[] = ["semantic", "episodic", "procedural", "reflection"]

/** Tallest the grid grows before it scrolls internally; below this it shrinks to
 *  fit so a two-hit search group doesn't reserve a screenful of empty rows. */
const MAX_VIEWPORT_PX = 560

/** Everything but `content` is sized to what it holds — a status badge, a
 *  namespace, a timestamp — and `content` takes whatever is left over, so the
 *  row ends on the container's edge at any window width. It carries the slack
 *  because it's the only column with unbounded text. */
const COLUMNS: PretableColumn<GridRow>[] = [
  {
    id: "status",
    header: "status",
    widthPx: 104,
    type: "enum",
    filterable: true,
    options: STATUSES.map((value) => ({ value })),
    value: (row) => row.status,
    render: ({ row }) => <Badge variant={row.status}>{row.status}</Badge>,
  },
  {
    id: "content",
    header: "content",
    // Only status and kind are translated into the server query, and this list
    // is one page of a larger store — a funnel here would filter the rows that
    // happen to be loaded and quietly answer a different question. Search does
    // content, across everything.
    filterable: false,
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
    // The facet rail already scopes namespace server-side, with real counts.
    filterable: false,
    value: (row) => row.namespace,
  },
  {
    id: "kind",
    header: "kind",
    widthPx: 100,
    type: "enum",
    filterable: true,
    options: KINDS.map((value) => ({ value })),
    value: (row) => row.kind,
  },
  {
    id: "confidence",
    header: "confidence",
    widthPx: 100,
    filterable: false,
    value: (row) => row.confidence,
    format: ({ value }) => Number(value).toFixed(2),
  },
  {
    id: "updated",
    header: "updated",
    widthPx: 180,
    filterable: false,
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
 * Sort is external AND the browse columns are non-sortable: leaving sort on
 * "engine" would sort a server-selected window locally, which presents the wrong
 * SAMPLE under a truthful-looking `aria-sort`, while external sort without an
 * `orderBy` in the request would paint a header arrow that does nothing. Sorting
 * comes back with server ordering.
 */
const SERVER_PROCESSING: PretableProcessingOptions = { filter: "external", sort: "external" }

const BROWSE_COLUMNS: PretableColumn<GridRow>[] = COLUMNS.map((column) => ({
  ...column,
  sortable: false,
}))

/** Enough room for a loading/empty/error block to be legible when the body holds
 *  no rows to give the viewport its height. */
const MIN_BODY_STATE_PX = 160

/** Lifecycle copy. `emptyStateMessage` is NOT here — filtered-empty and
 *  unfiltered-empty are different answers, and only the caller knows which. */
const BROWSE_MESSAGES: PretableSurfaceMessages = {
  loadingStateMessage: () => "Loading memories…",
  dataErrorAnnouncement: ({ message }) =>
    message === undefined ? "Could not load memories." : `Could not load memories: ${message}`,
  staleAnnouncement: () => "Updating results…",
  focusedRowRemovedAnnouncement: () => "The focused memory was removed.",
  resultsAnnouncement: ({ loaded, total, added, scope }) => {
    const head =
      scope === "all" || total.kind !== "exact"
        ? `${loaded.toLocaleString()} loaded`
        : `${loaded.toLocaleString()} loaded of ${total.count.toLocaleString()} matching`
    return added === undefined ? head : `Loaded ${added.toLocaleString()} more. ${head}.`
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

export function MemoryGrid({
  records,
  onSelect,
  onTickedChange,
  groupByNamespace = false,
  filters,
  onFiltersChange,
  dataState,
  resultMeta,
  emptyMessage,
  onRetry,
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
  /** Funnel state to display, and where changes go. Omit both to render without
   *  column filtering — the grouped search results filter nothing. */
  filters?: Record<string, ColumnFilter>
  onFiltersChange?: (next: Record<string, ColumnFilter>) => void
  /** Supply to turn lifecycle presentation ON: body blocks, the phase attribute,
   *  phase announcements, and external processing authority. Omit it — as the
   *  search results do — and the grid behaves exactly as it did before. */
  dataState?: PretableDataState
  /** The matching population and the dataset identity, always for the FULFILLED
   *  revision. */
  resultMeta?: PretableResultMeta
  /** Body copy for the empty block. "Nothing stored" and "nothing matches what you
   *  asked for" are different answers; only the caller knows which applies. */
  emptyMessage?: string
  /** Retry affordance for the error block. The design routes it through the
   *  body-state slot rather than a second banner, so exactly one retry control is
   *  ever on screen. */
  onRetry?: () => void
}) {
  const rows = useMemo(() => records.map(toRow), [records])

  const surfaceState = useMemo(
    () => ({
      rowGroups: groupByNamespace ? GROUP_BY_NAMESPACE : FLAT_ROWS,
      ...(filters ? { filters } : {}),
    }),
    [groupByNamespace, filters],
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
    dataState !== undefined && rows.length === 0 ? MIN_BODY_STATE_PX : 0,
  )

  const messages = useMemo<PretableSurfaceMessages>(
    () => ({
      ...BROWSE_MESSAGES,
      emptyStateMessage: () => emptyMessage ?? "No memories.",
    }),
    [emptyMessage],
  )

  return (
    <PretableSurface<GridRow>
      ariaLabel="Memories"
      columns={dataState === undefined ? COLUMNS : BROWSE_COLUMNS}
      rows={rows}
      getRowId={rowIdOf}
      viewportHeight={viewportHeight}
      // One controlled `state`: a second `state` prop would clobber the first,
      // silently ungrouping the moment a filter was applied.
      state={surfaceState}
      // Spread-or-omit rather than `prop={undefined}`: `exactOptionalPropertyTypes`
      // rejects an explicit undefined, and `dataState` has NO default — omitting it
      // turns lifecycle presentation entirely off.
      {...(dataState === undefined ? {} : { dataState, processing: SERVER_PROCESSING, messages })}
      {...(resultMeta === undefined ? {} : { resultMeta })}
      {...(dataState === undefined
        ? {}
        : {
            renderBodyState: ({
              kind,
              errorMessage,
            }: {
              kind: PretableBodyStateKind
              errorMessage?: string
            }) =>
              kind === "loading" ? (
                <p data-testid="browse-loading" className="p-4 text-sm text-zinc-400">
                  Loading memories…
                </p>
              ) : kind === "empty" ? (
                <p data-testid="browse-empty" className="p-4 text-sm text-zinc-400">
                  {emptyMessage ?? "No memories."}
                </p>
              ) : (
                <div
                  data-testid="browse-error"
                  className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                  <span>{errorMessage ?? "Could not load memories."}</span>
                  {onRetry ? (
                    <Button variant="outline" className="h-7 px-2" onClick={onRetry}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              ),
          })}
      {...(onTickedChange
        ? {
            rowSelectionColumn: { enabled: true, headerCheckbox: true } as const,
            onRowSelectionChange: onTickedChange,
          }
        : {})}
      {...(onFiltersChange ? { onFiltersChange } : {})}
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
