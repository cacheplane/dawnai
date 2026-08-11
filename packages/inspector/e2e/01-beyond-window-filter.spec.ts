import {
  BROWSE_PAGE_SIZE,
  NEEDLE_ID,
  NEEDLE_TERM,
  seedIdsInDefaultOrder,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  applyTextFilter,
  asDrawn,
  clearFilter,
  expectDrawnRows,
  openBrowse,
  status,
  timeToFulfilled,
  total,
} from "./helpers"

// D1-GRID-01, D1-QUERY-01..08. A matching record outside the initial window appears
// after a server-side filter. If filtering were local, none of these could ever match:
// the record is not in the loaded window when the filter is applied.
test.describe("scenario 1 — beyond-window filter", () => {
  test("a content filter finds a record the first window never loaded", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    // The pre-filter state, asserted POSITIVELY. A bare `expect(await rowIds(page)).not
    // .toContain(NEEDLE_ID)` reads as the stronger claim and is the weaker one: taken
    // before the first paint it answers `[]` and passes without the grid having drawn
    // anything. Pinning the whole drawn head instead cannot pass vacuously, and says the
    // same thing about the needle on the way past.
    await expectDrawnRows(page, asDrawn(seedIdsInDefaultOrder().slice(0, BROWSE_PAGE_SIZE)))
    // The claim the test rests on, and it is about the WINDOW rather than about what the
    // virtualizer drew: the client never RECEIVED the needle, so a local filter would
    // have had nothing to find.
    expect(seedIdsInDefaultOrder().indexOf(NEEDLE_ID)).toBeGreaterThan(BROWSE_PAGE_SIZE)

    const elapsed = await timeToFulfilled(
      page,
      () => applyTextFilter(page, "content", "contains", NEEDLE_TERM),
      () => expectDrawnRows(page, asDrawn([NEEDLE_ID])),
    )
    // One record matches, so this is the whole answer and not a head of it: the loaded
    // count, the matching total and the rows all describe the same single record.
    await expect(status(page)).toHaveText("1 loaded of 1 matching")
    // Design §11 proposes p95 < 300 ms against a local server. This is not that: one
    // sample is not a p95, and `timeToFulfilled` measures the driver as well as the page
    // (its doc lists what rides along). The 200 ms debounce is NOT among the costs — the
    // menu's unmount cleanup applies the pending draft, so Escape flushes it rather than
    // waiting it out. The ceiling is deliberately loose: it catches a regression of KIND
    // (a client round-trip storm), not of degree. Tasks 18 and 21 measure the budget.
    expect(elapsed).toBeLessThan(2_000)
  })

  test("an enum filter narrows to the server's whole matching set, not the window's", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await applySetFilter(page, "status", ["superseded"])
    // The matching set, in the documented default order, truncated to one window —
    // exactly what a server-authoritative first page should be.
    const matching = seedRecordsMatching({ status: ["superseded"] })
    await expectDrawnRows(page, asDrawn(seedIdsInDefaultOrder(matching).slice(0, BROWSE_PAGE_SIZE)))
    // The count that no local filter could produce: the client holds 200 records and
    // this names a population of the whole store, for the query the rows answer.
    expect(matching.length).toBeGreaterThan(BROWSE_PAGE_SIZE)
    await expect(total(page)).toHaveText(matching.length.toLocaleString("en-US"))

    // Clearing restores the unfiltered head — clearing is a new query, not an undo.
    await clearFilter(page, "status")
    await expectDrawnRows(page, asDrawn(seedIdsInDefaultOrder().slice(0, BROWSE_PAGE_SIZE)))
  })
})
