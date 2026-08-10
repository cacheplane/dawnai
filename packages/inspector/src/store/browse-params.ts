import {
  BROWSE_DEFAULT_LIMIT,
  BROWSE_MAX_LIMIT,
  type BrowseFilter,
  type BrowseQuery,
  BrowseQueryError,
  type BrowseSortEntry,
  validateBrowseQuery,
} from "@dawn-ai/memory/browse"

/**
 * Recognise a rejection from the shared validator WITHOUT `instanceof`.
 *
 * The store is loaded through `importMemory()` from real node_modules while this
 * module may be bundled by Next — two copies of the class, so `instanceof` is false
 * for anything the store throws (a bad continuation, for instance). The name is
 * stable across copies.
 */
export function isBrowseQueryError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && error.name === "BrowseQueryError"
}

function parseInstant(value: string | null, name: string): string | undefined {
  if (value === null) return undefined
  // Normalize FIRST: the store compares these lexicographically against stored
  // full-ISO-Z text, so an offset form ("...+02:00") would window silently wrong.
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed))
    throw new BrowseQueryError(`invalid ${name} "${value}" (expected an ISO-8601 date-time)`)
  return new Date(parsed).toISOString()
}

function parseJsonParam<T>(value: string | null, name: string): T | undefined {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    throw new BrowseQueryError(`${name} must be valid JSON`)
  }
}

function parseCount(value: string | null, name: string, fallback: number): number {
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new BrowseQueryError(`${name} must be a number`)
  return parsed
}

/** A repeated param is a SET, so a duplicate is not a second narrowing. The cursor
 *  fingerprint is taken over this list, so leaving one in would give a single dataset
 *  two fingerprints and reject its own continuation. */
function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * `URLSearchParams` → a validated `BrowseQuery`. Throws `BrowseQueryError`; the route
 * maps that to 400. Pure, so it is unit-tested without booting Next.
 */
export function parseBrowseQuery(
  sp: URLSearchParams,
  opts: { readonly now?: string },
): BrowseQuery {
  const statuses = uniqueValues(sp.getAll("status"))
  const kinds = uniqueValues(sp.getAll("kind"))
  const namespace = sp.get("namespace")
  const namespacePrefix = sp.get("namespacePrefix")
  const sourceType = sp.get("sourceType")
  const cursor = sp.get("cursor")
  const rawOffset = sp.get("offset")
  // includeExpired=1 drops the expiry cutoff; a caller-pinned past `now` moves it. Both
  // reveal expired-but-unpruned rows to this local-only caller, the flag strictly more.
  const includeExpired = sp.get("includeExpired") === "1"
  const since = parseInstant(sp.get("since"), "since")
  const until = parseInstant(sp.get("until"), "until")
  // Pinned by the caller, not stamped per request: `now` is part of the cursor
  // fingerprint, so a fresh stamp on each page rejects the continuation the page before
  // it issued.
  const now = parseInstant(sp.get("now"), "now") ?? opts.now
  // Passed on even when falsy, so `filters=0` is the validator's "must be an array"
  // rather than a silently unfiltered 200.
  const filters = parseJsonParam<readonly BrowseFilter[]>(sp.get("filters"), "filters")
  const orderBy = parseJsonParam<readonly BrowseSortEntry[]>(sp.get("orderBy"), "orderBy")
  const query: BrowseQuery = {
    ...(namespace ? { namespace } : {}),
    ...(namespacePrefix ? { namespacePrefix } : {}),
    // A param that appears zero times is ABSENT, not an empty set — the store's
    // "empty matches nothing" rule is deliberately unreachable over HTTP.
    ...(statuses.length > 0 ? { status: statuses as NonNullable<BrowseQuery["status"]> } : {}),
    ...(kinds.length > 0 ? { kind: kinds as NonNullable<BrowseQuery["kind"]> } : {}),
    ...(sourceType ? { sourceType: sourceType as NonNullable<BrowseQuery["sourceType"]> } : {}),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(includeExpired || now === undefined ? {} : { now }),
    ...(filters === undefined ? {} : { filters }),
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(cursor ? { cursor } : {}),
    limit: parseCount(sp.get("limit"), "limit", BROWSE_DEFAULT_LIMIT),
    // Only the DEFAULT is conditional. An offset the caller actually sent alongside a
    // cursor has to reach the validator, which is the one place that pair is named.
    ...(cursor && rawOffset === null ? {} : { offset: parseCount(rawOffset, "offset", 0) }),
  }
  validateBrowseQuery(query, { maxLimit: BROWSE_MAX_LIMIT })
  return query
}
