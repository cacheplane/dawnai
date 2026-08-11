import { BROWSE_MAX_LIMIT } from "@dawn-ai/memory/browse"
import { describe, expect, it } from "vitest"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_RESIDENT_CAP,
  dedupeById,
  loadMoreState,
} from "../../src/components/memory/browse-window"

describe("browse window constants", () => {
  it("caps residency at exactly the maximum request limit", () => {
    // The head refresh re-derives the WHOLE resident span in one request. If the
    // cap ever exceeded the max limit, that single request could not cover it and
    // the ≤ one-poll-period convergence guarantee would silently stop holding.
    // Slice 3 declares the cap as a literal 1000, so this equality is the ONLY
    // thing tying it to the route's ceiling — the tie is asserted, not structural.
    expect(BROWSE_RESIDENT_CAP).toBe(BROWSE_MAX_LIMIT)
    expect(BROWSE_RESIDENT_CAP).toBe(1000)
  })

  it("pages in fifths of the cap", () => {
    expect(BROWSE_PAGE_SIZE).toBe(200)
    expect(BROWSE_RESIDENT_CAP % BROWSE_PAGE_SIZE).toBe(0)
  })
})

describe("dedupeById", () => {
  const a = { id: "a", n: 1 }
  const b = { id: "b", n: 2 }
  const bAgain = { id: "b", n: 99 }
  const c = { id: "c", n: 3 }

  it("appends records that are new", () => {
    expect(dedupeById([a], [b, c])).toEqual([a, b, c])
  })

  it("drops an appended record whose id is already resident, keeping the resident copy", () => {
    // A keyset walk can re-emit one row when a sort-key edit crosses the cursor
    // downward. The resident copy stays because it holds the position the grid
    // already rendered; the refresh tick is what repairs a stale payload.
    expect(dedupeById([a, b], [bAgain, c])).toEqual([a, b, c])
  })

  it("de-duplicates within the appended page as well", () => {
    expect(dedupeById([], [b, bAgain, c])).toEqual([b, c])
  })

  it("returns the resident array itself when the page adds nothing", () => {
    const resident = [a, b]
    expect(dedupeById(resident, [bAgain])).toBe(resident)
  })
})

describe("loadMoreState", () => {
  it("offers a load while a continuation exists and the cap is clear", () => {
    expect(loadMoreState({ phase: "idle", loaded: 200, hasMore: true })).toBe("available")
  })

  it("reports exhaustion when the server issued no continuation", () => {
    expect(loadMoreState({ phase: "idle", loaded: 137, hasMore: false })).toBe("exhausted")
  })

  it("reports the cap even when more rows exist server-side", () => {
    expect(loadMoreState({ phase: "idle", loaded: 1000, hasMore: true })).toBe("at-cap")
  })

  it("is busy while a tail extension is in flight", () => {
    expect(loadMoreState({ phase: "loading-more", loaded: 200, hasMore: true })).toBe("loading")
  })

  it("is unavailable while the visible rows answer a previous query", () => {
    // Extending a window that is about to be replaced spends a request on a
    // dataset the user has already left.
    expect(loadMoreState({ phase: "stale", loaded: 200, hasMore: true })).toBe("unavailable")
    expect(loadMoreState({ phase: "loading", loaded: 0, hasMore: false })).toBe("unavailable")
    expect(loadMoreState({ phase: "error", loaded: 200, hasMore: true })).toBe("unavailable")
  })

  it("allows a load during a background refresh — the hook queues it", () => {
    expect(loadMoreState({ phase: "refreshing", loaded: 200, hasMore: true })).toBe("available")
  })
})
