import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BROWSE_POLL_INTERVAL_MS } from "../../src/browse/use-memory-browse"
import { BulkBar } from "../../src/components/memory/bulk-bar"
import { ListPage, STATS_POLL_INTERVAL_MS } from "../../src/components/memory/list-page"
import { TEST_IDS } from "../../src/components/memory/test-ids"
import { browseSeedRecords } from "../seed"

const RECORDS = browseSeedRecords().slice(0, 4)
const FAILING_ID = RECORDS[1]?.id as string
/** A row the forget SUCCEEDS on — the only kind that can tell a prune from a no-op. */
const SUCCEEDED_ID = RECORDS[0]?.id as string

/** How long the isolation test below holds each write. The writes are sequential, so a
 *  run spans this once per id — but the window an ordering can be read across runs from
 *  the FIRST write being issued to the LAST, which is one gap shorter. */
const WRITE_LATENCY_MS = 900
const RUN_WINDOW_MS = (RECORDS.length - 1) * WRITE_LATENCY_MS

let posted: string[] = []
/** Browse responses served, to wait for the reconciling refresh rather than guess at it. */
let listed = 0
/** Set to hold every POST mid-flight, so a run can be observed while it is running. */
let postGate: Promise<void> | undefined

/**
 * The list route answers with all four records for the whole test, INCLUDING the three
 * the forget succeeds on. A faithful store would drop them, and dropping them would take
 * the evidence with it: a row absent from the grid paints no checkbox, so a selection
 * the code failed to prune would be invisible rather than wrong. Keeping the rows is
 * what makes `aria-checked` on a succeeded row a real reading of the engine's state.
 */
function stubFetch(): void {
  posted = []
  listed = 0
  postGate = undefined
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "POST") {
        posted.push(url)
        if (postGate !== undefined) await postGate
        if (url.includes(FAILING_ID))
          return Response.json({ error: "not a candidate" }, { status: 409 })
        return Response.json({ ok: true })
      }
      if (url.includes("/api/memory/stats"))
        return Response.json({
          total: RECORDS.length,
          byStatus: {},
          byKind: {},
          byNamespace: {},
          bySourceType: {},
        })
      if (url.includes("/api/memory/list")) {
        listed += 1
        return Response.json({ records: RECORDS, total: RECORDS.length, continuation: null })
      }
      return Response.json({})
    }),
  )
}

/**
 * Tick every loaded row through the header checkbox.
 *
 * The wait is load-bearing twice over. The header checkbox is in the document from the
 * first paint, and select-all spans the rows the engine can SEE — clicked before the
 * first page lands it ticks nothing and no bar ever appears. And these assertions read
 * the document, not a render result, so a leftover tree from the previous test would
 * answer them: `cleanup()` below is what keeps each `render` alone in the document.
 */
async function tickEveryLoadedRow(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector(`[data-pretable-row-id="${FAILING_ID}"]`)).not.toBeNull(),
  )
  const header = document.querySelector("[data-pretable-row-select-all]")
  expect(header).not.toBeNull()
  fireEvent.click(header as Element)
}

