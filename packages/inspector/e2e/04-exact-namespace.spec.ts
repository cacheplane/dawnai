import {
  BROWSE_PAGE_SIZE,
  browseSeedRecords,
  seedIdsInDefaultOrder,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import { expectDrawnRows, grid, openBrowse, rowIds, status } from "./helpers"

/** The facet under test and the prefix sibling it must not sweep in. The seed exists to
 *  bait exactly this trap (`seed.ts`'s `namespaceFor`). */
const NAMESPACE = "route=/notes"
const SIBLING = "route=/notes-archive"

// D1-QUERY-08, D1-COUNT-01. The facet rail sends an EXACT namespace, so prefix
// siblings are excluded server-side — and the total it displays counts the same set
// the rows come from.
test.describe("scenario 4 — exact namespace", () => {
  test("selecting route=/notes excludes route=/notes-archive and its total matches", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    const matching = seedRecordsMatching({ namespace: NAMESPACE })
    const archiveIds = new Set(seedRecordsMatching({ namespace: SIBLING }).map((r) => r.id))
    // The trap has to be BAITED, and baited WHERE THE TEST LOOKS. A non-empty archive is
    // not enough on its own: the assertions below read one window, so a prefix query
    // whose first window happened to be archive-free would satisfy them. This pins that
    // the prefix answer differs inside the very window the grid draws.
    expect(archiveIds.size).toBeGreaterThan(0)
    const prefixWindow = seedIdsInDefaultOrder(
      seedRecordsMatching({ namespacePrefix: NAMESPACE }),
    ).slice(0, BROWSE_PAGE_SIZE)
    expect(prefixWindow.some((id) => archiveIds.has(id))).toBe(true)

    // The rail labels each facet `<namespace> <count>`, so the accessible name carries
    // both. The count is COMPUTED here rather than transcribed, which makes this click
    // also pin the claim the rail's own note makes: `stats.byNamespace` is a bare
    // `GROUP BY` over the whole table, so the number beside a facet is the global
    // census and not the current query's.
    //
    // `exact`, because `route=/notes` is a PREFIX of the sibling's label: substring
    // matching resolves to both buttons and fails on strict mode.
    await page.getByRole("button", { name: `${NAMESPACE} ${matching.length}`, exact: true }).click()

    // FLAT, not `asDrawn`: `list-page` passes `groupByNamespace={namespace === undefined}`,
    // so selecting a facet turns grouping off — every row would otherwise sit under a
    // single header restating the facet. An `asDrawn` expectation here would assert a
    // group row the grid is correct not to draw.
    await expectDrawnRows(page, seedIdsInDefaultOrder(matching).slice(0, BROWSE_PAGE_SIZE))

    // The exclusion in its own words rather than left implied by the list above. Safe as
    // a negative only because `expectDrawnRows` has already settled a POSITIVE claim
    // about this same read — taken alone, before the first paint, it would pass against
    // an empty grid.
    expect((await rowIds(page)).filter((id) => archiveIds.has(id))).toEqual([])

    // D1-COUNT-01: the total belongs to the same query as the rows. Both numbers, so a
    // total quoted for the unfiltered store — or for a prefix match — reddens here.
    await expect(status(page)).toHaveText(
      `${Math.min(BROWSE_PAGE_SIZE, matching.length).toLocaleString("en-US")} loaded of ${matching.length.toLocaleString("en-US")} matching`,
    )
    expect(matching.length).toBeLessThan(browseSeedRecords().length)

    // Design §4.5: `aria-rowcount = total + 1` holds under full external authority, an
    // exact total and NO grouping — which is this view and not the unscoped one. It is
    // the only channel through which a screen-reader user learns the population while
    // the client holds one window, and scenario 5 pins the grouped downgrade.
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(matching.length + 1))
  })
})
