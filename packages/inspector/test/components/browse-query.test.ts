import type { BrowseFilter, BrowseSortEntry } from "@dawn-ai/memory/browse"
import { describe, expect, it } from "vitest"
import {
  browseMatchesNothing,
  browseSearchParams,
  canonicalBrowseQuery,
  datasetKeyOf,
} from "../../src/browse/canonical-query"
import { parseBrowseQuery } from "../../src/store/browse-params"

const STATUS_IN_ACTIVE: BrowseFilter = { field: "status", op: "in", values: ["active"] }
const KIND_IN_EPISODIC: BrowseFilter = { field: "kind", op: "in", values: ["episodic"] }
const CONFIDENCE_DESC: BrowseSortEntry = { field: "confidence", dir: "desc" }

describe("canonicalBrowseQuery", () => {
  it("uses null for unfiltered and keeps an empty set as itself", () => {
    const unfiltered = canonicalBrowseQuery({ view: "list" })
    expect(unfiltered).toEqual({
      view: "list",
      namespace: null,
      status: null,
      kind: null,
      since: null,
      filters: null,
      orderBy: null,
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

  it("pivots the key on the predicate and on the order, which decide the answer too", () => {
    // Without this the pivot never fires for a funnel or a header click: the grid
    // would keep a selection made under one question while the rows underneath it
    // answered another — the exact corruption `datasetKey` exists to prevent.
    const base = canonicalBrowseQuery({ view: "list" })
    const filtered = canonicalBrowseQuery({ view: "list", filters: [STATUS_IN_ACTIVE] })
    const ordered = canonicalBrowseQuery({ view: "list", orderBy: [CONFIDENCE_DESC] })
    expect(datasetKeyOf(filtered)).not.toBe(datasetKeyOf(base))
    expect(datasetKeyOf(ordered)).not.toBe(datasetKeyOf(base))
    expect(datasetKeyOf(filtered)).not.toBe(datasetKeyOf(ordered))
    // Same field, same value, different OPERATOR — a different answer.
    expect(datasetKeyOf(filtered)).not.toBe(
      datasetKeyOf(
        canonicalBrowseQuery({
          view: "list",
          filters: [{ field: "status", op: "notIn", values: ["active"] }],
        }),
      ),
    )
  })

  it("keeps ONE key for two equal predicates, so a re-render is not a new dataset", () => {
    const rebuilt = canonicalBrowseQuery({
      view: "list",
      filters: [{ field: "status", op: "in", values: ["active"] }],
      orderBy: [{ field: "confidence", dir: "desc" }],
    })
    const held = canonicalBrowseQuery({
      view: "list",
      filters: [STATUS_IN_ACTIVE],
      orderBy: [CONFIDENCE_DESC],
    })
    expect(datasetKeyOf(rebuilt)).toBe(datasetKeyOf(held))
  })

  it("orders predicates by field, so a second producer cannot fork the key", () => {
    // The grid is not the only producer for long — a restored URL, a resumed cursor,
    // a test helper — and each builds its predicate list in whatever order it walks.
    // Canonicalizing here rather than trusting every caller is what stops one
    // question minting two datasets and pivoting a selection nobody changed.
    const kindFirst = canonicalBrowseQuery({
      view: "list",
      filters: [KIND_IN_EPISODIC, STATUS_IN_ACTIVE],
    })
    const statusFirst = canonicalBrowseQuery({
      view: "list",
      filters: [STATUS_IN_ACTIVE, KIND_IN_EPISODIC],
    })
    expect(statusFirst.filters).toEqual([KIND_IN_EPISODIC, STATUS_IN_ACTIVE])
    expect(datasetKeyOf(statusFirst)).toBe(datasetKeyOf(kindFirst))
  })

  it("pivots on orderBy ORDER — sort priority decides the answer, unlike a value set", () => {
    const a = canonicalBrowseQuery({
      view: "list",
      orderBy: [CONFIDENCE_DESC, { field: "status", dir: "asc" }],
    })
    const b = canonicalBrowseQuery({
      view: "list",
      orderBy: [{ field: "status", dir: "asc" }, CONFIDENCE_DESC],
    })
    expect(datasetKeyOf(a)).not.toBe(datasetKeyOf(b))
  })

  it("reads an empty predicate list as absent, so an emptied funnel is not a new dataset", () => {
    const emptied = canonicalBrowseQuery({ view: "list", filters: [], orderBy: [] })
    expect(emptied.filters).toBeNull()
    expect(emptied.orderBy).toBeNull()
    expect(datasetKeyOf(emptied)).toBe(datasetKeyOf(canonicalBrowseQuery({ view: "list" })))
  })

  it("drops the timeline kind default once a predicate claims the field", () => {
    // Both narrowings reach the server as an AND, so leaving the default on beside a
    // `kind` predicate would answer "episodic AND semantic" — nothing — under a
    // funnel that reads as applied.
    const claimed = canonicalBrowseQuery({
      view: "timeline",
      filters: [{ field: "kind", op: "in", values: ["semantic"] }],
    })
    expect(claimed.kind).toBeNull()
    const unclaimed = canonicalBrowseQuery({ view: "timeline", filters: [STATUS_IN_ACTIVE] })
    expect(unclaimed.kind).toEqual(["episodic"])
  })

  it("keeps the timeline kind default beside an EXCLUDING kind predicate", () => {
    // The stand-down is justified by the AND collapsing, and only `in` collapses:
    // `episodic AND NOT reflection` is a non-empty set of EPISODES. Standing down
    // for `notIn` instead widens the timeline to every kind the funnel did not
    // exclude, while every row still renders as "Open episode:" and the empty state
    // still says "No episodes in this window."
    const excluded = canonicalBrowseQuery({
      view: "timeline",
      filters: [{ field: "kind", op: "notIn", values: ["reflection"] }],
    })
    expect(excluded.kind).toEqual(["episodic"])
  })

  it("lets an excluding predicate empty the timeline when it excludes episodes", () => {
    // "Episodes that are not episodes" is empty, and saying so is the honest answer —
    // the alternative is dropping one of the two narrowings the user can see applied.
    const contradiction = canonicalBrowseQuery({
      view: "timeline",
      filters: [{ field: "kind", op: "notIn", values: ["episodic"] }],
    })
    expect(contradiction.kind).toEqual(["episodic"])
    expect(contradiction.filters).toEqual([{ field: "kind", op: "notIn", values: ["episodic"] }])
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

  it("sends predicates and order as the JSON params the route already parses", () => {
    const params = browseSearchParams(
      canonicalBrowseQuery({
        view: "list",
        filters: [STATUS_IN_ACTIVE],
        orderBy: [CONFIDENCE_DESC],
      }),
      { limit: 200, offset: 0 },
    )
    expect(JSON.parse(params.get("filters") ?? "null")).toEqual([
      { field: "status", op: "in", values: ["active"] },
    ])
    expect(JSON.parse(params.get("orderBy") ?? "null")).toEqual([
      { field: "confidence", dir: "desc" },
    ])
    // One grammar per field: the shorthand is not ALSO sent, or the server would AND
    // two narrowings of the same field for one funnel.
    expect(params.getAll("status")).toEqual([])
  })

  it("omits both when the grid asked for neither", () => {
    const params = browseSearchParams(canonicalBrowseQuery({ view: "list" }), {
      limit: 200,
      offset: 0,
    })
    expect(params.get("filters")).toBeNull()
    expect(params.get("orderBy")).toBeNull()
  })

  it("emits params the store's own parser accepts", () => {
    // These two are the halves of ONE wire format, and only the parser runs the
    // validator. A shape invented on this side would otherwise surface as a 400 at
    // runtime and nowhere in these tests.
    const params = browseSearchParams(
      canonicalBrowseQuery({
        view: "timeline",
        namespace: "route=/notes",
        filters: [STATUS_IN_ACTIVE, { field: "confidence", op: "between", min: 0.1, max: 0.9 }],
        orderBy: [CONFIDENCE_DESC],
        since: "2026-08-01T00:00:00.000Z",
      }),
      { limit: 200, offset: 400 },
    )
    expect(parseBrowseQuery(params, {})).toEqual({
      namespace: "route=/notes",
      kind: ["episodic"],
      since: "2026-08-01T00:00:00.000Z",
      // Field order, not argument order — the canonical form sorts predicates, and
      // the parser hands back what it was sent.
      filters: [{ field: "confidence", op: "between", min: 0.1, max: 0.9 }, STATUS_IN_ACTIVE],
      orderBy: [CONFIDENCE_DESC],
      limit: 200,
      offset: 400,
    })
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
