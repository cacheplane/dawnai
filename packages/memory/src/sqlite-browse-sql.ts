import type { SQLInputValue } from "node:sqlite"
import type { BrowseFilter } from "./types.js"

/**
 * Append one normalized filter to a SQLite WHERE list. Column names come from this
 * switch and nowhere else; every value is bound.
 *
 * Text matching uses literal substring primitives (`instr`, `substr`) rather than
 * LIKE, so `%`, `_` and `\` in a user's search term need no escaping and can never
 * change the predicate. Case-insensitivity is `lower()`, which is ASCII-only in
 * SQLite without ICU — a documented, conformance-pinned divergence from Postgres's
 * ctype-aware `lower()`.
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
        default:
          where.push("lower(content) <> lower(?)")
          params.push(filter.value)
          return
      }
    }
    default:
      throw new Error(`unhandled browse filter field: ${(filter as { field: string }).field}`)
  }
}
