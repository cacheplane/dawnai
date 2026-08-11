import type { MemoryRecord } from "@dawn-ai/memory/browse"
import { describe, expect, it } from "vitest"
import {
  BROWSE_RESIDENT_CAP,
  type BrowseEvent,
  type BrowseState,
  browseHasMore,
  browsePhase,
  browseReduce,
  INITIAL_BROWSE_STATE,
} from "../../src/browse/browse-machine"
import { type LoadMoreState, loadMoreState } from "../../src/components/memory/browse-window"

describe("loadMoreState", () => {
  it("offers a load while the server holds rows this client has not, and the cap is clear", () => {
    expect(loadMoreState({ phase: "idle", loaded: 200, hasMore: true })).toBe("available")
  })

  it("reports exhaustion once the loaded rows ARE the whole matching set", () => {
    expect(loadMoreState({ phase: "idle", loaded: 137, hasMore: false })).toBe("exhausted")
  })

  it("reports the cap even when more rows exist server-side", () => {
    expect(loadMoreState({ phase: "idle", loaded: BROWSE_RESIDENT_CAP, hasMore: true })).toBe(
      "at-cap",
    )
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

  it("allows a load during a background refresh — the machine queues it", () => {
    expect(loadMoreState({ phase: "refreshing", loaded: 200, hasMore: true })).toBe("available")
  })
})

describe("loadMoreState against the machine that answers the click", () => {
  function record(id: string): MemoryRecord {
    return {
      id,
      kind: "semantic",
      namespace: "route=/notes",
      content: `content ${id}`,
      data: {},
      source: { type: "tool", id: "remember" },
      confidence: 0.5,
      tags: [],
      status: "active",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }
  }

  function rows(count: number): MemoryRecord[] {
    return Array.from({ length: count }, (_, i) => record(`r${i}`))
  }

  function apply(state: BrowseState, ...events: BrowseEvent[]): BrowseState {
    let next = state
    for (const event of events) next = browseReduce(next, event).state
    return next
  }

  // Shaped like `datasetKeyOf` actually emits — seven members since `filters` and
  // `orderBy` joined the identity. The machine only ever compares these for equality,
  // so the shape buys realism rather than coverage.
  const KEY_A = '["list",null,null,null,null,null,null]'
  const KEY_B = '["list","route=/notes",null,null,null,null,null]'

  /** `continuation` decides `browseHasMore`, so it is what puts a state on one side or
   *  the other of the footer's "exhausted" branch — the counts no longer do. */
  function fulfilledWith(
    count: number,
    total: number,
    continuation: string | null = "cur-1",
  ): BrowseState {
    return apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      {
        type: "response",
        revision: 1,
        kind: "initial",
        page: { records: rows(count), total, continuation },
        at: 1,
      },
    )
  }

  const partial = fulfilledWith(200, 5432)
  const states: Readonly<Record<string, BrowseState>> = {
    partial,
    complete: fulfilledWith(137, 137, null),
    atCap: fulfilledWith(BROWSE_RESIDENT_CAP, 5432),
    refreshing: apply(partial, { type: "poll-tick" }),
    queued: apply(partial, { type: "poll-tick" }, { type: "load-more-requested" }),
    loadingMore: apply(partial, { type: "load-more-requested" }),
    stale: apply(partial, { type: "query-changed", datasetKey: KEY_B }),
    errored: apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      { type: "failure", revision: 1, kind: "initial", message: "boom" },
    ),
  }

  /** The three values `useMemoryBrowse` publishes, derived from ONE state exactly as it
   *  derives them. Feeding the function anything else makes the assertions below a
   *  statement about literals rather than about the control's real inputs. */
  function footerInput(state: BrowseState) {
    return {
      phase: browsePhase(state),
      loaded: state.fulfilled?.records.length ?? 0,
      hasMore: browseHasMore(state),
    }
  }

  /** The machine ACTS on a click when it starts the request or holds the intent for the
   *  tick in flight. Neither one leaves a trace the footer reads, so a refusal here is
   *  a click that vanishes: no state change, no error slot, no phase change. */
  function actsOnLoadMore(state: BrowseState): boolean {
    const transition = browseReduce(state, { type: "load-more-requested" })
    return transition.start !== null || transition.state.queuedLoadMore
  }

  it("offers a load exactly when the machine acts on the click", () => {
    // The render gate (`=== "available"`) and the request gate (`browseCanLoadMore`,
    // plus single flight) are two implementations of one decision. Nothing but this
    // crosses between them.
    for (const [label, state] of Object.entries(states)) {
      expect({ label, offers: loadMoreState(footerInput(state)) === "available" }).toEqual({
        label,
        offers: actsOnLoadMore(state),
      })
    }
  })

  it("reaches every load-more state from a real machine state", () => {
    // Without this the agreement above would also hold for a fixture set that never
    // reaches "available" — or never leaves it.
    const reached = new Set(Object.values(states).map((state) => loadMoreState(footerInput(state))))
    expect(reached).toEqual(
      new Set<LoadMoreState>(["available", "loading", "exhausted", "at-cap", "unavailable"]),
    )
  })
})
