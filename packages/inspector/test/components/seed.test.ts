import type { BrowseSortEntry } from "@dawn-ai/memory/browse"
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

/** The head and tail of every order the lane sorts by, derived from the generator's rules
 *  by hand rather than from its output — this file is the ONE place the fixture's shape is
 *  transcribed, so that everything downstream can compute instead of transcribe. A change
 *  to the fixture is meant to redden this file and nothing else. */
const SORTS: readonly {
  readonly name: string
  readonly entries: readonly BrowseSortEntry[]
  readonly head: string
  readonly tail: string
}[] = [
  // Newest minute (124) first, id ASC inside it; oldest minute (0) last, id ASC inside it.
  {
    name: "updatedAt desc",
    entries: [{ field: "updatedAt", dir: "desc" }],
    head: "mem-1240",
    tail: "mem-0009",
  },
  {
    name: "updatedAt asc",
    entries: [{ field: "updatedAt", dir: "asc" }],
    head: "mem-0000",
    tail: "mem-1249",
  },
  // createdAt = minute − (index % 7) − 1, so its extremes fall on neither end of the id
  // range: proof that the two timestamps really are different orders.
  {
    name: "createdAt desc",
    entries: [{ field: "createdAt", dir: "desc" }],
    head: "mem-1246",
    tail: "mem-0006",
  },
  // 0.98 is index % 50 === 49, 0 is index % 50 === 0.
  {
    name: "confidence desc",
    entries: [{ field: "confidence", dir: "desc" }],
    head: "mem-0049",
    tail: "mem-1200",
  },
  {
    name: "confidence asc",
    entries: [{ field: "confidence", dir: "asc" }],
    head: "mem-0000",
    tail: "mem-1249",
  },
  // BINARY order: "route=/chat" < "route=/notes" < "route=/notes-archive" (prefix first).
  {
    name: "namespace asc",
    entries: [{ field: "namespace", dir: "asc" }],
    head: "mem-0003",
    tail: "mem-1245",
  },
  // "episodic" < "procedural" < "reflection" < "semantic".
  {
    name: "kind asc",
    entries: [{ field: "kind", dir: "asc" }],
    head: "mem-0001",
    tail: "mem-1248",
  },
  // "active" < "candidate" < "superseded".
  {
    name: "status asc",
    entries: [{ field: "status", dir: "asc" }],
    head: "mem-0001",
    tail: "mem-1247",
  },
]

