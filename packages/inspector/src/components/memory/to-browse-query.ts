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
 * Every refusal in this module, carrying the TWO strings its two audiences need.
 *
 * It THROWS rather than dropping the clause: dropping it silently would leave a
 * funnel that looks applied and is not, the exact dishonesty this whole design
 * exists to remove.
 *
 * `message` is the developer half — it names the column, the operator and the
 * offending value, and goes to the console. `userMessage` is the half the page
 * renders, and it is NOT a reworded copy of the other one. It obeys two rules the
 * developer half cannot:
 *
 *  - It never names anything the user cannot see. "grid intent", "browse query"
 *    and "BrowseFilter arm" are this repo's words, not the screen's.
 *  - It never quotes the offending VALUE. `JSON.stringify` is what makes the
 *    developer half specific, and it renders `Infinity` — what pretable's number
 *    funnel parses out of a typed `1e999` — as the literal `null`. Echoing that
 *    shows the user a value nobody entered.
 *
 * `filterOperators` makes an unmappable operator rare, NOT unreachable —
 * pretable's `operatorsForType` warns once and falls back to the full set,
 * `isEmpty`/`isNotEmpty` included, when the declared list prunes every operator
 * the column type offers (operator names that do not match the `type` do that).
 * The user then sees "is empty" on the menu and clicks it, so this backstop
 * catches a live path and not only a coding slip.
 *
 * `BrowseQueryError` is extended rather than replaced so the Inspector has ONE
 * rejection family; the base constructor sets `name` and this passes the same
 * code, so `isBrowseQueryError` (src/store/browse-params.ts), which matches on
 * `error.name`, still recognises it across the two module copies Next's bundler
 * produces.
 */
class IntentRefusalError extends BrowseQueryError {
  readonly userMessage: string
  constructor(userMessage: string, detail: string) {
    super(`cannot map grid intent to a browse query: ${detail}`, "unmappable-intent")
    this.userMessage = userMessage
  }
}

/**
 * The user-facing half of a refusal, or `undefined` for any other failure.
 *
 * Read STRUCTURALLY rather than with `instanceof`, for the reason
 * `isBrowseQueryError` matches on `name`: an identity check fails whenever the
 * error crosses a module-copy boundary, and here it would fail SILENTLY — the
 * caller would fall back to generic copy and nobody would see a defect.
 */
export function intentRefusalMessage(error: unknown): string | undefined {
  const message = (error as { userMessage?: unknown } | null | undefined)?.userMessage
  return typeof message === "string" && message !== "" ? message : undefined
}

// The two sentences the page can render. Each refusal supplies the clause naming
// what is wrong; the clause saying the control did nothing is fixed here, so the
// promise the notice makes cannot drift from site to site. Which suffix applies is
// decided by WHERE the refusal is raised, not by which control the user touched —
// see `commitIntent` in list-page.tsx, which only ever offers one unvetted half.
function filterRefusal(problem: string): string {
  return `${problem}, so the filter was not applied.`
}

function sortRefusal(problem: string): string {
  return `${problem}, so the sort was not applied.`
}

function unmappable(userMessage: string, detail: string): never {
  throw new IntentRefusalError(userMessage, detail)
}

function badOperator(columnId: string, operator: FilterOperator): never {
  // The operator is named in the developer half only: pretable's spelling
  // ("isNotEmpty") is not the label on the menu item the user clicked ("is not
  // empty"), and this module does not have that label.
  return unmappable(
    filterRefusal(`That condition is not available for the ${columnId} column`),
    `operator "${operator}" on column "${columnId}" has no BrowseFilter arm`,
  )
}

// The four operand checks below all put `label` in BOTH halves of their refusal, so
// it has to be the user's word for the box holding the value, not the store's field
// name: pretable labels a range funnel's two inputs "Filter minimum" and "Filter
// maximum", and its single-operand funnels sit under the column header, so the
// callers pass "confidence minimum", "updated date" and so on.
function asText(value: ColumnFilter["value"], label: string): string {
  // Trimmed to DECIDE, returned untrimmed: an all-whitespace box is an empty one the
  // user cannot see, while a leading or trailing space inside a real value is part of
  // the predicate — the store compares the bytes it is given.
  if (typeof value !== "string" || value.trim() === "")
    unmappable(
      filterRefusal(`That ${label} is empty`),
      `${label} needs non-blank text, got ${JSON.stringify(value)}`,
    )
  return value
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    unmappable(
      filterRefusal(`That ${label} is out of range`),
      `${label} needs a finite number, got ${JSON.stringify(value)}`,
    )
  return value
}

