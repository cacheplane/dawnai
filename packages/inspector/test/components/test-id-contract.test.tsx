import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"
import { TEST_IDS } from "../../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT, browseSeedRecords } from "../seed"

/** One page of the fixture plus the honest total — enough for the chrome to render
 *  every state the lane targets. */
function browsePage(offset = 0) {
  const records = browseSeedRecords().slice(offset, offset + BROWSE_PAGE_SIZE)
  return { records, total: BROWSE_SEED_COUNT, continuation: "cursor-1" }
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/memory/stats"))
        return Response.json({
          total: BROWSE_SEED_COUNT,
          byStatus: {},
          byKind: {},
          byNamespace: {},
          bySourceType: {},
        })
      if (url.includes("/api/memory/list")) return Response.json(browsePage())
      return Response.json({})
    }),
  )
})

/** Explicit: this project does not set `globals`, so RTL never registers its own
 *  auto-cleanup. Without this the second `render` stacks on the first, and the
 *  containment check below reads a viewport from one tree and a control from the
 *  other — which passes, while proving nothing. */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("verification DOM contract", () => {
  it("renders every hook the Playwright lane locates by", async () => {
    render(<ListPage />)
    for (const id of [TEST_IDS.status, TEST_IDS.total, TEST_IDS.loadMore, TEST_IDS.liveToggle]) {
      await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy())
    }
  })

  it("puts the load-more control OUTSIDE the grid viewport", async () => {
    render(<ListPage />)
    const control = await screen.findByTestId(TEST_IDS.loadMore)
    const viewport = document.querySelector("[data-pretable-scroll-viewport]")
    expect(viewport).not.toBeNull()
    expect(viewport?.contains(control)).toBe(false)
  })
})
