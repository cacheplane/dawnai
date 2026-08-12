import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BROWSE_POLL_INTERVAL_MS } from "../../src/browse/use-memory-browse"
import { ListPage } from "../../src/components/memory/list-page"
import { TEST_IDS } from "../../src/components/memory/test-ids"
import { browseSeedRecords } from "../seed"

/**
 * Written over `ListPage` with a stubbed `fetch` rather than over `useMemoryBrowse`,
 * deliberately: the claim is about what goes on the wire and what reaches the grid, and
 * that phrasing survives any refactor of the hook's internals — including which of the
 * two gates (the abort at the boundary, or `browseReduce`'s revision check, pinned in
 * `browse-machine.test.ts` flow 6) actually performs the discard.
 */

const ALL = browseSeedRecords().slice(0, 6)
const ACTIVE = ALL.filter((record) => record.status === "active")

let listUrls: string[] = []
let deferred: { url: string; resolve: (body: unknown) => void }[] = []

function recordsFor(url: string) {
  return url.includes("active") ? ACTIVE : ALL
}

beforeEach(() => {
  listUrls = []
  deferred = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/memory/stats"))
        return Response.json({
          total: ALL.length,
          byStatus: {},
          byKind: {},
          byNamespace: {},
          bySourceType: {},
        })
      if (!url.includes("/api/memory/list")) return Response.json({})
      listUrls.push(url)
      // Every list response is held open so a test can decide the ORDER in which
      // revisions land — which is the whole subject here.
      return new Promise((resolve) => {
        deferred.push({
          url,
          resolve: (body) => resolve(Response.json(body)),
        })
      })
    }),
  )
})

afterEach(() => {
  // This project runs vitest without `globals`, so RTL registers no auto-cleanup: the
  // previous test's page stays mounted, still polling, and every `screen` query below
  // matches twice. Unmount first, then drop the stub the unmount's last effects read.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Settle the oldest held request that matches `match`. */
function settle(match: (url: string) => boolean): void {
  const index = deferred.findIndex((entry) => match(entry.url))
  expect(index, `no held request matched`).toBeGreaterThanOrEqual(0)
  const [entry] = deferred.splice(index, 1)
  const records = recordsFor(entry?.url ?? "")
  entry?.resolve({ records, total: records.length, continuation: null })
}

describe("polling identity", () => {
  it("polls with the ACTIVE query's parameters, not the one the page mounted with", async () => {
    render(<ListPage />)
    await waitFor(() => expect(listUrls).toHaveLength(1))
    settle(() => true)
    await screen.findByText(ALL[0]?.content as string)

    // Move the query.
    const funnel = await screen.findByRole("button", { name: "Filter status" })
    fireEvent.click(funnel)
    fireEvent.click(await screen.findByRole("checkbox", { name: "active" }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    await waitFor(() => expect(listUrls.length).toBeGreaterThan(1))
    settle((url) => url.includes("active"))

    // Every subsequent request — poll ticks included — carries the new identity.
    const before = listUrls.length
    await waitFor(() => expect(listUrls.length).toBeGreaterThan(before), { timeout: 15_000 })
    for (const url of listUrls.slice(before)) {
      expect(url).toContain("active")
    }
  }, 30_000)

  it("discards a poll response whose revision is no longer desired", async () => {
    render(<ListPage />)
    await waitFor(() => expect(listUrls).toHaveLength(1))
    settle(() => true)
    await screen.findByText(ALL[0]?.content as string)

    // WAIT FOR A REAL POLL TICK before moving the query. Settling the mount request and
    // clicking straight through leaves nothing in flight to be superseded — the held
    // set is empty at the end and the discard below is never performed. Measured: the
    // plan's ordering reached the last step with `deferred` at length 0.
    await waitFor(() => expect(listUrls.length).toBeGreaterThan(1), {
      timeout: BROWSE_POLL_INTERVAL_MS * 5,
    })
    const stalePoll = deferred.find((entry) => !entry.url.includes("active"))
    // A throw, not an `expect`: the whole point below is to answer THIS request late,
    // and an assertion that only reports would leave the test passing over a discard it
    // never performed.
    if (stalePoll === undefined) throw new Error("no poll request is held in flight")

    // Change the query while that request is still in flight, then land the OLD one last.
    const funnel = await screen.findByRole("button", { name: "Filter status" })
    fireEvent.click(funnel)
    fireEvent.click(await screen.findByRole("checkbox", { name: "active" }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(deferred.some((d) => d.url.includes("active"))).toBe(true))

    settle((url) => url.includes("active"))
    await waitFor(() => expect(screen.queryByText(ALL[0]?.content as string)).toBeNull())
    await screen.findByText(ACTIVE[0]?.content as string)
    expect(screen.getByTestId(TEST_IDS.total).textContent).toBe(String(ACTIVE.length))

    // Now answer the stale request. Nothing may change — and the total is asserted
    // beside the rows because a response is discarded WHOLE or not at all.
    const staleIndex = deferred.indexOf(stalePoll)
    expect(staleIndex).toBeGreaterThanOrEqual(0)
    const [stale] = deferred.splice(staleIndex, 1)
    stale?.resolve({ records: ALL, total: ALL.length, continuation: null })

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByText(ALL[0]?.content as string)).toBeNull()
    expect(screen.getByTestId(TEST_IDS.total).textContent).toBe(String(ACTIVE.length))
  }, 30_000)
})
