"use client"
import type { MemoryRecord } from "@dawn-ai/memory"
import type { KeyboardEvent } from "react"
import { Badge } from "../ui/badge"

// TODO(pretable): switch to @pretable/react's <PretableSurface> once 0.0.2 is
// installable. The 0.0.2 API is a perfect fit — `onSelectedRowIdChange` for
// row-click selection and `getRowClassName` for status tinting — but the
// published 0.0.2 tarball declares hard deps on @pretable/ui@0.0.2 (and its
// theme CSS at @pretable/ui/themes/excel.css + @pretable/ui/grid.css), and
// @pretable/ui is not on the npm registry at any version, so `pnpm add
// @pretable/react@0.0.2` fails resolution outright. Until a fixed publish
// lands, this semantic <table> is the interim body behind the same props.
// Column sorting is deliberately deferred to that swap too — the approved
// wireframe's sort-by-column comes with pretable's header sorting; until then
// rows arrive server-ordered (updated_at DESC).

const COLUMNS = ["status", "content", "namespace", "kind", "confidence", "updated"] as const

function rowClass(record: MemoryRecord): string {
  if (record.status === "candidate") return "bg-amber-50"
  if (record.status === "superseded") return "text-zinc-400 line-through"
  return ""
}

export function MemoryGrid({
  records,
  onSelect,
}: {
  records: readonly MemoryRecord[]
  onSelect: (id: string) => void
}) {
  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelect(id)
    }
  }
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            {COLUMNS.map((col) => (
              <th key={col} className="px-3 py-2 font-medium">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            // biome-ignore lint/a11y/useSemanticElements: a real <button> is invalid as a table row; role+tabIndex+keydown is the accessible pattern for clickable <tr>s
            <tr
              key={record.id}
              tabIndex={0}
              role="button"
              aria-label={`Open memory: ${record.content}`}
              onClick={() => onSelect(record.id)}
              onKeyDown={(event) => onRowKeyDown(event, record.id)}
              className={`cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-400 ${rowClass(record)}`}
            >
              <td className="px-3 py-2">
                <Badge variant={record.status}>{record.status}</Badge>
              </td>
              <td className="max-w-md truncate px-3 py-2" title={record.content}>
                {record.content}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{record.namespace}</td>
              <td className="px-3 py-2">{record.kind}</td>
              <td className="px-3 py-2 tabular-nums">{record.confidence.toFixed(2)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500">
                {new Date(record.updatedAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
