import { BrowseQueryError } from "./browse-validate.js"
import type { BrowseSortEntry, BrowseSortField } from "./types.js"

export interface ResolvedBrowseSort {
  readonly field: BrowseSortField
  /** Physical column. Comes from the table below and NOWHERE else — this is the
   *  only place a browse sort name becomes a SQL identifier. */
  readonly column: string
  readonly dir: "asc" | "desc"
  /** Postgres binds JS numbers as float8; a float4 column needs a `::real` cast on
   *  the parameter or equality against a stored value is false. Postgres also STORES
   *  confidence as float4, so two confidences that differ only below float4 precision
   *  are equal at rest there and still distinct on SQLite — ordering by confidence
   *  then falls to the id tie-break on one backend and not the other. */
  readonly numeric: boolean
  /** Postgres needs COLLATE "C" here to match SQLite's BINARY order. Deliberately
   *  FALSE for updated_at/created_at: they are uniform ASCII (so every collation
   *  agrees) AND the (updated_at DESC, id ASC) index is uncollated — a collated
   *  ORDER BY would stop matching it and turn the hot path into a sort. FALSE for
   *  kind/status on unrelated grounds: they are closed lowercase-ASCII enums, so no
   *  collation can reorder them. Nothing but TypeScript holds that — neither schema
   *  has a CHECK — and a member outside `[a-z]+` would need this flipped to true. */
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

/** The documented reset state: newest first. `resolveBrowseOrder` hands out THIS array,
 *  so it is frozen — the stores' `id ASC` tie-break goes into a new list, and a store
 *  that appends in place fails loudly instead of rewriting the default process-wide. */
export const DEFAULT_BROWSE_ORDER: readonly ResolvedBrowseSort[] = Object.freeze([
  Object.freeze<ResolvedBrowseSort>({ field: "updatedAt", ...COLUMNS.updatedAt, dir: "desc" }),
])

export function resolveBrowseOrder(
  orderBy?: readonly BrowseSortEntry[],
): readonly ResolvedBrowseSort[] {
  if (!orderBy || orderBy.length === 0) return DEFAULT_BROWSE_ORDER
  return orderBy.map((entry) => {
    const meta = COLUMNS[entry.field]
    // Defence in depth: validateBrowseQuery already rejected this, but a store
    // must never interpolate an unmapped name.
    if (!meta) throw new BrowseQueryError(`unknown sort field ${JSON.stringify(entry.field)}`)
    // Checked HERE rather than trusted to each dialect's `dir === "desc" ? … : …`, so the
    // whitelist is the single gate every part of an ORDER BY passes through.
    if (entry.dir !== "asc" && entry.dir !== "desc")
      throw new BrowseQueryError(
        `sort direction must be "asc" or "desc", got ${JSON.stringify(entry.dir)}`,
      )
    return {
      field: entry.field,
      column: meta.column,
      dir: entry.dir,
      numeric: meta.numeric,
      collateC: meta.collateC,
    }
  })
}
