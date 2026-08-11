import { expect, test } from "./fixtures"
import { browseRegion, gridIn, openBrowse } from "./helpers"

// D1-GRID-04. The search view renders the SAME MemoryGrid component with no
// `processing`, no `resultMeta` and no `dataState` — an ordinary complete in-memory
// Pretable consumer. It must behave exactly as it did before slice 1 existed.
test.describe("scenario 14 — local regression", () => {
  test("a grid that opted into nothing gets no lifecycle presentation at all", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await page.getByLabel("Search memories").fill("acme threshold 1")

    // SCOPED to the search surface, and the scope is the test rather than a detail of
    // it. Slice 4 keeps the browse grid MOUNTED-and-`hidden` beside the results, and
    // that grid DOES carry lifecycle chrome — pretable latches its body-state wrapper
    // on for the life of a surface that was ever handed a `dataState`. A
    // document-wide query for the ABSENCE of that chrome would therefore answer about
    // the wrong grid and fail for a reason with nothing to do with the local one.
    // `<section>` is the search results' own element and nothing else on this page
    // renders one while a search is active (the timeline is not mounted then).
    const searchSurface = page.locator("main section").first()
    const searchGrid = gridIn(searchSurface)
    await expect(searchGrid).toBeVisible()

    // No dataState → no phase attribute, no body-state wrapper, no body-state block.
    await expect(searchGrid).not.toHaveAttribute("data-pretable-data-phase", /.*/)
    await expect(searchSurface.locator("[data-pretable-data-state-wrapper]")).toHaveCount(0)
    await expect(searchSurface.locator("[data-pretable-body-state]")).toHaveCount(0)

    // The control, without which the three assertions above are just a claim about a
    // selector that matches nothing anywhere: the grid that DID opt in, in the same
    // document at the same moment, carries the wrapper.
    await expect(browseRegion(page).locator("[data-pretable-data-state-wrapper]")).toHaveCount(1)

    // Local ARIA semantics: aria-rowcount is the VISIBLE row count plus the header,
    // not any remote population. A search group is the store's ranked top-8, so every
    // row of it is drawn and the DOM count is the model count — the equality this
    // makes would not hold over a virtualized 200-row window.
    const visible = await searchGrid.locator("[data-pretable-row-id]").count()
    expect(visible).toBeGreaterThan(0)
    await expect(searchGrid).toHaveAttribute("aria-rowcount", String(visible + 1))
    await expect(searchGrid).not.toHaveAttribute("aria-busy", /.*/)
  })
})
