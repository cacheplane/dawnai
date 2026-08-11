import type { Page } from "@playwright/test"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  seedIdsInDefaultOrder,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  DRAWN_FIRST_WINDOW,
  DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9,
  expectDrawnRows,
  expectPhase,
  grid,
  loadMore,
  MIN_RENDERED_ROWS,
  n,
  openBrowse,
  SCENARIO_9_STABLE_DRAWN_PREFIX,
  status,
  statusText,
  total,
} from "./helpers"

/**
 * D1-A11Y-02. Design §4.5 publishes the matching population as `aria-rowcount` only when
 * every condition making loaded index `i` equal dataset position `i` holds; anything short
 * of that downgrades to the loaded-model count.
 *
 * The two branches this surface cannot produce are named rather than tested: an
 * `estimate`/`unknown` total (`useMemoryBrowse` builds `{kind:"exact"}` from the response's
 * integer `total` and nothing else, so `-1` is unreachable from here) and a non-integer
 * count (same reason). Both live in `@pretable/react`'s `data-scope` unit tests. The
 * reachable branches — exact-and-ungrouped, grouped, and a total that undercounts what is
 * loaded — are all below, so a reviewer can see the coverage is complete rather than
 * partial.
 *
 * GROUPING is one of §4.5's conditions and the unscoped browse is grouped
 * (`list-page.tsx`: `groupByNamespace={namespace === undefined}`), so the population branch
 * is reachable only under a FACET and the unscoped view IS the grouped-downgrade branch.
 * This file is the one place both are asserted side by side.
 */

/** The facet this file scopes to. Chosen because it survives the shared fixture: scenario
 *  9's two writes both land in `route=/notes-archive` (see the derivation block in
 *  `helpers.ts`), so this namespace holds the same 667 records in the same default order
 *  whether this file runs alone against a freshly seeded store or last in a whole-suite
 *  run. Nothing here needs `browseSeedRecordsAfterScenario9()` for that reason. */
const SCOPED = seedRecordsMatching({ namespace: "route=/notes" })
const SCOPED_ORDER = seedIdsInDefaultOrder(SCOPED)

/** The lie test 3 makes the server tell: a full window of records under a total far below
 *  it. 200 loaded records cannot be a contiguous prefix of a 5-row population, which is
 *  the contract `PretableResultMeta` states and §4.5 downgrades on. */
const UNDERCOUNTED_TOTAL = 5

/**
 * Scope to `route=/notes`, and assert the precondition the population branch needs.
 *
 * `role` is the assertion, not decoration: pretable publishes `treegrid` exactly while it
 * is grouping and `grid` otherwise, and grouping is §4.5's FIRST downgrade — it is checked
 * before the total is even read. Without this line a run in which the facet silently failed
 * to turn grouping off would reach the `aria-rowcount` assertions below as a grouped grid,
 * and they would be about the wrong branch.
 *
 * The rail's counts come from `/api/memory/stats`, which is a different endpoint from the
 * one test 3 intercepts — so this locator finds the same button under the lie as without
 * it.
 */
async function scopeToNotes(page: Page): Promise<void> {
  await page.getByRole("button", { name: `route=/notes ${SCOPED.length}`, exact: true }).click()
  await expectPhase(page, "idle")
  await expect(grid(page)).toHaveAttribute("role", "grid")
}

/**
 * The LAST row the grid draws with the box scrolled to the bottom — its id and its
 * published position, sampled together.
 *
 * The grid virtualizes, so `rows.nth(399)` addresses a node that was never rendered and
 * the deep position has to be scrolled to. The offset is far past any `scrollHeight` this
 * fixture produces, so the browser CLAMPS it to the end: no row pitch is assumed and no
 * arithmetic can drift.
 *
 * Scroll, settle and read happen inside ONE page evaluation. A driver round trip between
 * them would let the 2 s poll re-render the rows in the gap, and the id and the index would
 * then describe different commits. Three frames because the scroll handler sets React
 * state, the re-render commits, and only then is the tail in the document.
 */
async function tailRow(page: Page): Promise<{ id: string; rowIndex: string }> {
  return grid(page).evaluate(async (node) => {
    node.scrollTop = 1e7
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise(requestAnimationFrame)
    }
    const rows = node.querySelectorAll("[data-pretable-row-id]")
    const last = rows[rows.length - 1] as HTMLElement | undefined
    return {
      id: last?.dataset.pretableRowId ?? "",
      rowIndex: last?.getAttribute("aria-rowindex") ?? "",
    }
  })
}

/** §4.5's prohibition, checked at the grid and then across the whole document — the rule is
 *  "not on the grid, the rowgroup, or the rows in any D1 state", and a per-row or
 *  per-rowgroup `aria-busy` would satisfy a grid-only check while doing the exact damage
 *  the ruling exists to prevent. */
async function expectNoAriaBusy(page: Page): Promise<void> {
  await expect(grid(page)).not.toHaveAttribute("aria-busy", /.*/)
  expect(await page.locator("[aria-busy]").count(), "elements carrying aria-busy").toBe(0)
}

