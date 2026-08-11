import type { MemoryRecord } from "@dawn-ai/memory/browse"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { Suspense, startTransition, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BROWSE_RESIDENT_CAP } from "../../src/browse/browse-machine"
import { type CanonicalBrowseQuery, canonicalBrowseQuery } from "../../src/browse/canonical-query"
import {
  fetchBrowsePage,
  type UseMemoryBrowseResult,
  useMemoryBrowse,
} from "../../src/browse/use-memory-browse"

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

type BrowsePage = { records: readonly MemoryRecord[]; total: number }

interface DeferredCall {
  params: URLSearchParams
  signal: AbortSignal
  resolve: (page: BrowsePage) => void
  reject: (error: Error) => void
}

/** A fetcher whose every call is resolved by hand, so a response can be made to
 *  land after the query it belongs to has already been superseded. */
function deferredFetcher() {
  const calls: DeferredCall[] = []
  const fetchPage = vi.fn(
    (params: URLSearchParams, signal: AbortSignal) =>
      new Promise<BrowsePage>((resolve, reject) => {
        calls.push({ params, signal, resolve, reject })
      }),
  )
  return { calls, fetchPage }
}

/** Indexing straight into `calls` optional-chains the ACTION as much as the read: a
 *  request that was never issued would settle nothing, and the miss would surface
 *  several assertions later as a phase that makes no sense. This throws at the line
 *  that is actually wrong. */
function callAt(calls: readonly DeferredCall[], index: number): DeferredCall {
  const call = calls[index]
  if (call === undefined) {
    throw new Error(`no browse request at index ${index}; ${calls.length} were issued`)
  }
  return call
}

afterEach(cleanup)

