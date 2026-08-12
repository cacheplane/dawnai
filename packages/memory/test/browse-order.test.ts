import { describe, expect, it } from "vitest"
import {
  DEFAULT_BROWSE_ORDER,
  type ResolvedBrowseSort,
  resolveBrowseOrder,
} from "../src/browse-order.js"

describe("resolveBrowseOrder", () => {
  it("defaults to updated_at DESC when orderBy is absent or empty", () => {
    expect(resolveBrowseOrder()).toEqual(DEFAULT_BROWSE_ORDER)
    expect(resolveBrowseOrder([])).toEqual(DEFAULT_BROWSE_ORDER)
    expect(DEFAULT_BROWSE_ORDER).toEqual([
      { field: "updatedAt", column: "updated_at", dir: "desc", numeric: false, collateC: false },
    ])
    // Both spellings of the same logical sort must resolve identically: a cursor minted
    // under the default and continued under the explicit form compares the same column
    // under the same collation, or keyset pagination silently skips rows.
    expect(DEFAULT_BROWSE_ORDER).toEqual(resolveBrowseOrder([{ field: "updatedAt", dir: "desc" }]))
  })
  it("hands back a default no caller can corrupt for the rest of the process", () => {
    // resolveBrowseOrder() returns the singleton itself, so a store appending its
    // `id ASC` tie-break in place would rewrite the default for every later query.
    expect(() =>
      (resolveBrowseOrder() as ResolvedBrowseSort[]).push(...DEFAULT_BROWSE_ORDER),
    ).toThrow(TypeError)
    const entry = resolveBrowseOrder()[0] as { dir: string }
    expect(() => {
      entry.dir = "asc"
    }).toThrow(TypeError)
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
  it("throws rather than leaving each dialect to interpret an unknown direction", () => {
    expect(() => resolveBrowseOrder([{ field: "updatedAt", dir: "desc, id" as never }])).toThrow(
      /sort direction must be "asc" or "desc"/,
    )
  })
})
