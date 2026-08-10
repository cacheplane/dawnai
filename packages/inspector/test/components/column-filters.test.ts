import { describe, expect, it } from "vitest"
import { resolveFilter, toFilter } from "../../src/components/memory/column-filters"

const STATUSES = ["candidate", "active", "superseded"] as const

describe("resolveFilter", () => {
  it("is unfiltered when the column has no filter", () => {
    expect(resolveFilter(undefined, STATUSES)).toBeUndefined()
  })

  it("keeps the ticked values for isAnyOf", () => {
    expect(
      resolveFilter({ operator: "isAnyOf", value: ["candidate", "active"] }, STATUSES),
    ).toEqual(["candidate", "active"])
  })

  it("turns isNoneOf into the complement, so the store needs no negation", () => {
    expect(resolveFilter({ operator: "isNoneOf", value: ["candidate"] }, STATUSES)).toEqual([
      "active",
      "superseded",
    ])
  })

  it("treats an explicitly empty set as matching nothing, not everything", () => {
    // The distinction the store draws: [] is a filter, undefined is no filter.
    // The grid drops an emptied checklist before it gets here (an inactive
    // filter), so this guards the operators that do mean "nothing" — and any
    // caller that hands the set in directly.
    expect(resolveFilter({ operator: "isAnyOf", value: [] }, STATUSES)).toEqual([])
  })

  it("ignores values that are not options on this column", () => {
    expect(resolveFilter({ operator: "isAnyOf", value: ["candidate", "bogus"] }, STATUSES)).toEqual(
      ["candidate"],
    )
  })

  it("reads isEmpty as matching nothing and isNotEmpty as unfiltered", () => {
    // These are offered for every column type but degenerate on a non-nullable
    // enum: nothing is empty, everything is non-empty.
    expect(resolveFilter({ operator: "isEmpty" }, STATUSES)).toEqual([])
    expect(resolveFilter({ operator: "isNotEmpty" }, STATUSES)).toBeUndefined()
  })

  it("leaves a text-style operator unfiltered rather than guessing", () => {
    expect(resolveFilter({ operator: "contains", value: "cand" }, STATUSES)).toBeUndefined()
  })
})

describe("toFilter", () => {
  it("shows no funnel state when unfiltered", () => {
    expect(toFilter(undefined, STATUSES)).toBeUndefined()
  })

  it("shows no funnel state when every option is selected", () => {
    // All-of-them and no-filter are the same view; keeping the funnel lit would
    // suggest a narrowing that isn't there.
    expect(toFilter(["candidate", "active", "superseded"], STATUSES)).toBeUndefined()
  })

  it("round-trips a narrowed set", () => {
    const set = ["candidate", "superseded"] as const
    const filter = toFilter(set, STATUSES)
    expect(filter).toEqual({ operator: "isAnyOf", value: ["candidate", "superseded"] })
    expect(resolveFilter(filter, STATUSES)).toEqual(set)
  })

  it("round-trips the match-nothing set", () => {
    expect(resolveFilter(toFilter([], STATUSES), STATUSES)).toEqual([])
  })
})
