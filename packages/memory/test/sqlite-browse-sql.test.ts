import { describe, expect, it } from "vitest"
import { resolveBrowseOrder } from "../src/browse-order.js"
import { appendSqliteBrowseFilter, sqliteKeysetWhere } from "../src/sqlite-browse-sql.js"
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

describe("appendSqliteBrowseFilter — confidence", () => {
  it("maps each comparison op and makes between inclusive", () => {
    expect(build({ field: "confidence", op: "eq", value: 0.5 })).toEqual({
      sql: "confidence = ?",
      params: [0.5],
    })
    expect(build({ field: "confidence", op: "neq", value: 0.5 }).sql).toBe("confidence <> ?")
    expect(build({ field: "confidence", op: "gt", value: 0.5 }).sql).toBe("confidence > ?")
    expect(build({ field: "confidence", op: "gte", value: 0.5 }).sql).toBe("confidence >= ?")
    expect(build({ field: "confidence", op: "lt", value: 0.5 }).sql).toBe("confidence < ?")
    expect(build({ field: "confidence", op: "lte", value: 0.5 }).sql).toBe("confidence <= ?")
    expect(build({ field: "confidence", op: "between", min: 0.2, max: 0.8 })).toEqual({
      sql: "confidence >= ? AND confidence <= ?",
      params: [0.2, 0.8],
    })
  })
})

describe("appendSqliteBrowseFilter — updatedAt", () => {
  it("brackets UTC days against the stored full-ISO-Z text", () => {
    expect(build({ field: "updatedAt", op: "onDay", day: "2026-08-09" })).toEqual({
      sql: "updated_at >= ? AND updated_at < ?",
      params: ["2026-08-09T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    })
    expect(build({ field: "updatedAt", op: "beforeDay", day: "2026-08-09" })).toEqual({
      sql: "updated_at < ?",
      params: ["2026-08-09T00:00:00.000Z"],
    })
    expect(build({ field: "updatedAt", op: "afterDay", day: "2026-08-09" })).toEqual({
      sql: "updated_at >= ?",
      params: ["2026-08-10T00:00:00.000Z"],
    })
    expect(
      build({ field: "updatedAt", op: "betweenDays", fromDay: "2026-08-01", untilDay: "2026-08-09" }),
    ).toEqual({
      sql: "updated_at >= ? AND updated_at < ?",
      params: ["2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    })
  })
})

describe("sqliteKeysetWhere", () => {
  it("emits the redundant leading guard plus the OR-chain, id last", () => {
    const params: (string | number)[] = []
    const sql = sqliteKeysetWhere(
      resolveBrowseOrder(),
      { key: ["2026-08-09T00:00:00.000Z"], id: "r1" },
      params,
    )
    expect(sql).toBe("updated_at <= ? AND (updated_at < ? OR (updated_at = ? AND id > ?))")
    expect(params).toEqual([
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
      "r1",
    ])
  })
  it("flips the guard and the chain operators for an ascending leading key", () => {
    const params: (string | number)[] = []
    const sql = sqliteKeysetWhere(
      resolveBrowseOrder([{ field: "createdAt", dir: "asc" }]),
      { key: ["2026-08-09T00:00:00.000Z"], id: "r1" },
      params,
    )
    expect(sql).toBe("created_at >= ? AND (created_at > ? OR (created_at = ? AND id > ?))")
  })
  it("nests one equality level per additional key", () => {
    const params: (string | number)[] = []
    const sql = sqliteKeysetWhere(
      resolveBrowseOrder([
        { field: "namespace", dir: "asc" },
        { field: "confidence", dir: "desc" },
      ]),
      { key: ["ns=a", 0.5], id: "r1" },
      params,
    )
    expect(sql).toBe(
      "namespace >= ? AND (namespace > ? OR (namespace = ? AND confidence < ?) OR (namespace = ? AND confidence = ? AND id > ?))",
    )
    expect(params).toEqual(["ns=a", "ns=a", "ns=a", 0.5, "ns=a", 0.5, "r1"])
  })
})
