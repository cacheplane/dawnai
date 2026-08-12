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
    //
    // `list-page` renders one `<section>` per search GROUP, so this is N elements and
    // every one of them holds a local grid. Asserted over ALL of them: `.first()` here
    // would silently narrow the whole test to group one, and the groups are exactly what
    // varies. `TimelineView` renders `<section>` per day too, but it is unmounted while a
    // search is active — and the grid-per-section equality below is what holds that
    // invariant, since a timeline section carries no grid.
    const searchSections = page.locator("main section")
    const searchGrids = gridIn(searchSections)
    // Waited for BEFORE anything is counted: the search input is debounced, so every
    // count taken ahead of the first result answers zero and each `toHaveCount(0)` below
    // would then be a claim about an empty document.
    await expect(searchGrids.first()).toBeVisible()
    const groupCount = await searchSections.count()
    expect(groupCount).toBeGreaterThan(0)
    await expect(searchGrids).toHaveCount(groupCount)

    // No dataState → no body-state wrapper and no body-state block, in ANY group.
    await expect(searchSections.locator("[data-pretable-data-state-wrapper]")).toHaveCount(0)
    await expect(searchSections.locator("[data-pretable-body-state]")).toHaveCount(0)

    // The control, without which the two assertions above are just a claim about a
    // selector that matches nothing anywhere: the grid that DID opt in, in the same
    // document at the same moment, carries the wrapper.
    await expect(browseRegion(page).locator("[data-pretable-data-state-wrapper]")).toHaveCount(1)

    // The per-grid reads, in ONE page evaluation over every group: an absent phase, an
    // absent aria-busy, and local ARIA counting — aria-rowcount is the VISIBLE row count
    // plus the header, not any remote population. A search group is the store's ranked
    // top-8, so every row of it is drawn and the DOM count is the model count; the
    // equality this makes would not hold over a virtualized 200-row window.
    const locals = await searchGrids.evaluateAll((nodes) =>
      nodes.map((node) => ({
        phase: node.getAttribute("data-pretable-data-phase"),
        busy: node.getAttribute("aria-busy"),
        rowCount: node.getAttribute("aria-rowcount"),
        rows: node.querySelectorAll("[data-pretable-row-id]").length,
      })),
    )
    expect(locals.length).toBe(groupCount)
    for (const local of locals) {
      expect(local.phase).toBeNull()
      expect(local.busy).toBeNull()
      expect(local.rows).toBeGreaterThan(0)
      expect(local.rowCount).toBe(String(local.rows + 1))
    }
  })
})
