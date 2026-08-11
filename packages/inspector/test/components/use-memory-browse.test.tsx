import type { MemoryRecord } from "@dawn-ai/memory/browse"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { canonicalBrowseQuery } from "../../src/browse/canonical-query"
import { useMemoryBrowse } from "../../src/browse/use-memory-browse"

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

/** A fetcher whose every call is resolved by hand, so a response can be made to
 *  land after the query it belongs to has already been superseded. */
function deferredFetcher() {
  const calls: {
    params: URLSearchParams
    signal: AbortSignal
    resolve: (page: { records: readonly MemoryRecord[]; total: number }) => void
    reject: (error: Error) => void
  }[] = []
  const fetchPage = vi.fn(
    (params: URLSearchParams, signal: AbortSignal) =>
      new Promise<{ records: readonly MemoryRecord[]; total: number }>((resolve, reject) => {
        calls.push({ params, signal, resolve, reject })
      }),
  )
  return { calls, fetchPage }
}

afterEach(cleanup)

describe("useMemoryBrowse", () => {
  it("fetches the first window on mount and reports loading until it lands", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list" })
    const { result } = renderHook(() => useMemoryBrowse({ query, live: true, fetchPage }))

    expect(result.current.dataState).toEqual({ phase: "loading" })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.params.get("limit")).toBe("200")
    expect(calls[0]?.params.get("offset")).toBe("0")

    await act(async () => {
      calls[0]?.resolve({ records: [record("a")], total: 5432 })
    })
    expect(result.current.dataState).toEqual({ phase: "idle" })
    expect(result.current.records.map((r) => r.id)).toEqual(["a"])
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
      calls[0]?.resolve({ records: [record("a")], total: 2 })
    })
    const firstKey = result.current.resultMeta.datasetKey

    rerender({ namespace: "route=/notes" })
    expect(result.current.dataState).toEqual({ phase: "stale" })
    // Still the OLD key while the old rows are on screen: selection over them is
    // valid FOR THEM, and is cleared exactly when the new answer lands.
    expect(result.current.resultMeta.datasetKey).toBe(firstKey)

    await waitFor(() => expect(calls).toHaveLength(2))
    await act(async () => {
      calls[1]?.resolve({ records: [record("z")], total: 1 })
    })
    expect(result.current.resultMeta.datasetKey).not.toBe(firstKey)
    expect(result.current.records.map((r) => r.id)).toEqual(["z"])
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
    expect(calls[0]?.signal.aborted).toBe(true)

    // Abort lost the race: the superseded response resolves anyway.
    await act(async () => {
      calls[0]?.resolve({ records: [record("stale")], total: 999 })
    })
    expect(result.current.records).toHaveLength(0)
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

  it("polls on the interval, and a failure suspends polling until retry", async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchPage } = deferredFetcher()
      const query = canonicalBrowseQuery({ view: "list" })
      const { result } = renderHook(() =>
        useMemoryBrowse({ query, live: true, fetchPage, pollIntervalMs: 2000 }),
      )
      await act(async () => {
        calls[0]?.resolve({ records: [record("a")], total: 5432 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(calls).toHaveLength(2)
      expect(result.current.dataState).toEqual({ phase: "refreshing" })

      await act(async () => {
        calls[1]?.reject(new Error("network down"))
      })
      // A refresh failure keeps the rows and the idle phase; it fills its own slot.
      expect(result.current.dataState).toEqual({ phase: "idle" })
      expect(result.current.errors).toEqual({ refresh: "network down" })
      expect(result.current.paused).toBe(false)
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
        calls[0]?.resolve({ records: [record("a")], total: 5432 })
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
        calls[0]?.reject(new Error("no memory store configured"))
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
        calls[1]?.resolve({ records: [record("a")], total: 1 })
      })
      expect(result.current.dataState).toEqual({ phase: "idle" })
      expect(result.current.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a response that resolves after unmount", async () => {
    const { calls, fetchPage } = deferredFetcher()
    const query = canonicalBrowseQuery({ view: "list" })
    const { unmount } = renderHook(() => useMemoryBrowse({ query, live: true, fetchPage }))
    await waitFor(() => expect(calls).toHaveLength(1))
    unmount()
    expect(calls[0]?.signal.aborted).toBe(true)
    // Resolving now must not throw, warn, or touch anything.
    await act(async () => {
      calls[0]?.resolve({ records: [record("a")], total: 1 })
    })
  })
})
