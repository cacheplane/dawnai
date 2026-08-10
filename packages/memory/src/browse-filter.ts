/**
 * Normalise a `BrowseQuery` filter that accepts either one value or a set.
 *
 * Returns `undefined` when the caller did not filter on the field at all, and
 * an array otherwise — including the empty array, which is a filter that
 * matches nothing rather than an absent one. Backends must keep that
 * distinction: `IN ()` is false, while "no clause" is true for every row.
 *
 * Exported so the sqlite and Postgres stores share one reading of the contract
 * instead of each interpreting the union themselves.
 */
export function normalizeSetFilter<T extends string>(
  value: T | readonly T[] | undefined,
): readonly T[] | undefined {
  if (value === undefined) return undefined
  return typeof value === "string" ? [value] : value
}
