/** The two fields the default browse order (`updatedAt DESC, id ASC`) reads. */
export interface BrowseOrderKey {
  readonly id: string
  readonly updatedAt: string
}

/**
 * The default browse order, evaluated client-side.
 *
 * `<` on strings is UTF-16 code-unit order. That equals the server's byte order
 * here because both fields are ASCII-uniform by construction — `updatedAt` is
 * full-ISO-Z TEXT and ids are ASCII — which is exactly what lets a client-side
 * span comparison agree with the window the server actually returned.
 */
export function compareDefaultBrowseOrder(a: BrowseOrderKey, b: BrowseOrderKey): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** Append `next` onto `prev`, dropping ids `prev` already holds — the
 *  belt-and-suspenders against a paging duplicate. Returns `prev` ITSELF when
 *  nothing was added, so an append that changed nothing does not churn the array
 *  identity the grid keys its work on. */
export function dedupeById<T extends { readonly id: string }>(
  prev: readonly T[],
  next: readonly T[],
): readonly T[] {
  const held = new Set(prev.map((row) => row.id))
  const added = next.filter((row) => !held.has(row.id))
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
 *    because inserts arrived; the next tick's larger limit re-covers them.
 *
 * A window that did not FILL its limit reached the end of the matching set, so its
 * span is unbounded and rule 3 has no members.
 */
export function reconcileRefreshedWindow<T extends BrowseOrderKey>(
  resident: readonly T[],
  refreshed: readonly T[],
  requestedLimit: number,
): readonly T[] {
  const spanEnd = refreshed.length >= requestedLimit ? refreshed.at(-1) : undefined
  if (spanEnd === undefined) return [...refreshed]
  const refreshedIds = new Set(refreshed.map((row) => row.id))
  const tail = resident.filter(
    (row) => !refreshedIds.has(row.id) && compareDefaultBrowseOrder(row, spanEnd) > 0,
  )
  return tail.length === 0 ? [...refreshed] : [...refreshed, ...tail]
}
