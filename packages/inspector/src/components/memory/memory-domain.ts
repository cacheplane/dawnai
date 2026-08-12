import type { MemoryKind, MemoryStatus } from "@dawn-ai/memory/browse"

/**
 * The closed sets the funnels offer and the query mapping validates against.
 *
 * Two unrelated modules need the SAME universe: `memory-grid.tsx` turns these into
 * `column.options` (the funnel checklist), and `to-browse-query.ts` checks a ticked
 * value against them before it reaches `BrowseFilter.values`. `browse-validate.ts`
 * holds the third reading — the one the store actually rejects against — so each copy
 * is pinned to the union itself rather than to a sibling, and a set that fell out of
 * step would let the funnel offer a value the server answers with a 400.
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

/** Proof that each list spells out its WHOLE union. `satisfies` above proves only the
 *  converse — that nothing listed is a typo — which would leave a member added
 *  upstream missing here and nothing red: the funnel would never offer the value, so
 *  rows carrying it could not be narrowed to or excluded, and the guards below would
 *  call it invalid — making `to-browse-query.ts` THROW on any predicate that names it.
 *  The brackets suppress distribution, without which a union member missing from the
 *  list still yields `true`. */
type Exhaustive<Union, List extends readonly unknown[]> = [Union] extends [List[number]]
  ? true
  : never
const _listsSpellOutTheirUnions: [
  Exhaustive<MemoryStatus, typeof STATUSES>,
  Exhaustive<MemoryKind, typeof KINDS>,
] = [true, true]
void _listsSpellOutTheirUnions

export function isMemoryStatus(value: string): value is MemoryStatus {
  return (STATUSES as readonly string[]).includes(value)
}

export function isMemoryKind(value: string): value is MemoryKind {
  return (KINDS as readonly string[]).includes(value)
}
