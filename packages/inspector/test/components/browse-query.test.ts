import { describe, expect, it } from "vitest"
import {
  browseMatchesNothing,
  browseSearchParams,
  canonicalBrowseQuery,
  datasetKeyOf,
} from "../../src/browse/canonical-query"

describe("canonicalBrowseQuery", () => {
  it("uses null for unfiltered and keeps an empty set as itself", () => {
    const unfiltered = canonicalBrowseQuery({ view: "list" })
    expect(unfiltered).toEqual({
      view: "list",
      namespace: null,
      status: null,
      kind: null,
      since: null,
    })
    const nothing = canonicalBrowseQuery({ view: "list", status: [] })
    expect(nothing.status).toEqual([])
  })

  it("sorts and dedupes value sets so tick order cannot fork the dataset", () => {
    const a = canonicalBrowseQuery({ view: "list", status: ["superseded", "active", "active"] })
    const b = canonicalBrowseQuery({ view: "list", status: ["active", "superseded"] })
    expect(a.status).toEqual(["active", "superseded"])
    expect(datasetKeyOf(a)).toBe(datasetKeyOf(b))
  })

  it("defaults the timeline view to episodic, and lets the funnel override it", () => {
    expect(canonicalBrowseQuery({ view: "timeline" }).kind).toEqual(["episodic"])
    expect(canonicalBrowseQuery({ view: "timeline", kind: ["semantic"] }).kind).toEqual([
      "semantic",
    ])
    // An emptied funnel still means "matches nothing", not "fall back to episodic".
    expect(canonicalBrowseQuery({ view: "timeline", kind: [] }).kind).toEqual([])
  })

  it("reads an empty namespace as unfiltered, the way the server does", () => {
    const empty = canonicalBrowseQuery({ view: "list", namespace: "" })
    expect(empty.namespace).toBeNull()
    expect(datasetKeyOf(empty)).toBe(datasetKeyOf(canonicalBrowseQuery({ view: "list" })))
  })

  it("freezes value sets, so the shared timeline default cannot be mutated for the process", () => {
    expect(Object.isFrozen(canonicalBrowseQuery({ view: "timeline" }).kind)).toBe(true)
    expect(Object.isFrozen(canonicalBrowseQuery({ view: "list", status: ["active"] }).status)).toBe(
      true,
    )
  })

  it("gives a different key to every identity field", () => {
    const base = canonicalBrowseQuery({ view: "list" })
    const variants = [
      canonicalBrowseQuery({ view: "timeline" }),
      canonicalBrowseQuery({ view: "list", namespace: "route=/notes" }),
      canonicalBrowseQuery({ view: "list", status: ["active"] }),
      canonicalBrowseQuery({ view: "list", kind: ["semantic"] }),
      canonicalBrowseQuery({ view: "list", since: "2026-08-01T00:00:00.000Z" }),
    ]
    for (const variant of variants) {
      expect(datasetKeyOf(variant)).not.toBe(datasetKeyOf(base))
    }
  })
})

describe("browseMatchesNothing", () => {
  it("is true only for a set narrowed to nothing", () => {
    expect(browseMatchesNothing(canonicalBrowseQuery({ view: "list" }))).toBe(false)
    expect(browseMatchesNothing(canonicalBrowseQuery({ view: "list", status: ["active"] }))).toBe(
      false,
    )
    expect(browseMatchesNothing(canonicalBrowseQuery({ view: "list", status: [] }))).toBe(true)
    expect(browseMatchesNothing(canonicalBrowseQuery({ view: "list", kind: [] }))).toBe(true)
  })
})

describe("browseSearchParams", () => {
  it("sends the EXACT namespace, repeated enum params, and the window", () => {
    const params = browseSearchParams(
      canonicalBrowseQuery({
        view: "list",
        namespace: "route=/notes",
        status: ["active", "candidate"],
        kind: ["semantic"],
      }),
      { limit: 200, offset: 400 },
    )
    expect(params.get("namespace")).toBe("route=/notes")
    expect(params.get("namespacePrefix")).toBeNull()
    expect(params.getAll("status")).toEqual(["active", "candidate"])
    expect(params.getAll("kind")).toEqual(["semantic"])
    expect(params.get("limit")).toBe("200")
    expect(params.get("offset")).toBe("400")
  })

  it("omits absent narrowings entirely", () => {
    const params = browseSearchParams(canonicalBrowseQuery({ view: "list" }), {
      limit: 200,
      offset: 0,
    })
    expect(params.get("namespace")).toBeNull()
    expect(params.getAll("status")).toEqual([])
    expect(params.get("since")).toBeNull()
  })

  it("takes the expiry cutoff out of the answer, so one key means one set", () => {
    const params = browseSearchParams(canonicalBrowseQuery({ view: "timeline" }), {
      limit: 200,
      offset: 400,
    })
    expect(params.get("includeExpired")).toBe("1")
    expect(params.get("now")).toBeNull()
  })

  it("refuses a matches-nothing query instead of asking for everything", () => {
    const nothing = canonicalBrowseQuery({ view: "list", status: [] })
    expect(() => browseSearchParams(nothing, { limit: 200, offset: 0 })).toThrow(/matches nothing/)
  })

  it("threads the pinned timeline window bound", () => {
    const params = browseSearchParams(
      canonicalBrowseQuery({ view: "timeline", since: "2026-08-01T00:00:00.000Z" }),
      { limit: 200, offset: 0 },
    )
    expect(params.get("since")).toBe("2026-08-01T00:00:00.000Z")
    expect(params.getAll("kind")).toEqual(["episodic"])
  })
})
