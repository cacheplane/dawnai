import { TEST_IDS } from "../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  browseRegion,
  expectPhase,
  loadMore,
  MIN_RENDERED_ROWS,
  n,
  openBrowse,
  openFilterMenu,
  rowIds,
  status,
  waitOnePollPeriod,
} from "./helpers"

/** "400 loaded", not "400": the status bar states two numbers in one sentence and
 *  the second one is the population, which differs between a solo run of this file
 *  (a pristine 1,250) and a whole-suite run (scenario 9 has removed one by then). */
function loadedText(count: number): string {
  return `${n(count)} loaded`
}

// View-scope matrix (§8.2) and Flow 10. Browse controls never appear to constrain a
// view that ignores them, and leaving browse does not destroy the browse dataset.
test.describe("scenario 12 — view isolation", () => {
  test.setTimeout(90_000)

  test("browse-only controls are unreachable WITH A REASON in the search view", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // NOTE (corrected after slice 4 shipped): slice 4 chose to keep the browse
    // grid MOUNTED but `hidden` across view switches, rather than disabling its
    // funnels in place. So during search the funnel is not merely aria-disabled
    // — it is inside a hidden region and not reachable at all. Assert the
    // structure that actually ships:
    //   1. the browse region is hidden while a search is active,
    //   2. no funnel is reachable from it (hidden content is out of the tab
    //      order and out of the accessibility tree),
    //   3. the scope note still tells the user why.
    // If a future slice reverts to in-place disabling, restore the
    // aria-disabled + focusable + aria-describedby assertions below, which are
    // the right shape for THAT structure:
    //   await expect(funnel).toHaveAttribute("aria-disabled", "true")
    //   await funnel.focus(); await expect(funnel).toBeFocused()

    // Opened BEFORE the search, and this is the whole point of the popover
    // assertion below: pretable portals the panel to `<body>`, which is outside
    // everything `hidden` reaches, so the same assertion taken with no panel open
    // would hold just as well over a page that never closes one.
    await openFilterMenu(page, "status")
    await expect(page.getByRole("dialog", { name: "Filter status", exact: true })).toBeVisible()

    // `fill` focuses and types; it dispatches no pointer event, so pretable's own
    // dismiss-on-outside-pointerdown never fires and closing the panel is left
    // entirely to the page. That is the keyboard user's path, and it is the one
    // the effect under test exists for.
    await page.getByLabel("Search memories").fill("acme")

    await expect(browseRegion(page)).toBeHidden()
    await expect(page.getByRole("button", { name: "Filter status", exact: true })).toHaveCount(0)
    // And no popover survived the hide: pretable portals them to document.body,
    // so an open funnel would otherwise float over the search results.
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByTestId(TEST_IDS.searchScopeNote)).toBeVisible()
  })

  test("a search hides the browse dataset without destroying any of it", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await loadMore(page).click()
    // CORRECTED (preamble 9): the loaded count comes off the STATUS BAR, never off
    // `rowIds` — the DOM holds ~19 rows however many the client is holding, so the
    // rows alone cannot tell one resident window from two.
    await expect(status(page)).toContainText(loadedText(BROWSE_PAGE_SIZE * 2))
    await expectPhase(page, "idle")
    const loaded = await rowIds(page)
    // A floor, so the comparisons below are between two real windows: `rowIds`
    // does not retry, and an empty read would make every later `toEqual` agree
    // with itself about nothing.
    expect(loaded.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)

    await page.getByLabel("Search memories").fill("acme")
    await expect(browseRegion(page)).toBeHidden()
    // The whole status bar goes with it: those two numbers describe the browse
    // population, and the search is not it.
    await expect(status(page)).toHaveCount(0)

    await page.getByLabel("Search memories").fill("")
    await expect(browseRegion(page)).toBeVisible()

    // Flow 10 at full strength. A search does not touch the browse query, so the
    // dataset identity here is the one both windows were loaded under: BOTH are
    // still resident, and the head of the model is untouched.
    await expect(status(page)).toContainText(loadedText(BROWSE_PAGE_SIZE * 2))
    await expect.poll(() => rowIds(page)).toEqual(loaded)
    await expectPhase(page, "idle")

    // Polling really did come back, and the refresh it sends re-derives the whole
    // resident span rather than the first page of it — one real tick, request and
    // response both, and the client still holds two windows afterwards.
    await waitOnePollPeriod(page)
    await expect(status(page)).toContainText(loadedText(BROWSE_PAGE_SIZE * 2))
    await expect.poll(() => rowIds(page)).toEqual(loaded)
  })

  test("the timeline is a different dataset, so neither view inherits the other's walk", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await loadMore(page).click()
    await expect(status(page)).toContainText(loadedText(BROWSE_PAGE_SIZE * 2))
    await expectPhase(page, "idle")
    const loaded = await rowIds(page)
    expect(loaded.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)

    await page.getByRole("button", { name: "timeline", exact: true }).click()
    await expect(browseRegion(page)).toBeHidden()
    await page.getByRole("button", { name: "list", exact: true }).click()
    await expect(browseRegion(page)).toBeVisible()

    // Flow 10: the grid is hidden, not unmounted. The head of the model comes back
    // identical and the phase settles without the surface ever having been rebuilt.
    await expect.poll(() => rowIds(page)).toEqual(loaded)
    await expectPhase(page, "idle")

    // …and the WALK does not come back, which is the same design decision seen from
    // the other side: `view` is part of the canonical query, so this round trip is a
    // dataset pivot and the list view starts its walk again at one window. Stated in
    // `canonical-query.ts` — "a switch that inherited them would resume another
    // surface's walk" — and in Flow 10, which says search and timeline never inherit
    // the browse continuation.
    //
    // Pinned HERE because it is invisible everywhere else: the drawn head is
    // identical at 200 resident and at 400, so nothing above this line can tell the
    // two apart, and a user who paged to 400, glanced at the timeline and came back
    // is silently holding half of what they had. A slice that decides to carry the
    // walk across the toggle must move this expectation deliberately.
    await expect(status(page)).toContainText(loadedText(BROWSE_PAGE_SIZE))
    await expect(status(page)).not.toContainText(loadedText(BROWSE_PAGE_SIZE * 2))
  })
})
