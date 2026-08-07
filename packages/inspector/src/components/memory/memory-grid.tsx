"use client"
import type { MemoryKind, MemoryRecord, MemoryStatus } from "@dawn-ai/memory"
import { type PretableColumn, PretableSurface, type PretableTelemetry } from "@pretable/react"
import { getDensityHeights } from "@pretable/ui"
import { useCallback, useMemo, useState } from "react"
import { Badge } from "../ui/badge"

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

/** Tallest the grid grows before it scrolls internally; below this it shrinks to
 *  fit so a two-hit search group doesn't reserve a screenful of empty rows. */
const MAX_VIEWPORT_PX = 560

/** Column widths are fixed (pretable sizes to content or to `widthPx`, never to
 *  fill its container) and sum to ~1030px so the whole row fits beside the facet
 *  rail on a 1280px screen. Wider than that is the grid's own scroll; `content`
 *  carries the slack because it's the only column with unbounded text. */
const COLUMNS: PretableColumn<GridRow>[] = [
  {
    id: "status",
    header: "status",
    widthPx: 104,
    value: (row) => row.status,
    render: ({ row }) => <Badge variant={row.status}>{row.status}</Badge>,
  },
  {
    id: "content",
    header: "content",
    widthPx: 360,
    value: (row) => row.content,
    // Cells are flex containers, and text-overflow does nothing on one — so the
    // ellipsis has to live on an inner box. min-w-0 lets it shrink below its
    // text width; without it the flex item refuses to and the text just clips.
    render: ({ formattedValue }) => <span className="min-w-0 truncate">{formattedValue}</span>,
  },
  { id: "namespace", header: "namespace", widthPx: 190, value: (row) => row.namespace },
  { id: "kind", header: "kind", widthPx: 100, value: (row) => row.kind },
  {
    id: "confidence",
    header: "confidence",
    widthPx: 100,
    value: (row) => row.confidence,
    format: ({ value }) => Number(value).toFixed(2),
  },
  {
    id: "updated",
    header: "updated",
    widthPx: 180,
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

function statusClass(status: MemoryStatus): string {
  if (status === "candidate") return "bg-amber-50"
  if (status === "superseded") return "text-zinc-400 line-through"
  return ""
}

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
}: {
  records: readonly MemoryRecord[]
  onSelect: (id: string) => void
}) {
  const rows = useMemo(() => records.map(toRow), [records])

  // The engine reports the exact height of all rows; until the first layout
  // effect lands, estimate from the theme's density so the initial paint is
  // close (a too-short first guess would virtualize rows away for one frame).
  const [contentHeight, setContentHeight] = useState<number>()
  const onTelemetryChange = useCallback((telemetry: PretableTelemetry) => {
    setContentHeight(telemetry.totalHeight)
  }, [])
  const density = getDensityHeights()
  const viewportHeight = Math.min(
    (contentHeight ?? rows.length * density.rowHeight) + density.headerHeight,
    MAX_VIEWPORT_PX,
  )

  return (
    <PretableSurface<GridRow>
      ariaLabel="Memories"
      columns={COLUMNS}
      rows={rows}
      getRowId={rowIdOf}
      viewportHeight={viewportHeight}
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
