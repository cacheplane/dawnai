import { describe, expect, it } from "vitest"
import {
  BROWSE_CURSOR_VERSION,
  browseCursorKey,
  browseQueryFingerprint,
  decodeBrowseCursor,
  encodeBrowseCursor,
} from "../src/browse-cursor.js"
import { resolveBrowseOrder } from "../src/browse-order.js"
import { BrowseQueryError } from "../src/browse-validate.js"
import type { BrowseFilter, BrowseQuery, MemoryRecord } from "../src/types.js"

const record: MemoryRecord = {
  id: "r1",
  kind: "semantic",
  namespace: "route=/x",
  content: "c",
  data: {},
  source: { type: "eval", id: "seed" },
  confidence: 0.25,
  tags: [],
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
}

const BY_UPDATED_AT = resolveBrowseOrder()
const BY_CONFIDENCE_THEN_NAMESPACE = resolveBrowseOrder([
  { field: "confidence", dir: "desc" },
  { field: "namespace", dir: "asc" },
])

/** Labels of cases sharing a fingerprint. Empty means every case is told apart — and a
 *  failure names the two queries that collided instead of printing two hex strings. */
function collidingLabels(cases: readonly (readonly [string, BrowseQuery])[]): readonly string[] {
  const seen = new Map<string, string>()
  const collisions: string[] = []
  for (const [label, query] of cases) {
    const fingerprint = browseQueryFingerprint(query)
    const previous = seen.get(fingerprint)
    if (previous === undefined) seen.set(fingerprint, label)
    else collisions.push(`${previous} = ${label}`)
  }
  return collisions
}

/** Asserted on `.code`, not on the message: the route branches on the code. */
function expectContinuationInvalid(decode: () => unknown): void {
  try {
    decode()
  } catch (error) {
    expect(error).toBeInstanceOf(BrowseQueryError)
    expect((error as BrowseQueryError).code).toBe("continuation-invalid")
    return
  }
  expect.unreachable("should have thrown")
}