beforeEach(() => {
  stubFetch()
  vi.spyOn(window, "confirm").mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("bulk partial failure", () => {
  it("keeps ONLY the failures selected, so a retry cannot repeat a completed delete", async () => {
    render(<ListPage />)
    await tickEveryLoadedRow()

    const bar = await screen.findByTestId(TEST_IDS.bulkBar)
    expect(bar.textContent).toContain(String(RECORDS.length))

    const listedBeforeRun = listed
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    await waitFor(() => expect(posted).toHaveLength(RECORDS.length))

    // The three that succeeded are gone from the selection; the one 409 remains.
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.bulkBar).textContent).toContain("1 selected"),
    )
    expect(screen.getByTestId(TEST_IDS.bulkError).textContent).toContain(FAILING_ID)
    // The engine agrees with the bar, read on BOTH sides. The failure's box is a whole
    // row, not the indeterminate box a short cell range leaves behind — and a succeeded
    // row is unticked, which is the reading that distinguishes a prune from a no-op:
    // select-all had already ticked the failure, so its box alone proves nothing.
    expect(
      document
        .querySelector(`[data-pretable-row-id="${FAILING_ID}"] [data-pretable-row-select]`)
        ?.getAttribute("aria-checked"),
    ).toBe("true")
    expect(
      document
        .querySelector(`[data-pretable-row-id="${SUCCEEDED_ID}"] [data-pretable-row-select]`)
        ?.getAttribute("aria-checked"),
    ).toBe("false")

    // And it HOLDS through the reconciling refresh. `onTickedChange` mirrors the grid's
    // selection back into the bar's count, so an unpruned engine would re-arm the bar at
    // four the moment the next answer landed — after the assertions above had passed.
    await waitFor(() => expect(listed).toBeGreaterThan(listedBeforeRun))
    expect(screen.getByTestId(TEST_IDS.bulkBar).textContent).toContain("1 selected")
    expect(
      document
        .querySelector(`[data-pretable-row-id="${SUCCEEDED_ID}"] [data-pretable-row-select]`)
        ?.getAttribute("aria-checked"),
    ).toBe("false")

    // Retry: exactly one further POST, and it is the failure.
    posted = []
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain(FAILING_ID)
  })

  it("names the count and the scope in the confirmation", async () => {
    render(<ListPage />)
    await tickEveryLoadedRow()
    await screen.findByTestId(TEST_IDS.bulkBar)
    // DISMISS. This test wants the question, not the answer: confirming would launch
    // four real POSTs whose completion handler fires a refresh, and those land after
    // the assertions — against a `fetch` that `afterEach` has already unstubbed.
    const confirmMock = vi.mocked(window.confirm)
    confirmMock.mockReturnValue(false)
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const message = String(confirmMock.mock.calls[0]?.[0] ?? "")
    expect(message).toContain(String(RECORDS.length))
    expect(message).toMatch(/selected|loaded/i)
    expect(posted).toHaveLength(0)
  })

  /**
   * Read through the status bar because that is where `paused` reaches the DOM: the bar
   * quotes an "Updated <time>" instant only while polling is suspended, and shows
   * nothing while it is live. The property under test is that the suspension covers the
   * whole run — the bar's failure list is component state, and a tick that empties
   * `ticked` mid-run unmounts the bar and takes that list with it.
   */
  it("suspends browse polling from the first POST until the run completes", async () => {
    let release = (): void => {}
    postGate = new Promise<void>((resolve) => {
      release = resolve
    })
    render(<ListPage />)
    await tickEveryLoadedRow()
    await screen.findByTestId(TEST_IDS.bulkBar)
    expect(screen.queryByTestId(TEST_IDS.asOf)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    await screen.findByTestId(TEST_IDS.asOf)

    postGate = undefined
    release()
    await waitFor(() => expect(posted).toHaveLength(RECORDS.length))
    // And it is a suspension, not a stop: polling resumes on completion.
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.asOf)).toBeNull())
  })

  /**
   * The completion refresh is redundant while polling is live — resuming from the
   * suspension above already ticks. Turning polling OFF is what makes it the only thing
   * that would ever fetch the post-write answer, so it is the only setting in which the
   * call can be observed at all.
   */
  it("reconciles the grid after a run with live polling off", async () => {
    render(<ListPage />)
    await tickEveryLoadedRow()
    await screen.findByTestId(TEST_IDS.bulkBar)

    fireEvent.click(screen.getByTestId(TEST_IDS.liveToggle))
    // Paused, and settled: the stamp appears once `live` is off, and any tick that was
    // already in flight has landed by then — so `listed` stops moving on its own here.
    await screen.findByTestId(TEST_IDS.asOf)
    const listedWhilePaused = listed

    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    await waitFor(() => expect(posted).toHaveLength(RECORDS.length))
    await waitFor(() => expect(listed).toBeGreaterThan(listedWhilePaused))
  })
})

