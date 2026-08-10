import { describe, expect, it } from "vitest"
import { appendSqliteBrowseFilter } from "../src/sqlite-browse-sql.js"
import type { BrowseFilter } from "../src/types.js"

function build(filter: BrowseFilter) {
  const where: string[] = []
  const params: (string | number)[] = []
  appendSqliteBrowseFilter(filter, where, params)
  return { sql: where.join(" AND "), params }
}

describe("appendSqliteBrowseFilter — sets", () => {
  it("expands in/notIn to placeholders", () => {
    expect(build({ field: "status", op: "in", values: ["active", "candidate"] })).toEqual({
      sql: "status IN (?,?)",
      params: ["active", "candidate"],
    })
    expect(build({ field: "kind", op: "notIn", values: ["episodic"] })).toEqual({
      sql: "kind NOT IN (?)",
      params: ["episodic"],
    })
  })
})

describe("appendSqliteBrowseFilter — unmapped field", () => {
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

describe("appendSqliteBrowseFilter — content", () => {
  it("uses literal substring primitives, never LIKE (no metacharacter escaping, ever)", () => {
    expect(build({ field: "content", op: "contains", value: "50%" })).toEqual({
      sql: "instr(lower(content), lower(?)) > 0",
      params: ["50%"],
    })
    expect(build({ field: "content", op: "notContains", value: "x" }).sql).toBe(
      "instr(lower(content), lower(?)) = 0",
    )
    expect(build({ field: "content", op: "startsWith", value: "x" }).sql).toBe(
      "instr(lower(content), lower(?)) = 1",
    )
    expect(build({ field: "content", op: "endsWith", value: "x" })).toEqual({
      sql: "substr(lower(content), -length(?)) = lower(?)",
      params: ["x", "x"],
    })
    expect(build({ field: "content", op: "equals", value: "x" }).sql).toBe(
      "lower(content) = lower(?)",
    )
    expect(build({ field: "content", op: "notEquals", value: "x" }).sql).toBe(
      "lower(content) <> lower(?)",
    )
  })
})

describe("appendSqliteBrowseFilter — namespace", () => {
  it("compares exactly for equals", () => {
    expect(build({ field: "namespace", op: "equals", value: "route=/x" })).toEqual({
      sql: "namespace = ?",
      params: ["route=/x"],
    })
  })
  it("turns startsWith into a half-open byte range (sargable, still metachar-literal)", () => {
    expect(build({ field: "namespace", op: "startsWith", value: "route=/a" })).toEqual({
      sql: "namespace >= ? AND namespace < ?",
      params: ["route=/a", "route=/b"],
    })
  })
  it("drops the upper bound when the prefix has none", () => {
    expect(build({ field: "namespace", op: "startsWith", value: "\u{10FFFF}" })).toEqual({
      sql: "namespace >= ?",
      params: ["\u{10FFFF}"],
    })
  })
})
