import { describe, expect, it } from "vitest"
import { BROWSE_MAX_LIMIT, BrowseQueryError, validateBrowseQuery } from "../src/browse-validate.js"
import type { BrowseQuery } from "../src/types.js"

const ok = (q: BrowseQuery, opts?: { maxLimit?: number }) =>
  expect(() => validateBrowseQuery(q, opts)).not.toThrow()
const bad = (q: BrowseQuery, match: RegExp, opts?: { maxLimit?: number }) =>
  expect(() => validateBrowseQuery(q, opts)).toThrow(match)

describe("validateBrowseQuery — bounds", () => {
  it("accepts an empty query", () => ok({}))
  it("rejects a non-integer or sub-1 limit", () => {
    bad({ limit: 0 }, /limit must be an integer >= 1/)
    bad({ limit: 1.5 }, /limit must be an integer >= 1/)
    bad({ limit: Number.NaN }, /limit must be an integer >= 1/)
  })
  it("enforces the ceiling only when the caller supplies one", () => {
    ok({ limit: 10_000 })
    bad({ limit: BROWSE_MAX_LIMIT + 1 }, /limit must be at most 1000/, {
      maxLimit: BROWSE_MAX_LIMIT,
    })
    ok({ limit: BROWSE_MAX_LIMIT }, { maxLimit: BROWSE_MAX_LIMIT })
  })
  it("rejects a negative offset", () => bad({ offset: -1 }, /offset must be an integer >= 0/))
  it("rejects a cursor combined with a non-zero offset", () => {
    ok({ cursor: "abc", offset: 0 })
    bad({ cursor: "abc", offset: 10 }, /cursor and a non-zero offset/)
  })
  it("accepts a cursor at the length cap", () => ok({ cursor: "x".repeat(4096) }))
  it("rejects an oversized cursor", () => bad({ cursor: "x".repeat(4097) }, /at most 4096/))
  it("rejects an oversized string value", () =>
    bad({ namespace: "n".repeat(1025) }, /namespace must be at most 1024 bytes/))
  it("measures the string cap in bytes, not characters", () => {
    ok({ namespace: "é".repeat(512) })
    bad({ namespace: "é".repeat(513) }, /namespace must be at most 1024 bytes/)
  })
})

describe("validateBrowseQuery — instants and enums", () => {
  it("requires full ISO-Z instants", () => {
    ok({ since: "2026-08-09T00:00:00.000Z" })
    bad({ since: "2026-08-09T00:00:00Z" }, /since must be a full ISO-8601 UTC instant/)
    bad({ until: "2026-08-09" }, /until must be a full ISO-8601 UTC instant/)
    bad({ now: "not-a-date" }, /now must be a full ISO-8601 UTC instant/)
  })
  it("rejects well-formed instants that name no real UTC time", () => {
    bad(
      { since: "2026-02-31T00:00:00.000Z" },
      /since "2026-02-31T00:00:00\.000Z" is not a real UTC instant/,
    )
    bad({ until: "2026-99-99T99:99:99.999Z" }, /until .* is not a real UTC instant/)
    bad({ now: "2026-08-09T24:00:00.000Z" }, /now .* is not a real UTC instant/)
  })
  it("rejects unknown status/kind/sourceType values instead of matching zero rows", () => {
    bad({ status: "bogus" as never }, /invalid status "bogus"/)
    bad({ kind: ["semantic", "nope"] as never }, /invalid kind "nope"/)
    bad({ sourceType: "ghost" as never }, /invalid sourceType "ghost"/)
  })
  it("rejects an array sourceType — every store binds it as a single parameter", () =>
    bad({ sourceType: ["run", "user"] as never }, /invalid sourceType \["run","user"\]/))
  it("accepts an empty set (it means 'match nothing', not 'invalid')", () => ok({ status: [] }))
})

