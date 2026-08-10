import type { SQLInputValue } from "node:sqlite"
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
    default:
      // Reachable today: validateBrowseQuery accepts namespace/confidence/updatedAt,
      // whose clauses are not built yet. BrowseQueryError rather than Error — the HTTP
      // boundary maps a rejection by NAME, so a plain Error 500s where this must 400.
      throw new BrowseQueryError(`unhandled browse filter field: ${filter.field}`)
  }
}
