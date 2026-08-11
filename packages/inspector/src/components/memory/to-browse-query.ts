import {
  type BrowseFilter,
  BrowseQueryError,
  type BrowseSortEntry,
  type BrowseSortField,
  type MemoryKind,
  type MemoryStatus,
} from "@dawn-ai/memory/browse"
import type { ColumnFilter, FilterOperator, PretableSortEntry } from "@pretable/react"
import { isMemoryKind, isMemoryStatus } from "./memory-domain"

/** The two query parts a grid can express. Keys are OMITTED when empty rather
 *  than emitted as `[]`, so an unfiltered query serializes identically however
 *  it was reached — which keeps the client-side datasetKey hash stable. */
export interface BrowseQueryIntent {
  readonly filters?: readonly BrowseFilter[]
  readonly orderBy?: readonly BrowseSortEntry[]
}

/** The validator's ceiling, restated where the UI can enforce it. */
export const MAX_BROWSE_SORT_ENTRIES = 3

/** Grid column id → the `BrowseFilter` field it edits. A column missing from
 *  this table has no server predicate, so its funnel must not exist. */
const FILTER_FIELD_BY_COLUMN = {
  status: "status",
  kind: "kind",
  content: "content",
  namespace: "namespace",
  confidence: "confidence",
  updated: "updatedAt",
} as const satisfies Record<string, BrowseFilter["field"]>

/** Grid column id → sort field. `content` is deliberately absent: the store's
 *  whitelist has no content field (design §14 Q2), and the column declares
 *  `sortable: false` so this table is never asked for it. */
const SORT_FIELD_BY_COLUMN = {
  status: "status",
  kind: "kind",
  namespace: "namespace",
  confidence: "confidence",
  updated: "updatedAt",
} as const satisfies Record<string, BrowseSortField>

// Spelled out rather than Extract-ed: `Extract<BrowseFilter, {op: …}>` over the
// confidence arms matches BOTH of them (the `between` arm's op is a string too),
// which would quietly let `between` into the comparison table it must never be in.
type ContentOp = Extract<BrowseFilter, { field: "content" }>["op"]
type ConfidenceCompareOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
type DayOp = "onDay" | "beforeDay" | "afterDay"

const CONTENT_OP: Partial<Record<FilterOperator, ContentOp>> = {
  contains: "contains",
  notContains: "notContains",
  equals: "equals",
  notEquals: "notEquals",
  startsWith: "startsWith",
  endsWith: "endsWith",
}
const CONFIDENCE_OP: Partial<Record<FilterOperator, ConfidenceCompareOp>> = {
  equals: "eq",
  notEquals: "neq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
}
const DAY_OP: Partial<Record<FilterOperator, DayOp>> = {
  on: "onDay",
  before: "beforeDay",
  after: "afterDay",
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Every refusal in this module.
 *
 * It THROWS rather than dropping the clause: dropping it silently would leave a
 * funnel that looks applied and is not, the exact dishonesty this whole design
 * exists to remove.
 *
 * `filterOperators` makes an unmappable operator rare, NOT unreachable —
 * pretable's `operatorsForType` warns once and falls back to the full set,
 * `isEmpty`/`isNotEmpty` included, when the declared list prunes every operator
 * the column type offers (operator names that do not match the `type` do that).
 * The user then sees "is empty" on the menu and clicks it, so this backstop
 * catches a live path and not only a coding slip.
 *
 * `BrowseQueryError` is reused so the Inspector has ONE rejection family, and
 * `isBrowseQueryError` (src/store/browse-params.ts) matches on `error.name`, so
 * it recognises this across the two module copies Next's bundler produces.
 */
function unmappable(detail: string): never {
  throw new BrowseQueryError(
    `cannot map grid intent to a browse query: ${detail}`,
    "unmappable-intent",
  )
}

function badOperator(columnId: string, operator: FilterOperator): never {
  return unmappable(`operator "${operator}" on column "${columnId}" has no BrowseFilter arm`)
}

function asText(value: ColumnFilter["value"], label: string): string {
  // Trimmed to DECIDE, returned untrimmed: an all-whitespace box is an empty one the
  // user cannot see, while a leading or trailing space inside a real value is part of
  // the predicate — the store compares the bytes it is given.
  if (typeof value !== "string" || value.trim() === "")
    unmappable(`${label} needs a non-empty text value, got ${JSON.stringify(value)}`)
  return value
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    unmappable(`${label} needs a finite number, got ${JSON.stringify(value)}`)
  return value
}

function asDay(value: unknown, label: string): string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value))
    unmappable(`${label} needs a "YYYY-MM-DD" day, got ${JSON.stringify(value)}`)
  return value
}

// Both helpers widen through a local before the Array.isArray guard: TypeScript
// does not narrow a READONLY tuple/array member of a union through that guard,
// so indexing the original value straight after it is a type error.
function asPair(value: ColumnFilter["value"], label: string): readonly [unknown, unknown] {
  const list = value as readonly unknown[] | null
  if (!Array.isArray(list) || list.length !== 2)
    unmappable(`${label} needs a two-element range, got ${JSON.stringify(value)}`)
  return [list[0], list[1]] as const
}

function asValues(value: ColumnFilter["value"], label: string): readonly string[] {
  const list = value as readonly unknown[] | null
  if (!Array.isArray(list) || list.length === 0)
    unmappable(`${label} needs a non-empty value list, got ${JSON.stringify(value)}`)
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== "string")
      unmappable(`${label} values must be strings, got ${JSON.stringify(entry)}`)
    out.push(entry)
  }
  return out
}

