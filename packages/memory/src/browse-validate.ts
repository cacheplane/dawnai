import type {
  BrowseQuery,
  BrowseSortField,
  MemoryKind,
  MemorySource,
  MemoryStatus,
} from "./types.js"

/** Largest `limit` the UNTRUSTED boundary accepts. Enforced only when a caller passes
 *  `maxLimit` — in-process callers (the CLI's 10 000-row consolidation scan) are
 *  trusted and exempt; the HTTP route is not. */
export const BROWSE_MAX_LIMIT = 1000
/** Applied by the stores when `limit` is absent. */
export const BROWSE_DEFAULT_LIMIT = 50

const MAX_STRING_BYTES = 1024
const MAX_CURSOR_CHARS = 4096
const MAX_FILTERS = 8
const MAX_ORDER_BY = 3

export const BROWSE_SORT_FIELDS = [
  "updatedAt",
  "createdAt",
  "confidence",
  "namespace",
  "kind",
  "status",
] as const satisfies readonly BrowseSortField[]

const STATUSES: readonly MemoryStatus[] = ["candidate", "active", "superseded"]
const KINDS: readonly MemoryKind[] = ["semantic", "episodic", "procedural", "reflection"]
const SOURCE_TYPES: readonly MemorySource["type"][] = ["run", "user", "tool", "eval", "human"]
const FILTER_FIELDS = ["status", "kind", "content", "namespace", "confidence", "updatedAt"] as const
const CONTENT_OPS = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
] as const
const NAMESPACE_OPS = ["equals", "startsWith"] as const
const CONFIDENCE_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "between"] as const
const UPDATED_AT_OPS = ["onDay", "beforeDay", "afterDay", "betweenDays"] as const
const SET_OPS = ["in", "notIn"] as const

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every rejection this module raises. The Inspector maps it to 400 `{error}`; the
 *  stores let it propagate, so a bad query fails loudly instead of silently matching
 *  zero rows. */
export class BrowseQueryError extends Error {
  readonly code: string
  constructor(message: string, code = "invalid-query") {
    super(message)
    this.name = "BrowseQueryError"
    this.code = code
  }
}

function fail(message: string): never {
  throw new BrowseQueryError(message)
}

function checkString(value: unknown, label: string): void {
  if (typeof value !== "string") fail(`${label} must be a string`)
  if (value.length === 0) fail(`${label} must not be empty`)
  if (new TextEncoder().encode(value).length > MAX_STRING_BYTES)
    fail(`${label} must be at most ${MAX_STRING_BYTES} bytes`)
}

function checkFinite(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`)
}

function checkInstant(value: unknown, label: string): void {
  // Full-ISO-Z only: the stores compare these TEXT columns lexicographically, so a
  // shorter or offset form silently windows wrong rather than failing.
  if (typeof value !== "string" || !ISO_Z.test(value))
    fail(`${label} must be a full ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.sssZ")`)
}

function checkDay(value: unknown, label: string): void {
  if (typeof value !== "string" || !DAY.test(value)) fail(`${label} must be a "YYYY-MM-DD" UTC day`)
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
    fail(`${label} "${value}" is not a real calendar day`)
}

function checkEnumList(value: unknown, allowed: readonly string[], label: string): void {
  const values = typeof value === "string" ? [value] : value
  if (!Array.isArray(values)) fail(`${label} must be a value or an array of values`)
  for (const entry of values) {
    if (typeof entry !== "string" || !allowed.includes(entry))
      fail(`invalid ${label} ${JSON.stringify(entry)} (expected one of: ${allowed.join(", ")})`)
  }
}

function checkOp(op: unknown, allowed: readonly string[], field: string): string {
  if (typeof op !== "string" || !allowed.includes(op))
    fail(
      `unknown op ${JSON.stringify(op)} for filter field "${field}" (expected one of: ${allowed.join(", ")})`,
    )
  return op
}

