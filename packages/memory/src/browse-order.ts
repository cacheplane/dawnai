import { BrowseQueryError } from "./browse-validate.js"
import type { BrowseSortEntry, BrowseSortField } from "./types.js"

export interface ResolvedBrowseSort {
  readonly field: BrowseSortField
  /** Physical column. Comes from the table below and NOWHERE else — this is the
   *  only place a browse sort name becomes a SQL identifier. */
  readonly column: string
  readonly dir: "asc" | "desc"
  /** Postgres binds JS numbers as float8; a float4 column needs a `::real` cast on
   *  the parameter or equality against a stored value is false. */
  readonly numeric: boolean
  /** Postgres needs COLLATE "C" here to match SQLite's BINARY order. Deliberately
   *  FALSE for updated_at/created_at: they are uniform ASCII (so every collation
   *  agrees) AND the (updated_at DESC, id ASC) index is uncollated — a collated
   *  ORDER BY would stop matching it and turn the hot path into a sort. */
  readonly collateC: boolean
}

const COLUMNS: Readonly<
  Record<
    BrowseSortField,
    { readonly column: string; readonly numeric: boolean; readonly collateC: boolean }
  >
> = {
  updatedAt: { column: "updated_at", numeric: false, collateC: false },
  createdAt: { column: "created_at", numeric: false, collateC: false },
  confidence: { column: "confidence", numeric: true, collateC: false },
  namespace: { column: "namespace", numeric: false, collateC: true },
  kind: { column: "kind", numeric: false, collateC: false },
  status: { column: "status", numeric: false, collateC: false },
}

/** The documented reset state: newest first, `id ASC` appended by the stores. */
export const DEFAULT_BROWSE_ORDER: readonly ResolvedBrowseSort[] = [
  { field: "updatedAt", column: "updated_at", dir: "desc", numeric: false, collateC: false },
]

export function resolveBrowseOrder(
  orderBy?: readonly BrowseSortEntry[],
): readonly ResolvedBrowseSort[] {
  if (!orderBy || orderBy.length === 0) return DEFAULT_BROWSE_ORDER
  return orderBy.map((entry) => {
    const meta = COLUMNS[entry.field]
    // Defence in depth: validateBrowseQuery already rejected this, but a store
    // must never interpolate an unmapped name.
    if (!meta) throw new BrowseQueryError(`unknown sort field ${JSON.stringify(entry.field)}`)
    return {
      field: entry.field,
      column: meta.column,
      dir: entry.dir,
      numeric: meta.numeric,
      collateC: meta.collateC,
    }
  })
}
