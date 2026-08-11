import type {
  BrowseFilter,
  BrowseSortEntry,
  MemoryKind,
  MemoryStatus,
} from "@dawn-ai/memory/browse"

/** Which surface is browsing. Never sent to the server: it selects the kind default
 *  and the component that consumes the page.
 *
 *  It is part of the dataset identity anyway. A timeline query and a list query
 *  narrowed to episodic serialize to the SAME params, so keying on `view` costs a
 *  refetch on that one toggle — paid deliberately, because the resident window and
 *  the offset it implies belong to the surface that paged them, and a switch that
 *  inherited them would resume another surface's walk. */
export type BrowseView = "list" | "timeline"

/**
 * The canonical form of everything that narrows WHICH records the server returns.
 *
 * The inverse of `src/store/browse-params.ts`, which decodes what this encodes; the
 * expiry cutoff is the one narrowing that lives in neither — `browseSearchParams`
 * switches it off rather than carrying it, for the reason stated there.
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
  /** The grid's funnels, already mapped to store predicates by `toBrowseQuery`.
   *  Nothing Pretable-shaped reaches this type. */
  readonly filters: readonly BrowseFilter[] | null
  /** The grid's header sort, in PRIORITY order — which is why this one is never
   *  reordered on the way through. */
  readonly orderBy: readonly BrowseSortEntry[] | null
}

/** Timeline is an episode view: the kind funnel still overrides, but with nothing
 *  ticked it asks for episodes rather than for everything. Handed out by reference to
 *  every call that takes the default, so a mutation would reach all of them. */
const TIMELINE_DEFAULT_KIND: readonly MemoryKind[] = Object.freeze(["episodic"])

/** Sorted and deduped, so two funnels that tick the same boxes in a different order
 *  produce ONE dataset key rather than two. Frozen because `readonly` is erased at
 *  runtime, and one widening cast downstream would let a `.sort()` or `.push()` edit
 *  a set the key was already taken over. */
function normalizeSet<T extends string>(values: readonly T[] | undefined): readonly T[] | null {
  if (values === undefined) return null
  return Object.freeze([...new Set(values)].sort())
}

/**
 * An empty list is ABSENT, unlike a value set.
 *
 * The two say different things: `status: []` is a narrowing to nothing, while an
 * empty `filters` is a grid with every funnel cleared — and `validateBrowseQuery`
 * agrees, rejecting a filter entry with no values as a construction bug. Collapsing
 * it here is what keeps an unfiltered query serializing one way however it was
 * reached, so clearing the last funnel returns to the key the page started on
 * instead of minting a third dataset.
 *
 * Order is left alone here. `orderBy` needs that — its order IS the sort priority —
 * while `filters` is canonicalized by its own caller below.
 */
function normalizeList<T>(values: readonly T[] | undefined): readonly T[] | null {
  if (values === undefined || values.length === 0) return null
  return Object.freeze([...values])
}

/** Predicates in one order, whoever built the list. A conjunction is a SET, so the
 *  order carries no meaning to the server — but `datasetKeyOf` stringifies it, and
 *  two spellings of one question would mint two datasets and pivot a selection
 *  nobody changed. The store allows at most one predicate per field, so `field`
 *  alone is a total order over any list it accepts. */
function sortedByField(filters: readonly BrowseFilter[] | null): readonly BrowseFilter[] | null {
  if (filters === null) return null
  return Object.freeze(
    [...filters].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
  )
}

/**
 * MEMOIZE the result. Identity is fresh on every call, so `datasetKeyOf` is the only
 * comparison that answers "same question"; anything keyed on the object itself sees a
 * new dataset every render.
 *
 * A `since` derived from the clock must be pinned to the moment its window changed,
 * never recomputed per render: it is part of the identity, so a moving `since` bumps
 * the key on every render and refetches forever.
 */
