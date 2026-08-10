const DAY_MS = 86_400_000

/** Inclusive lower bound of a UTC day, in the stored full-ISO-Z form. */
export function utcDayStart(day: string): string {
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
