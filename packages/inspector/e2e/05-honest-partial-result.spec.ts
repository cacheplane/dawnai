import {
  BROWSE_PAGE_SIZE,
  BROWSE_RESIDENT_CAP,
  BROWSE_SEED_COUNT,
  seedIdsInDefaultOrder,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  asDrawn,
  expectDrawnRows,
  expectPhase,
  grid,
  liveRegionText,
  loadMore,
  openBrowse,
  scrollTop,
  status,
} from "./helpers"

/** The page formats every count through `toLocaleString`/`Intl.NumberFormat`, and
 *  `playwright.config` pins the runner to `en-US` for exactly this reason. Expectations
 *  go through the same formatter rather than through `String(n)`, which would look right
 *  and never match a four-digit count. */
function n(value: number): string {
  return value.toLocaleString("en-US")
}

/** `BrowseStatusBar`'s whole sentence — the two numbers this scenario is about, in the
 *  one place a sighted user reads them. */
function statusText(loaded: number, matching: number): string {
  return `${n(loaded)} loaded of ${n(matching)} matching`
}

async function scrollGridTo(page: Parameters<typeof grid>[0], offset: number): Promise<void> {
  await grid(page).evaluate((node, top) => {
    node.scrollTop = top
  }, offset)
}

// D1-GRID-06, D1-DATA-07, D1-COUNT-01. The UI distinguishes LOADED records from
// MATCHING records and can retrieve another window without losing what it holds.
test.describe("scenario 5 — honest partial result", () => {
  test.setTimeout(90_000)

  test("loaded count and matching total are separately stated, and load-more appends", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    const order = seedIdsInDefaultOrder()
    const firstWindow = asDrawn(order.slice(0, BROWSE_PAGE_SIZE))
    await expectDrawnRows(page, firstWindow)

    // Both numbers, in one sentence, and demonstrably different: what the client HOLDS
    // and what the store MATCHES. A UI that quoted only one of them satisfies neither
    // half of this.
    expect(BROWSE_PAGE_SIZE).toBeLessThan(BROWSE_SEED_COUNT)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))

    // Design §4.5: grouping destroys the loaded-index → dataset-position mapping, so
    // `aria-rowcount` REVERTS to the loaded model — group headers included — and the
    // population honesty moves to the status chrome asserted above. The unscoped browse
    // groups by namespace, so the downgraded value is the correct one here, and it is
    // pinned rather than skipped: publishing the population under grouping would be the
    // dishonest answer. Scenario 4, where the facet turns grouping off, is where
    // `total + 1` is claimed.
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(firstWindow.length + 1))

    // Scrolled off the top BEFORE the append. Taken at rest the offset is 0, and an
    // append that reset the scroll box to 0 would satisfy a before/after comparison of
    // two zeroes while having moved the user's place.
    await scrollGridTo(page, 400)
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0)
    const offsetBefore = await scrollTop(page)

    await loadMore(page).click()
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, BROWSE_SEED_COUNT))
    await expectPhase(page, "idle")
    // Design §11: an append moves nothing, because the rows arrive BELOW the viewport.
    expect(await scrollTop(page)).toBe(offsetBefore)
    // The announcement carries the DELTA and the SCOPE, not a bare number — asserted as
    // the whole sentence, since "400" alone appears in any count-shaped message.
    // `toContain` rather than an equality: the region is one permanent node and its
    // lifecycle slot is not the only thing that can ever be in it.
    await expect
      .poll(() => liveRegionText(page))
      .toContain(
        `Loaded ${n(BROWSE_PAGE_SIZE)} more. ${statusText(BROWSE_PAGE_SIZE * 2, BROWSE_SEED_COUNT)}.`,
      )

    // What it HOLDS, not just what it counted: the extended window is the same order
    // continued, so the head is unchanged and the second page follows the first. Read
    // back at the top because the grid virtualizes — the rows this compares are only in
    // the document while the viewport is over them.
    await scrollGridTo(page, 0)
    await expectDrawnRows(page, asDrawn(order.slice(0, BROWSE_PAGE_SIZE * 2)))
  })

  test("load-more stops at the resident cap and says why", async ({ page, consoleErrors }) => {
    void consoleErrors
    await openBrowse(page)

    // Progress is measured off the STATUS BAR, never off the DOM: the grid virtualizes,
    // so at no point are a thousand rows in the document and a row-count assertion would
    // be counting the viewport. The loaded count is exactly what this chrome states.
    for (let loaded = BROWSE_PAGE_SIZE; loaded < BROWSE_RESIDENT_CAP; loaded += BROWSE_PAGE_SIZE) {
      await loadMore(page).click()
      await expect(status(page)).toHaveText(
        statusText(loaded + BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT),
      )
    }
    // The cap is a stop, not a slowdown: it lands ON the cap rather than past it, and
    // the store still has records the client can never hold at once.
    await expect(status(page)).toHaveText(statusText(BROWSE_RESIDENT_CAP, BROWSE_SEED_COUNT))
    expect(BROWSE_RESIDENT_CAP).toBeLessThan(BROWSE_SEED_COUNT)

    // The control STAYS MOUNTED at the cap and is inactive. `toBeDisabled` is satisfied
    // here through `aria-disabled` — the button is deliberately never natively
    // `disabled`, which is the next assertion's subject.
    await expect(loadMore(page)).toBeVisible()
    await expect(loadMore(page)).toBeDisabled()
    // Design §9.2: a native `disabled` removes the control from the tab order and drops
    // keyboard focus to `<body>` at the exact moment the user finished paging. Proven
    // behaviourally rather than by the absence of an attribute — a natively disabled
    // button cannot take focus, so this fails if the implementation ever swaps them.
    await loadMore(page).focus()
    await expect(loadMore(page)).toBeFocused()

    // The label explains the stop with both numbers…
    await expect(loadMore(page)).toHaveText(
      `First ${n(BROWSE_RESIDENT_CAP)} of ${n(BROWSE_SEED_COUNT)} loaded`,
    )
    // …and the reason it points at says what to do instead. Read through
    // `aria-describedby` because that association IS the requirement: the sentence is
    // the only channel a keyboard or AT user has for why the control went quiet.
    // Matched as an attribute rather than an `#id` selector — React's `useId` emits
    // characters that are not valid in one.
    const reasonId = await loadMore(page).getAttribute("aria-describedby")
    expect(reasonId).not.toBeNull()
    await expect(page.locator(`[id="${reasonId}"]`)).toHaveText(
      `The Inspector holds ${n(BROWSE_RESIDENT_CAP)} records at a time — narrow the filters to reach the rest.`,
    )
  })
})