export function canonicalBrowseQuery(input: {
  readonly view: BrowseView
  readonly namespace?: string | undefined
  readonly status?: readonly MemoryStatus[] | undefined
  readonly kind?: readonly MemoryKind[] | undefined
  readonly since?: string | undefined
  readonly filters?: readonly BrowseFilter[] | undefined
  readonly orderBy?: readonly BrowseSortEntry[] | undefined
}): CanonicalBrowseQuery {
  const kind = normalizeSet(input.kind)
  const filters = sortedByField(normalizeList(input.filters))
  // The shorthand and a predicate on the same field reach the server as an AND, so
  // the timeline default has to stand down once the funnel claims `kind` — left on,
  // it would answer "episodic AND semantic", which is nothing, under a funnel that
  // reads as applied.
  const kindClaimed = filters?.some((filter) => filter.field === "kind") === true
  return {
    view: input.view,
    // `||`, not `??`: `""` is not a namespace the server can express — `browse-params.ts`
    // drops a falsy one — so it must not read as a narrowing on this side either.
    namespace: input.namespace || null,
    status: normalizeSet(input.status),
    // `[] ?? x` is `[]`, so an emptied funnel survives the timeline default intact.
    kind: kind ?? (input.view === "timeline" && !kindClaimed ? TIMELINE_DEFAULT_KIND : null),
    since: input.since ?? null,
    filters,
    orderBy: normalizeList(input.orderBy),
  }
}

/**
 * The dataset identity. One direction only: a shared key guarantees the same
 * question, while two keys do not guarantee two questions — `view` splits one pair
 * that serializes identically. Any change bumps the desired revision, invalidates the
 * loaded records and the total together, and pivots the grid's `resultMeta.datasetKey`.
 *
 * The canonical JSON IS the key. A hash would only shorten a string that nothing
 * but `===` ever reads, and would buy a collision class in exchange — while an
 * unhashed key stays legible in a failing assertion.
 */
export function datasetKeyOf(query: CanonicalBrowseQuery): string {
  return JSON.stringify([
    query.view,
    query.namespace,
    query.status,
    query.kind,
    query.since,
    // A predicate and an order narrow and rank the answer, so both are identity: a
    // key that ignored them would never pivot for a funnel or a header click, and a
    // selection taken over one question would survive into another's rows.
    query.filters,
    query.orderBy,
  ])
}

/** A set narrowed to nothing matches nothing. Over HTTP a repeated param that
 *  appears zero times is ABSENT, so asking the server would come back unfiltered —
 *  the opposite answer. Callers must resolve this locally instead. */
export function browseMatchesNothing(query: CanonicalBrowseQuery): boolean {
  return query.status?.length === 0 || query.kind?.length === 0
}

/**
 * One window of `query`, as the params `/api/memory/list` parses.
 *
 * THROWS on a matches-nothing query. `browseMatchesNothing` is the guard, and a
 * caller that skips it has to fail loudly: the params for an empty set are the params
 * for no set at all, so the request would come back unfiltered — every record, in
 * answer to "none of them".
 */
export function browseSearchParams(
  query: CanonicalBrowseQuery,
  window: { readonly limit: number; readonly offset: number },
): URLSearchParams {
  if (browseMatchesNothing(query))
    throw new Error("browseSearchParams: this query matches nothing; resolve it locally")
  const params = new URLSearchParams()
  // EXACT namespace, not `namespacePrefix`: a prefix answer and an exact total
  // describe different sets, and this UI displays the two side by side.
  if (query.namespace !== null) params.set("namespace", query.namespace)
  for (const value of query.status ?? []) params.append("status", value)
  for (const value of query.kind ?? []) params.append("kind", value)
  if (query.since !== null) params.set("since", query.since)
  // JSON, because that is the grammar `src/store/browse-params.ts` parses for these
  // two — operators and directions have no repeated-param spelling.
  if (query.filters !== null) params.set("filters", JSON.stringify(query.filters))
  if (query.orderBy !== null) params.set("orderBy", JSON.stringify(query.orderBy))
  // The expiry cutoff is switched OFF rather than pinned, which is what makes the
  // dataset key total. Left to default, the route stamps `now` per request, so an
  // episode expiring mid-walk shifts every later offset up by one and that row is
  // skipped for good — and two requests sharing a key answer different sets. Pinning
  // a `now` here would instead freeze the cutoff for a view that re-polls every two
  // seconds, and advancing it would pivot the whole dataset just to move a clock.
  params.set("includeExpired", "1")
  params.set("limit", String(window.limit))
  params.set("offset", String(window.offset))
  return params
}
