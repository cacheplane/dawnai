import { BROWSE_MAX_LIMIT, type MemoryRecord } from "@dawn-ai/memory/browse"
import { describe, expect, it } from "vitest"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_RESIDENT_CAP,
  type BrowseEvent,
  type BrowseState,
  browseCanLoadMore,
  browseDataState,
  browsePhase,
  browseReduce,
  INITIAL_BROWSE_STATE,
} from "../../src/browse/browse-machine"

function record(id: string, updatedAt = "2026-08-01T00:00:00.000Z"): MemoryRecord {
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
    updatedAt,
  }
}

/** Rows in the default browse order — `updatedAt` DESCENDS as the index rises, so a
 *  generated window agrees with the order the reconciler compares spans in. */
function rows(count: number, from = 0): MemoryRecord[] {
  return Array.from({ length: count }, (_, i) =>
    record(`r${from + i}`, new Date(Date.UTC(2026, 7, 1) - (from + i) * 60_000).toISOString()),
  )
}

/** Rows a day newer than every `rows()` row: a refresh window made entirely of head
 *  inserts, which is what pushes residents past the span rule 3 retains. */
function inserted(count: number): MemoryRecord[] {
  return Array.from({ length: count }, (_, i) =>
    record(`n${i}`, new Date(Date.UTC(2026, 7, 2) - i * 60_000).toISOString()),
  )
}

/** Apply a list of events, returning the final state. Mirrors what the hook does:
 *  it feeds the reducer's `state` back in and ignores `start`/`abort`. */
function apply(state: BrowseState, ...events: BrowseEvent[]): BrowseState {
  let next = state
  for (const event of events) next = browseReduce(next, event).state
  return next
}

const KEY_A = '["list",null,null,null,null]'
const KEY_B = '["list","route=/notes",null,null,null]'

describe("browse machine — flow 1: initial load", () => {
  it("mount bumps the revision to 1 and asks for the first window", () => {
    const transition = browseReduce(INITIAL_BROWSE_STATE, {
      type: "query-changed",
      datasetKey: KEY_A,
    })
    expect(transition.state.revision).toBe(1)
    expect(transition.state.datasetKey).toBe(KEY_A)
    expect(transition.abort).toBe(false)
    expect(transition.start).toEqual({
      revision: 1,
      kind: "initial",
      window: { limit: BROWSE_PAGE_SIZE, offset: 0 },
    })
    expect(browsePhase(transition.state)).toBe("loading")
  })

  it("the response stores records, total and key together, tagged with the revision", () => {
    const state = apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      {
        type: "response",
        revision: 1,
        kind: "initial",
        page: { records: [record("a")], total: 5432 },
        at: 1000,
      },
    )
    expect(state.fulfilled).toEqual({
      revision: 1,
      datasetKey: KEY_A,
      records: [record("a")],
      total: 5432,
      at: 1000,
    })
    expect(browsePhase(state)).toBe("idle")
    expect(browseDataState(state)).toEqual({ phase: "idle" })
  })
})

describe("browse machine — flows 2 and 4: a new desired query over a fulfilled one", () => {
  const loaded = apply(
    INITIAL_BROWSE_STATE,
    { type: "query-changed", datasetKey: KEY_A },
    {
      type: "response",
      revision: 1,
      kind: "initial",
      page: { records: [record("a")], total: 5432 },
      at: 1000,
    },
  )

  it("keeps the old rows visible and marks them stale", () => {
    const transition = browseReduce(loaded, { type: "query-changed", datasetKey: KEY_B })
    expect(transition.state.revision).toBe(2)
    expect(transition.state.fulfilled?.revision).toBe(1)
    expect(browsePhase(transition.state)).toBe("stale")
    expect(transition.start?.kind).toBe("initial")
  })

  it("aborts what was in flight, and drops the queued load-more and every error slot", () => {
    const busy: BrowseState = {
      ...loaded,
      inFlight: { revision: 1, kind: "refresh", window: { limit: 200, offset: 0 } },
      queuedLoadMore: true,
      kindErrors: { refresh: "boom" },
    }
    const transition = browseReduce(busy, { type: "query-changed", datasetKey: KEY_B })
    expect(transition.abort).toBe(true)
    expect(transition.state.queuedLoadMore).toBe(false)
    expect(transition.state.kindErrors).toEqual({})
  })

  it("fulfilling the new revision replaces the records and re-tags the key", () => {
    const state = apply(
      loaded,
      { type: "query-changed", datasetKey: KEY_B },
      {
        type: "response",
        revision: 2,
        kind: "initial",
        page: { records: [record("z")], total: 7 },
        at: 2000,
      },
    )
    expect(state.fulfilled).toEqual({
      revision: 2,
      datasetKey: KEY_B,
      records: [record("z")],
      total: 7,
      at: 2000,
    })
    expect(browsePhase(state)).toBe("idle")
  })
})

