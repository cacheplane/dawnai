import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { usePolling } from "../../src/components/use-polling"

/** Long enough that no interval fires inside a test that is counting IMMEDIATE ticks —
 *  those tests are about the edges, and a cadence landing mid-assertion would read as
 *  one. The one test that wants the cadence names its own. */
const NEVER_MS = 60_000

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("usePolling immediate ticks", () => {
  it("ticks once on mount even with polling disabled", async () => {
    const fn = vi.fn(async () => "a")
    renderHook(() => usePolling(fn, NEVER_MS, false))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
  })

  /**
   * The reason the effect depends on `fn` identity at all: callers pass a useCallback'd
   * fetcher whose identity moves when the filters do, and with live mode off this tick
   * is the ONLY thing that would ever fetch the new question's answer.
   */
  it("ticks on an fn change while polling stays disabled", async () => {
    const first = vi.fn(async () => "a")
    const second = vi.fn(async () => "b")
    const { rerender } = renderHook(({ fn }) => usePolling(fn, NEVER_MS, false), {
      initialProps: { fn: first },
    })
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    rerender({ fn: second })
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1))
  })

  /**
   * The suspension is silent, and that is the whole point of it. Callers disable polling
   * to hold a reading still across a change they are making themselves — a bulk run's
   * per-id writes — and they flip the flag from the same event that issues the first
   * write. A parting tick on the way down would therefore be taken CONCURRENTLY with
   * that write and publish exactly the half-applied reading the suspension exists to
   * keep off screen. Resuming ticks at once, so the cost of the suspension is one read
   * at its trailing edge and none inside it.
   */
  it("does not tick when polling is suspended, and ticks again on resume", async () => {
    const fn = vi.fn(async () => "a")
    const { rerender } = renderHook(({ enabled }) => usePolling(fn, NEVER_MS, enabled), {
      initialProps: { enabled: true },
    })
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))

    rerender({ enabled: false })
    // Settled, not merely un-awaited: a tick would be issued synchronously by the
    // effect, so one flushed microtask queue is enough to have seen it.
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)

    rerender({ enabled: true })
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })

  /**
   * The app runs `reactStrictMode`, whose remount re-runs this effect against hook state
   * it did NOT reset — so the ref telling a suspension from a mount is already written
   * by the time the second run reads it. Read through the published value rather than a
   * call count, because that is where the failure would show: the first run's cleanup
   * marks its tick dead, so a second run that declines to tick leaves the value undefined
   * forever. Disabled on mount is the arm that can fail; enabled would tick regardless.
   */
  it("publishes a mount tick under StrictMode with polling disabled", async () => {
    const fn = vi.fn(async () => "a")
    const { result } = renderHook(() => usePolling(fn, NEVER_MS, false), { wrapper: StrictMode })
    await waitFor(() => expect(result.current).toBe("a"))
  })

  it("polls on the interval while enabled", async () => {
    const fn = vi.fn(async () => "a")
    renderHook(() => usePolling(fn, 20, true))
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3))
  })
})
