import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"
import { TEST_IDS } from "../../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT, browseSeedRecords } from "../seed"

/** One page of the fixture plus the honest total — enough for the chrome to render
 *  every state the lane targets. */
function browsePage() {
  return {
    records: browseSeedRecords().slice(0, BROWSE_PAGE_SIZE),
    total: BROWSE_SEED_COUNT,
    continuation: "cursor-1",
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/memory/stats"))
        return jsonResponse({
          total: BROWSE_SEED_COUNT,
          byStatus: {},
          byKind: {},
          byNamespace: {},
          bySourceType: {},
        })
      if (url.includes("/api/memory/list")) return jsonResponse(browsePage())
      // 404 rather than an empty 200: an endpoint this file has not stubbed must fail
      // where it is called. A `{}` body is a shape every reader here parses into "no
      // rows, no total", which reads as a missing HOOK several assertions later.
      return jsonResponse({ error: "unstubbed endpoint" }, 404)
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

/**
 * Every id in the module, decided.
 *
 * `"mounted"` means the hook is in the DOM of a `ListPage` whose first responses
 * succeeded, which is what the first test renders. Every other entry names the
 * condition that produces the hook — each needs a failure, a selection or a paused
 * poll this file does not stage, and they are reached by the component suites and by
 * the Playwright scenarios instead.
 *
 * Typed on `keyof typeof TEST_IDS`, so an id added to the module without a decision
 * fails `pnpm typecheck`; the parity test below catches the same thing under the
 * runner. An id nobody decided is the failure mode this module exists to prevent:
 * the lane trusts it and finds out fifteen scenarios later, as a locator timeout.
 */
const COVERAGE: Record<keyof typeof TEST_IDS, "mounted" | string> = {
  browseRegion: "mounted",
  status: "mounted",
  total: "mounted",
  loadMore: "mounted",
  liveToggle: "mounted",
  // In the document from the first paint and `hidden` until a search runs. Presence
  // is what a rename breaks; `view-scope.test.tsx` reads what it says.
  searchScopeNote: "mounted",
  asOf: "only while polling is paused",
  retryInitial: "only in the error phase, and only while the grid is visible",
  bannerRefresh: "only once a poll tick has failed",
  bannerLoadMore: "only once an append has failed",
  bannerRetry: "only while a browse request's failure is banner-borne",
  bulkBar: "only while rows are ticked",
  bulkError: "only once a bulk mutation has partly failed",
}

const MOUNTED_IDS = Object.entries(COVERAGE).flatMap(([key, when]) =>
  when === "mounted" ? [TEST_IDS[key as keyof typeof TEST_IDS]] : [],
)

describe("verification DOM contract", () => {
  it("renders every hook the Playwright lane locates by", async () => {
    // A loop over an empty list passes: this test's subject is the LIST as much as
    // the assertions, and the list is derived.
    expect(MOUNTED_IDS.length).toBeGreaterThan(0)
    render(<ListPage />)
    for (const id of MOUNTED_IDS) {
      await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy())
    }
  })

  it("leaves no id in the module undecided", () => {
    expect(Object.keys(COVERAGE).sort()).toEqual(Object.keys(TEST_IDS).sort())
  })

  it("puts the load-more control OUTSIDE the grid viewport", async () => {
    render(<ListPage />)
    const control = await screen.findByTestId(TEST_IDS.loadMore)
    // Scoped to the browse region and pinned to exactly one. A search renders a grid
    // — so a second viewport — beside this one, and a document-wide first match could
    // read the viewport this control was never in danger of being inside, passing for
    // a reason that has nothing to do with the placement §9.2 asks for.
    const viewports = screen
      .getByTestId(TEST_IDS.browseRegion)
      .querySelectorAll("[data-pretable-scroll-viewport]")
    expect(viewports).toHaveLength(1)
    expect(viewports[0]?.contains(control)).toBe(false)
  })
})
