import { BROWSE_SORT_FIELDS, validateBrowseQuery } from "@dawn-ai/memory/browse"
import type { ColumnFilter, PretableSortEntry } from "@pretable/react"
import { describe, expect, it } from "vitest"
import {
  capSortEntries,
  intentRefusalMessage,
  MAX_BROWSE_SORT_ENTRIES,
  toBrowseQuery,
} from "../../src/components/memory/to-browse-query"

const noSort: PretableSortEntry[] = []

function filters(map: Record<string, ColumnFilter>) {
  return toBrowseQuery(map, noSort)
}

describe("toBrowseQuery — enum columns", () => {
  it("maps isAnyOf to in", () => {
    expect(filters({ status: { operator: "isAnyOf", value: ["candidate", "active"] } })).toEqual({
      filters: [{ field: "status", op: "in", values: ["candidate", "active"] }],
    })
  })

  it("maps isNoneOf to notIn without complementing the set", () => {
    // The excluded value is carried through as-is. Complementing it against the
    // full option list would answer a different question once a kind is added
    // upstream: the unlisted one would silently join the permitted set.
    expect(filters({ kind: { operator: "isNoneOf", value: ["episodic"] } })).toEqual({
      filters: [{ field: "kind", op: "notIn", values: ["episodic"] }],
    })
  })

  it("throws on a value outside the declared universe", () => {
    expect(() => filters({ status: { operator: "isAnyOf", value: ["actve"] } })).toThrow(
      /"actve" is not a memory status/,
    )
  })

  it("throws on an empty value list", () => {
    // Pretable deletes an inactive filter, so an empty list can only be a bug —
    // and the store rejects it with a 400 rather than reading it as unfiltered.
    expect(() => filters({ status: { operator: "isAnyOf", value: [] } })).toThrow(
      /non-empty value list/,
    )
  })
})

describe("toBrowseQuery — text columns", () => {
  it("maps every content operator one to one", () => {
    const ops = [
      ["contains", "contains"],
      ["notContains", "notContains"],
      ["equals", "equals"],
      ["notEquals", "notEquals"],
      ["startsWith", "startsWith"],
      ["endsWith", "endsWith"],
    ] as const
    for (const [pretable, browse] of ops) {
      expect(filters({ content: { operator: pretable, value: "acme" } })).toEqual({
        filters: [{ field: "content", op: browse, value: "acme" }],
      })
    }
  })

  it("keeps whitespace inside a content value — it is significant", () => {
    expect(filters({ content: { operator: "contains", value: " acme " } })).toEqual({
      filters: [{ field: "content", op: "contains", value: " acme " }],
    })
  })

  it("maps the namespace column's two operators", () => {
    expect(filters({ namespace: { operator: "startsWith", value: "route=/" } })).toEqual({
      filters: [{ field: "namespace", op: "startsWith", value: "route=/" }],
    })
    expect(filters({ namespace: { operator: "equals", value: "route=/notes" } })).toEqual({
      filters: [{ field: "namespace", op: "equals", value: "route=/notes" }],
    })
  })

  it("throws when the namespace column is handed a content-only operator", () => {
    expect(() => filters({ namespace: { operator: "contains", value: "notes" } })).toThrow(
      /operator "contains" on column "namespace"/,
    )
  })
})

describe("toBrowseQuery — confidence", () => {
  it("renames the comparison operators to the store's spelling", () => {
    const ops = [
      ["equals", "eq"],
      ["notEquals", "neq"],
      ["gt", "gt"],
      ["gte", "gte"],
      ["lt", "lt"],
      ["lte", "lte"],
    ] as const
    for (const [pretable, browse] of ops) {
      expect(filters({ confidence: { operator: pretable, value: 0.5 } })).toEqual({
        filters: [{ field: "confidence", op: browse, value: 0.5 }],
      })
    }
  })

  it("splits a between range into min and max", () => {
    expect(filters({ confidence: { operator: "between", value: [0.25, 0.75] } })).toEqual({
      filters: [{ field: "confidence", op: "between", min: 0.25, max: 0.75 }],
    })
  })

  it("throws on a non-numeric confidence operand", () => {
    expect(() => filters({ confidence: { operator: "gt", value: "high" } })).toThrow(
      /finite number/,
    )
  })
})

describe("toBrowseQuery — updated", () => {
  it("maps the day operators", () => {
    const ops = [
      ["on", "onDay"],
      ["before", "beforeDay"],
      ["after", "afterDay"],
    ] as const
    for (const [pretable, browse] of ops) {
      expect(filters({ updated: { operator: pretable, value: "2026-08-09" } })).toEqual({
        filters: [{ field: "updatedAt", op: browse, day: "2026-08-09" }],
      })
    }
  })

  it("maps dateBetween to an inclusive day range", () => {
    expect(
      filters({ updated: { operator: "dateBetween", value: ["2026-08-01", "2026-08-09"] } }),
    ).toEqual({
      filters: [
        { field: "updatedAt", op: "betweenDays", fromDay: "2026-08-01", untilDay: "2026-08-09" },
      ],
    })
  })

  it("throws on a value the date input could not have produced", () => {
    expect(() =>
      filters({ updated: { operator: "on", value: "2026-08-09T12:00:00.000Z" } }),
    ).toThrow(/"YYYY-MM-DD" day/)
  })
})

