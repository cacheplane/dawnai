"use client"
import type { MemoryRecord } from "@dawn-ai/memory"
import { Badge } from "../ui/badge"

function dayOf(r: MemoryRecord): string {
  return (r.effectiveAt ?? r.createdAt).slice(0, 10)
}

function outcomeVariant(outcome: string): "active" | "danger" | "candidate" {
  if (outcome === "ok") return "active"
  if (outcome === "error") return "danger"
  return "candidate"
}

export function TimelineView({
  records,
  onSelect,
}: {
  records: readonly MemoryRecord[]
  onSelect: (id: string) => void
}) {
  const days = new Map<string, MemoryRecord[]>()
  for (const r of records) {
    const day = dayOf(r)
    const bucket = days.get(day)
    if (bucket) bucket.push(r)
    else days.set(day, [r])
  }
  return (
    <div className="p-4" data-testid="timeline-view">
      {[...days.entries()].map(([day, rows]) => (
        <section key={day} className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {day}
          </h2>
          <ol className="space-y-1">
            {rows.map((r) => {
              const outcome = typeof r.data.outcome === "string" ? r.data.outcome : undefined
              const durationMs =
                typeof r.data.durationMs === "number" ? r.data.durationMs : undefined
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-zinc-50"
                    aria-label={`Open episode: ${r.content}`}
                  >
                    <span className="w-14 shrink-0 font-mono text-xs text-zinc-400">
                      {(r.effectiveAt ?? r.createdAt).slice(11, 16)}
                    </span>
                    {outcome ? (
                      <Badge variant={outcomeVariant(outcome)}>{outcome}</Badge>
                    ) : (
                      <Badge>authored</Badge>
                    )}
                    <span className="truncate" title={r.content}>
                      {r.content}
                    </span>
                    {durationMs !== undefined ? (
                      <span className="ml-auto shrink-0 text-xs text-zinc-400">
                        {(durationMs / 1000).toFixed(1)}s
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
      {records.length === 0 ? (
        <p className="text-sm text-zinc-400">No episodes in this window.</p>
      ) : null}
    </div>
  )
}
