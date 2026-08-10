import { describe, expect, it } from "vitest"
import {
  type MemoryRecord,
  selectConsolidationBatches,
  selectReflectionInput,
} from "../src/index.js"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "episodic",
    namespace: "route=/a",
    content: over.id,
    data: {},
    source: { type: "run", id: over.id },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }
}
// 2026-07-06 is a Monday; week A = Jul 6-12, week B = Jul 13-19.
const wA = (d: number) => `2026-07-0${d}T12:00:00.000Z`
const wB = (d: number) => `2026-07-1${d}T12:00:00.000Z`

describe("selectConsolidationBatches", () => {
  it("groups by namespace and ISO week, ordering records by event time ascending", () => {
    const records = [
      rec({ id: "a3", effectiveAt: wA(9) }),
      rec({ id: "a1", effectiveAt: wA(7) }),
      rec({ id: "a2", effectiveAt: wA(8) }),
      rec({ id: "b1", namespace: "route=/b", effectiveAt: wA(7) }),
      rec({ id: "a4", effectiveAt: wB(3) }),
      rec({ id: "a5", effectiveAt: wB(4) }),
    ]
    const batches = selectConsolidationBatches(records, { minBatchSize: 2, maxBatchSize: 50 })
    // route=/a week A (3), route=/a week B (2), route=/b week A (1 → dropped by minBatchSize)
    expect(batches.length).toBe(2)
    const first = batches.find((b) => b.namespace === "route=/a" && b.records.length === 3)
    // Thrown rather than asserted: the period comparisons below read as `false` on an
    // absent batch, which fails with no hint that the batch itself was missing.
    if (first === undefined) throw new Error("no route=/a batch of 3 records")
    expect(first.records.map((r) => r.id)).toEqual(["a1", "a2", "a3"])
    expect(first.period.since <= wA(7)).toBe(true)
    expect(first.period.until > wA(9)).toBe(true)
    expect(batches.every((b) => b.namespace !== "route=/b")).toBe(true)
  })
  it("falls back to createdAt when effectiveAt is absent", () => {
    const batches = selectConsolidationBatches(
      [
        rec({ id: "x", createdAt: wA(7), updatedAt: wA(7) }),
        rec({ id: "y", createdAt: wA(8), updatedAt: wA(8) }),
      ],
      { minBatchSize: 2, maxBatchSize: 50 },
    )
    expect(batches[0]?.records.map((r) => r.id)).toEqual(["x", "y"])
  })
  it("splits a group larger than maxBatchSize into ordered chunks", () => {
    const records = Array.from({ length: 7 }, (_, i) =>
      rec({ id: `r${i}`, effectiveAt: `2026-07-0${(i % 3) + 7}T0${i}:00:00.000Z` }),
    )
    const batches = selectConsolidationBatches(records, { minBatchSize: 2, maxBatchSize: 3 })
    expect(batches.map((b) => b.records.length)).toEqual([3, 3, 1])
    // chunks stay in ascending event order across the split
    const flat = batches.flatMap((b) => b.records.map((r) => r.id))
    expect(flat.length).toBe(7)
    expect(new Set(flat).size).toBe(7)
  })
  it("preserves namespaces containing spaces (serializeNamespace only encodes % | =)", () => {
    const ns = "workspace=app|user=Ada Lovelace"
    const batches = selectConsolidationBatches(
      [
        rec({ id: "s1", namespace: ns, effectiveAt: wA(7) }),
        rec({ id: "s2", namespace: ns, effectiveAt: wA(8) }),
      ],
      { minBatchSize: 2, maxBatchSize: 50 },
    )
    expect(batches.length).toBe(1)
    expect(batches[0]?.namespace).toBe(ns) // NOT truncated at the first space
  })
  it("returns an empty array when nothing meets minBatchSize", () => {
    expect(
      selectConsolidationBatches([rec({ id: "lonely" })], { minBatchSize: 5, maxBatchSize: 50 }),
    ).toEqual([])
  })
})

describe("selectReflectionInput", () => {
  const opts = { minNewRecords: 2, maxRecords: 10 }
  it("filters to records strictly after the watermark", () => {
    const input = selectReflectionInput(
      [
        rec({ id: "old", effectiveAt: wA(7) }),
        rec({ id: "new1", effectiveAt: wA(9) }),
        rec({ id: "new2", effectiveAt: wB(3) }),
      ],
      { ...opts, coveredUntil: wA(8) },
    )
    expect(input?.records.map((r) => r.id)).toEqual(["new1", "new2"])
    expect(input?.coveredUntil).toBe(wB(3)) // the newest event time in the input
  })
  it("returns null below the threshold (the cheap no-op)", () => {
    expect(
      selectReflectionInput([rec({ id: "one", effectiveAt: wB(3) })], {
        ...opts,
        coveredUntil: wA(7),
      }),
    ).toBeNull()
  })
  it("treats a missing watermark as the epoch (first-ever pass)", () => {
    const input = selectReflectionInput(
      [rec({ id: "a", effectiveAt: wA(7) }), rec({ id: "b", effectiveAt: wA(8) })],
      opts,
    )
    expect(input?.records.map((r) => r.id)).toEqual(["a", "b"])
  })
  it("caps at maxRecords keeping the NEWEST, re-sorted ascending", () => {
    const records = [1, 2, 3, 4, 5].map((i) =>
      rec({ id: `r${i}`, effectiveAt: `2026-07-0${i + 4}T00:00:00.000Z` }),
    )
    const input = selectReflectionInput(records, { minNewRecords: 2, maxRecords: 3 })
    expect(input?.records.map((r) => r.id)).toEqual(["r3", "r4", "r5"])
  })
  it("breaks maxRecords ties deterministically by id (total comparator)", () => {
    const at = wA(9)
    const records = ["d", "c", "b", "a"].map((id) => rec({ id, effectiveAt: at }))
    const first = selectReflectionInput(records, { minNewRecords: 2, maxRecords: 2 })
    const second = selectReflectionInput([...records].reverse(), {
      minNewRecords: 2,
      maxRecords: 2,
    })
    // All four share an event time, so the id tiebreak decides: the cap keeps the
    // HIGHEST ids ("c","d") and the result is re-sorted ascending — independent of
    // input order. A comparator that returned 1 for equals would leave this to sort luck.
    expect(first?.records.map((r) => r.id)).toEqual(["c", "d"])
    expect(second?.records.map((r) => r.id)).toEqual(["c", "d"])
    expect(first?.coveredUntil).toBe(at)
  })
})