describe("browse machine — flow 6: a stale response completing after a query change", () => {
  it("discards the response WHOLE — records, total and the flight slot", () => {
    const stale = apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      {
        type: "query-changed",
        datasetKey: KEY_B,
      },
    )
    const transition = browseReduce(stale, {
      type: "response",
      revision: 1,
      kind: "initial",
      page: { records: [record("a")], total: 999 },
      at: 3000,
    })
    expect(transition.state).toBe(stale)
    expect(transition.start).toBeNull()
    expect(browsePhase(transition.state)).toBe("loading")
  })

  it("discards a stale FAILURE too, so it cannot hold the new revision in error", () => {
    const stale = apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      {
        type: "query-changed",
        datasetKey: KEY_B,
      },
    )
    const transition = browseReduce(stale, {
      type: "failure",
      revision: 1,
      kind: "initial",
      message: "gone",
    })
    expect(transition.state).toBe(stale)
    expect(browsePhase(transition.state)).toBe("loading")
  })
})

describe("browse machine — the phase table", () => {
  const loaded = apply(
    INITIAL_BROWSE_STATE,
    { type: "query-changed", datasetKey: KEY_A },
    {
      type: "response",
      revision: 1,
      kind: "initial",
      page: { records: [record("a")], total: 5432 },
      at: 1000,
    },
  )

  it("names the in-flight kind while the desired revision is fulfilled", () => {
    expect(
      browsePhase({
        ...loaded,
        inFlight: { revision: 1, kind: "refresh", window: { limit: 200, offset: 0 } },
      }),
    ).toBe("refreshing")
    expect(
      browsePhase({
        ...loaded,
        inFlight: { revision: 1, kind: "load-more", window: { limit: 200, offset: 1 } },
      }),
    ).toBe("loading-more")
  })

  it("error means nothing is fulfilled for the DESIRED revision, with or without rows", () => {
    const failedCold = apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      {
        type: "failure",
        revision: 1,
        kind: "initial",
        message: "no memory store configured",
      },
    )
    expect(browsePhase(failedCold)).toBe("error")
    expect(browseDataState(failedCold)).toEqual({
      phase: "error",
      message: "no memory store configured",
    })

    const failedWarm = apply(
      loaded,
      { type: "query-changed", datasetKey: KEY_B },
      {
        type: "failure",
        revision: 2,
        kind: "initial",
        message: "boom",
      },
    )
    expect(browsePhase(failedWarm)).toBe("error")
    expect(failedWarm.fulfilled?.records).toHaveLength(1)
  })

  it("a retry in flight is a fresh attempt, not the held failure", () => {
    const failed = apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      {
        type: "failure",
        revision: 1,
        kind: "initial",
        message: "boom",
      },
    )
    const retried = browseReduce(failed, { type: "retry" })
    expect(retried.start).toEqual({
      revision: 1,
      kind: "initial",
      window: { limit: BROWSE_PAGE_SIZE, offset: 0 },
    })
    expect(browsePhase(retried.state)).toBe("loading")
  })
})