function asDay(value: unknown, label: string): string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value))
    unmappable(
      filterRefusal(`That ${label} is not a valid date`),
      `${label} needs a "YYYY-MM-DD" day, got ${JSON.stringify(value)}`,
    )
  return value
}

// Both helpers widen through a local before the Array.isArray guard: TypeScript
// does not narrow a READONLY tuple/array member of a union through that guard,
// so indexing the original value straight after it is a type error.
function asPair(value: ColumnFilter["value"], label: string): readonly [unknown, unknown] {
  const list = value as readonly unknown[] | null
  if (!Array.isArray(list) || list.length !== 2)
    unmappable(
      filterRefusal(`That ${label} needs both a minimum and a maximum`),
      `${label} needs both operands, got ${JSON.stringify(value)}`,
    )
  return [list[0], list[1]] as const
}

function asValues(value: ColumnFilter["value"], label: string): readonly string[] {
  const list = value as readonly unknown[] | null
  if (!Array.isArray(list) || list.length === 0)
    unmappable(
      filterRefusal(`No ${label} values are selected`),
      `${label} needs a non-empty value list, got ${JSON.stringify(value)}`,
    )
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== "string")
      unmappable(
        filterRefusal(`That ${label} selection cannot be used`),
        `${label} values must be strings, got ${JSON.stringify(entry)}`,
      )
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
  if (field === undefined)
    unmappable(
      filterRefusal("That column cannot be filtered"),
      `column "${columnId}" has no browse filter field`,
    )
  const { operator, value } = filter

  switch (field) {
    case "status": {
      const op = setOp(columnId, operator)
      const values: MemoryStatus[] = []
      for (const entry of asValues(value, "status")) {
        // The ticked value IS the user's own, so naming it in the user half would
        // be honest — but the funnel's options come from the same list this checks
        // against, so reaching here means the two have drifted, and the value is
        // then more confusing than the column name alone.
        if (!isMemoryStatus(entry))
          unmappable(
            filterRefusal("That status is not one this server recognizes"),
            `"${entry}" is not a memory status`,
          )
        values.push(entry)
      }
      return { field: "status", op, values }
    }
    case "kind": {
      const op = setOp(columnId, operator)
      const values: MemoryKind[] = []
      for (const entry of asValues(value, "kind")) {
        if (!isMemoryKind(entry))
          unmappable(
            filterRefusal("That kind is not one this server recognizes"),
            `"${entry}" is not a memory kind`,
          )
        values.push(entry)
      }
      return { field: "kind", op, values }
    }
    case "content": {
      const op = CONTENT_OP[operator]
      if (op === undefined) return badOperator(columnId, operator)
      return { field: "content", op, value: asText(value, "content value") }
    }
    case "namespace": {
      if (operator !== "equals" && operator !== "startsWith") return badOperator(columnId, operator)
      return { field: "namespace", op: operator, value: asText(value, "namespace value") }
    }
    case "confidence": {
      if (operator === "between") {
        const [min, max] = asPair(value, "confidence range")
        return {
          field: "confidence",
          op: "between",
          min: asNumber(min, "confidence minimum"),
          max: asNumber(max, "confidence maximum"),
        }
      }
      const op = CONFIDENCE_OP[operator]
      if (op === undefined) return badOperator(columnId, operator)
      return { field: "confidence", op, value: asNumber(value, "confidence value") }
    }
    case "updatedAt": {
      if (operator === "dateBetween") {
        const [from, until] = asPair(value, "updated range")
        return {
          field: "updatedAt",
          op: "betweenDays",
          fromDay: asDay(from, "updated minimum"),
          untilDay: asDay(until, "updated maximum"),
        }
      }
      const op = DAY_OP[operator]
      if (op === undefined) return badOperator(columnId, operator)
      return { field: "updatedAt", op, day: asDay(value, "updated date") }
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
    unmappable(
      sortRefusal(`Sorting is limited to ${MAX_BROWSE_SORT_ENTRIES} columns`),
      `at most ${MAX_BROWSE_SORT_ENTRIES} sort columns, got ${sort.length}`,
    )
  const orderBy: BrowseSortEntry[] = []
  for (const entry of sort) {
    const field = SORT_FIELD_BY_COLUMN[entry.columnId as keyof typeof SORT_FIELD_BY_COLUMN]
    if (field === undefined)
      unmappable(
        sortRefusal("That column cannot be sorted"),
        `column "${entry.columnId}" is not a sortable browse field`,
      )
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
