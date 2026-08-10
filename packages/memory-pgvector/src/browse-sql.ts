import type { BrowseFilter } from "@dawn-ai/memory"

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
        default:
          params.push(filter.value)
          where.push(`lower(content) <> lower($${params.length})`)
          return
      }
    }
    default:
      throw new Error(`unhandled browse filter field: ${(filter as { field: string }).field}`)
  }
}
