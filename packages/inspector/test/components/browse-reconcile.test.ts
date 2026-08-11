import { DEFAULT_BROWSE_ORDER } from "@dawn-ai/memory/browse"
import { describe, expect, it } from "vitest"

import {
  compareDefaultBrowseOrder,
  dedupeById,
  reconcileRefreshedWindow,
} from "../../src/browse/browse-reconcile"

/** A row carrying just the two fields the default order reads, plus a payload
 *  marker so "took the response's payload" is observable. */
function row(id: string, updatedAt: string, payload = "old") {
  return { id, updatedAt, payload }
}

describe("compareDefaultBrowseOrder", () => {
  it("orders updatedAt DESC then id ASC", () => {
    expect(
      compareDefaultBrowseOrder(
        row("a", "2026-08-02T00:00:00.000Z"),
        row("b", "2026-08-01T00:00:00.000Z"),
      ),
    ).toBeLessThan(0)
    expect(
      compareDefaultBrowseOrder(
        row("a", "2026-08-01T00:00:00.000Z"),
        row("b", "2026-08-02T00:00:00.000Z"),
      ),
    ).toBeGreaterThan(0)
    expect(
      compareDefaultBrowseOrder(
        row("a", "2026-08-01T00:00:00.000Z"),
        row("b", "2026-08-01T00:00:00.000Z"),
      ),
    ).toBeLessThan(0)
    expect(
      compareDefaultBrowseOrder(
        row("a", "2026-08-01T00:00:00.000Z"),
        row("a", "2026-08-01T00:00:00.000Z"),
      ),
    ).toBe(0)
  })

  it("breaks id ties on code units, so uppercase sorts before lowercase", () => {
    expect(compareDefaultBrowseOrder(row("Z", "t"), row("a", "t"))).toBeLessThan(0)
  })

  // The premise of the whole module: rules 2 and 3 only decide anything if this
  // comparator is the ORDER BY the server actually ran. Changing the store default —
  // or starting to send an explicit `orderBy`, which `src/store/browse-params.ts`
  // already parses — desynchronizes them silently, so pin the default here. The
  // trailing `id ASC` is not in this array: both stores append it themselves so every
  // order is total.
  it("implements the server's DEFAULT_BROWSE_ORDER", () => {
    expect(DEFAULT_BROWSE_ORDER.map((entry) => [entry.field, entry.dir])).toEqual([
      ["updatedAt", "desc"],
    ])
  })
})

describe("dedupeById", () => {
  it("appends only ids the resident set does not hold", () => {
    const prev = [row("a", "t"), row("b", "t")]
    expect(dedupeById(prev, [row("b", "t"), row("c", "t")]).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("returns the SAME array when nothing was added", () => {
    const prev = [row("a", "t")]
    expect(dedupeById(prev, [row("a", "t")])).toBe(prev)
  })

  it("drops a duplicate WITHIN next, not only one against prev", () => {
    const next = [row("b", "t"), row("b", "t", "again"), row("c", "t")]
    expect(dedupeById([row("a", "t")], next).map((r) => r.id)).toEqual(["a", "b", "c"])
  })
})

describe("reconcileRefreshedWindow", () => {
  it("rule 1: a resident row in the response takes the response payload AND position", () => {
    const resident = [row("a", "2026-08-03T00:00:00.000Z"), row("b", "2026-08-02T00:00:00.000Z")]
    // `b` was approved: hoisted above `a`, with a new payload.
    const refreshed = [
      row("b", "2026-08-04T00:00:00.000Z", "new"),
      row("a", "2026-08-03T00:00:00.000Z", "new"),
    ]
    const next = reconcileRefreshedWindow(resident, refreshed, { filled: true })
    expect(next.map((r) => r.id)).toEqual(["b", "a"])
    expect(next.every((r) => r.payload === "new")).toBe(true)
  })

  it("rule 2: a resident row inside the refreshed span but absent from it is dropped", () => {
    const resident = [
      row("a", "2026-08-03T00:00:00.000Z"),
      row("b", "2026-08-02T00:00:00.000Z"),
      row("c", "2026-08-01T00:00:00.000Z"),
    ]
    // A full window that no longer contains `b` — deleted, or filtered out.
    const refreshed = [row("a", "2026-08-03T00:00:00.000Z"), row("c", "2026-08-01T00:00:00.000Z")]
    expect(
      reconcileRefreshedWindow(resident, refreshed, { filled: true }).map((r) => r.id),
    ).toEqual(["a", "c"])
  })

  it("rule 3: a resident row BEYOND the refreshed span is retained as a stale tail", () => {
    const resident = [
      row("a", "2026-08-03T00:00:00.000Z"),
      row("b", "2026-08-02T00:00:00.000Z"),
      row("c", "2026-08-01T00:00:00.000Z"),
    ]
    // Two head inserts filled the whole limit, so coverage now ends at `x2`.
    const refreshed = [row("x1", "2026-08-09T00:00:00.000Z"), row("x2", "2026-08-08T00:00:00.000Z")]
    const next = reconcileRefreshedWindow(resident, refreshed, { filled: true })
    expect(next.map((r) => r.id)).toEqual(["x1", "x2", "a", "b", "c"])
  })

  it("an insert and a delete in ONE refresh leave the retained tail contiguous", () => {
    const resident = [
      row("a", "2026-08-04T00:00:00.000Z"),
      row("b", "2026-08-03T00:00:00.000Z"),
      row("c", "2026-08-02T00:00:00.000Z"),
      row("d", "2026-08-01T00:00:00.000Z"),
    ]
    // `b` deleted and two inserted in the same tick: the window still ends at `c`, so
    // `d` alone is beyond it. Dropping `b` must not pull `d` inside the span.
    const refreshed = [
      row("x1", "2026-08-09T00:00:00.000Z"),
      row("x2", "2026-08-08T00:00:00.000Z"),
      row("a", "2026-08-04T00:00:00.000Z"),
      row("c", "2026-08-02T00:00:00.000Z"),
    ]
    expect(
      reconcileRefreshedWindow(resident, refreshed, { filled: true }).map((r) => r.id),
    ).toEqual(["x1", "x2", "a", "c", "d"])
  })

  it("a window that did not FILL its limit has an unbounded span, so nothing is retained", () => {
    const resident = [row("a", "2026-08-03T00:00:00.000Z"), row("b", "2026-08-02T00:00:00.000Z")]
    // The response did not fill: the matching set really is one row.
    expect(
      reconcileRefreshedWindow(resident, [row("a", "2026-08-03T00:00:00.000Z")], {
        filled: false,
      }).map((r) => r.id),
    ).toEqual(["a"])
  })

  it("an empty response empties the resident set", () => {
    expect(reconcileRefreshedWindow([row("a", "t")], [], { filled: false })).toEqual([])
  })
})
