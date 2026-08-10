import { describe, expect, it } from "vitest"
import {
  BROWSE_CURSOR_VERSION,
  browseCursorKey,
  browseQueryFingerprint,
  decodeBrowseCursor,
  encodeBrowseCursor,
} from "../src/browse-cursor.js"
import { resolveBrowseOrder } from "../src/browse-order.js"
import type { BrowseQuery, MemoryRecord } from "../src/types.js"

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
    const fp = browseQueryFingerprint(base)
    expect(browseQueryFingerprint({ ...base, namespace: "route=/y" })).not.toBe(fp)
    expect(browseQueryFingerprint({ ...base, status: "active" })).not.toBe(fp)
    expect(
      browseQueryFingerprint({ ...base, orderBy: [{ field: "confidence", dir: "asc" }] }),
    ).not.toBe(fp)
    expect(browseQueryFingerprint({ ...base, now: "2026-08-09T00:00:00.000Z" })).not.toBe(fp)
  })
  it("ignores paging, which is not part of dataset identity", () => {
    const fp = browseQueryFingerprint({ namespace: "route=/x" })
    expect(
      browseQueryFingerprint({ namespace: "route=/x", limit: 7, offset: 3, cursor: "z" }),
    ).toBe(fp)
  })
})

describe("browseCursorKey", () => {
  it("extracts the raw stored value for each ordered field", () => {
    expect(browseCursorKey(record, resolveBrowseOrder())).toEqual(["2026-08-09T12:00:00.000Z"])
    expect(
      browseCursorKey(
        record,
        resolveBrowseOrder([
          { field: "confidence", dir: "desc" },
          { field: "namespace", dir: "asc" },
        ]),
      ),
    ).toEqual([0.25, "route=/x"])
  })
})

describe("cursor codec", () => {
  const fp = browseQueryFingerprint({ namespace: "route=/x" })

  it("round-trips key and id", () => {
    const cursor = encodeBrowseCursor(fp, { key: ["2026-08-09T12:00:00.000Z"], id: "r1" })
    expect(decodeBrowseCursor(cursor, fp, 1)).toEqual({
      key: ["2026-08-09T12:00:00.000Z"],
      id: "r1",
    })
  })
  it("round-trips non-ASCII and full-precision numbers", () => {
    const cursor = encodeBrowseCursor(fp, { key: [0.1 + 0.2, "ns=✓/日本"], id: "r1" })
    expect(decodeBrowseCursor(cursor, fp, 2)).toEqual({
      key: [0.30000000000000004, "ns=✓/日本"],
      id: "r1",
    })
  })
  it("is base64url — no +, / or = to escape in a query string", () => {
    const cursor = encodeBrowseCursor(fp, { key: ["ÿÿÿÿ"], id: "r1" })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it("rejects a cursor from a different query", () => {
    const cursor = encodeBrowseCursor(fp, { key: ["x"], id: "r1" })
    const other = browseQueryFingerprint({ namespace: "route=/y" })
    expect(() => decodeBrowseCursor(cursor, other, 1)).toThrow(/continuation-invalid/)
  })
  it("rejects garbage, a wrong version, and a key of the wrong length", () => {
    expect(() => decodeBrowseCursor("!!!not-base64!!!", fp, 1)).toThrow(/continuation-invalid/)
    const wrongVersion = Buffer.from(
      JSON.stringify({ v: BROWSE_CURSOR_VERSION + 1, fp, key: ["x"], id: "r1" }),
    ).toString("base64url")
    expect(() => decodeBrowseCursor(wrongVersion, fp, 1)).toThrow(/continuation-invalid/)
    const cursor = encodeBrowseCursor(fp, { key: ["x"], id: "r1" })
    expect(() => decodeBrowseCursor(cursor, fp, 2)).toThrow(/continuation-invalid/)
  })
  it("carries the continuation-invalid code so the route can map it to 400", () => {
    try {
      decodeBrowseCursor("###", fp, 1)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("continuation-invalid")
    }
  })
})
