import type { SQLInputValue } from "node:sqlite"
import type { BrowseCursorPayload } from "./browse-cursor.js"
import type { ResolvedBrowseSort } from "./browse-order.js"
import { namespacePrefixUpperBound, utcDayAfter, utcDayStart } from "./browse-range.js"
import { BrowseQueryError } from "./browse-validate.js"
import type { BrowseFilter } from "./types.js"

/**
 * Append one normalized filter to a SQLite WHERE list. Column names come from this
 * switch and nowhere else; every value is bound.
 *
 * Text matching uses literal substring primitives (`instr`, `substr`) rather than
 * LIKE, so `%`, `_` and `\` in a user's search term need no escaping and can never
 * change the predicate. Case-insensitivity is `lower()`, which folds ASCII only in
 * SQLite without ICU: `lower('CAFÉ')` is `'cafÉ'` here and `'café'` in Postgres, so a
 * non-ASCII needle matches on one backend and misses on the other. The conformance
 * suite asserts ONE reading for both stores and therefore cannot pin that divergence —
 * every fixture there is ASCII, and this comment is the whole documentation of it.
 */
export function appendSqliteBrowseFilter(
  filter: BrowseFilter,
  where: string[],
  params: SQLInputValue[],
): void {
  switch (filter.field) {
    case "status":
    case "kind": {
      const column = filter.field
      const placeholders = filter.values.map(() => "?").join(",")
      where.push(
        filter.op === "in"
          ? `${column} IN (${placeholders})`
          : `${column} NOT IN (${placeholders})`,
      )
      params.push(...filter.values)
      return
    }
    case "content": {
      switch (filter.op) {
        case "contains":
          where.push("instr(lower(content), lower(?)) > 0")
          params.push(filter.value)
          return
        case "notContains":
          where.push("instr(lower(content), lower(?)) = 0")
          params.push(filter.value)
          return
        case "startsWith":
          where.push("instr(lower(content), lower(?)) = 1")
          params.push(filter.value)
          return
        case "endsWith":
          // Negative substr() takes the LAST n characters; a needle longer than the
          // content yields the whole content, which cannot equal it. Correct by
          // construction, no length guard needed.
          where.push("substr(lower(content), -length(?)) = lower(?)")
          params.push(filter.value, filter.value)
          return
        case "equals":
          where.push("lower(content) = lower(?)")
          params.push(filter.value)
          return
        case "notEquals":
          where.push("lower(content) <> lower(?)")
          params.push(filter.value)
          return
        default: {
          // Every op has its own case above, so this binding is `never` today: an op
          // added to the union stops the BUILD here rather than reaching a caller as
          // `<>` — wrong rows, no signal, and two dialects to forget.
          const unmapped: never = filter
          throw new BrowseQueryError(
            `unhandled content filter op: ${JSON.stringify((unmapped as BrowseFilter).op)}`,
          )
        }
      }
    }
    case "namespace": {
      if (filter.op === "equals") {
        where.push("namespace = ?")
        params.push(filter.value)
        return
      }
      // Byte-exact prefix as a half-open RANGE: metacharacters stay literal and the
      // comparison stays case-sensitive. Sargable, with the same ORDER BY trade the
      // store's own `namespacePrefix` documents.
      const upper = namespacePrefixUpperBound(filter.value)
      where.push(upper === undefined ? "namespace >= ?" : "namespace >= ? AND namespace < ?")
      params.push(filter.value)
      if (upper !== undefined) params.push(upper)
      return
    }
    case "confidence": {
      if (filter.op === "between") {
        // Inclusive on both ends, matching the grid's local `between`.
        where.push("confidence >= ? AND confidence <= ?")
        params.push(filter.min, filter.max)
        return
      }
      const operators = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const
      where.push(`confidence ${operators[filter.op]} ?`)
      params.push(filter.value)
      return
    }
    case "updatedAt": {
      // Bounds are the fixed-width `YYYY-MM-DDT00:00:00.000Z` form and the comparison
      // is lexicographic, so a row buckets to the right UTC day only while its stored
      // updated_at is that same form. Nothing enforces that — MemoryRecord types
      // updatedAt as a bare string — so `2026-08-02T20:00:00-05:00` lands in the day it
      // READS as, not the day it is. Both schemas flag the unnormalized column for
      // ORDER BY; here it decides membership, not just order.
      switch (filter.op) {
        case "onDay":
          where.push("updated_at >= ? AND updated_at < ?")
          params.push(utcDayStart(filter.day), utcDayAfter(filter.day))
          return
        case "beforeDay":
          where.push("updated_at < ?")
          params.push(utcDayStart(filter.day))
          return
        case "afterDay":
          where.push("updated_at >= ?")
          params.push(utcDayAfter(filter.day))
          return
        case "betweenDays":
          // Inclusive of BOTH days.
          where.push("updated_at >= ? AND updated_at < ?")
          params.push(utcDayStart(filter.fromDay), utcDayAfter(filter.untilDay))
          return
        default: {
          const unmapped: never = filter
          throw new BrowseQueryError(
            `unhandled updatedAt filter op: ${JSON.stringify((unmapped as BrowseFilter).op)}`,
          )
        }
      }
    }
    default: {
      // Every field has its own case above, so this binding is `never`: a field added
      // to the union stops the BUILD here rather than reaching a caller unfiltered.
      // Still throws at runtime — the untyped HTTP caller reaches this too, and
      // BrowseQueryError rather than Error because that boundary maps a rejection by
      // NAME: a plain Error 500s where this must 400.
      const unmapped: never = filter
      throw new BrowseQueryError(
        `unhandled browse filter field: ${(unmapped as BrowseFilter).field}`,
      )
    }
  }
}