function setOp(columnId: string, operator: FilterOperator): "in" | "notIn" {
  if (operator === "isAnyOf") return "in"
  if (operator === "isNoneOf") return "notIn"
  return badOperator(columnId, operator)
}

function toBrowseFilter(columnId: string, filter: ColumnFilter): BrowseFilter {
  const field = FILTER_FIELD_BY_COLUMN[columnId as keyof typeof FILTER_FIELD_BY_COLUMN]
  if (field === undefined) unmappable(`column "${columnId}" has no browse filter field`)
  const { operator, value } = filter

  switch (field) {
    case "status": {
      const op = setOp(columnId, operator)
      const values: MemoryStatus[] = []
      for (const entry of asValues(value, "status")) {
        if (!isMemoryStatus(entry)) unmappable(`"${entry}" is not a memory status`)
        values.push(entry)
      }
      return { field: "status", op, values }
    }
    case "kind": {
      const op = setOp(columnId, operator)
      const values: MemoryKind[] = []
      for (const entry of asValues(value, "kind")) {
        if (!isMemoryKind(entry)) unmappable(`"${entry}" is not a memory kind`)
        values.push(entry)
      }
      return { field: "kind", op, values }
    }
    case "content": {
      const op = CONTENT_OP[operator]
      if (op === undefined) return badOperator(columnId, operator)
      return { field: "content", op, value: asText(value, "content") }
    }
    case "namespace": {
      if (operator !== "equals" && operator !== "startsWith") return badOperator(columnId, operator)
      return { field: "namespace", op: operator, value: asText(value, "namespace") }
    }
    case "confidence": {
      if (operator === "between") {
        const [min, max] = asPair(value, "confidence between")
        return {
          field: "confidence",
          op: "between",
          min: asNumber(min, "confidence min"),
          max: asNumber(max, "confidence max"),
        }
      }
      const op = CONFIDENCE_OP[operator]
      if (op === undefined) return badOperator(columnId, operator)
      return { field: "confidence", op, value: asNumber(value, "confidence") }
    }
    case "updatedAt": {
      if (operator === "dateBetween") {
        const [from, until] = asPair(value, "updated between")
        return {
          field: "updatedAt",
          op: "betweenDays",
          fromDay: asDay(from, "updated fromDay"),
          untilDay: asDay(until, "updated untilDay"),
        }
      }
      const op = DAY_OP[operator]
      if (op === undefined) return badOperator(columnId, operator)
      return { field: "updatedAt", op, day: asDay(value, "updated day") }
    }
  }
}

/**
 * Pretable filter/sort intent → the browse query's `filters` and `orderBy`.
 *
 * Pure. Total over the GRAMMAR — every column, operator and value SHAPE the
 * declared columns can produce maps to an arm, and anything else throws — but not
 * over value legality, which stays the store's to rule on. A reversed range
 * (`min > max`, `fromDay > untilDay`) is well-formed here and rejected by
 * `validateBrowseQuery`; pretable's `isComplete` only checks both operands are
 * present, so a user can type one. It surfaces as the store's own message
 * naming the mistake, which reads better than a mapping failure would, and the
 * funnel is visibly unapplied either way. Over-long strings are the same class.
 *
 * Nothing Pretable-shaped crosses the store boundary.
 */
export function toBrowseQuery(
  filters: Record<string, ColumnFilter>,
  sort: readonly PretableSortEntry[],
): BrowseQueryIntent {
  const mapped: BrowseFilter[] = []
  // Sorted so one intent maps one way whatever order the funnel map was built in.
  // The dataset identity does NOT rest on this — `canonicalBrowseQuery` sorts
  // predicates by field for every producer, not just this one — so a column id that
  // stops matching its field order costs nothing.
  for (const columnId of Object.keys(filters).sort()) {
    const filter = filters[columnId]
    if (filter) mapped.push(toBrowseFilter(columnId, filter))
  }

  if (sort.length > MAX_BROWSE_SORT_ENTRIES)
    unmappable(`at most ${MAX_BROWSE_SORT_ENTRIES} sort columns, got ${sort.length}`)
  const orderBy: BrowseSortEntry[] = []
  for (const entry of sort) {
    const field = SORT_FIELD_BY_COLUMN[entry.columnId as keyof typeof SORT_FIELD_BY_COLUMN]
    if (field === undefined) unmappable(`column "${entry.columnId}" is not a sortable browse field`)
    orderBy.push({ field, dir: entry.direction })
  }

  return {
    ...(mapped.length > 0 ? { filters: mapped } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
  }
}

/**
 * Trim a sort intent to what the store accepts, keeping the HIGHEST-priority
 * entries.
 *
 * Pretable's shift-click appends the new key at the lowest priority, so the
 * fourth key is the one dropped: the user's existing ordering survives intact.
 * Dropping the primary key instead would silently re-rank a sort the user built
 * on purpose.
 *
 * Returns the ARGUMENT itself when it already fits, so a result held in a memo or
 * dep chain keeps its identity across renders instead of re-firing the query for
 * a sort that never changed. The result is therefore aliased to the caller's
 * array and must not be mutated; `grid.replaceSort` wants a mutable array, so
 * hand it a copy.
 *
 * The capped list must reach BOTH the query and the grid's own sort state. Cap
 * only the query and the header keeps drawing the declined key as an active sort
 * indicator the server never applied — this function cannot enforce that pairing,
 * so the caller carries it, along with telling the user the key was declined.
 */
export function capSortEntries(
  entries: readonly PretableSortEntry[],
): readonly PretableSortEntry[] {
  if (entries.length <= MAX_BROWSE_SORT_ENTRIES) return entries
  return entries.slice(0, MAX_BROWSE_SORT_ENTRIES)
}