function validateFilter(raw: unknown, seen: Set<string>): void {
  const filter = raw as Record<string, unknown>
  const field = filter?.field
  if (typeof field !== "string" || !(FILTER_FIELDS as readonly string[]).includes(field))
    fail(
      `unknown filter field ${JSON.stringify(field)} (expected one of: ${FILTER_FIELDS.join(", ")})`,
    )
  if (seen.has(field)) fail(`at most one filter per field; "${field}" appears twice`)
  seen.add(field)
  switch (field) {
    case "status":
    case "kind": {
      checkOp(filter.op, SET_OPS, field)
      const values = filter.values
      if (!Array.isArray(values)) fail(`${field} values must be an array`)
      // An empty list can only be a bug: an inactive filter is never sent.
      if (values.length === 0) fail(`${field} values must not be empty`)
      checkEnumList(values, field === "status" ? STATUSES : KINDS, field)
      return
    }
    case "content": {
      checkOp(filter.op, CONTENT_OPS, field)
      checkString(filter.value, "content value")
      return
    }
    case "namespace": {
      checkOp(filter.op, NAMESPACE_OPS, field)
      checkString(filter.value, "namespace value")
      return
    }
    case "confidence": {
      const op = checkOp(filter.op, CONFIDENCE_OPS, field)
      if (op === "between") {
        checkFinite(filter.min, "confidence min")
        checkFinite(filter.max, "confidence max")
        if ((filter.min as number) > (filter.max as number))
          fail("confidence between requires min <= max")
        return
      }
      checkFinite(filter.value, "confidence value")
      return
    }
    default: {
      const op = checkOp(filter.op, UPDATED_AT_OPS, field)
      if (op === "betweenDays") {
        checkDay(filter.fromDay, "updatedAt fromDay")
        checkDay(filter.untilDay, "updatedAt untilDay")
        // "YYYY-MM-DD" is uniform-width ASCII, so lexicographic order IS chronological.
        if ((filter.fromDay as string) > (filter.untilDay as string))
          fail("updatedAt betweenDays requires fromDay <= untilDay")
        return
      }
      checkDay(filter.day, "updatedAt day")
    }
  }
}

/**
 * The single reading of "is this browse query legal". Runs at the Inspector HTTP
 * boundary (mapped to 400) and defensively inside every store (thrown). Pass
 * `maxLimit` at untrusted boundaries only — see BROWSE_MAX_LIMIT.
 */
export function validateBrowseQuery(
  query: BrowseQuery,
  opts: { readonly maxLimit?: number } = {},
): void {
  // The query may arrive from JSON, so every field is treated as unknown.
  const q = query as Record<string, unknown>
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || (q.limit as number) < 1) fail("limit must be an integer >= 1")
    if (opts.maxLimit !== undefined && (q.limit as number) > opts.maxLimit)
      fail(`limit must be at most ${opts.maxLimit}`)
  }
  if (q.offset !== undefined && (!Number.isInteger(q.offset) || (q.offset as number) < 0))
    fail("offset must be an integer >= 0")
  if (q.cursor !== undefined) {
    if (typeof q.cursor !== "string" || q.cursor.length === 0)
      fail("cursor must be a non-empty string")
    if (q.cursor.length > MAX_CURSOR_CHARS)
      fail(`cursor must be at most ${MAX_CURSOR_CHARS} characters`)
    if (q.offset !== undefined && q.offset !== 0)
      fail(
        "cursor and a non-zero offset cannot be combined — a keyset continuation already carries the position",
      )
  }
  if (q.namespace !== undefined) checkString(q.namespace, "namespace")
  if (q.namespacePrefix !== undefined) checkString(q.namespacePrefix, "namespacePrefix")
  if (q.since !== undefined) checkInstant(q.since, "since")
  if (q.until !== undefined) checkInstant(q.until, "until")
  if (q.now !== undefined) checkInstant(q.now, "now")
  if (q.status !== undefined) checkEnumList(q.status, STATUSES, "status")
  if (q.kind !== undefined) checkEnumList(q.kind, KINDS, "kind")
  if (q.sourceType !== undefined) checkEnumList(q.sourceType, SOURCE_TYPES, "sourceType")
  if (q.filters !== undefined) {
    if (!Array.isArray(q.filters)) fail("filters must be an array")
    if (q.filters.length > MAX_FILTERS) fail(`at most ${MAX_FILTERS} filters`)
    const seen = new Set<string>()
    for (const filter of q.filters) validateFilter(filter, seen)
  }
  if (q.orderBy !== undefined) {
    if (!Array.isArray(q.orderBy)) fail("orderBy must be an array")
    if (q.orderBy.length > MAX_ORDER_BY) fail(`at most ${MAX_ORDER_BY} orderBy entries`)
    const seenFields = new Set<string>()
    for (const raw of q.orderBy) {
      const entry = raw as Record<string, unknown>
      const field = entry?.field
      if (typeof field !== "string" || !(BROWSE_SORT_FIELDS as readonly string[]).includes(field))
        fail(
          `unknown sort field ${JSON.stringify(field)} (expected one of: ${BROWSE_SORT_FIELDS.join(", ")})`,
        )
      if (entry.dir !== "asc" && entry.dir !== "desc")
        fail(`sort direction must be "asc" or "desc", got ${JSON.stringify(entry.dir)}`)
      if (seenFields.has(field)) fail(`orderBy repeats the field "${field}"`)
      seenFields.add(field)
    }
  }
}