/**
 * Everything strictly after `cursor` in `order`, as a WHERE fragment.
 *
 * Row-value comparisons cannot express mixed asc/desc, so this is the expanded
 * OR-chain — plus a REDUNDANT leading range guard. The guard is logically implied by
 * the chain and is still mandatory: it is what lets the planner seek the leading index
 * column instead of scanning the whole index (0.54 ms vs 22.8 ms at 1M rows).
 *
 * Parameters are pushed in the exact textual order they appear, so the caller can
 * concatenate this fragment after its filter clauses without renumbering.
 */
export function sqliteKeysetWhere(
  order: readonly ResolvedBrowseSort[],
  cursor: BrowseCursorPayload,
  params: SQLInputValue[],
): string {
  const first = order[0]
  // A plain Error 500s at the boundary that maps this module's throws to 400 by name.
  if (!first) throw new BrowseQueryError("keyset requires at least one ordered key")
  const guard = `${first.column} ${first.dir === "desc" ? "<=" : ">="} ?`
  params.push(cursor.key[0] as SQLInputValue)

  const terms: string[] = []
  for (let i = 0; i < order.length; i += 1) {
    const parts: string[] = []
    for (let j = 0; j < i; j += 1) {
      // Narrowed rather than `order[j]?.column`: out of range this throws, where
      // optional chaining would interpolate the literal identifier `undefined`.
      const entry = order[j] as ResolvedBrowseSort
      parts.push(`${entry.column} = ?`)
      params.push(cursor.key[j] as SQLInputValue)
    }
    const entry = order[i] as ResolvedBrowseSort
    parts.push(`${entry.column} ${entry.dir === "desc" ? "<" : ">"} ?`)
    params.push(cursor.key[i] as SQLInputValue)
    terms.push(parts.length === 1 ? (parts[0] as string) : `(${parts.join(" AND ")})`)
  }
  const tail: string[] = []
  for (let j = 0; j < order.length; j += 1) {
    const entry = order[j] as ResolvedBrowseSort
    tail.push(`${entry.column} = ?`)
    params.push(cursor.key[j] as SQLInputValue)
  }
  tail.push("id > ?")
  params.push(cursor.id)
  terms.push(`(${tail.join(" AND ")})`)

  return `${guard} AND (${terms.join(" OR ")})`
}
