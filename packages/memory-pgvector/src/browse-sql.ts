import {
  type BrowseFilter,
  BrowseQueryError,
  namespacePrefixUpperBound,
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
      // confidence is float4, and the comparison must resolve THERE: promoted to
      // float8 it reads 0.9::real <> 0.9, so equality against a stored value is
      // false. Uncast, that resolution is inherited from the column's context; the
      // cast states it, so wrapping the column can never silently promote it.
      if (filter.op === "between") {
        params.push(filter.min, filter.max)
        const max = params.length
        where.push(`confidence >= $${max - 1}::real AND confidence <= $${max}::real`)
        return
      }
      const operators = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const
      params.push(filter.value)
      where.push(`confidence ${operators[filter.op]} $${params.length}::real`)
      return
    }
    case "updatedAt": {
      switch (filter.op) {
        case "onDay":
          params.push(utcDayStart(filter.day), utcDayAfter(filter.day))
          where.push(`updated_at >= $${params.length - 1} AND updated_at < $${params.length}`)
          return
        case "beforeDay":
          params.push(utcDayStart(filter.day))
          where.push(`updated_at < $${params.length}`)
          return
        case "afterDay":
          params.push(utcDayAfter(filter.day))
          where.push(`updated_at >= $${params.length}`)
          return
        default:
          // Inclusive of BOTH days: the upper bound is the day AFTER untilDay.
          params.push(utcDayStart(filter.fromDay), utcDayAfter(filter.untilDay))
          where.push(`updated_at >= $${params.length - 1} AND updated_at < $${params.length}`)
          return
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
