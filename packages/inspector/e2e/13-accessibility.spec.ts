import { TEST_IDS } from "../src/components/memory/test-ids"
import {
  BROWSE_PAGE_SIZE,
  seedIdsInDefaultOrder,
  seedIdsSortedBy,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  browseRegion,
  expectPhase,
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

/** What the browser logs for the browse response this spec makes the server refuse.
 *  Mirrors `08-refresh-append-failure.spec.ts`: the ENDPOINT is half the match,
 *  because Chromium's message text names only the status. */
function isSeededBrowseFailure(line: string): boolean {
  return /Failed to load resource: .*status of 500/.test(line) && line.includes("/api/memory/list")
}

/** Account for the console errors this spec CAUSED and leave everything else for the
 *  fixture's own teardown gate. `expected` is a floor, not a formality: a fault
 *  injection that silently stopped matching would log nothing, and a drain that merely
 *  filtered would let that pass while proving nothing about the path it claims to walk. */
function drainSeededFetchErrors(consoleErrors: string[], expected: number): void {
  const seeded = consoleErrors.filter(isSeededBrowseFailure)
  const unexpected = consoleErrors.filter((line) => !isSeededBrowseFailure(line))
  consoleErrors.length = 0
  expect(unexpected, "console errors this spec did not inject").toEqual([])
  expect(seeded.length, "seeded 500s the browser logged").toBeGreaterThanOrEqual(expected)
}

/**
 * WHICH cell DOM focus is on, relative to the browse grid — read in ONE page evaluation
 * so every field answers for the same instant.
 *
 * The address, not merely the shape. A report of tag + containment + "is a cell" is
 * identical before and after a dataset pivot, so an expectation written against it cannot
 * tell "focus moved to the first data cell of the NEW result" — which is what §4.2
 * promises — from focus that was re-asserted at the same coordinates over different rows.
 * The row id is what distinguishes them, and it is the seed that says which row that
 * should be.
 *
 * `columnId` is read off the active element itself rather than off an ancestor, so a
 * non-empty value already means the focused node IS the cell. It also excludes the
 * row-select cell, which carries `data-pretable-cell` too and would otherwise satisfy a
 * bare "on a data cell" claim.
 */
async function focusReport(
  page: import("@playwright/test").Page,
): Promise<{ tag: string; inGrid: boolean; rowId: string; columnId: string }> {
  return browseRegion(page).evaluate((region) => {
    const active = document.activeElement as HTMLElement | null
    const viewport = region.querySelector("[data-pretable-scroll-viewport]")
    return {
      tag: active?.tagName ?? "",
      inGrid: viewport?.contains(active ?? null) ?? false,
      rowId: active?.closest("[data-pretable-row-id]")?.getAttribute("data-pretable-row-id") ?? "",
      columnId: active?.getAttribute("data-pretable-column-id") ?? "",
    }
  })
}

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

    // Focus a DATA cell. Not `[data-pretable-cell]` first — that is the row-select
    // checkbox cell, whose click focuses a button and ticks a row instead of moving
    // the grid's own cell focus. A data-cell click is also row ACTIVATION (pretable
    // routes click and Enter/Space alike to `onRowActivate`, and this page opens the
    // detail sheet from it), so the sheet is dismissed again before the query change
    // below, or the rest of this walkthrough would be about the sheet. Escape is the
    // sheet's own documented dismissal and moves no focus of its own.
    await firstRow.locator('[data-pretable-cell][data-pretable-column-id="status"]').click()
    await page.keyboard.press("Escape")
    await expect(page.getByLabel("Close detail")).toHaveCount(0)
    // The precondition, asserted rather than assumed. §4.2's DK-change focus rule is
    // conditional — "if DOM focus was inside the grid at the change" — so a run that
    // reached the pivot with focus already elsewhere would satisfy the rule vacuously
    // and prove nothing.
    //
    // POLLED, and not for symmetry with the read after the pivot: the sheet restores focus
    // to its opener from an unmount layout effect, and `toHaveCount(0)` above confirms only
    // that the sheet is gone — a one-shot read landing in the same tick sees `<body>`.
    const defaultHead = seedIdsInDefaultOrder(scoped)[0] as string
    await expect
      .poll(() => focusReport(page))
      .toEqual({ tag: "DIV", inGrid: true, rowId: defaultHead, columnId: "status" })

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
      .toEqual({ tag: "DIV", inGrid: true, rowId: sortedHead, columnId: "status" })

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