describe("browseQueryFingerprint", () => {
  it("is stable across key order and filter order", () => {
    const a: BrowseQuery = {
      namespace: "route=/x",
      filters: [
        { field: "status", op: "in", values: ["active", "candidate"] },
        { field: "content", op: "contains", value: "acme" },
      ],
    }
    const b: BrowseQuery = {
      filters: [
        { field: "content", op: "contains", value: "acme" },
        { field: "status", op: "in", values: ["candidate", "active"] },
      ],
      namespace: "route=/x",
    }
    expect(browseQueryFingerprint(a)).toBe(browseQueryFingerprint(b))
  })
  it("changes when any identity field changes", () => {
    const base: BrowseQuery = { namespace: "route=/x" }
    expect(
      collidingLabels([
        ["base", base],
        ["namespace", { ...base, namespace: "route=/y" }],
        ["namespacePrefix", { ...base, namespacePrefix: "route=" }],
        ["status", { ...base, status: "active" }],
        ["kind", { ...base, kind: "semantic" }],
        ["sourceType", { ...base, sourceType: "eval" }],
        ["since", { ...base, since: "2026-08-01T00:00:00.000Z" }],
        ["until", { ...base, until: "2026-08-09T00:00:00.000Z" }],
        ["now", { ...base, now: "2026-08-09T00:00:00.000Z" }],
        ["filters", { ...base, filters: [{ field: "content", op: "contains", value: "acme" }] }],
        ["orderBy", { ...base, orderBy: [{ field: "confidence", dir: "asc" }] }],
      ]),
    ).toEqual([])
  })
  it("tells apart every filter field, op and operand", () => {
    const filters: readonly (readonly [string, BrowseFilter])[] = [
      ["status in", { field: "status", op: "in", values: ["active"] }],
      ["status notIn", { field: "status", op: "notIn", values: ["active"] }],
      ["status in candidate", { field: "status", op: "in", values: ["candidate"] }],
      ["kind in", { field: "kind", op: "in", values: ["semantic"] }],
      ["content contains", { field: "content", op: "contains", value: "acme" }],
      ["content endsWith", { field: "content", op: "endsWith", value: "acme" }],
      ["content contains widget", { field: "content", op: "contains", value: "widget" }],
      ["namespace equals", { field: "namespace", op: "equals", value: "acme" }],
      ["namespace startsWith", { field: "namespace", op: "startsWith", value: "acme" }],
      ["confidence gt", { field: "confidence", op: "gt", value: 0.5 }],
      ["confidence lt", { field: "confidence", op: "lt", value: 0.5 }],
      ["confidence gt 0.9", { field: "confidence", op: "gt", value: 0.9 }],
      ["confidence between", { field: "confidence", op: "between", min: 0.1, max: 0.5 }],
      ["confidence between wider", { field: "confidence", op: "between", min: 0.1, max: 0.9 }],
      ["updatedAt onDay", { field: "updatedAt", op: "onDay", day: "2026-08-01" }],
      ["updatedAt beforeDay", { field: "updatedAt", op: "beforeDay", day: "2026-08-01" }],
      ["updatedAt onDay later", { field: "updatedAt", op: "onDay", day: "2026-08-02" }],
      [
        "updatedAt betweenDays",
        { field: "updatedAt", op: "betweenDays", fromDay: "2026-08-01", untilDay: "2026-08-05" },
      ],
      [
        "updatedAt betweenDays wider",
        { field: "updatedAt", op: "betweenDays", fromDay: "2026-08-01", untilDay: "2026-08-09" },
      ],
    ]
    expect(
      collidingLabels(filters.map(([label, filter]) => [label, { filters: [filter] }] as const)),
    ).toEqual([])
  })
  it("reads status/kind as sets, but the empty set as narrowed-to-nothing", () => {
    expect(browseQueryFingerprint({ status: ["active", "candidate"] })).toBe(
      browseQueryFingerprint({ status: ["candidate", "active"] }),
    )
    expect(browseQueryFingerprint({ kind: "semantic" })).toBe(
      browseQueryFingerprint({ kind: ["semantic"] }),
    )
    // `[]` matches nothing while an absent field matches everything, so one fingerprint
    // for both would let a continuation cross between two different datasets.
    expect(browseQueryFingerprint({ status: [] })).not.toBe(browseQueryFingerprint({}))
  })
  it("ignores paging, which is not part of dataset identity", () => {
    const fp = browseQueryFingerprint({ namespace: "route=/x" })
    expect(
      browseQueryFingerprint({ namespace: "route=/x", limit: 7, offset: 3, cursor: "z" }),
    ).toBe(fp)
  })
  it("throws rather than fingerprinting a filter field it does not map", () => {
    expect(() =>
      browseQueryFingerprint({
        filters: [{ field: "createdAt" as never, op: "onDay", day: "2026-08-01" }],
      }),
    ).toThrow(/unknown filter field "createdAt"/)
  })
})

describe("browseCursorKey", () => {
  it("extracts the raw stored value for each ordered field", () => {
    expect(browseCursorKey(record, BY_UPDATED_AT)).toEqual(["2026-08-09T12:00:00.000Z"])
    expect(browseCursorKey(record, BY_CONFIDENCE_THEN_NAMESPACE)).toEqual([0.25, "route=/x"])
    expect(
      browseCursorKey(
        record,
        resolveBrowseOrder([
          { field: "createdAt", dir: "asc" },
          { field: "kind", dir: "asc" },
          { field: "status", dir: "asc" },
        ]),
      ),
    ).toEqual(["2026-08-01T00:00:00.000Z", "semantic", "active"])
  })
  it("throws rather than keying a page off some other column", () => {
    expect(() =>
      browseCursorKey(record, [
        {
          field: "content" as never,
          column: "content",
          dir: "asc",
          numeric: false,
          collateC: false,
        },
      ]),
    ).toThrow(/unknown sort field "content"/)
  })
})

