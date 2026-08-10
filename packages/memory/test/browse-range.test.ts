import { describe, expect, it } from "vitest"
import { namespacePrefixUpperBound, utcDayAfter, utcDayStart } from "../src/browse-range.js"

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
})

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
  it("bounds every string that starts with the prefix", () => {
    const prefix = "route=/x"
    const upper = namespacePrefixUpperBound(prefix)
    expect(upper).toBeDefined()
    for (const suffix of ["", "y", "\u{1F600}", "\u{10FFFF}"]) {
      expect(prefix + suffix >= prefix).toBe(true)
      expect([...(prefix + suffix)].join("") < (upper as string)).toBe(true)
    }
  })
})