describe("toBrowseQuery — refusals", () => {
  it("throws on isEmpty and isNotEmpty rather than dropping them", () => {
    // No BrowseFilter arm expresses them, every browse field is NOT NULL, and a
    // silent drop is exactly the active-looking-but-ignored control this design
    // exists to kill. The column's filterOperators keep them off the menu; this
    // throw is the backstop that makes a menu regression loud.
    expect(() => filters({ content: { operator: "isEmpty" } })).toThrow(
      /operator "isEmpty" on column "content"/,
    )
    expect(() => filters({ confidence: { operator: "isNotEmpty" } })).toThrow(
      /operator "isNotEmpty" on column "confidence"/,
    )
  })

  it("throws on a column with no server predicate at all", () => {
    expect(() => filters({ tags: { operator: "contains", value: "x" } })).toThrow(
      /column "tags" has no browse filter field/,
    )
  })
})

/**
 * A refusal has TWO audiences and therefore two strings: the developer half names
 * the column, operator and value for the log, and the user half is the sentence the
 * page renders. Neither may stand in for the other — the developer half quotes the
 * value through `JSON.stringify`, which renders the `Infinity` pretable parses out
 * of a typed `1e999` as the literal `null`, and putting that on screen shows the
 * user a value they never entered.
 */
describe("toBrowseQuery — refusals speak to both audiences", () => {
  function refusalFrom(run: () => unknown): { user: string; developer: string } {
    try {
      run()
    } catch (error) {
      const user = intentRefusalMessage(error)
      if (user === undefined) throw new Error(`refusal carries no user-facing half: ${error}`)
      return { user, developer: error instanceof Error ? error.message : String(error) }
    }
    throw new Error("expected a refusal, got a mapped query")
  }

  it("names the confidence box and not the value the mapping saw", () => {
    // The exact pair, pinned. `1e999` is what the user types; `Infinity` is what
    // pretable's free-text number funnel hands the mapping; `null` is what
    // `JSON.stringify` makes of it. Only the last of those three is unfit to show,
    // and it is the one the single string used to carry.
    const { user, developer } = refusalFrom(() =>
      filters({ confidence: { operator: "gt", value: Number.POSITIVE_INFINITY } }),
    )
    expect(user).toBe("That confidence value is out of range, so the filter was not applied.")
    expect(developer).toBe(
      "cannot map grid intent to a browse query: confidence value needs a finite number, got null",
    )
  })

  it("says SORT, not filter, when it is a sort key being declined", () => {
    // One notice renders both, so the sentence has to name the control that did
    // nothing. A fixed "that filter was not applied" lead-in reads as a lie here.
    const { user } = refusalFrom(() =>
      toBrowseQuery({}, [{ columnId: "content", direction: "asc" }]),
    )
    expect(user).toBe("That column cannot be sorted, so the sort was not applied.")
  })

  /** Every refusal site in the module, so a new one cannot ship with only half its
   *  audience served — the user half is a required constructor argument, but nothing
   *  else stops it being filled with the developer's wording. */
  const SITES: [string, () => unknown][] = [
    ["column with no filter field", () => filters({ tags: { operator: "contains", value: "x" } })],
    ["operator with no arm", () => filters({ content: { operator: "isEmpty" } })],
    ["set operator on an enum", () => filters({ status: { operator: "contains", value: "x" } })],
    ["empty text value", () => filters({ content: { operator: "contains", value: "   " } })],
    ["non-finite confidence", () => filters({ confidence: { operator: "gt", value: 1 / 0 } })],
    [
      "non-finite confidence minimum",
      () => filters({ confidence: { operator: "between", value: [1 / 0, 1] } }),
    ],
    [
      "non-finite confidence maximum",
      () => filters({ confidence: { operator: "between", value: [0, 1 / 0] } }),
    ],
    ["malformed day", () => filters({ updated: { operator: "on", value: "13/07/2026" } })],
    [
      "malformed day range",
      () => filters({ updated: { operator: "dateBetween", value: ["nope", "2026-07-13"] } }),
    ],
    // A `between` carrying ONE operand instead of two. Spelled as a bare number
    // because pretable's `FilterValue` has no one-element array member — a
    // shorter list is not a shape the type can even express.
    ["half a range", () => filters({ confidence: { operator: "between", value: 0.5 } })],
    ["empty value list", () => filters({ status: { operator: "isAnyOf", value: [] } })],
    [
      "non-string in a value list",
      () => filters({ kind: { operator: "isAnyOf", value: [1, 2] as const } }),
    ],
    ["unknown status", () => filters({ status: { operator: "isAnyOf", value: ["actve"] } })],
    ["unknown kind", () => filters({ kind: { operator: "isAnyOf", value: ["semanic"] } })],
    [
      "past the sort ceiling",
      () =>
        toBrowseQuery(
          {},
          ["status", "kind", "namespace", "confidence"].map((columnId) => ({
            columnId,
            direction: "asc" as const,
          })),
        ),
    ],
    ["unsortable column", () => toBrowseQuery({}, [{ columnId: "content", direction: "asc" }])],
  ]

  it.each(SITES)("gives %s a sentence fit to render", (_name, run) => {
    const { user, developer } = refusalFrom(run)
    // A whole sentence about the control, ending in what it did: nothing.
    expect(user).toMatch(/^[A-Z].* was not applied\.$/)
    // Nothing from this repo's vocabulary, and nothing from `JSON.stringify` — the
    // `null` in particular is a value no user ever typed.
    expect(user).not.toMatch(/grid intent|browse query|BrowseFilter|orderBy|operand|arm\b/)
    expect(user).not.toMatch(/null|undefined|NaN|Infinity|"/)
    // The specific half survives for the log — that is the whole point of splitting.
    expect(developer).toContain("cannot map grid intent to a browse query: ")
  })

  it("reports no user half for anything that is not one of these refusals", () => {
    // The page falls back to generic copy on this, so a wrong answer here would put
    // a raw internal message on screen — exactly what the split exists to prevent.
    expect(intentRefusalMessage(new Error("boom"))).toBeUndefined()
    expect(intentRefusalMessage(undefined)).toBeUndefined()
    expect(intentRefusalMessage({ userMessage: 7 })).toBeUndefined()
  })
})

describe("toBrowseQuery — composition", () => {
  it("omits both keys when there is no intent", () => {
    expect(toBrowseQuery({}, noSort)).toEqual({})
  })

  it("emits filters in a deterministic column order regardless of insertion order", () => {
    const a = toBrowseQuery(
      {
        status: { operator: "isAnyOf", value: ["active"] },
        kind: { operator: "isAnyOf", value: ["semantic"] },
      },
      noSort,
    )
    const b = toBrowseQuery(
      {
        kind: { operator: "isAnyOf", value: ["semantic"] },
        status: { operator: "isAnyOf", value: ["active"] },
      },
      noSort,
    )
    expect(a).toEqual(b)
    expect(a.filters?.map((f) => f.field)).toEqual(["kind", "status"])
  })
})

describe("toBrowseQuery — sort", () => {
  it("maps the column ids to sort fields, keeping priority order", () => {
    expect(
      toBrowseQuery({}, [
        { columnId: "confidence", direction: "desc" },
        { columnId: "updated", direction: "asc" },
      ]),
    ).toEqual({
      orderBy: [
        { field: "confidence", dir: "desc" },
        { field: "updatedAt", dir: "asc" },
      ],
    })
  })

  it("throws for the content column, which the whitelist has no field for", () => {
    expect(() => toBrowseQuery({}, [{ columnId: "content", direction: "asc" }])).toThrow(
      /column "content" is not a sortable browse field/,
    )
  })

  it("throws above the validator's orderBy ceiling", () => {
    const four: PretableSortEntry[] = [
      { columnId: "status", direction: "asc" },
      { columnId: "kind", direction: "asc" },
      { columnId: "namespace", direction: "asc" },
      { columnId: "confidence", direction: "asc" },
    ]
    expect(() => toBrowseQuery({}, four)).toThrow(/at most 3 sort columns/)
  })
})

describe("capSortEntries", () => {
  it("keeps the highest-priority entries and drops the excess", () => {
    const four: PretableSortEntry[] = [
      { columnId: "status", direction: "asc" },
      { columnId: "kind", direction: "asc" },
      { columnId: "namespace", direction: "asc" },
      { columnId: "confidence", direction: "asc" },
    ]
    expect(capSortEntries(four)).toEqual(four.slice(0, 3))
  })

  it("caps at exactly the ceiling the store enforces", () => {
    // MAX_BROWSE_SORT_ENTRIES restates browse-validate's MAX_ORDER_BY, which is not
    // exported. Pinned against the validator rather than the literal 3: were the
    // store's ceiling raised, a literal would leave capSortEntries dropping a key the
    // store would have accepted, and nothing would be red to say so.
    const entries = BROWSE_SORT_FIELDS.map((field) => ({ field, dir: "asc" }) as const)
    expect(() =>
      validateBrowseQuery({ orderBy: entries.slice(0, MAX_BROWSE_SORT_ENTRIES) }),
    ).not.toThrow()
    expect(() =>
      validateBrowseQuery({ orderBy: entries.slice(0, MAX_BROWSE_SORT_ENTRIES + 1) }),
    ).toThrow(/orderBy entries/)
  })

  it("hands back the very same array when nothing needs dropping", () => {
    // Identity, not deep equality: the result feeds a memo/effect dep chain, and a
    // fresh array on every render re-fires the query for a sort that never changed.
    const under: PretableSortEntry[] = [{ columnId: "status", direction: "asc" }]
    expect(capSortEntries(under)).toBe(under)
  })
})
