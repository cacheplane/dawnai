import { describe, expect, it } from "vitest"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_RESIDENT_CAP,
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  NEEDLE_ID,
  NEEDLE_TERM,
  seedIdsInDefaultOrder,
  seedIdsSortedBy,
  seedRecordsMatching,
} from "../seed"

describe("browse seed fixture", () => {
  it("is larger than one window and larger than the resident cap", () => {
    expect(BROWSE_PAGE_SIZE).toBe(200)
    expect(BROWSE_RESIDENT_CAP).toBe(1000)
    expect(BROWSE_SEED_COUNT).toBe(1250)
    expect(browseSeedRecords()).toHaveLength(1250)
  })

  it("is pure — two calls produce equal records", () => {
    expect(browseSeedRecords()).toEqual(browseSeedRecords())
  })

  it("puts ten records on every updatedAt so the id tie-break is exercised in every window", () => {
    const byStamp = new Map<string, string[]>()
    for (const record of browseSeedRecords()) {
      byStamp.set(record.updatedAt, [...(byStamp.get(record.updatedAt) ?? []), record.id])
    }
    expect(byStamp.size).toBe(125)
    for (const ids of byStamp.values()) expect(ids).toHaveLength(10)
  })

  it("hides the content needle beyond the first default window", () => {
    const order = seedIdsInDefaultOrder()
    expect(order.indexOf(NEEDLE_ID)).toBeGreaterThan(BROWSE_PAGE_SIZE)
    expect(seedRecordsMatching({ contentContains: NEEDLE_TERM }).map((r) => r.id)).toEqual([
      NEEDLE_ID,
    ])
  })

  it("carries a namespace that is a strict prefix of another namespace", () => {
    const exact = seedRecordsMatching({ namespace: "route=/notes" })
    const prefixed = seedRecordsMatching({ namespacePrefix: "route=/notes" })
    expect(exact.length).toBeGreaterThan(0)
    expect(prefixed.length).toBeGreaterThan(exact.length)
    expect(exact.every((r) => r.namespace === "route=/notes")).toBe(true)
  })

  it("ties confidence 25 ways so a sort window is only deterministic with the id tie-break", () => {
    const top = seedIdsSortedBy([{ field: "confidence", dir: "desc" }]).slice(0, 25)
    const records = new Map(browseSeedRecords().map((r) => [r.id, r]))
    expect(new Set(top.map((id) => records.get(id)?.confidence)).size).toBe(1)
    expect(top).toEqual([...top].sort())
  })
})