describe("useMemoryBrowse", () => {
  it("fetches the first window on mount and reports loading until it lands", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list" })
    const { result } = renderHook(() => useMemoryBrowse({ query, live: true, fetchPage }))

    expect(result.current.dataState).toEqual({ phase: "loading" })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(callAt(calls, 0).params.get("limit")).toBe("200")
    expect(callAt(calls, 0).params.get("offset")).toBe("0")

    await act(async () => {
      callAt(calls, 0).resolve({ records: [record("a")], total: 5432 })
    })
    expect(result.current.dataState).toEqual({ phase: "idle" })
    expect(result.current.rows.map((r) => r.id)).toEqual(["a"])
    expect(result.current.total).toBe(5432)
    expect(result.current.resultMeta.total).toEqual({ kind: "exact", count: 5432 })
    expect(result.current.resultMeta.datasetKey).toBe('["list",null,null,null,null]')
  })

  it("publishes the FULFILLED dataset key, so the grid pivots when the answer lands", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const { result, rerender } = renderHook(
      ({ namespace }: { namespace?: string }) =>
        useMemoryBrowse({
          query: canonicalBrowseQuery({ view: "list", ...(namespace ? { namespace } : {}) }),
          live: true,
          fetchPage,
        }),
      { initialProps: {} as { namespace?: string } },
    )
    await waitFor(() => expect(calls).toHaveLength(1))
    await act(async () => {
      callAt(calls, 0).resolve({ records: [record("a")], total: 2 })
    })
    const firstKey = result.current.resultMeta.datasetKey

    rerender({ namespace: "route=/notes" })
    expect(result.current.dataState).toEqual({ phase: "stale" })
    // Still the OLD key while the old rows are on screen: selection over them is
    // valid FOR THEM, and is cleared exactly when the new answer lands.
    expect(result.current.resultMeta.datasetKey).toBe(firstKey)

    await waitFor(() => expect(calls).toHaveLength(2))
    await act(async () => {
      callAt(calls, 1).resolve({ records: [record("z")], total: 1 })
    })
    expect(result.current.resultMeta.datasetKey).not.toBe(firstKey)
    expect(result.current.rows.map((r) => r.id)).toEqual(["z"])
  })

  it("aborts the superseded request and discards it even if abort loses the race", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const { result, rerender } = renderHook(
      ({ namespace }: { namespace?: string }) =>
        useMemoryBrowse({
          query: canonicalBrowseQuery({ view: "list", ...(namespace ? { namespace } : {}) }),
          live: true,
          fetchPage,
        }),
      { initialProps: {} as { namespace?: string } },
    )
    await waitFor(() => expect(calls).toHaveLength(1))
    rerender({ namespace: "route=/notes" })
    expect(callAt(calls, 0).signal.aborted).toBe(true)

    // Abort lost the race: the superseded response resolves anyway.
    await act(async () => {
      callAt(calls, 0).resolve({ records: [record("stale")], total: 999 })
    })
    expect(result.current.rows).toHaveLength(0)
    expect(result.current.total).toBeNull()
    expect(result.current.dataState).toEqual({ phase: "loading" })
  })

  it("answers a set narrowed to nothing locally, without a request", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list", status: [] })
    const { result } = renderHook(() => useMemoryBrowse({ query, live: true, fetchPage }))
    await waitFor(() => expect(result.current.dataState).toEqual({ phase: "idle" }))
    expect(calls).toHaveLength(0)
    expect(result.current.total).toBe(0)
  })

  it("polls on the interval, and a refresh failure banners itself and keeps polling", async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchPage } = deferredFetcher()
      const query = canonicalBrowseQuery({ view: "list" })
      const { result } = renderHook(() =>
        useMemoryBrowse({ query, live: true, fetchPage, pollIntervalMs: 2000 }),
      )
      await act(async () => {
        callAt(calls, 0).resolve({ records: [record("a")], total: 5432 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(calls).toHaveLength(2)
      expect(result.current.dataState).toEqual({ phase: "refreshing" })

      await act(async () => {
        callAt(calls, 1).reject(new Error("network down"))
      })
      // A refresh failure keeps the rows and the idle phase; it fills its own slot.
      expect(result.current.dataState).toEqual({ phase: "idle" })
      expect(result.current.errors).toEqual({ refresh: "network down" })
      expect(result.current.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds the published identities across a refresh that changes neither", async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchPage } = deferredFetcher()
      const query = canonicalBrowseQuery({ view: "list" })
      const { result } = renderHook(() =>
        useMemoryBrowse({ query, live: true, fetchPage, pollIntervalMs: 2000 }),
      )
      await act(async () => {
        callAt(calls, 0).resolve({ records: [record("a")], total: 5432 })
      })
      const meta = result.current.resultMeta
      const dataState = result.current.dataState

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      await act(async () => {
        callAt(calls, 1).resolve({ records: [record("a")], total: 5432 })
      })
      // The grid holds both of these as dependencies and the cadence walks
      // idle → refreshing → idle every 2 s: a fresh object on the way back reports a
      // change that did not happen.
      expect(result.current.resultMeta).toBe(meta)
      expect(result.current.dataState).toBe(dataState)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports hasMore from the matching population, not from the resident cap", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list" })
    const { result } = renderHook(() => useMemoryBrowse({ query, live: false, fetchPage }))
    await waitFor(() => expect(calls).toHaveLength(1))

    await act(async () => {
      callAt(calls, 0).resolve({
        records: Array.from({ length: BROWSE_RESIDENT_CAP }, (_, i) => record(`r${i}`)),
        total: 5432,
      })
    })
    // The cap closes the load-more REQUEST, and the machine is what refuses it. It does
    // not make the other 4432 matching records stop existing, and this field is what a
    // footer quotes the loaded count against — so it must not read as exhaustion.
    expect(result.current.rows).toHaveLength(BROWSE_RESIDENT_CAP)
    expect(result.current.hasMore).toBe(true)
  })

  it("reports hasMore false once every matching record is resident", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list" })
    const { result } = renderHook(() => useMemoryBrowse({ query, live: false, fetchPage }))
    await waitFor(() => expect(calls).toHaveLength(1))

    await act(async () => {
      callAt(calls, 0).resolve({ records: [record("a"), record("b")], total: 2 })
    })
    expect(result.current.hasMore).toBe(false)
  })

  it("queues a load-more asked for behind a refresh and drains it onto the tail", async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchPage } = deferredFetcher()
      const query = canonicalBrowseQuery({ view: "list" })
      const { result } = renderHook(() =>
        useMemoryBrowse({ query, live: true, fetchPage, pollIntervalMs: 2000 }),
      )
      await act(async () => {
        callAt(calls, 0).resolve({ records: [record("a"), record("b")], total: 5 })
      })
      expect(result.current.hasMore).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(calls).toHaveLength(2)
      expect(callAt(calls, 1).params.get("offset")).toBe("0")

      // Asked for while the tick holds the single flight: intent is queued, never
      // dropped, and no second request goes out yet.
      act(() => {
        result.current.loadMore()
      })
      expect(calls).toHaveLength(2)

      // Draining happens INSIDE the refresh's own promise handler, so the queued
      // request re-enters `startRequest` while that handler is still on the stack —
      // and must not abort or orphan the controller it is unwinding from.
      await act(async () => {
        callAt(calls, 1).resolve({ records: [record("a"), record("b")], total: 5 })
      })
      expect(calls).toHaveLength(3)
      expect(callAt(calls, 2).params.get("offset")).toBe("2")
      expect(callAt(calls, 2).signal.aborted).toBe(false)
      expect(result.current.dataState).toEqual({ phase: "loading-more" })

      await act(async () => {
        callAt(calls, 2).resolve({ records: [record("c")], total: 5 })
      })
      expect(result.current.rows.map((r) => r.id)).toEqual(["a", "b", "c"])
      expect(result.current.dataState).toEqual({ phase: "idle" })
      expect(result.current.hasMore).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("pauses when live goes off and ticks IMMEDIATELY on resume", async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchPage } = deferredFetcher()
      const query = canonicalBrowseQuery({ view: "list" })
      const { result, rerender } = renderHook(
        ({ live }: { live: boolean }) =>
          useMemoryBrowse({ query, live, fetchPage, pollIntervalMs: 2000 }),
        { initialProps: { live: true } },
      )
      await act(async () => {
        callAt(calls, 0).resolve({ records: [record("a")], total: 5432 })
      })

      rerender({ live: false })
      expect(result.current.paused).toBe(true)
      expect(result.current.updatedAt).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(calls).toHaveLength(1)

      await act(async () => {
        rerender({ live: true })
      })
      expect(calls).toHaveLength(2)
      expect(result.current.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("an initial failure holds the error phase and suspends polling", async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchPage } = deferredFetcher()
      const query = canonicalBrowseQuery({ view: "list" })
      const { result } = renderHook(() =>
        useMemoryBrowse({ query, live: true, fetchPage, pollIntervalMs: 2000 }),
      )
      await act(async () => {
        callAt(calls, 0).reject(new Error("no memory store configured"))
      })
      expect(result.current.dataState).toEqual({
        phase: "error",
        message: "no memory store configured",
      })
      expect(result.current.paused).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(calls).toHaveLength(1)

      await act(async () => {
        result.current.retry()
      })
      expect(calls).toHaveLength(2)
      await act(async () => {
        callAt(calls, 1).resolve({ records: [record("a")], total: 1 })
      })
      expect(result.current.dataState).toEqual({ phase: "idle" })
      expect(result.current.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts on unmount, and the abort is what discards a response that lands after", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const now = vi.fn(() => 1_700_000_000_000)
    const query = canonicalBrowseQuery({ view: "list" })
    const { unmount } = renderHook(() => useMemoryBrowse({ query, live: true, fetchPage, now }))
    await waitFor(() => expect(calls).toHaveLength(1))
    unmount()
    expect(callAt(calls, 0).signal.aborted).toBe(true)

    await act(async () => {
      callAt(calls, 0).resolve({ records: [record("a")], total: 1 })
    })
    // Stamping the as-of instant is the FIRST thing applying a response does, so an
    // unread clock is the observable proof the handler bailed on the aborted signal.
    expect(now).not.toHaveBeenCalled()
  })

  it("builds a request from the COMMITTED query, never from a render React threw away", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    let release = () => {}
    try {
      const { calls, fetchPage } = deferredFetcher()
      const everything = canonicalBrowseQuery({ view: "list" })
      const narrowed = canonicalBrowseQuery({ view: "list", namespace: "route=/notes" })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let latest: UseMemoryBrowseResult | undefined
      let update: (next: { query: CanonicalBrowseQuery; suspend: boolean }) => void = () => {}

      function Probe({ query, suspend }: { query: CanonicalBrowseQuery; suspend: boolean }) {
        latest = useMemoryBrowse({ query, live: false, fetchPage })
        if (suspend) throw held
        return null
      }
      function App() {
        const [props, setProps] = useState({ query: everything, suspend: false })
        update = setProps
        return (
          <Suspense fallback={null}>
            <Probe {...props} />
          </Suspense>
        )
      }

      await act(async () => {
        root.render(<App />)
      })
      await act(async () => {
        callAt(calls, 0).resolve({ records: [record("a")], total: 5432 })
      })

      // A transition keeps the committed tree — and everything it can still dispatch
      // from — alive while the next one renders. This render reaches the hook, so it
      // has already written whatever a render writes, and then suspends: React throws
      // it away and no effect of it ever runs.
      await act(async () => {
        startTransition(() => update({ query: narrowed, suspend: true }))
      })

      // The refresh belongs to the revision the machine still holds, which is the
      // un-narrowed one. Params from the abandoned render would put one question's
      // rows and total under the other's dataset key — and `browseReduce` accepts the
      // response, because the revision it is tagged with is still the desired one.
      latest?.refresh()
      expect(calls).toHaveLength(2)
      expect(callAt(calls, 1).params.get("namespace")).toBeNull()
    } finally {
      release()
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it("fails the request when a page cannot be applied, rather than wedging", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list" })
    const { result } = renderHook(() => useMemoryBrowse({ query, live: true, fetchPage }))
    await waitFor(() => expect(calls).toHaveLength(1))

    // A fetcher is caller-supplied, so what it resolves with is unchecked: applying
    // this one throws inside the reducer, on the promise handler's own stack.
    await act(async () => {
      callAt(calls, 0).resolve(undefined as unknown as BrowsePage)
    })
    expect(result.current.dataState.phase).toBe("error")

    // Nothing is left in flight, so the hook is still reachable afterwards. A throw
    // that escaped instead would leave `inFlight` populated for good, and single
    // flight would skip this retry and every tick after it.
    await act(async () => {
      result.current.retry()
    })
    expect(calls).toHaveLength(2)
  })
})

describe("fetchBrowsePage", () => {
  function stubFetch(response: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    )
  }

  afterEach(() => vi.unstubAllGlobals())

  it("returns a well-formed page", async () => {
    stubFetch(() => Response.json({ records: [record("a")], total: 1 }))
    const page = await fetchBrowsePage(new URLSearchParams(), new AbortController().signal)
    expect(page.total).toBe(1)
    expect(page.records.map((r) => r.id)).toEqual(["a"])
  })

  it("rejects a 200 that is not a page, rather than handing it to the reducer", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }))
    await expect(
      fetchBrowsePage(new URLSearchParams(), new AbortController().signal),
    ).rejects.toThrow(/not a browse page/)

    stubFetch(() => Response.json({ records: [record("a")] }))
    await expect(
      fetchBrowsePage(new URLSearchParams(), new AbortController().signal),
    ).rejects.toThrow(/not a browse page/)
  })

  it("surfaces the API's error body on a failed status", async () => {
    stubFetch(() => Response.json({ error: "no memory store configured" }, { status: 500 }))
    await expect(
      fetchBrowsePage(new URLSearchParams(), new AbortController().signal),
    ).rejects.toThrow("no memory store configured")
  })
})
