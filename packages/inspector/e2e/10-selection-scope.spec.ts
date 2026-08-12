import type { Locator, Page } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  expectPhase,
  grid,
  loadMore,
  MIN_RENDERED_ROWS,
  n,
  openBrowse,
  scrollGridTo,
  status,
  statusText,
  total,
} from "./helpers"

/** Far past any scrollHeight this fixture produces; the browser clamps it to the bottom.
 *  The bottom of the two-window model is where the APPENDED records are drawn. */
const SCROLL_TO_BOTTOM_PX = 1_000_000

/** How long a query-change response is held back, so the mid-flight half of test 3 has a
 *  window to be read in rather than a race to win. Comfortably longer than a driver round
 *  trip on a loaded machine and shorter than the file's per-test budget. */
const HOLD_MS = 4_000

function selectAll(page: Page): Locator {
  return grid(page).locator("[data-pretable-row-select-all]")
}

function bulkBar(page: Page): Locator {
  return page.getByTestId(TEST_IDS.bulkBar)
}

/**
 * The matching population, as a number, read from the PAGE rather than from the seed.
 *
 * Two fixture states reach this file. A full-suite run arrives after scenario 9's two
 * writes (one record forgotten); running this file alone re-seeds the store — `serve.ts`
 * is what seeds it — and meets the pristine fixture. Every claim below is about the
 * RELATION between what is loaded and what matches, so neither value is transcribed. It
 * is still held to the two values the fixture can be in, so a page reporting a count from
 * nowhere fails here rather than silently satisfying the relations.
 */
async function matchingPopulation(page: Page): Promise<number> {
  const rendered = await total(page).innerText()
  expect([n(BROWSE_SEED_COUNT), n(BROWSE_SEED_COUNT - 1)]).toContain(rendered)
  return Number(rendered.replaceAll(",", ""))
}

/**
 * Every DATA row in the document with its selected flag.
 *
 * `data-pretable-selected` is written on every data row as `"true"` or `"false"`, never
 * omitted — so the attribute-presence selector the eye reaches for
 * (`[data-pretable-row-id][data-pretable-selected]`) matches every drawn row and any
 * claim built on it is vacuous. Group rows carry the row-id channel but no selected
 * flag at all, which is why they are excluded rather than defaulted.
 */
async function drawnSelection(page: Page): Promise<{ id: string; selected: boolean }[]> {
  return grid(page)
    .locator("[data-pretable-row-id]:not([data-pretable-group-row])")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement
        const id = element.dataset.pretableRowId
        if (id === undefined) throw new Error("pretable rendered a row without a row id")
        const selected = element.getAttribute("data-pretable-selected")
        if (selected === null) throw new Error(`row "${id}" carries no selected flag`)
        return { id, selected: selected === "true" }
      }),
    )
}

