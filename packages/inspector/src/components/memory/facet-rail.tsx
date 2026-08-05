"use client"
import type { MemoryStats } from "@dawn-ai/memory"

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
  return (
    <nav className="w-48 shrink-0 border-r border-zinc-200 bg-zinc-50 p-3 text-sm">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
        Namespace
      </div>
      <button
        type="button"
        aria-pressed={selected === undefined}
        onClick={() => onSelect(undefined)}
        className={`flex w-full justify-between rounded px-2 py-1 ${selected === undefined ? "bg-indigo-50 font-medium text-indigo-800" : "hover:bg-zinc-100"}`}
      >
        <span>all</span>
        <span className="text-zinc-400">{stats?.total ?? 0}</span>
      </button>
      {namespaces.map(([ns, n]) => (
        <button
          key={ns}
          type="button"
          aria-pressed={selected === ns}
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
