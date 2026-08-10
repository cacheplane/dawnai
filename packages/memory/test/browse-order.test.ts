import { describe, expect, it } from "vitest"
import { DEFAULT_BROWSE_ORDER, resolveBrowseOrder } from "../src/browse-order.js"

describe("resolveBrowseOrder", () => {
  it("defaults to updated_at DESC when orderBy is absent or empty", () => {
    expect(resolveBrowseOrder()).toEqual(DEFAULT_BROWSE_ORDER)
    expect(resolveBrowseOrder([])).toEqual(DEFAULT_BROWSE_ORDER)
    expect(DEFAULT_BROWSE_ORDER).toEqual([
      { field: "updatedAt", column: "updated_at", dir: "desc", numeric: false, collateC: false },
    ])
  })
  it("maps every whitelisted field to its physical column", () => {
    expect(
      resolveBrowseOrder([
        { field: "confidence", dir: "desc" },
        { field: "namespace", dir: "asc" },
        { field: "createdAt", dir: "asc" },
      ]),
    ).toEqual([
      { field: "confidence", column: "confidence", dir: "desc", numeric: true, collateC: false },
      { field: "namespace", column: "namespace", dir: "asc", numeric: false, collateC: true },
      { field: "createdAt", column: "created_at", dir: "asc", numeric: false, collateC: false },
    ])
  })
  it('marks only namespace as needing COLLATE "C" — timestamps must stay uncollated so the (updated_at DESC, id ASC) index is still usable', () => {
    expect(resolveBrowseOrder([{ field: "updatedAt", dir: "desc" }])[0]?.collateC).toBe(false)
    expect(resolveBrowseOrder([{ field: "status", dir: "asc" }])[0]?.collateC).toBe(false)
    expect(resolveBrowseOrder([{ field: "kind", dir: "asc" }])[0]?.collateC).toBe(false)
  })
  it("throws rather than passing an unknown field through to SQL", () => {
    expect(() => resolveBrowseOrder([{ field: "content" as never, dir: "asc" }])).toThrow(
      /unknown sort field "content"/,
    )
  })
})
