import type { ColumnFilter } from "@pretable/react"

/**
 * The grid's funnel speaks operators over a closed set of options; the store
 * speaks a set of values. `undefined` means unfiltered, and `[]` means match
 * nothing — the same distinction `BrowseQuery` draws, kept rather than
 * collapsed so an emptied funnel does not read as "show everything".
 */
export type ValueSet<T extends string> = readonly T[] | undefined

/**
 * Resolve one funnel filter against the column's full option list.
 *
 * `isNoneOf` becomes the complement rather than needing negation support
 * downstream: these columns are closed enums, so "not any of these" is exactly
 * "any of the others". `isEmpty`/`isNotEmpty` are offered for every column type
 * but are degenerate here — the values are non-nullable, so nothing is empty
 * and everything is non-empty.
 */
export function resolveFilter<T extends string>(
  filter: ColumnFilter | undefined,
  all: readonly T[],
): ValueSet<T> {
  if (!filter) return undefined
  const selected = toValues<T>(filter.value).filter((value) => all.includes(value))

  switch (filter.operator) {
    case "isAnyOf":
      // A funnel with nothing ticked is a filter that matches nothing.
      return selected
    case "isNoneOf":
      return all.filter((value) => !selected.includes(value))
    case "isEmpty":
      return []
    case "isNotEmpty":
      return undefined
    default:
      // Any other operator would be a text-style predicate the store cannot
      // express as a set; leaving it unfiltered beats guessing.
      return undefined
  }
}

/** The funnel state that displays a resolved set — the inverse of `resolveFilter`. */
export function toFilter<T extends string>(
  values: ValueSet<T>,
  all: readonly T[],
): ColumnFilter | undefined {
  if (values === undefined || values.length === all.length) return undefined
  return { operator: "isAnyOf", value: [...values] }
}

function toValues<T extends string>(value: ColumnFilter["value"]): T[] {
  if (Array.isArray(value)) return value.filter((v): v is T => typeof v === "string")
  return typeof value === "string" ? [value as T] : []
}
