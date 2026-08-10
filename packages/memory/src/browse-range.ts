import { BrowseQueryError } from "./browse-validate.js"

const DAY_MS = 86_400_000
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Defence in depth, the same posture as browse-order: validateBrowseQuery already
 *  rejected this, but an unchecked day becomes a bound no stored row can sit at —
 *  a silently empty window instead of a 400. */
function checkDay(day: string): void {
  if (!DAY.test(day))
    throw new BrowseQueryError(`day must be a "YYYY-MM-DD" UTC day, got ${JSON.stringify(day)}`)
  // Out-of-range components ROLL OVER rather than fail to parse: "2026-02-31" reads as
  // March 3, so only a day that round-trips names the date it spells.
  const parsed = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day)
    throw new BrowseQueryError(`day ${JSON.stringify(day)} is not a real calendar day`)
}

/** Inclusive lower bound of a UTC day, in the stored full-ISO-Z form. */
export function utcDayStart(day: string): string {
  checkDay(day)
  return `${day}T00:00:00.000Z`
}

/** EXCLUSIVE upper bound of a UTC day — the next day's start. UTC has no DST, so
 *  adding 24h is exact. */
export function utcDayAfter(day: string): string {
  return new Date(Date.parse(utcDayStart(day)) + DAY_MS).toISOString()
}

const MAX_CODE_POINT = 0x10ffff
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff

/**
 * Smallest string strictly greater than every string starting with `prefix`, so a
 * prefix match becomes the sargable range `col >= prefix AND col < succ(prefix)`.
 * Strip trailing maximal code points, increment the last remaining one; an
 * all-maximal prefix has no upper bound (undefined = omit the clause).
 *
 * Defined over CODE POINTS, which is order-equivalent to UTF-8 byte order — the
 * order SQLite's BINARY collation and Postgres's COLLATE "C" both use.
 */
export function namespacePrefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix)
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const codePoint = points[i]?.codePointAt(0)
    if (codePoint === undefined || codePoint >= MAX_CODE_POINT) continue
    let next = codePoint + 1
    // Surrogates are not valid scalar values; skipping the block keeps the bound a
    // legal string while staying an upper bound (nothing sorts between D7FF and E000).
    if (next >= SURROGATE_START && next <= SURROGATE_END) next = SURROGATE_END + 1
    return points.slice(0, i).join("") + String.fromCodePoint(next)
  }
  return undefined
}
