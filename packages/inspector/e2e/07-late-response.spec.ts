import {
  BROWSE_PAGE_SIZE,
  browseSeedRecords,
  seedIdsInDefaultOrder,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  asDrawn,
  expectDrawnRows,
  expectPhase,
  openBrowse,
  rowIds,
} from "./helpers"

/** A row id no window of the fixture can contain, so its presence anywhere in the grid
 *  is unambiguous: query A's answer, and nothing else, put it there. */
const SENTINEL_ID = "stale-sentinel"

/** How long query A's answer is held. Long enough that B is applied, requested and
 *  drawn while A is still outstanding — the whole point being that A lands into a page
 *  that has already moved on. */
const LATE_MS = 4_000

/** One read per second across a window that outlasts `LATE_MS` by half again, so the
 *  instant A comes back is inside it wherever it falls. */
const WATCH_TICKS = 6

// D1-DATA-02. A response for a dead revision never reaches the grid: not as a
// replacement, not as an append, and not as a total beside somebody else's rows.
//
// WHICH MECHANISM THIS SEES. The design gives the client two, in order: a new desired
// revision aborts what is in flight (§6.1 "single flight … a new desired revision
// aborts and supersedes anything"), and any response that survives to settle is
// discarded whole unless its revision is still the desired one. Those are not
// separable from here. `browse-machine`'s `query-changed` returns `abort: inFlight !==
// null` and `startRequest` opens every settle with `if (controller.signal.aborted)
// return`, so the abort always fires FIRST at a network seam — there is no fault this
// spec can inject that lets a superseded response reach the reducer at all. What this
// proves is therefore the OUTCOME the requirement is about, over both mechanisms
// together; the revision gate is pinned on its own, without a network, by
// `test/components/browse-machine.test.ts` "flow 6: a stale response completing after
// a query change".
test.describe("scenario 7 — late response", () => {
  test.setTimeout(90_000)

  test("a response for a superseded query never reaches the grid", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // The abort, observed rather than assumed — this is the mechanism the spec's
    // preamble says fires first, and reading it off the network is what turns that
    // claim into an observation instead of a comment.
    const abortedForDeadRevision: string[] = []
    page.on("requestfailed", (request) => {
      if (!request.url().includes("/api/memory/list")) return
      const filters = new URL(request.url()).searchParams.get("filters") ?? ""
      if (filters.includes("superseded") && !filters.includes("episodic")) {
        abortedForDeadRevision.push(request.failure()?.errorText ?? "unknown")
      }
    })

    // Query A (status=superseded) is answered LATE, with an unmistakable sentinel row.
    //
    // The predicate has to exclude B as well as select A. Filters COMPOSE: once the
    // kind funnel is added, B's params — and every 2 s poll B goes on to make — still
    // carry "superseded", so a predicate keyed on that word alone would hold and
    // sentinel-answer the very query whose rows this test is watching.
    // A real fixture record wearing the sentinel id, so the body is a page the client
    // would accept: `fetchBrowsePage` rejects anything that is not one, and a
    // hand-rolled row shape would have this test proving the response VALIDATOR
    // instead of the revision it belongs to.
    const [seedTemplate] = browseSeedRecords()
    if (seedTemplate === undefined) throw new Error("the browse fixture is empty")

    let heldForDeadRevision = 0
    await page.route("**/api/memory/list*", async (route) => {
      const filters = new URL(route.request().url()).searchParams.get("filters") ?? ""
      if (filters.includes("superseded") && !filters.includes("episodic")) {
        heldForDeadRevision += 1
        await new Promise((resolve) => setTimeout(resolve, LATE_MS))
        // Not wrapped: the page has cancelled this request by now, and a Playwright
        // that ever starts rejecting the fulfil of a cancelled one should redden here
        // rather than be swallowed — the swallow would leave the loop below watching a
        // page whose fault was never delivered, which is the one way this scenario can
        // pass while proving nothing.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            records: [
              { ...seedTemplate, id: SENTINEL_ID, content: "this belongs to a dead revision" },
            ],
            total: 1,
            continuation: null,
          }),
        })
        return
      }
      await route.continue()
    })

    await applySetFilter(page, "status", ["superseded"])
    await expectPhase(page, "stale")

    // Supersede it with query B before A can answer.
    await applySetFilter(page, "kind", ["episodic"])

    const matching = seedRecordsMatching({ status: ["superseded"], kind: ["episodic"] })
    // B has to be a real, non-empty narrowing of A, or "B's rows are still B's" would
    // be a claim about an empty grid — which the sentinel would visibly break anyway,
    // but for the wrong reason.
    expect(matching.length).toBeGreaterThan(0)
    expect(matching.length).toBeLessThan(seedRecordsMatching({ status: ["superseded"] }).length)
    const projection = asDrawn(seedIdsInDefaultOrder(matching).slice(0, BROWSE_PAGE_SIZE))
    await expectDrawnRows(page, projection)

    // Watch across the whole window in which A could still land.
    for (let tick = 0; tick < WATCH_TICKS; tick += 1) {
      await page.waitForTimeout(1_000)
      // Positive first, and retried: it settles what the grid IS drawing, which also
      // guarantees the read below is a populated one. Taken the other way round, a
      // read that caught the grid between paints answers `[]` and satisfies "does not
      // contain the sentinel" no matter what arrived.
      await expectDrawnRows(page, projection)
      expect(await rowIds(page)).not.toContain(SENTINEL_ID)
    }

    // The fault was injected. Without this, a change to how filters are spelled in the
    // params would silently stop matching, and the loop above would be watching a page
    // nobody ever attacked.
    expect(heldForDeadRevision).toBeGreaterThan(0)
    // …and the client stopped paying for the dead revision rather than merely ignoring
    // its answer. §6.1 specifies both halves; this is the one that is observable from
    // outside the page.
    expect(abortedForDeadRevision.length).toBeGreaterThan(0)
  })
})
