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

/**
 * `URLSearchParams` → a validated `BrowseQuery`. Throws `BrowseQueryError`; the route
 * maps that to 400. Pure, so it is unit-tested without booting Next.
 */
export function parseBrowseQuery(
  sp: URLSearchParams,
  opts: { readonly now?: string },
): BrowseQuery {
  const statuses = sp.getAll("status")
  const kinds = sp.getAll("kind")
  const namespace = sp.get("namespace")
  const namespacePrefix = sp.get("namespacePrefix")
  const sourceType = sp.get("sourceType")
  const cursor = sp.get("cursor")
  // includeExpired=1 reveals expired-but-unpruned rows; this is a debugging surface.
  const includeExpired = sp.get("includeExpired") === "1"
  const query: BrowseQuery = {
    ...(namespace ? { namespace } : {}),
    ...(namespacePrefix ? { namespacePrefix } : {}),
    // A param that appears zero times is ABSENT, not an empty set — the store's
    // "empty matches nothing" rule is deliberately unreachable over HTTP. The casts are
    // `NonNullable`, not the bare indexed access: under exactOptionalPropertyTypes an
    // optional property's type carries `undefined`, which would then land in a key that
    // is only ever written when it has a value.
    ...(statuses.length > 0 ? { status: statuses as NonNullable<BrowseQuery["status"]> } : {}),
    ...(kinds.length > 0 ? { kind: kinds as NonNullable<BrowseQuery["kind"]> } : {}),
    ...(sourceType ? { sourceType: sourceType as NonNullable<BrowseQuery["sourceType"]> } : {}),
    ...(() => {
      const since = parseInstant(sp.get("since"), "since")
      return since ? { since } : {}
    })(),
    ...(() => {
      const until = parseInstant(sp.get("until"), "until")
      return until ? { until } : {}
    })(),
    // A request-supplied `now` outranks the route's fresh stamp. `now` is part of the
    // cursor fingerprint, so a walk whose every page re-stamps it rejects each
    // continuation the page before it issued; pinning it is how a caller holds one
    // reading of "expired" for the whole walk.
    ...(() => {
      const now = parseInstant(sp.get("now"), "now") ?? opts.now
      return includeExpired || !now ? {} : { now }
    })(),
    ...(() => {
      const filters = parseJsonParam<readonly BrowseFilter[]>(sp.get("filters"), "filters")
      return filters ? { filters } : {}
    })(),
    ...(() => {
      const orderBy = parseJsonParam<readonly BrowseSortEntry[]>(sp.get("orderBy"), "orderBy")
      return orderBy ? { orderBy } : {}
    })(),
    ...(cursor ? { cursor } : {}),
    limit: parseCount(sp.get("limit"), "limit", BROWSE_DEFAULT_LIMIT),
    // A cursor already carries the position; sending both is a caller bug the
    // validator rejects, so do not default `offset` alongside one.
    ...(cursor ? {} : { offset: parseCount(sp.get("offset"), "offset", 0) }),
  }
  // The untrusted boundary is where the 1..1000 ceiling applies.
  validateBrowseQuery(query, { maxLimit: BROWSE_MAX_LIMIT })
  return query
}
