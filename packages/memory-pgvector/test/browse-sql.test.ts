import type { BrowseFilter } from "@dawn-ai/memory"
import { describe, expect, it } from "vitest"
import { appendPgBrowseFilter } from "../src/browse-sql.js"

function build(filter: BrowseFilter, startIndex = 0) {
  const where: string[] = []
  const params: unknown[] = new Array(startIndex).fill("seed")
  appendPgBrowseFilter(filter, where, params)
  return { sql: where.join(" AND "), params: params.slice(startIndex) }
}

describe("appendPgBrowseFilter — sets", () => {
  it("binds one array parameter instead of expanding placeholders", () => {
    expect(build({ field: "status", op: "in", values: ["active", "candidate"] })).toEqual({
      sql: "status = ANY($1::text[])",
      params: [["active", "candidate"]],
    })
    expect(build({ field: "kind", op: "notIn", values: ["episodic"] }).sql).toBe(
      "kind <> ALL($1::text[])",
    )
  })
  it("numbers placeholders from the caller's current parameter count", () => {
    expect(build({ field: "status", op: "in", values: ["active"] }, 3).sql).toBe(
      "status = ANY($4::text[])",
    )
  })
})

describe("appendPgBrowseFilter — unmapped field", () => {
  it("rejects as BrowseQueryError, the name the HTTP boundary maps to 400", () => {
    let thrown: unknown
    try {
      build({ field: "tags", op: "in", values: ["x"] } as never)
    } catch (error) {
      thrown = error
    }
    // Identity, not wording: a plain Error carries the same message and still 500s.
    expect(thrown).toMatchObject({ name: "BrowseQueryError", code: "invalid-query" })
    expect(thrown).toHaveProperty(
      "message",
      expect.stringContaining("unhandled browse filter field"),
    )
  })
})

describe("appendPgBrowseFilter — content", () => {
  it("uses position()/starts_with()/right(), never LIKE", () => {
    expect(build({ field: "content", op: "contains", value: "50%" })).toEqual({
      sql: "position(lower($1) in lower(content)) > 0",
      params: ["50%"],
    })
    expect(build({ field: "content", op: "notContains", value: "x" }).sql).toBe(
      "position(lower($1) in lower(content)) = 0",
    )
    expect(build({ field: "content", op: "startsWith", value: "x" }).sql).toBe(
      "starts_with(lower(content), lower($1))",
    )
    expect(build({ field: "content", op: "endsWith", value: "x" })).toEqual({
      sql: "right(lower(content), length($1)) = lower($2)",
      params: ["x", "x"],
    })
    expect(build({ field: "content", op: "equals", value: "x" }).sql).toBe(
      "lower(content) = lower($1)",
    )
    expect(build({ field: "content", op: "notEquals", value: "x" }).sql).toBe(
      "lower(content) <> lower($1)",
    )
  })
})

describe("appendPgBrowseFilter — namespace", () => {
  it('compares with COLLATE "C" so byte order matches SQLite', () => {
    expect(build({ field: "namespace", op: "equals", value: "route=/x" })).toEqual({
      sql: 'namespace COLLATE "C" = $1',
      params: ["route=/x"],
    })
    expect(build({ field: "namespace", op: "startsWith", value: "route=/a" })).toEqual({
      sql: 'namespace COLLATE "C" >= $1 AND namespace COLLATE "C" < $2',
      params: ["route=/a", "route=/b"],
    })
  })
  it("drops the upper bound when the prefix has none", () => {
    expect(build({ field: "namespace", op: "startsWith", value: "\u{10FFFF}" })).toEqual({
      sql: 'namespace COLLATE "C" >= $1',
      params: ["\u{10FFFF}"],
    })
  })
  it("numbers both bounds from the caller's current parameter count", () => {
    // The bounds are pushed one at a time, so $n is read off params.length twice —
    // an off-by-one here binds the upper bound to someone else's parameter.
    expect(build({ field: "namespace", op: "startsWith", value: "route=/a" }, 3).sql).toBe(
      'namespace COLLATE "C" >= $4 AND namespace COLLATE "C" < $5',
    )
    expect(build({ field: "namespace", op: "startsWith", value: "\u{10FFFF}" }, 3).sql).toBe(
      'namespace COLLATE "C" >= $4',
    )
  })
})