describe("browse machine — single-flight arbitration", () => {
  const loaded = apply(
    INITIAL_BROWSE_STATE,
    { type: "query-changed", datasetKey: KEY_A },
    {
      type: "response",
      revision: 1,
      kind: "initial",
      page: { records: [record("a"), record("b")], total: 5432 },
      at: 1000,
    },
  )
  const fulfilled = loaded.fulfilled
  if (fulfilled === null) throw new Error("unreachable")

  it("a poll tick asks for offset 0 with limit = resident count, floored at one page", () => {
    expect(browseReduce(loaded, { type: "poll-tick" }).start).toEqual({
      revision: 1,
      kind: "refresh",
      window: { limit: BROWSE_PAGE_SIZE, offset: 0 },
    })
    const big: BrowseState = {
      ...loaded,
      fulfilled: { ...fulfilled, records: Array.from({ length: 600 }, (_, i) => record(`r${i}`)) },
    }
    expect(browseReduce(big, { type: "poll-tick" }).start?.window).toEqual({
      limit: 600,
      offset: 0,
    })
  })

  it("a poll tick due while ANYTHING is in flight is skipped", () => {
    for (const kind of ["initial", "refresh", "load-more"] as const) {
      const busy: BrowseState = {
        ...loaded,
        inFlight: { revision: 1, kind, window: { limit: 200, offset: 0 } },
      }
      const transition = browseReduce(busy, { type: "poll-tick" })
      expect(transition.start).toBeNull()
      expect(transition.state).toBe(busy)
    }
  })

  it("a load-more asked for during a poll tick is QUEUED and runs when the tick settles", () => {
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    const queued = browseReduce(refreshing, { type: "load-more-requested" })
    expect(queued.start).toBeNull()
    expect(queued.state.queuedLoadMore).toBe(true)

    const settled = browseReduce(queued.state, {
      type: "response",
      revision: 1,
      kind: "refresh",
      page: { records: [record("a"), record("b")], total: 5432 },
      at: 2000,
    })
    expect(settled.state.queuedLoadMore).toBe(false)
    expect(settled.start).toEqual({
      revision: 1,
      kind: "load-more",
      window: { limit: BROWSE_PAGE_SIZE, offset: 2 },
    })
  })

  it("a queued load-more also runs when the tick it waited on FAILS", () => {
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    const queued = browseReduce(refreshing, { type: "load-more-requested" }).state
    const settled = browseReduce(queued, {
      type: "failure",
      revision: 1,
      kind: "refresh",
      message: "boom",
    })
    expect(settled.start?.kind).toBe("load-more")
  })

  it("load-more during load-more is a no-op, and stops at the resident cap", () => {
    const loading: BrowseState = {
      ...loaded,
      inFlight: { revision: 1, kind: "load-more", window: { limit: 200, offset: 2 } },
    }
    expect(browseReduce(loading, { type: "load-more-requested" }).start).toBeNull()
    expect(browseReduce(loading, { type: "load-more-requested" }).state.queuedLoadMore).toBe(false)

    const atCap: BrowseState = {
      ...loaded,
      fulfilled: {
        ...fulfilled,
        records: Array.from({ length: BROWSE_RESIDENT_CAP }, (_, i) => record(`r${i}`)),
        total: 5432,
      },
    }
    expect(browseCanLoadMore(atCap)).toBe(false)
    expect(browseReduce(atCap, { type: "load-more-requested" }).start).toBeNull()
  })

  it("load-more is unavailable once everything matching is loaded", () => {
    const complete: BrowseState = { ...loaded, fulfilled: { ...fulfilled, total: 2 } }
    expect(browseCanLoadMore(complete)).toBe(false)
  })
})

describe("browse machine — immutability and identity", () => {
  const loaded = apply(
    INITIAL_BROWSE_STATE,
    { type: "query-changed", datasetKey: KEY_A },
    {
      type: "response",
      revision: 1,
      kind: "initial",
      page: { records: [record("a")], total: 5432 },
      at: 1000,
    },
  )

  it("freezes the singletons it hands out, which `readonly` does not survive to runtime", () => {
    expect(Object.isFrozen(INITIAL_BROWSE_STATE)).toBe(true)
    expect(Object.isFrozen(INITIAL_BROWSE_STATE.kindErrors)).toBe(true)
    // The same empty-slots object is installed on EVERY query change, so one widening
    // cast downstream would edit the slots of every state that ever cleared them.
    const cleared = browseReduce(
      { ...loaded, kindErrors: { refresh: "boom" } },
      { type: "query-changed", datasetKey: KEY_B },
    ).state
    expect(Object.isFrozen(cleared.kindErrors)).toBe(true)
  })

  it("a load-more asked for twice under one tick keeps the SAME state", () => {
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    const queued = browseReduce(refreshing, { type: "load-more-requested" }).state
    expect(queued.queuedLoadMore).toBe(true)
    expect(browseReduce(queued, { type: "load-more-requested" }).state).toBe(queued)
  })

  it("hands out one dataState per phase, so a consumer can hold it as a dependency", () => {
    expect(browseDataState(loaded)).toBe(browseDataState(loaded))
    // The 2 s cadence walks idle → refreshing → idle forever; coming back to idle is
    // not a change, and a fresh object each tick says it is.
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    const settled = browseReduce(refreshing, {
      type: "response",
      revision: 1,
      kind: "refresh",
      page: { records: [record("a")], total: 5432 },
      at: 2000,
    }).state
    expect(browseDataState(refreshing)).not.toBe(browseDataState(loaded))
    expect(browseDataState(settled)).toBe(browseDataState(loaded))
  })

  it("holds one dataState per failure, message and all", () => {
    const failed = apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      { type: "failure", revision: 1, kind: "initial", message: "boom" },
    )
    expect(browseDataState(failed)).toEqual({ phase: "error", message: "boom" })
    expect(browseDataState(failed)).toBe(browseDataState(failed))
  })
})

