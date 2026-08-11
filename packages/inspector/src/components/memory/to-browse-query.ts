import {
  type BrowseFilter,
  BrowseQueryError,
  type BrowseSortEntry,
  type BrowseSortField,
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
 * It THROWS rather than dropping the clause. Once each column declares
 * `filterOperators`, an unmappable operator can only arrive from a column
 * declaration that drifted out of step with the store's grammar — a
 * programming error. Dropping it silently would leave a funnel that looks
 * applied and is not: the exact dishonesty this whole design exists to remove.
 * `BrowseQueryError` is reused so the Inspector has ONE rejection family, and
 * `isBrowseQueryError` (src/store/browse-params.ts) already recognises it
 * across the two module copies Next's bundler produces.
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
  // Untrimmed on purpose: whitespace is significant in a content predicate, and
  // the store compares the bytes it is given.
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
      const values = asValues(value, "status")
      for (const entry of values)
        if (!isMemoryStatus(entry)) unmappable(`"${entry}" is not a memory status`)
      return { field: "status", op, values: values.filter(isMemoryStatus) }
    }
    case "kind": {
      const op = setOp(columnId, operator)
      const values = asValues(value, "kind")
      for (const entry of values)
        if (!isMemoryKind(entry)) unmappable(`"${entry}" is not a memory kind`)
      return { field: "kind", op, values: values.filter(isMemoryKind) }
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
    default: {
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
 * Pure and total for every intent the declared columns can produce; it throws
 * for everything else. Nothing Pretable-shaped crosses the store boundary.
 */
export function toBrowseQuery(
  filters: Record<string, ColumnFilter>,
  sort: readonly PretableSortEntry[],
): BrowseQueryIntent {
  const mapped: BrowseFilter[] = []
  // Sorted so one intent always serializes one way: the fingerprint the SERVER
  // computes is order-insensitive, but the datasetKey the CLIENT hashes is not,
  // and a re-ordered map would otherwise read as a new dataset.
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
 * fourth key is the one dropped: the user's existing ordering survives intact,
 * and the caller shows a notice saying the extra key was declined. Dropping the
 * primary key instead would silently re-rank a sort the user built on purpose.
 */
export function capSortEntries(entries: readonly PretableSortEntry[]): PretableSortEntry[] {
  return entries.slice(0, MAX_BROWSE_SORT_ENTRIES)
}
