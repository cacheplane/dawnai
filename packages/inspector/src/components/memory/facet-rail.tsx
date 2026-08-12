"use client"
import type { MemoryStats } from "@dawn-ai/memory"
import { useId } from "react"

export function FacetRail({
  stats,
  selected,
  onSelect,
}: {
  stats: MemoryStats | undefined
  selected: string | undefined
  onSelect: (ns: string | undefined) => void
}) {
  const namespaces = Object.entries(stats?.byNamespace ?? {})
  const scopeId = useId()
  return (
    <nav
      aria-describedby={scopeId}
      className="w-48 shrink-0 border-r border-zinc-200 bg-zinc-50 p-3 text-sm"
    >
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
        Namespace
      </div>
      {/* The counts come from the always-global stats endpoint, not from the
          current query — so they are LABELLED global rather than quietly
          presented as if they described the filtered result. Query-aware facet
          counts are a separate, deferred piece of work.

          Every button repeats the reference because a description on a landmark
          does not reach its descendants: tabbing straight to a facet is the
          usual way to reach a count, and that path must carry the scope too. */}
      <p id={scopeId} className="mb-1 text-[10px] leading-tight text-zinc-400">
        Counts are across all memories, not the current filters.
      </p>
      <button
        type="button"
        aria-pressed={selected === undefined}
        aria-describedby={scopeId}
        onClick={() => onSelect(undefined)}
        className={`flex w-full justify-between rounded px-2 py-1 ${selected === undefined ? "bg-indigo-50 font-medium text-indigo-800" : "hover:bg-zinc-100"}`}
      >
        <span>all</span>
        {/* Before the stats response lands — and after it fails — there is no
            count, and a `0` under a label promising a census of every memory
            reads as that census rather than as its absence. */}
        <span className="text-zinc-400">{stats === undefined ? "—" : stats.total}</span>
      </button>
      {namespaces.map(([ns, n]) => (
        <button
          key={ns}
          type="button"
          aria-pressed={selected === ns}
          aria-describedby={scopeId}
          onClick={() => onSelect(ns)}
          className={`flex w-full justify-between rounded px-2 py-1 font-mono text-xs ${selected === ns ? "bg-indigo-50 font-medium text-indigo-800" : "hover:bg-zinc-100"}`}
        >
          <span className="truncate">{ns}</span>
          <span className="text-zinc-400">{n}</span>
        </button>
      ))}
    </nav>
  )
}
