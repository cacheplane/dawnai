import { TEST_IDS } from "../src/components/memory/test-ids"
import {
  BROWSE_PAGE_SIZE,
  seedIdsInDefaultOrder,
  seedIdsSortedBy,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  drainSeededFetchErrors,
  expectPhase,
  focusRecordCell,
  focusReport,
  grid,
  liveRegionText,
  loadMore,
  n,
  openBrowse,
  sortByHeader,
} from "./helpers"

/** How long the sort's FIRST response is held open.
 *
 *  Sized like `06-desired-fulfilled-mismatch.spec.ts` and `10-selection-scope.spec.ts`
 *  rather than guessed, and for their reason: everything claimed about `stale` is claimed
 *  about the window between the gesture and the answer, each claim inside it costs a CDP
 *  round trip, and on a machine running several suites at once a 1 s hold is a window the
 *  assertions can fall out of — reported then as "the sort already landed" rather than as
 *  anything about staleness. A sort is ONE dataset pivot, so `stale` happens exactly once
 *  and every later poll is `refreshing`: a missed window is a hard failure that no
 *  auto-retry can absorb, which is what makes the margin worth its seconds. */
const HOLD_MS = 5_000

// D1-A11Y-01..04, as one walkthrough: busy, count, position, stale, error and retry
// are all identifiable, and focus is never lost across any of them.
test.describe("scenario 13 — accessibility walkthrough", () => {
  test.setTimeout(120_000)

  test("every lifecycle state is identifiable and focus never leaves the page", async ({
    page,
    consoleErrors,
  }) => {
    await openBrowse(page)

    // CORRECTED (preamble 9): the unscoped browse is GROUPED, so the population is not
    // in `aria-rowcount` there and the first drawn row is a `__group__:` header rather
    // than a record — which the cell click below would then be focusing. Scope to a
    // facet FIRST: that is the branch where §4.5 publishes the population, and it is
    // the branch this walkthrough means. The grouped downgrade is scenario 5's, and
    // the two branches side by side are Task 10's.
    //
    // The PRISTINE seed is the right input for this count even in a whole-suite run:
    // both of scenario 9's writes land in `route=/notes-archive`, so this namespace holds
    // the same records before and after it. WHY both land there, so the next reader does
    // not re-derive it: the drawn projection groups ascending by namespace — `route=/chat`,
    // `route=/notes`, `route=/notes-archive` — and scenario 9 picks the LAST drawn row to
    // forget (archive, being the last group) and the LAST episodic candidate in that
    // projection to approve (archive again, since that group has some). And if either ever
    // moved, this fails loudly rather than silently: the facet button is located by this
    // very number.
    const scoped = seedRecordsMatching({ namespace: "route=/notes" })
    await page.getByRole("button", { name: `route=/notes ${scoped.length}`, exact: true }).click()
    await expectPhase(page, "idle")

    // COUNT + POSITION: the population in aria-rowcount, the position in aria-rowindex.
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(scoped.length + 1))
    const firstRow = grid(page).locator("[data-pretable-row-id]").first()
    await expect(firstRow).toHaveAttribute("aria-rowindex", "2")

    // BUSY: never as aria-busy. The lifecycle is a data attribute plus prose.
    await expect(grid(page)).not.toHaveAttribute("aria-busy", /.*/)

    // Focus a DATA cell, by ID rather than through `firstRow`: the head of the default
    // order is what the seed says it is, so naming it here makes the click's target a
    // checked fact and not whatever the grid happened to draw first.
    //
    // The precondition is asserted rather than assumed — `focusRecordCell` ends by
    // pinning the whole address. §4.2's DK-change focus rule is conditional ("if DOM
    // focus was inside the grid at the change"), so a run that reached the pivot with
    // focus already elsewhere would satisfy the rule vacuously and prove nothing.
    const defaultHead = seedIdsInDefaultOrder(scoped)[0] as string
    await focusRecordCell(page, defaultHead, "status")

    // The query change is a SORT HEADER, and the choice is load-bearing. §4.2's rule
    // only governs a pivot that starts with focus inside the grid, and a funnel does
    // not: pretable's `FilterMenu` is portaled to `<body>` and does not restore focus
    // to its trigger on Escape — recorded in design §1.1 as a pre-existing a11y gap
    // that is explicitly NOT a D1 obligation. Driving this through the funnel would
    // therefore be asserting the exempted path and failing on the exemption. A header
    // click leaves DOM focus on the header cell, which is inside the viewport, which
    // is the rule's stated precondition.
    //
    // `status` rather than `updated`: one click is DESC, and `updated` DESC is already
    // the default order, so that gesture would canonicalize to the query the page is
    // on and pivot no dataset at all.
    //
    // A LATCH on the first sorted request, not a predicate on the param. The browse
    // re-polls every 2 s and every one of those ticks carries `orderBy` too, so holding
    // all of them would leave the page mid-flight for the rest of the walkthrough — the
    // error/retry half below would be read through a permanently delayed transport, and a
    // handler would still be sleeping when `unrouteAll` fires.
    let heldFirstSortedRequest = false
    await page.route("**/api/memory/list*", async (route) => {
      if (!heldFirstSortedRequest && new URL(route.request().url()).searchParams.has("orderBy")) {
        heldFirstSortedRequest = true
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
      }
      await route.continue()
    })
    await sortByHeader(page, "status")

    // STALE: announced once, marked on the DOM, rows still readable.
    await expectPhase(page, "stale")
    await expect.poll(() => liveRegionText(page)).toContain("Updating")
    await expectPhase(page, "idle")
    // The fault was actually injected. Without this the stale claims above are made about
    // a page that was never held, and an `orderBy` this route stopped recognising would
    // take them with it, silently.
    expect(heldFirstSortedRequest).toBe(true)

    // §4.2, "deterministic, never `<body>`": the pivot cleared the old focus and the
    // surface put it on the first data cell of the NEW result — the head of the
    // status-sorted order, which is a DIFFERENT record from the one focus was on. Without
    // that inequality this read would be satisfied by focus that never moved, since the
    // grid re-renders the same coordinates over new rows.
    const sortedHead = seedIdsSortedBy([{ field: "status", dir: "desc" }], scoped)[0] as string
    expect(sortedHead).not.toBe(defaultHead)
    await expect
      .poll(() => focusReport(page))
      .toEqual({ rowId: sortedHead, columnId: "status", inGrid: true, onBody: false })

    // ERROR + RETRY: reachable by keyboard, announced through the polite region.
    await page.unrouteAll()
    let failing = true
    await page.route("**/api/memory/list*", async (route) => {
      if (failing) {
        await route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        return
      }
      await route.continue()
    })
    await page.reload()
    // Pretable's hydration signal before any keystroke: an SSR'd control is painted
    // and inert, and the Enter press below would be silently dropped.
    await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
    await expect(grid(page)).toHaveAttribute("data-pretable-data-phase", "error")
    await expect.poll(() => liveRegionText(page)).toMatch(/could not|error|fail/i)
    failing = false
    await page.getByTestId(TEST_IDS.retryInitial).focus()
    await page.keyboard.press("Enter")
    await expectPhase(page, "idle")
    await expect(loadMore(page)).toContainText(n(BROWSE_PAGE_SIZE))

    drainSeededFetchErrors(consoleErrors, 1)
  })
})