// One criterion per test, in file order: the header checkbox says what it covers
// (D1-SELECT-01), an append does not corrupt the selection (-03), and a query change
// clears it (-02).
//
// NOT 04. That one is "a retry after a partial failure re-attempts the failures only",
// and reaching it needs a mutation that fails for one id and succeeds for the others —
// an outcome this lane cannot stage against a real store. It is covered against a
// stubbed route in test/components/bulk-safety.test.tsx instead.
//
// This file does NOT mutate the store: the three tests select, page and filter, all of
// which are client state. It runs after scenario 9 in a full suite, so it reads the
// population off the page (see `matchingPopulation`) instead of naming it.
test.describe("scenario 10 — selection scope", () => {
  test.setTimeout(90_000)

  test("select-all names the LOADED scope, never the population", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // The premise: what the client holds is a strict subset of what the store matches.
    // Without it every assertion below is satisfied by a grid that loaded everything.
    const matching = await matchingPopulation(page)
    expect(BROWSE_PAGE_SIZE).toBeLessThan(matching)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, matching))

    await selectAll(page).click()

    // The bar counts the LOADED window …
    await expect(bulkBar(page)).toContainText(`${BROWSE_PAGE_SIZE} selected`)
    // … and the destructive verb names that same number, which is the one the user is
    // actually about to act on. A bar that agreed in its summary and offered "Forget
    // 1,249" would satisfy the line above on its own.
    await expect(
      bulkBar(page).getByRole("button", { name: `Forget ${BROWSE_PAGE_SIZE}`, exact: true }),
    ).toBeVisible()
    // Nowhere on the bar does the POPULATION appear. Locale-formatted, because that is
    // how every count in this chrome is rendered — `String(matching)` would look right
    // and never match a four-digit number.
    await expect(bulkBar(page)).not.toContainText(n(matching))

    // D1-SELECT-01: the control SAYS its scope. `resolveDataScope` answers "loaded" only
    // because the total is exact and exceeds what is loaded — the same fact the status
    // bar states above — so this label is the accessible half of that sentence, and the
    // one an AT user has.
    await expect(selectAll(page)).toHaveAttribute("aria-label", /loaded/i)
    await expect(selectAll(page)).toHaveAttribute("aria-checked", "true")
  })

  test("appending a window preserves the selection and adds no selection entries", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    const matching = await matchingPopulation(page)

    await selectAll(page).click()
    await expect(bulkBar(page)).toContainText(`${BROWSE_PAGE_SIZE} selected`)

    await loadMore(page).click()
    // The loaded count comes off the STATUS BAR, never off a row count: the grid
    // virtualizes, so the document holds ~19 rows however many the client is holding.
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, matching))
    await expectPhase(page, "idle")

    // D1-SELECT-03. Still 200 — the append added ROWS, it did not add selection, and it
    // did not lose any either. Both failure modes land on this one number: an append that
    // selected what it appended reads 400, and one that replaced the model rather than
    // extending it reads 0.
    await expect(bulkBar(page)).toContainText(`${BROWSE_PAGE_SIZE} selected`)

    // The rows at the HEAD are window 1's, and every one of them is still marked …
    const head = await drawnSelection(page)
    expect(head.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    expect(head.filter((row) => !row.selected)).toEqual([])
    expect(new Set(head.map((row) => row.id)).size).toBe(head.length)

    // … and the rows the append CONTRIBUTED are not. Read at the bottom of the model,
    // which under grouping is the tail of the last namespace: `asDrawn` files each
    // arriving record at the end of its own group, so every row down there came from
    // window 2. Without this half, "still 200 selected" is equally satisfied by a client
    // that selected the appended rows and dropped as many of the originals.
    await scrollGridTo(page, SCROLL_TO_BOTTOM_PX)
    await expect(async () => {
      const tail = await drawnSelection(page)
      expect(tail.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
      expect(new Set(tail.map((row) => row.id)).size).toBe(tail.length)
      expect(tail.filter((row) => row.selected)).toEqual([])
      // The tail is genuinely a DIFFERENT part of the model, not the head read twice at
      // an offset the virtualizer never applied.
      expect(tail.map((row) => row.id)).not.toEqual(head.map((row) => row.id))
    }).toPass({ timeout: 15_000 })
  })

  test("a query change clears the selection at fulfillment, never mid-flight", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await selectAll(page).click()
    await expect(bulkBar(page)).toBeVisible()

    // Hold the query-change response so "mid-flight" is a state with duration. Every
    // later poll for the new revision carries `filters` too and is held the same way,
    // which is harmless: the revision gate discards all but one of them.
    await page.route("**/api/memory/list*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("filters")) {
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
      }
      await route.continue()
    })
    await applySetFilter(page, "kind", ["procedural"])

    // MID-FLIGHT. The rows on screen still answer query A, and the ENGINE still holds the
    // selection over them: nothing has been cleared, because nothing has been fulfilled.
    // A client that cleared on INTENT would blank this the moment the funnel closed.
    await expectPhase(page, "stale")
    const held = await drawnSelection(page)
    expect(held.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    expect(held.filter((row) => !row.selected)).toEqual([])

    // CORRECTION to the plan's snippet, which expected the bulk bar to stay VISIBLE here.
    // Design §7 Flow 11 says the opposite — "the bulk bar is disabled during `stale`
    // (acting on rows a new query is about to replace is the ambiguity D1 bans)" — and
    // `list-page.tsx` gates the bar on `!browse.rowsAreStale`, so it is withheld outright.
    // The selection surviving mid-flight is asserted above, on the engine's own flags,
    // which is where that claim belongs; the bar is a claim about what may be ACTED on.
    await expect(bulkBar(page)).toHaveCount(0)

    // AT FULFILLMENT the datasetKey pivots and the engine drops selection, focus and
    // group expansion in one emit. Polled rather than read once: the pivot lands with the
    // response, a frame after the phase attribute settles.
    await expectPhase(page, "idle")
    await expect(grid(page).locator('[data-pretable-selected="true"]')).toHaveCount(0)
    await expect(bulkBar(page)).toHaveCount(0)
    // The clear is not an artifact of an empty result — there are rows under it, and they
    // are the NEW query's.
    await expect(async () => {
      const after = await drawnSelection(page)
      expect(after.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
      expect(after.filter((row) => row.selected)).toEqual([])
    }).toPass({ timeout: 15_000 })
  })
})
