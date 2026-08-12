import { BROWSE_PAGE_SIZE, seedIdsInDefaultOrder, seedRecordsMatching } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  asDrawn,
  expectDrawnRows,
  expectPhase,
  grid,
  liveRegionText,
  openBrowse,
  rowIds,
  status,
  total,
} from "./helpers"

/** How long query B's first response is held open.
 *
 *  Generous on purpose. Everything this scenario claims is claimed about the window
 *  between the gesture and the answer, and each claim inside it costs a CDP round
 *  trip — on a machine running several suites at once, a 1 s hold is a window the
 *  assertions can fall out of, and the failure then reads as "B already landed"
 *  rather than as anything about staleness. Nothing here waits out the whole hold:
 *  the settle assertions poll. */
const HOLD_MS = 5_000

// D1-DATA-01, D1-UX-02. The controls show query B while query A's rows are still on
// screen; A is visibly stale, and every number beside it still belongs to A.
test.describe("scenario 6 — desired/fulfilled mismatch", () => {
  test("query A's rows stay visible, marked stale, and are never presented as B's", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // The unscoped browse groups and virtualizes (preamble 9), so `aIds` is what the
    // viewport DREW — a prefix of the projection, not the 200-row window. That is
    // exactly what the "A's rows are intact" comparisons below need it to be: a read
    // of the same channel, taken before and during, with nothing in between that
    // could move the scroll box.
    const aProjection = asDrawn(seedIdsInDefaultOrder().slice(0, BROWSE_PAGE_SIZE))
    await expectDrawnRows(page, aProjection)
    const aIds = await rowIds(page)
    const aTotal = await total(page).innerText()

    // Hold the FIRST request that carries a `filters` param — query B's initial fetch.
    // A latch rather than a predicate on the param alone: the browse re-polls every 2 s
    // and every one of those ticks carries B's filters too, so holding all of them
    // would leave the page permanently mid-flight and the settle assertions below
    // would be timing the fault injection instead of the product.
    let heldFirstFilteredRequest = false
    await page.route("**/api/memory/list*", async (route) => {
      if (!heldFirstFilteredRequest && new URL(route.request().url()).searchParams.has("filters")) {
        heldFirstFilteredRequest = true
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
      }
      await route.continue()
    })

    await applySetFilter(page, "status", ["active"])

    // MID-FLIGHT. The claim is about a state the page is passing THROUGH, so nothing here
    // may be satisfiable after the hold expires — and nothing here is, because every read
    // below is written against a value that MOVES when it does: the phase leaves `stale`,
    // the total becomes B's, the "Updating results…" node unmounts, pretable replaces the
    // live region's text with the settled results announcement, and the rowcount becomes
    // B's (a different number — guarded where `bMatching` is computed, since that is what
    // keeps the rowcount read from being satisfiable on both sides of the hold).
    //
    // That is what makes the retries here safe rather than permissive: an auto-retrying
    // assertion cannot outlast the window, so its retry only ever absorbs a slow read, and
    // each read below costs a CDP round trip. `HOLD_MS` is sized for the whole block.
    await expectPhase(page, "stale")
    // Polled for that reason, and no weaker for it: after the hold these rows are B's. A
    // one-shot read has the failure `rowIds` warns about, in reverse — a read taken
    // between paints answers `[]` and reddens a page that is entirely correct.
    await expect.poll(() => rowIds(page)).toEqual(aIds)
    // The total is A's, on its own node, exactly — not "some number". A UI that
    // published B's population beside A's rows would be answering two questions with
    // one picture, and `toContainText` on the sentence would not catch a value that
    // merely contains A's digits.
    await expect(total(page)).toHaveText(aTotal)
    // …and the surface SAYS it is out of date, in both channels: the visible chrome
    // and the single permanent polite region.
    await expect(status(page)).toContainText("Updating results…")
    await expect.poll(() => liveRegionText(page)).toContain("Updating results…")
    // A stale grid still publishes an honest rowcount. This browse is unscoped, so
    // §4.5 has already downgraded the attribute to the loaded model (preamble 9) and
    // the population honesty lives on the `total` node asserted above; what this pins
    // is that the stale tick did not MOVE the number — it is still the one A had.
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(aProjection.length + 1))

    // It settles into B, and only then does anything move.
    const bMatching = seedRecordsMatching({ status: ["active"] })
    // Both halves have to bite, or "the total moved" would be provable by a UI that
    // never changed it: B must be a narrowing, and it must be a non-empty one.
    expect(bMatching.length).toBeGreaterThan(0)
    expect(bMatching.length).toBeLessThan(seedIdsInDefaultOrder().length)
    const bProjection = asDrawn(seedIdsInDefaultOrder(bMatching).slice(0, BROWSE_PAGE_SIZE))
    // Both windows are a full page, so the projections differ only in how many namespaces
    // they span — a fixture that ever made those counts agree would leave B's settled
    // rowcount satisfying the mid-flight assertion above, and that read would quietly stop
    // distinguishing the two sides of the hold.
    expect(bProjection.length).not.toBe(aProjection.length)
    await expectPhase(page, "idle")
    await expectDrawnRows(page, bProjection)
    // Positive first, so this negative one cannot be satisfied by an empty read.
    expect(await rowIds(page)).not.toEqual(aIds)
    await expect(total(page)).toHaveText(bMatching.length.toLocaleString("en-US"))
    await expect(status(page)).not.toContainText("Updating results…")

    // The fault was actually injected. Without this the whole scenario passes on a
    // page that never asked for B — a filter param this route stopped recognising
    // would take every mid-flight claim above with it, silently.
    expect(heldFirstFilteredRequest).toBe(true)
  })
})