describe("bulk run isolation", () => {
  /**
   * The suspension above is read through the status bar; this reads it through the WIRE,
   * for BOTH polls — the rows and the counts are two readings of one store, and a run
   * that stills only the rows still paints a half-applied number beside them. The stub
   * serves its own `order` log rather than the shared one because the property is an
   * ORDERING — where the reads sit relative to the run's writes — and the shared stub
   * counts them without recording when they happened.
   */
  it("issues no browse or stats request between the first and last per-id write", async () => {
    // The window has to outlast the slower poll or neither assertion below proves
    // anything: a poll still armed but with no time to tick reads exactly like a
    // suspended one, and the test would pass on a reverted suspension.
    expect(RUN_WINDOW_MS).toBeGreaterThan(Math.max(BROWSE_POLL_INTERVAL_MS, STATS_POLL_INTERVAL_MS))
    const order: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === "POST") {
          order.push(`POST ${url}`)
          await new Promise((resolve) => setTimeout(resolve, WRITE_LATENCY_MS))
          return Response.json({ ok: true })
        }
        if (url.includes("/api/memory/list")) {
          order.push("LIST")
          return Response.json({ records: RECORDS, total: RECORDS.length, continuation: null })
        }
        if (url.includes("/api/memory/stats")) {
          order.push("STATS")
          return Response.json({
            total: RECORDS.length,
            byStatus: {},
            byKind: {},
            byNamespace: {},
            bySourceType: {},
          })
        }
        return Response.json({})
      }),
    )

    render(<ListPage />)
    // The shared helper, not a wait on `order`: "LIST" is logged when the request is
    // ISSUED, and select-all spans the rows the engine can see — ticking on the request
    // rather than on the answer would tick nothing and raise no bar.
    await tickEveryLoadedRow()
    await screen.findByTestId(TEST_IDS.bulkBar)
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))

    await waitFor(
      () => expect(order.filter((entry) => entry.startsWith("POST"))).toHaveLength(RECORDS.length),
      { timeout: 20_000 },
    )
    const firstPost = order.findIndex((entry) => entry.startsWith("POST"))
    const lastPost = order.length - 1 - [...order].reverse().findIndex((e) => e.startsWith("POST"))
    expect(order.slice(firstPost, lastPost)).not.toContain("LIST")
    expect(order.slice(firstPost, lastPost)).not.toContain("STATS")
  }, 30_000)

  /**
   * Driven through `BulkBar` directly: the property is that the run holds the ids the
   * CONFIRMATION named, and only a caller that can swap `ticked` mid-flight can tell that
   * apart from re-reading the prop. `ListPage` cannot be made to do that on demand.
   *
   * What carries the property is the CLOSURE — the click handler captured `ticked` from
   * the render it fired on, and every later render is a different array the run cannot
   * see. The defensive copy inside `run` is not it: deleting the copy leaves this test
   * green. The failure mode this rules out is a loop that re-reads the live selection per
   * iteration, which is why the swap happens between two writes rather than before them.
   */
  it("runs against the ids confirmed, not the ids currently ticked", async () => {
    // Named apart from the file-level `posted`: this test drives the bar alone, and the
    // shared stub that fills the other one is not installed over this render.
    const written: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        written.push(String(input))
        if (written.length === 1) await gate
        return Response.json({ ok: true })
      }),
    )
    const ids = RECORDS.map((record) => record.id)
    const { rerender } = render(
      <BulkBar
        ticked={ids}
        records={RECORDS}
        onDone={() => {}}
        onStart={() => {}}
        onClear={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    // The grid changes underneath, mid-run: only one row is ticked now.
    rerender(
      <BulkBar
        ticked={[ids[0] as string]}
        records={RECORDS}
        onDone={() => {}}
        onStart={() => {}}
        onClear={() => {}}
      />,
    )
    release?.()
    // The run still targets the CONFIRMED four.
    await waitFor(() => expect(written).toHaveLength(ids.length), { timeout: 20_000 })
    for (const id of ids) expect(written.some((url) => url.includes(id))).toBe(true)
  }, 30_000)
})
