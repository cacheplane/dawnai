import {
  type BrowseCursorPayload,
  type BrowseFilter,
  BrowseQueryError,
  namespacePrefixUpperBound,
  type ResolvedBrowseSort,
  utcDayAfter,
  utcDayStart,
} from "@dawn-ai/memory"

/**
 * Append one normalized filter to a Postgres WHERE list, numbering `$n` from the
 * caller's current parameter count. Mirrors `appendSqliteBrowseFilter` clause for
 * clause; the conformance suite is what holds the two readings together.
 */
export function appendPgBrowseFilter(
  filter: BrowseFilter,
  where: string[],
  params: unknown[],
): void {
  switch (filter.field) {
    case "status":
    case "kind": {
      const column = filter.field
      params.push(filter.values)
      // One bind for the whole set, and `<> ALL` is the exact NOT IN equivalent.
      where.push(
        filter.op === "in"
          ? `${column} = ANY($${params.length}::text[])`
          : `${column} <> ALL($${params.length}::text[])`,
      )
      return
    }
    case "content": {
      switch (filter.op) {
        case "contains":
          params.push(filter.value)
          where.push(`position(lower($${params.length}) in lower(content)) > 0`)
          return
        case "notContains":
          params.push(filter.value)
          where.push(`position(lower($${params.length}) in lower(content)) = 0`)
          return
        case "startsWith":
          params.push(filter.value)
          where.push(`starts_with(lower(content), lower($${params.length}))`)
          return
        case "endsWith": {
          params.push(filter.value, filter.value)
          const second = params.length
          where.push(`right(lower(content), length($${second - 1})) = lower($${second})`)
          return
        }
        case "equals":
          params.push(filter.value)
          where.push(`lower(content) = lower($${params.length})`)
          return
        case "notEquals":
          params.push(filter.value)
          where.push(`lower(content) <> lower($${params.length})`)
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
        params.push(filter.value)
        where.push(`namespace COLLATE "C" = $${params.length}`)
        return
      }
      const upper = namespacePrefixUpperBound(filter.value)
      params.push(filter.value)
      const lower = params.length
      if (upper === undefined) {
        where.push(`namespace COLLATE "C" >= $${lower}`)
        return
      }
      params.push(upper)
      where.push(`namespace COLLATE "C" >= $${lower} AND namespace COLLATE "C" < $${params.length}`)
      return
    }
    case "confidence": {
      // confidence is float4 and the comparison must resolve THERE: promoted to
      // float8 it reads 0.9::real <> 0.9, so equality against a stored value is false.
      if (filter.op === "between") {
        params.push(filter.min, filter.max)
        const second = params.length
        where.push(`confidence >= $${second - 1}::real AND confidence <= $${second}::real`)
        return
      }
      const operators = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const
      params.push(filter.value)
      where.push(`confidence ${operators[filter.op]} $${params.length}::real`)
      return
    }
    case "updatedAt": {
      switch (filter.op) {
        case "onDay": {
          params.push(utcDayStart(filter.day), utcDayAfter(filter.day))
          const second = params.length
          where.push(`updated_at >= $${second - 1} AND updated_at < $${second}`)
          return
        }
        case "beforeDay":
          params.push(utcDayStart(filter.day))
          where.push(`updated_at < $${params.length}`)
          return
        case "afterDay":
          params.push(utcDayAfter(filter.day))
          where.push(`updated_at >= $${params.length}`)
          return
        case "betweenDays": {
          // Inclusive of BOTH days.
          params.push(utcDayStart(filter.fromDay), utcDayAfter(filter.untilDay))
          const second = params.length
          where.push(`updated_at >= $${second - 1} AND updated_at < $${second}`)
          return
        }
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
 * Postgres twin of `sqliteKeysetWhere` — same shape, same guard, `$n` numbering
 * continued from `params`, COLLATE "C" where byte order matters and `::real` on the
 * float4 column.
 */
export function pgKeysetWhere(
  order: readonly ResolvedBrowseSort[],
  cursor: BrowseCursorPayload,
  params: unknown[],
): string {
  const first = order[0]
  if (!first) throw new Error("keyset requires at least one ordered key")
  const col = (entry: ResolvedBrowseSort) =>
    entry.collateC ? `${entry.column} COLLATE "C"` : entry.column
  const bind = (entry: ResolvedBrowseSort, index: number) =>
    entry.numeric ? `$${index}::real` : `$${index}`

  params.push(cursor.key[0])
  const guard = `${col(first)} ${first.dir === "desc" ? "<=" : ">="} ${bind(first, params.length)}`

  const terms: string[] = []
  for (let i = 0; i < order.length; i += 1) {
    const parts: string[] = []
    for (let j = 0; j < i; j += 1) {
      const entry = order[j] as ResolvedBrowseSort
      params.push(cursor.key[j])
      parts.push(`${col(entry)} = ${bind(entry, params.length)}`)
    }
    const entry = order[i] as ResolvedBrowseSort
    params.push(cursor.key[i])
    parts.push(`${col(entry)} ${entry.dir === "desc" ? "<" : ">"} ${bind(entry, params.length)}`)
    terms.push(parts.length === 1 ? (parts[0] as string) : `(${parts.join(" AND ")})`)
  }
  const tail: string[] = []
  for (let j = 0; j < order.length; j += 1) {
    const entry = order[j] as ResolvedBrowseSort
    params.push(cursor.key[j])
    tail.push(`${col(entry)} = ${bind(entry, params.length)}`)
  }
  params.push(cursor.id)
  tail.push(`id COLLATE "C" > $${params.length}`)
  terms.push(`(${tail.join(" AND ")})`)

  return `${guard} AND (${terms.join(" OR ")})`
}