function countBy<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

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

  it("emits every id exactly once, and NOT in id order", () => {
    const ids = browseSeedRecords().map((record) => record.id)
    const everyId = Array.from(
      { length: BROWSE_SEED_COUNT },
      (_, index) => `mem-${String(index).padStart(4, "0")}`,
    )
    expect([...ids].sort()).toEqual(everyId)
    // The property the id tie-break needs in order to be observable: were the fixture
    // emitted in id order, a stable sort would return id-ordered ties from a comparator
    // that had no tie-break at all.
    expect(ids).not.toEqual(everyId)
  })

  it("orders every sort by id inside a tie, whatever order the records arrive in", () => {
    const records = browseSeedRecords()
    const reversed = [...records].reverse()
    for (const { name, entries } of SORTS) {
      expect(seedIdsSortedBy(entries, reversed), name).toEqual(seedIdsSortedBy(entries, records))
    }
  })

  it("pins the head and tail of every order the lane sorts by", () => {
    for (const { name, entries, head, tail } of SORTS) {
      const ids = seedIdsSortedBy(entries)
      expect(ids, name).toHaveLength(BROWSE_SEED_COUNT)
      expect(ids[0], name).toBe(head)
      expect(ids.at(-1), name).toBe(tail)
    }
  })

  it("compares numbers as numbers, not as text", () => {
    // Out of the [0, 1] confidence domain on purpose: inside it decimal strings sort
    // exactly like their values, so no record of this fixture can tell a numeric compare
    // from a lexicographic one.
    const [template] = browseSeedRecords()
    if (!template) throw new Error("fixture is empty")
    const ids = seedIdsSortedBy(
      [{ field: "confidence", dir: "asc" }],
      [
        { ...template, id: "mem-9999", confidence: 10 },
        { ...template, id: "mem-9998", confidence: 2 },
      ],
    )
    expect(ids).toEqual(["mem-9998", "mem-9999"])
  })

  it("orders text by bytes and folds case ASCII-only, as SQLite does", () => {
    // Both properties are invisible in the fixture itself — every value in it is
    // lowercase ASCII, where ICU collation and BINARY agree and both `lower()`
    // implementations agree. They are pinned on synthetic records because the day a
    // namespace carries an upper-case letter, or a needle a non-ASCII one, the model has
    // to move WITH the store rather than with the JS defaults: `localeCompare` sorts "a"
    // before "A" where the store sorts "A" first, and JS `toLowerCase()` folds "É" where
    // SQLite's `lower()` leaves it alone.
    const [template] = browseSeedRecords()
    if (!template) throw new Error("fixture is empty")
    const mixedCase = [
      { ...template, id: "mem-9998", namespace: "route=/Notes" },
      { ...template, id: "mem-9999", namespace: "route=/notes" },
    ]
    expect(seedIdsSortedBy([{ field: "namespace", dir: "asc" }], mixedCase)).toEqual([
      "mem-9998",
      "mem-9999",
    ])
    const accented = [{ ...template, id: "mem-9997", content: "CAFÉ threshold" }]
    expect(seedRecordsMatching({ contentContains: "café" }, accented)).toEqual([])
    expect(seedRecordsMatching({ contentContains: "CAFÉ" }, accented)).toHaveLength(1)
    expect(seedRecordsMatching({ contentContains: "cafÉ" }, accented)).toHaveLength(1)
  })

  it("puts ten records on every updatedAt so the id tie-break is exercised in every window", () => {
    const byStamp = new Map<string, string[]>()
    for (const record of browseSeedRecords()) {
      byStamp.set(record.updatedAt, [...(byStamp.get(record.updatedAt) ?? []), record.id])
    }
    expect(byStamp.size).toBe(125)
    for (const ids of byStamp.values()) expect(ids).toHaveLength(10)
  })

  it("staggers createdAt off updatedAt so one sort cannot pass for the other", () => {
    for (const record of browseSeedRecords()) {
      expect(record.createdAt < record.updatedAt, record.id).toBe(true)
    }
    expect(seedIdsSortedBy([{ field: "createdAt", dir: "desc" }])).not.toEqual(
      seedIdsInDefaultOrder(),
    )
  })

  it("hides the content needle at a known index beyond the first default window", () => {
    // 34 whole minutes (124 down to 91) precede the needle's minute, and it is first
    // inside its own — so the first window can only reach it server-side.
    const index = seedIdsInDefaultOrder().indexOf(NEEDLE_ID)
    expect(index).toBe(340)
    expect(index).toBeGreaterThan(BROWSE_PAGE_SIZE)
    expect(seedRecordsMatching({ contentContains: NEEDLE_TERM }).map((r) => r.id)).toEqual([
      NEEDLE_ID,
    ])
    expect(
      seedRecordsMatching({ contentContains: NEEDLE_TERM.toUpperCase() }).map((r) => r.id),
    ).toEqual([NEEDLE_ID])
  })

  it("carries a namespace that is a strict prefix of another namespace", () => {
    const counts = countBy(browseSeedRecords().map((record) => record.namespace))
    // index % 5 === 0 → archive (250); index % 3 === 0 otherwise → chat (417 − 84);
    // everything else → notes.
    expect(Object.fromEntries(counts)).toEqual({
      "route=/notes": 667,
      "route=/chat": 333,
      "route=/notes-archive": 250,
    })
    expect(seedRecordsMatching({ namespace: "route=/notes" })).toHaveLength(667)
    expect(seedRecordsMatching({ namespacePrefix: "route=/notes" })).toHaveLength(917)
    expect(
      seedRecordsMatching({ namespace: "route=/notes" }).every(
        (r) => r.namespace === "route=/notes",
      ),
    ).toBe(true)
  })

  it("ties confidence 25 ways so a sort window is only deterministic with the id tie-break", () => {
    const byConfidence = countBy(browseSeedRecords().map((record) => record.confidence))
    expect(byConfidence.size).toBe(50)
    for (const [value, count] of byConfidence) expect(count, String(value)).toBe(25)
    // The 25 ids holding the maximum confidence, in the id order the terminator imposes.
    expect(seedIdsSortedBy([{ field: "confidence", dir: "desc" }]).slice(0, 25)).toEqual(
      Array.from({ length: 25 }, (_, k) => `mem-${String(k * 50 + 49).padStart(4, "0")}`),
    )
  })

  it("spreads kind, status and source so every facet has something to count", () => {
    const records = browseSeedRecords()
    expect(Object.fromEntries(countBy(records.map((r) => r.kind)))).toEqual({
      semantic: 313,
      episodic: 313,
      procedural: 312,
      reflection: 312,
    })
    expect(Object.fromEntries(countBy(records.map((r) => r.status)))).toEqual({
      candidate: 417,
      active: 417,
      superseded: 416,
    })
    // One source type across the fixture: the sourceType facet is a single bar, which is
    // what the "narrowing by it changes nothing" scenarios rely on.
    for (const record of records) {
      expect(record.source, record.id).toEqual({ type: "eval", id: "seed" })
      expect(record.tags, record.id).toEqual([])
      expect(record.data, record.id).toEqual({})
    }
  })
})
