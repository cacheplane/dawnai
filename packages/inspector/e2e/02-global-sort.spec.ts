import {
  BROWSE_PAGE_SIZE,
  browseSeedRecords,
  seedIdsInDefaultOrder,
  seedIdsSortedBy,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  asDrawn,
  expectDrawnRows,
  openBrowse,
  recordCells,
  recordsOnly,
  sortByHeader,
  sortHeader,
  timeToFulfilled,
} from "./helpers"

// D1-QUERY-09, D1-QUERY-10. Sorting returns the GLOBALLY correct first window with a
// deterministic tie-break — not a re-sort of the 200 rows already loaded, which would
// present a recency-biased sample as a confidence-sorted result.
test.describe("scenario 2 — global sort", () => {
  test("confidence DESC returns the global head with an id tie-break", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // The whole store in confidence order, truncated to one window. Computed over all
    // 1250 records, which is what makes it a claim about the SERVER's answer.
    const expected = asDrawn(
      seedIdsSortedBy([{ field: "confidence", dir: "desc" }]).slice(0, BROWSE_PAGE_SIZE),
    )
    // What a LOCAL re-sort of the window already on screen would have drawn. Pinned so
    // the assertion below cannot be satisfied under either authority: if the two agreed
    // at the top, this scenario would prove nothing, and it would say so here rather
    // than pass quietly.
    const firstWindow = new Set(seedIdsInDefaultOrder().slice(0, BROWSE_PAGE_SIZE))
    const localReSort = asDrawn(
      seedIdsSortedBy(
        [{ field: "confidence", dir: "desc" }],
        browseSeedRecords().filter((record) => firstWindow.has(record.id)),
      ),
    )
    expect(recordsOnly(localReSort)[0]).not.toEqual(recordsOnly(expected)[0])

    // One click, because pretable's cycle is none → desc → asc → none.
    const elapsed = await timeToFulfilled(
      page,
      () => sortByHeader(page, "confidence"),
      () => expectDrawnRows(page, expected),
    )
    // Read back rather than assumed: an assertion about a descending window means
    // nothing if the click actually produced an ascending one.
    await expect(sortHeader(page, "confidence")).toHaveAttribute("aria-sort", "descending")
    // A ceiling of KIND, not of degree — `timeToFulfilled`'s doc lists what the number
    // carries besides the page, and 01 states the §11 position this shares.
    expect(elapsed).toBeLessThan(2_000)

    // Computed, never transcribed (`seed.ts`'s convention): `0.98` is the store's
    // maximum only for as long as the seed says so.
    const maxConfidence = Math.max(...browseSeedRecords().map((record) => record.confidence))
    // A guard on the scenario's own premise, not a claim about the product. Under
    // grouping the TOP DRAWN row is the head of the alphabetically-first namespace
    // bucket, so its carrying the store's maximum is a property of this seed rather than
    // of the query — pinned here so a seed change reddens with that sentence instead of
    // reddening the page assertion below with a bare value diff.
    const byId = new Map(browseSeedRecords().map((record) => [record.id, record.confidence]))
    expect(byId.get(recordsOnly(expected)[0] ?? "")).toBe(maxConfidence)

    // Taken off the PAGE, and the one thing the id list above cannot show: the cells the
    // user actually reads carry the values those ids have, through the column's own
    // `toFixed(2)` format. Auto-retried by `toHaveText`, so it settles rather than races.
    await expect(recordCells(page, "confidence").first()).toHaveText(maxConfidence.toFixed(2))
  })

  test("updated ASC returns the global tail, with the id tie-break still ascending", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    const ascendingWindow = seedIdsSortedBy([{ field: "updatedAt", dir: "asc" }]).slice(
      0,
      BROWSE_PAGE_SIZE,
    )
    // Ascending is NOT the default order played backwards, and this pins the
    // difference: ten records share every `updatedAt`, and the store terminates on
    // `id ASC` whichever way the key runs. A server that reversed its terminator along
    // with its key would return the reversed list — same records, different order —
    // and would satisfy any assertion that only checked WHICH records are in the
    // window.
    expect(ascendingWindow).not.toEqual(
      [...seedIdsInDefaultOrder()].reverse().slice(0, BROWSE_PAGE_SIZE),
    )

    // Twice, with the intermediate state pinned rather than passed through: the first
    // click is descending. There is nothing in the ROWS to settle on between the two —
    // `updatedAt DESC` is already the default order, so the descending window is the one
    // on screen — which means the second click does land while the first sort's request
    // may still be in flight. That path is real and this test does cover it; the
    // assertion at the end is on the FULFILLED ascending window, so a stale answer
    // winning the race fails here rather than passing quietly.
    await sortByHeader(page, "updated")
    await expect(sortHeader(page, "updated")).toHaveAttribute("aria-sort", "descending")
    await sortByHeader(page, "updated")
    await expect(sortHeader(page, "updated")).toHaveAttribute("aria-sort", "ascending")
    await expectDrawnRows(page, asDrawn(ascendingWindow))
  })
})
