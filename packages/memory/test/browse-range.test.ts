import { describe, expect, it } from "vitest"
import { namespacePrefixUpperBound, utcDayAfter, utcDayStart } from "../src/browse-range.js"
import { BrowseQueryError } from "../src/browse-validate.js"

describe("UTC day buckets", () => {
  it("brackets a day as [start, next start)", () => {
    expect(utcDayStart("2026-08-09")).toBe("2026-08-09T00:00:00.000Z")
    expect(utcDayAfter("2026-08-09")).toBe("2026-08-10T00:00:00.000Z")
  })
  it("rolls over months and years", () => {
    expect(utcDayAfter("2026-08-31")).toBe("2026-09-01T00:00:00.000Z")
    expect(utcDayAfter("2026-12-31")).toBe("2027-01-01T00:00:00.000Z")
    expect(utcDayAfter("2028-02-28")).toBe("2028-02-29T00:00:00.000Z")
  })
  it("rejects a malformed day instead of windowing on nonsense", () => {
    expect(() => utcDayStart("oops")).toThrow(BrowseQueryError)
    expect(() => utcDayAfter("oops")).toThrow(BrowseQueryError)
    expect(() => utcDayStart("2026-8-9")).toThrow(/"YYYY-MM-DD"/)
    expect(() => utcDayAfter("2026-08-09T00:00:00.000Z")).toThrow(/"YYYY-MM-DD"/)
  })
  it("rejects a well-formed day that names no real date", () => {
    // Date.parse reads this as March 3 rather than failing, so shape alone lets a
    // window open at a lower bound no stored row can sit at.
    expect(() => utcDayStart("2026-02-31")).toThrow(/not a real calendar day/)
    expect(() => utcDayAfter("2026-02-31")).toThrow(/not a real calendar day/)
  })
})

const ENCODER = new TextEncoder()

/** JS `<` compares UTF-16 code units, which is NOT the order this bound is defined in:
 *  the two disagree above U+FFFF, so `"a\u{FFFF}z" < "a\u{10000}"` is false in JS and
 *  true in SQLite's BINARY and Postgres's COLLATE "C". Those are the only orders the
 *  bound is ever evaluated in, so the assertions below must use bytes. */
function lessByUtf8Bytes(left: string, right: string): boolean {
  const a = ENCODER.encode(left)
  const b = ENCODER.encode(right)
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number)
  }
  return a.length < b.length
}

describe("namespacePrefixUpperBound", () => {
  it("increments the last code point so the prefix becomes a half-open range", () => {
    expect(namespacePrefixUpperBound("route=/a")).toBe("route=/b")
    expect(namespacePrefixUpperBound("50%")).toBe("50&")
  })
  it("carries past maximal trailing code points", () => {
    expect(namespacePrefixUpperBound(`a\u{10FFFF}`)).toBe("b")
  })
  it("returns undefined when there is no upper bound (all code points maximal)", () => {
    expect(namespacePrefixUpperBound(`\u{10FFFF}\u{10FFFF}`)).toBeUndefined()
    expect(namespacePrefixUpperBound("")).toBeUndefined()
  })
  it("never lands inside the surrogate range (those are not valid code points)", () => {
    expect(namespacePrefixUpperBound("\u{D7FF}")).toBe("\u{E000}")
  })
  // The second prefix ends at the top of the BMP, where incrementing crosses into the
  // supplementary planes — the one case where UTF-8 and UTF-16 order disagree.
  it("bounds every string that starts with the prefix", () => {
    for (const prefix of ["route=/x", "route=/\u{FFFF}"]) {
      const upper = namespacePrefixUpperBound(prefix)
      expect(upper).toBeDefined()
      // The empty suffix is the prefix itself: the bound must exceed it strictly.
      for (const suffix of ["", "y", "\u{1F600}", "\u{10FFFF}"]) {
        expect(lessByUtf8Bytes(prefix + suffix, upper as string)).toBe(true)
      }
    }
  })
})
