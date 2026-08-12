/** The two fields the default browse order (`updatedAt DESC, id ASC`) reads. */
export interface BrowseOrderKey {
  readonly id: string
  readonly updatedAt: string
}

/**
 * The default browse order, evaluated client-side. Pinned against the store's
 * `DEFAULT_BROWSE_ORDER` in browse-reconcile.test.ts — the span comparisons below
 * only decide anything while this IS the ORDER BY the server ran.
 *
 * `<` on strings is UTF-16 code-unit order, which has to agree with the server's
 * byte order or a client-side span comparison contradicts the window the server
 * actually returned. `updatedAt` agrees outright: it is full-ISO-Z TEXT. Ids agree
 * only as far as they stay ASCII, and nothing enforces that — `put()` stores
 * whatever id the caller hands it and neither schema has a CHECK; it holds today
 * because every in-repo generator emits `memory_<kind>_<hash>`. The exposure is
 * narrower than "non-ASCII" though: UTF-16 sorts surrogates BELOW U+E000–U+FFFF
 * while UTF-8 sorts their bytes above, so only an ASTRAL character in an id can
 * order differently on the two sides.
 */
export function compareDefaultBrowseOrder(a: BrowseOrderKey, b: BrowseOrderKey): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** Append `next` onto `prev`, dropping every id already seen — held by `prev` OR
 *  taken earlier within `next` itself, so the result carries each id once whatever
 *  arrives. The belt-and-suspenders against a paging duplicate. Returns `prev`
 *  ITSELF when nothing was added, so an append that changed nothing does not churn
 *  the array identity the grid keys its work on. */
export function dedupeById<T extends { readonly id: string }>(
  prev: readonly T[],
  next: readonly T[],
): readonly T[] {
  const held = new Set(prev.map((row) => row.id))
  const added: T[] = []
  for (const row of next) {
    if (held.has(row.id)) continue
    held.add(row.id)
    added.push(row)
  }
  return added.length === 0 ? prev : [...prev, ...added]
}

/**
 * Head-anchored refresh reconciliation, rules 1–3:
 *
 * 1. A resident row whose id appears in the response takes the response's payload
 *    AND position — hoists into the head span and stale payloads, in one rule.
 *    Falls out of placing `refreshed` wholesale at the front.
 * 2. A resident row inside the refreshed span but absent from the response was
 *    deleted or moved out of the result: DROP it.
 * 3. A resident row beyond the refreshed span (head inserts pushed coverage up) is
 *    RETAINED as a possibly-stale tail. Rows are never evicted from under the user
 *    because inserts arrived; the next tick asks for a limit of the grown resident
 *    count and re-covers them — but only BELOW the caller's resident cap. At the cap
 *    the limit stops growing while rule 3 keeps appending, so the overflow never
 *    self-heals: `supersede` demotes a row with an UPDATE that leaves `updated_at`
 *    alone, so a row parked past the cap cannot move back into the span and renders
 *    active for good. A caller that polls forever must truncate this result to its
 *    own cap; this function does not know one.
 *
 * `span.filled` is the caller's statement that the response reached its limit, taken
 * against the request that produced it rather than re-derived here from a limit this
 * function does not hold. A window that did not fill reached the end of
 * the matching set, so its span is unbounded and rule 3 has no members.
 *
 * Always allocates, unlike `dedupeById` — deliberately, for want of a sound no-op
 * check to return `resident` on. The response is freshly parsed, so nothing is
 * reference-equal, and positional `(id, updatedAt)` equality would read the
 * `supersede` case above as an unchanged tick and pin a stale status on screen.
 */
export function reconcileRefreshedWindow<T extends BrowseOrderKey>(
  resident: readonly T[],
  refreshed: readonly T[],
  span: { readonly filled: boolean },
): readonly T[] {
  const spanEnd = span.filled ? refreshed.at(-1) : undefined
  if (spanEnd === undefined) return [...refreshed]
  const refreshedIds = new Set(refreshed.map((row) => row.id))
  const tail = resident.filter(
    (row) => !refreshedIds.has(row.id) && compareDefaultBrowseOrder(row, spanEnd) > 0,
  )
  return tail.length === 0 ? [...refreshed] : [...refreshed, ...tail]
}