describe("browse machine — the resident cap", () => {
  function loadedWith(records: readonly MemoryRecord[], total = 5432): BrowseState {
    return apply(
      INITIAL_BROWSE_STATE,
      { type: "query-changed", datasetKey: KEY_A },
      { type: "response", revision: 1, kind: "initial", page: { records, total }, at: 1000 },
    )
  }

  it("is the route's own BROWSE_MAX_LIMIT, so one refresh can ask for the whole set", () => {
    expect(BROWSE_RESIDENT_CAP).toBe(BROWSE_MAX_LIMIT)
  })

  it("holds the resident set at the cap however the pages land", () => {
    // A resident count off the 200 boundary is ordinary, not exotic: `dedupeById` drops
    // a paging duplicate whenever an insert shifts the offsets under a load-more.
    let state = loadedWith(rows(197))
    for (let guard = 0; browseCanLoadMore(state) && guard < 20; guard += 1) {
      const transition = browseReduce(state, { type: "load-more-requested" })
      const request = transition.start
      if (request === null) throw new Error("unreachable")
      expect(request.window.offset + request.window.limit).toBeLessThanOrEqual(BROWSE_RESIDENT_CAP)
      state = browseReduce(transition.state, {
        type: "response",
        revision: 1,
        kind: "load-more",
        page: { records: rows(request.window.limit, request.window.offset), total: 5432 },
        at: 2000,
      }).state
    }
    expect(state.fulfilled?.records).toHaveLength(BROWSE_RESIDENT_CAP)
    expect(browseCanLoadMore(state)).toBe(false)
  })

  it("truncates a reconciled refresh, so rule 3's tail stays inside a later window", () => {
    const state = loadedWith(rows(900))
    const refreshing = browseReduce(state, { type: "poll-tick" })
    expect(refreshing.start?.window).toEqual({ limit: 900, offset: 0 })
    const settled = browseReduce(refreshing.state, {
      type: "response",
      revision: 1,
      kind: "refresh",
      page: { records: inserted(900), total: 6000 },
      at: 2000,
    }).state
    expect(settled.fulfilled?.records).toHaveLength(BROWSE_RESIDENT_CAP)
    // Dropped from the FAR end: a row the next window can still reach is worth more
    // than one parked past the limit, which no refresh can ever re-cover again.
    expect(settled.fulfilled?.records.at(-1)?.id).toBe("r99")
    expect(browseReduce(settled, { type: "poll-tick" }).start?.window.limit).toBe(
      BROWSE_RESIDENT_CAP,
    )
  })

  it("retry does not re-issue a load-more the cap has already closed", () => {
    const atCap: BrowseState = {
      ...loadedWith(rows(BROWSE_RESIDENT_CAP)),
      kindErrors: { "load-more": "boom" },
    }
    expect(browseCanLoadMore(atCap)).toBe(false)
    expect(browseReduce(atCap, { type: "retry" }).start?.kind).toBe("refresh")
  })
})

