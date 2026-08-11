import type { MemoryKind, MemoryStatus } from "@dawn-ai/memory/browse"

/**
 * The closed sets the funnels offer and the query mapping validates against.
 *
 * They live here rather than beside the columns because two unrelated modules
 * need the SAME universe: `memory-grid.tsx` turns them into `column.options`
 * (the funnel checklist), and `to-browse-query.ts` checks a ticked value
 * against them before it reaches `BrowseFilter.values`. A drifting second copy
 * would let the funnel offer a value the server rejects with a 400.
 */
export const STATUSES = [
  "candidate",
  "active",
  "superseded",
] as const satisfies readonly MemoryStatus[]
export const KINDS = [
  "semantic",
  "episodic",
  "procedural",
  "reflection",
] as const satisfies readonly MemoryKind[]

export function isMemoryStatus(value: string): value is MemoryStatus {
  return (STATUSES as readonly string[]).includes(value)
}

export function isMemoryKind(value: string): value is MemoryKind {
  return (KINDS as readonly string[]).includes(value)
}