describe("cursor codec", () => {
  const fp = browseQueryFingerprint({ namespace: "route=/x" })

  it("round-trips key and id", () => {
    const cursor = encodeBrowseCursor(fp, { key: ["2026-08-09T12:00:00.000Z"], id: "r1" })
    expect(decodeBrowseCursor(cursor, fp, BY_UPDATED_AT)).toEqual({
      key: ["2026-08-09T12:00:00.000Z"],
      id: "r1",
    })
  })
  it("round-trips non-ASCII and full-precision numbers", () => {
    const cursor = encodeBrowseCursor(fp, { key: [0.1 + 0.2, "ns=✓/日本"], id: "r1" })
    expect(decodeBrowseCursor(cursor, fp, BY_CONFIDENCE_THEN_NAMESPACE)).toEqual({
      key: [0.30000000000000004, "ns=✓/日本"],
      id: "r1",
    })
  })
  it("is base64url of {v, fp, key, id} — the wire format slice 3's hook decodes", () => {
    const key = [0.25, "ns=✓/日本"]
    expect(encodeBrowseCursor(fp, { key, id: "r1" })).toBe(
      Buffer.from(JSON.stringify({ v: BROWSE_CURSOR_VERSION, fp, key, id: "r1" })).toString(
        "base64url",
      ),
    )
  })
  it("is base64url — no +, / or = to escape in a query string", () => {
    const cursor = encodeBrowseCursor(fp, { key: ["ÿÿÿÿ"], id: "r1" })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it("rejects a cursor from a different query", () => {
    const cursor = encodeBrowseCursor(fp, { key: ["x"], id: "r1" })
    const other = browseQueryFingerprint({ namespace: "route=/y" })
    expectContinuationInvalid(() => decodeBrowseCursor(cursor, other, BY_UPDATED_AT))
  })
  it("rejects garbage, a wrong version, and a key of the wrong length", () => {
    expectContinuationInvalid(() => decodeBrowseCursor("!!!not-base64!!!", fp, BY_UPDATED_AT))
    const wrongVersion = Buffer.from(
      JSON.stringify({ v: BROWSE_CURSOR_VERSION + 1, fp, key: ["x"], id: "r1" }),
    ).toString("base64url")
    expectContinuationInvalid(() => decodeBrowseCursor(wrongVersion, fp, BY_UPDATED_AT))
    const cursor = encodeBrowseCursor(fp, { key: ["x"], id: "r1" })
    expectContinuationInvalid(() => decodeBrowseCursor(cursor, fp, BY_CONFIDENCE_THEN_NAMESPACE))
  })
  it("rejects a key whose value types do not match the sort order", () => {
    const numeric = resolveBrowseOrder([{ field: "confidence", dir: "desc" }])
    const numericFp = browseQueryFingerprint({ orderBy: [{ field: "confidence", dir: "desc" }] })
    // Anyone can mint this: a string bound against a REAL column compares across SQLite's
    // storage classes rather than as a number, so the keyset boundary matches every row.
    const text = encodeBrowseCursor(numericFp, { key: ["0.25"], id: "r1" })
    expectContinuationInvalid(() => decodeBrowseCursor(text, numericFp, numeric))
    const notFinite = encodeBrowseCursor(numericFp, { key: [Number.NaN], id: "r1" })
    expectContinuationInvalid(() => decodeBrowseCursor(notFinite, numericFp, numeric))
    const number = encodeBrowseCursor(fp, { key: [17], id: "r1" })
    expectContinuationInvalid(() => decodeBrowseCursor(number, fp, BY_UPDATED_AT))
  })
  it("rejects a cursor carrying no row id to break the sort-key tie on", () => {
    const idless = Buffer.from(
      JSON.stringify({ v: BROWSE_CURSOR_VERSION, fp, key: ["x"] }),
    ).toString("base64url")
    expectContinuationInvalid(() => decodeBrowseCursor(idless, fp, BY_UPDATED_AT))
  })
  it("carries the continuation-invalid code so the route can map it to 400", () => {
    expectContinuationInvalid(() => decodeBrowseCursor("###", fp, BY_UPDATED_AT))
  })
})