describe("browse machine — flow 9: refresh reconciles, load-more dedupes", () => {
  const loaded = apply(
    INITIAL_BROWSE_STATE,
    { type: "query-changed", datasetKey: KEY_A },
    {
      type: "response",
      revision: 1,
      kind: "initial",
      page: {
        records: [record("a", "2026-08-03T00:00:00.000Z"), record("b", "2026-08-02T00:00:00.000Z")],
        total: 5432,
      },
      at: 1000,
    },
  )

  it("a refresh response is reconciled against the residents, not concatenated", () => {
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    // A partial window (2 of a 200 limit) ends the span: `b` is gone.
    const settled = browseReduce(refreshing, {
      type: "response",
      revision: 1,
      kind: "refresh",
      page: {
        records: [record("c", "2026-08-09T00:00:00.000Z"), record("a", "2026-08-03T00:00:00.000Z")],
        total: 5431,
      },
      at: 2000,
    })
    expect(settled.state.fulfilled?.records.map((r) => r.id)).toEqual(["c", "a"])
    expect(settled.state.fulfilled?.total).toBe(5431)
  })

  it("refuses a refresh response with nothing in flight instead of guessing its span", () => {
    // The request's limit is the only record of how far this response reached, and
    // either guess decides rule 3: too high drops a live tail, too low pins a stale one.
    expect(() =>
      browseReduce(
        { ...loaded, inFlight: null },
        {
          type: "response",
          revision: 1,
          kind: "refresh",
          page: { records: [record("a")], total: 5432 },
          at: 2000,
        },
      ),
    ).toThrow(/in flight/)
  })

  it("a load-more response is appended with ids deduped", () => {
    const loading = browseReduce(loaded, { type: "load-more-requested" }).state
    const settled = browseReduce(loading, {
      type: "response",
      revision: 1,
      kind: "load-more",
      page: {
        records: [record("b", "2026-08-02T00:00:00.000Z"), record("c", "2026-08-01T00:00:00.000Z")],
        total: 5432,
      },
      at: 2000,
    })
    expect(settled.state.fulfilled?.records.map((r) => r.id)).toEqual(["a", "b", "c"])
  })
})

describe("browse machine — flows 7 and 8: failure, slots and retry", () => {
  const loaded = apply(
    INITIAL_BROWSE_STATE,
    { type: "query-changed", datasetKey: KEY_A },
    {
      type: "response",
      revision: 1,
      kind: "initial",
      page: { records: [record("a")], total: 5432 },
      at: 1000,
    },
  )

  it("a refresh failure keeps the rows and the idle phase, and fills only its own slot", () => {
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    const failed = browseReduce(refreshing, {
      type: "failure",
      revision: 1,
      kind: "refresh",
      message: "network down",
    }).state
    expect(browsePhase(failed)).toBe("idle")
    expect(failed.fulfilled?.records).toHaveLength(1)
    expect(failed.kindErrors).toEqual({ refresh: "network down" })
  })

  it("one kind's success cannot clear another kind's failure", () => {
    const withBoth: BrowseState = { ...loaded, kindErrors: { refresh: "r", "load-more": "l" } }
    const refreshing = browseReduce(withBoth, { type: "poll-tick" }).state
    const ok = browseReduce(refreshing, {
      type: "response",
      revision: 1,
      kind: "refresh",
      page: { records: [record("a")], total: 5432 },
      at: 2000,
    }).state
    expect(ok.kindErrors).toEqual({ "load-more": "l" })
  })

  it("a repeated identical failure keeps the SAME slots object, so a 2 s cadence cannot re-render", () => {
    const refreshing = browseReduce(loaded, { type: "poll-tick" }).state
    const once = browseReduce(refreshing, {
      type: "failure",
      revision: 1,
      kind: "refresh",
      message: "network down",
    }).state
    const again = browseReduce(browseReduce(once, { type: "poll-tick" }).state, {
      type: "failure",
      revision: 1,
      kind: "refresh",
      message: "network down",
    }).state
    expect(again.kindErrors).toBe(once.kindErrors)
  })

  it("retry re-attempts the failed KIND, preferring load-more over refresh", () => {
    const loadMoreFailed: BrowseState = { ...loaded, kindErrors: { "load-more": "boom" } }
    expect(browseReduce(loadMoreFailed, { type: "retry" }).start).toEqual({
      revision: 1,
      kind: "load-more",
      window: { limit: BROWSE_PAGE_SIZE, offset: 1 },
    })
    const refreshFailed: BrowseState = { ...loaded, kindErrors: { refresh: "boom" } }
    expect(browseReduce(refreshFailed, { type: "retry" }).start?.kind).toBe("refresh")
  })

  it("retry after the query moved on is simply the new query's initial fetch", () => {
    const moved = apply(
      loaded,
      { type: "query-changed", datasetKey: KEY_B },
      {
        type: "failure",
        revision: 2,
        kind: "initial",
        message: "boom",
      },
    )
    expect(browseReduce(moved, { type: "retry" }).start).toEqual({
      revision: 2,
      kind: "initial",
      window: { limit: BROWSE_PAGE_SIZE, offset: 0 },
    })
  })

  it("retry while something is in flight is a no-op", () => {
    const busy: BrowseState = {
      ...loaded,
      inFlight: { revision: 1, kind: "refresh", window: { limit: 200, offset: 0 } },
    }
    expect(browseReduce(busy, { type: "retry" }).start).toBeNull()
  })
})