test.describe("ARIA counts and positions", () => {
  test.setTimeout(90_000)

  test("an exact total publishes the POPULATION, and positions are global", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await scopeToNotes(page)
    await expectDrawnRows(page, SCOPED_ORDER.slice(0, BROWSE_PAGE_SIZE))

    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(SCOPED.length + 1))
    await expect(grid(page).locator("[data-pretable-row-id]").first()).toHaveAttribute(
      "aria-rowindex",
      "2",
    )

    // The gap between the last position and the rowcount is the discovery affordance:
    // "row 401 of 668" is how a screen-reader user learns more exists. Append a second
    // window and read the deepest drawn row — position 401 under a rowcount still naming
    // the whole 667, which is the claim. The loaded count comes off the STATUS BAR rather
    // than off a row count, because the document holds ~19 rows however many the client is
    // holding.
    await loadMore(page).click()
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, SCOPED.length))
    await expectPhase(page, "idle")

    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(SCOPED.length + 1))
    // Both fields together: the position alone is satisfied by a grid that renumbered rows
    // it had reordered, and the id alone says nothing about the published position.
    await expect
      .poll(() => tailRow(page), { timeout: 20_000 })
      .toEqual({
        id: SCOPED_ORDER[BROWSE_PAGE_SIZE * 2 - 1],
        rowIndex: String(BROWSE_PAGE_SIZE * 2 + 1),
      })
    // The gap is real rather than incidental — with the whole population loaded, "position
    // 401 under a rowcount of 668" would be an ordinary complete-model grid saying nothing
    // about remote populations at all.
    expect(BROWSE_PAGE_SIZE * 2).toBeLessThan(SCOPED.length)
  })

  test("GROUPING downgrades the rowcount to the loaded model", async ({ page, consoleErrors }) => {
    void consoleErrors
    // The unscoped browse, which groups by namespace. §4.5: grouping destroys the
    // loaded-index → dataset-position mapping, so the population must NOT be published —
    // it moves to the status chrome, which is asserted here beside it so the downgrade is
    // not mistaken for the number going missing.
    await openBrowse(page)
    await expect(grid(page)).toHaveAttribute("role", "treegrid")

    // Only the prefix the three fixture states agree on (see `helpers.ts`): this file runs
    // after scenario 9 in a whole-suite run and against the pristine seed on its own, and
    // the projections diverge far below anything a viewport draws.
    await expectDrawnRows(page, DRAWN_FIRST_WINDOW.slice(0, SCENARIO_9_STABLE_DRAWN_PREFIX))
    // The rowcount is the whole projection, which is deeper than the drawn prefix — so it
    // is pinned against a length both fixture states share, checked rather than assumed.
    expect(DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9.length).toBe(DRAWN_FIRST_WINDOW.length)
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(DRAWN_FIRST_WINDOW.length + 1))

    // The population, read off the page — held to the two values the shared fixture can be
    // in, so a page reporting a count from nowhere fails here rather than being adopted as
    // the expectation.
    const rendered = await total(page).innerText()
    expect([n(BROWSE_SEED_COUNT), n(BROWSE_SEED_COUNT - 1)]).toContain(rendered)
    const matching = Number(rendered.replaceAll(",", ""))
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, matching))
    // …and the downgraded rowcount is not the population wearing a different name.
    expect(DRAWN_FIRST_WINDOW.length + 1).toBeLessThan(matching)
  })

  test("a total that UNDERCOUNTS the loaded rows downgrades to the loaded-model count", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    // A lying server: a full window of records under a total of 5. Pretable emits a
    // console.warn on this path (not an error), so the fixture's console gate stays green.
    await page.route("**/api/memory/list*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          records: browseSeedRecords().slice(0, BROWSE_PAGE_SIZE),
          total: UNDERCOUNTED_TOTAL,
          continuation: null,
        }),
      })
    })
    await openBrowse(page)
    // SCOPED, and that is what makes this test about the undercount at all: grouping is
    // checked first and would downgrade the rowcount on its own, so the unscoped view
    // cannot distinguish this branch from the previous test's. Under the facet the grid is
    // ungrouped and the total is the only thing left that can move the count.
    await scopeToNotes(page)

    const drawn = await grid(page).locator("[data-pretable-row-id]").count()
    expect(drawn).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(BROWSE_PAGE_SIZE + 1))
    // Stated as the prohibition too: the number the server claimed must not reach ARIA.
    await expect(grid(page)).not.toHaveAttribute("aria-rowcount", String(UNDERCOUNTED_TOTAL + 1))
  })

  test("no phase anywhere sets aria-busy, on the grid or inside it", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    // Hold the initial request open so `loading` is observable, and hold the FIRST cursored
    // request so `loading-more` is too. Both are latches rather than predicates: the browse
    // re-polls every 2 s, and holding every tick would leave the page permanently mid-flight
    // with a handler still sleeping at teardown.
    let releaseInitial: (() => void) | undefined
    let releaseAppend: (() => void) | undefined
    const initialHeld = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const appendHeld = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    let heldInitial = false
    let heldAppend = false
    await page.route("**/api/memory/list*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("cursor")) {
        if (!heldAppend) {
          heldAppend = true
          await appendHeld
        }
      } else if (!heldInitial) {
        heldInitial = true
        await initialHeld
      }
      await route.continue()
    })

    await page.goto("/memory")
    await expectPhase(page, "loading")
    await expectNoAriaBusy(page)
    releaseInitial?.()

    await expectPhase(page, "idle")
    await expectNoAriaBusy(page)

    // Pretable's hydration signal before the click: an SSR'd control is painted and inert,
    // and a click landing before it flips is silently dropped.
    await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
    await loadMore(page).click()
    await expectPhase(page, "loading-more")
    await expectNoAriaBusy(page)
    releaseAppend?.()

    await expect(status(page)).toContainText(`${n(BROWSE_PAGE_SIZE * 2)} loaded`)
    await expectPhase(page, "idle")
    await expectNoAriaBusy(page)

    // Both faults were actually injected. Without this the claims above are made about a
    // page that was never held, and a param this route stopped recognising would take them
    // with it, silently.
    expect({ heldInitial, heldAppend }).toEqual({ heldInitial: true, heldAppend: true })
  })
})
