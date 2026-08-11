import type { MemoryKind, MemoryStatus } from "@dawn-ai/memory/browse"

/** Which surface the records are being browsed for. Part of the dataset identity:
 *  timeline defaults the kind funnel to episodic, so the two views ask different
 *  questions and must never share a fulfilled result. */
export type BrowseView = "list" | "timeline"

/**
 * The canonical form of everything that decides WHICH records the server returns.
 *
 * `null` means unfiltered and `[]` means matches-nothing — the same distinction
 * `BrowseQuery` draws, kept rather than collapsed so an emptied funnel cannot read
 * as "show everything". Every field is present rather than optional, so the key
 * builder below can stringify a fixed field order with no optional-property hole.
 */
export interface CanonicalBrowseQuery {
  readonly view: BrowseView
  readonly namespace: string | null
  readonly status: readonly MemoryStatus[] | null
  readonly kind: readonly MemoryKind[] | null
  readonly since: string | null
}

/** Timeline is an episode view: the kind funnel still overrides, but with nothing
 *  ticked it asks for episodes rather than for everything. */
const TIMELINE_DEFAULT_KIND: readonly MemoryKind[] = ["episodic"]

/** Sorted and deduped, so two funnels that tick the same boxes in a different order
 *  produce ONE dataset key rather than two. */
function normalizeSet<T extends string>(values: readonly T[] | undefined): readonly T[] | null {
  if (values === undefined) return null
  return [...new Set(values)].sort()
}

export function canonicalBrowseQuery(input: {
  readonly view: BrowseView
  readonly namespace?: string | undefined
  readonly status?: readonly MemoryStatus[] | undefined
  readonly kind?: readonly MemoryKind[] | undefined
  readonly since?: string | undefined
}): CanonicalBrowseQuery {
  const kind = normalizeSet(input.kind)
  return {
    view: input.view,
    namespace: input.namespace ?? null,
    status: normalizeSet(input.status),
    // `[] ?? x` is `[]`, so an emptied funnel survives the timeline default intact.
    kind: kind ?? (input.view === "timeline" ? TIMELINE_DEFAULT_KIND : null),
    since: input.since ?? null,
  }
}

/**
 * The dataset identity. Two queries share a key exactly when they ask the same
 * question; any change bumps the desired revision, invalidates the loaded records
 * and the total together, and pivots the grid's `resultMeta.datasetKey`.
 *
 * The canonical JSON IS the key. A hash would only shorten a string that nothing
 * but `===` ever reads, and would buy a collision class in exchange — while an
 * unhashed key stays legible in a failing assertion.
 */
export function datasetKeyOf(query: CanonicalBrowseQuery): string {
  return JSON.stringify([query.view, query.namespace, query.status, query.kind, query.since])
}

/** A set narrowed to nothing matches nothing. Over HTTP a repeated param that
 *  appears zero times is ABSENT, so asking the server would come back unfiltered —
 *  the opposite answer. Callers must resolve this locally instead. */
export function browseMatchesNothing(query: CanonicalBrowseQuery): boolean {
  return query.status?.length === 0 || query.kind?.length === 0
}

/** One window of `query`, as the params `/api/memory/list` parses. */
export function browseSearchParams(
  query: CanonicalBrowseQuery,
  window: { readonly limit: number; readonly offset: number },
): URLSearchParams {
  const params = new URLSearchParams()
  // EXACT namespace, not `namespacePrefix`: a prefix answer and an exact total
  // describe different sets, and this UI displays the two side by side.
  if (query.namespace !== null) params.set("namespace", query.namespace)
  for (const value of query.status ?? []) params.append("status", value)
  for (const value of query.kind ?? []) params.append("kind", value)
  if (query.since !== null) params.set("since", query.since)
  params.set("limit", String(window.limit))
  params.set("offset", String(window.offset))
  return params
}