describe("validateBrowseQuery — filters", () => {
  it("rejects unknown fields and ops", () => {
    bad(
      { filters: [{ field: "tags", op: "in", values: ["a"] }] as never },
      /unknown filter field "tags"/,
    )
    bad(
      { filters: [{ field: "content", op: "isEmpty" }] as never },
      /unknown op "isEmpty" for filter field "content"/,
    )
  })
  it("accepts one filter on each of the six filterable fields", () =>
    ok({
      filters: [
        { field: "status", op: "in", values: ["active"] },
        { field: "kind", op: "in", values: ["semantic"] },
        { field: "content", op: "contains", value: "x" },
        { field: "namespace", op: "startsWith", value: "app/" },
        { field: "confidence", op: "gte", value: 0.5 },
        { field: "updatedAt", op: "onDay", day: "2026-08-09" },
      ],
    }))
  it("caps the filter count and forbids two filters on one field", () => {
    const one = { field: "content", op: "contains", value: "x" } as const
    bad(
      { filters: [one, { field: "content", op: "equals", value: "y" }] },
      /at most one filter per field; "content" appears twice/,
    )
    bad({ filters: Array.from({ length: 9 }, () => one) }, /at most 8 filters/)
  })
  it("requires a non-empty, domain-valid value list for in/notIn", () => {
    ok({ filters: [{ field: "status", op: "in", values: ["active"] }] })
    bad({ filters: [{ field: "status", op: "in", values: [] }] }, /status values must not be empty/)
    bad(
      { filters: [{ field: "kind", op: "notIn", values: ["nope"] as never }] },
      /invalid kind "nope"/,
    )
  })
  it("requires non-empty text values", () => {
    bad(
      { filters: [{ field: "content", op: "contains", value: "" }] },
      /content value must not be empty/,
    )
    bad(
      { filters: [{ field: "namespace", op: "startsWith", value: "" }] },
      /namespace value must not be empty/,
    )
  })
  it("requires finite confidence numbers and an ordered between range", () => {
    ok({ filters: [{ field: "confidence", op: "gte", value: 0.5 }] })
    bad(
      { filters: [{ field: "confidence", op: "gte", value: Number.POSITIVE_INFINITY }] },
      /confidence value must be a finite number/,
    )
    ok({ filters: [{ field: "confidence", op: "between", min: 0.1, max: 0.9 }] })
    bad(
      { filters: [{ field: "confidence", op: "between", min: 0.9, max: 0.1 }] },
      /confidence between requires min <= max/,
    )
  })
  it("requires real YYYY-MM-DD days in order", () => {
    ok({ filters: [{ field: "updatedAt", op: "onDay", day: "2026-08-09" }] })
    bad(
      { filters: [{ field: "updatedAt", op: "onDay", day: "2026-8-9" }] },
      /updatedAt day must be a "YYYY-MM-DD" UTC day/,
    )
    bad(
      { filters: [{ field: "updatedAt", op: "onDay", day: "2026-02-30" }] },
      /is not a real calendar day/,
    )
    bad(
      {
        filters: [
          { field: "updatedAt", op: "betweenDays", fromDay: "2026-08-09", untilDay: "2026-08-01" },
        ],
      },
      /updatedAt betweenDays requires fromDay <= untilDay/,
    )
  })
})

describe("validateBrowseQuery — orderBy", () => {
  it("accepts whitelisted fields and directions", () =>
    ok({
      orderBy: [
        { field: "confidence", dir: "desc" },
        { field: "namespace", dir: "asc" },
      ],
    }))
  it("accepts a full-depth orderBy", () =>
    ok({
      orderBy: [
        { field: "kind", dir: "asc" },
        { field: "status", dir: "asc" },
        { field: "namespace", dir: "asc" },
      ],
    }))
  it("rejects unknown fields, bad directions, duplicates and overlong lists", () => {
    bad({ orderBy: [{ field: "content", dir: "asc" }] as never }, /unknown sort field "content"/)
    bad(
      { orderBy: [{ field: "kind", dir: "sideways" }] as never },
      /sort direction must be "asc" or "desc"/,
    )
    bad(
      {
        orderBy: [
          { field: "kind", dir: "asc" },
          { field: "kind", dir: "desc" },
        ],
      },
      /orderBy repeats the field "kind"/,
    )
    bad(
      {
        orderBy: [
          { field: "kind", dir: "asc" },
          { field: "status", dir: "asc" },
          { field: "namespace", dir: "asc" },
          { field: "confidence", dir: "asc" },
        ],
      },
      /at most 3 orderBy entries/,
    )
  })
})

describe("BrowseQueryError", () => {
  it("is throwable, named, and carries a code", () => {
    try {
      validateBrowseQuery({ limit: 0 })
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(BrowseQueryError)
      expect((error as BrowseQueryError).name).toBe("BrowseQueryError")
      expect((error as BrowseQueryError).code).toBe("invalid-query")
    }
  })
})
