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
  expectDrawnRunAround,
  expectPhase,
  grid,
  liveRegionText,
  loadMore,
  n,
  openBrowse,
  scrollGridTo,
  scrollTop,
  status,
  statusText,
} from "./helpers"

// D1-GRID-06, D1-DATA-07, D1-COUNT-01. The UI distinguishes LOADED records from
// MATCHING records and can retrieve another window without losing what it holds.
test.describe("scenario 5 — honest partial result", () => {
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
    //
    // A single unretried snapshot, which the settling note on `rowIds` says is normally
    // a race. Safe HERE for a reason that does not generalise: an append only grows
    // `scrollHeight`, and the browser re-clamps `scrollTop` only when it shrinks. A
    // scenario that asserts this shape after a REPLACE has to poll instead.
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

    // What it HOLDS, not just what it counted. Three reads, because the count channels
    // above are all one channel: a page that incremented its own counter and dropped the
    // records satisfies every assertion so far.
    const both = asDrawn(order.slice(0, BROWSE_PAGE_SIZE * 2))

    // The rows reached the GRID's model rather than only the page's chrome. Under
    // grouping `aria-rowcount` IS the loaded model's size (the downgrade pinned above),
    // so this is an independent witness to the same append and the only one that is not
    // a number the status bar computed.
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(both.length + 1))

    // The head is UNCHANGED — an append, not a replace. This is all a read at the top
    // can settle: the viewport draws ~19 rows and the one-window and two-window
    // projections share a 54-row prefix, so it passes against either.
    await scrollGridTo(page, 0)
    await expectDrawnRows(page, both)

    // …and the second window CONTINUES the first, which is only testable AT THE SEAM.
    // The seam is not at row 200: grouping files each arriving record under its own
    // namespace, so window 2's rows land at the END OF THEIR GROUP and the first of them
    // sits inside the first group. Taking it as "the first drawn row the append
    // contributed" finds that position from the projection instead of naming a row.
    //
    // What this settles, exactly: the second window's RECORDS are resident, in the
    // server's order. Residency is attributable to the click — the background refresh
    // asks for a limit of the RESIDENT COUNT (`refreshWindow`), so a poll can re-anchor
    // rows it already has but can never fetch a window the client did not page into.
    // ORDER is attributable only for ~2 s: a refresh places its response wholesale at
    // the front, so an append that put the right records in the wrong place is corrected
    // by the next tick and is out of this scenario's reach. Pinning that needs the poll
    // suppressed, which is scenario 7's apparatus, not this one's.
    const appended = new Set(order.slice(BROWSE_PAGE_SIZE, BROWSE_PAGE_SIZE * 2))
    const seam = both.find((id) => appended.has(id))
    if (seam === undefined) throw new Error("the seed's second window contributes no drawn row")
    await expectDrawnRunAround(page, both, seam)
  })

  test("load-more stops at the resident cap and says why", async ({ page, consoleErrors }) => {
    void consoleErrors
    // Four sequential round-trips to the store, each gated on its own `expect` — so the
    // worst case this test can legitimately reach is four times the 10 s expect budget
    // plus the page load, which is over the file's 60 s default. Raised on THIS test
    // only: the append test above makes one round-trip and gains nothing from a longer
    // budget except a slower report when it genuinely hangs.
    test.setTimeout(90_000)
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
