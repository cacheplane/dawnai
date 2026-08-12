import type { Page } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  A11Y_FOCUS_DOOMED_DRAWN_INDEX,
  A11Y_FOCUS_FORGOTTEN_ID,
  browseRegion,
  browseSeedRecordsAfterA11yFocus,
  DRAWN_FIRST_WINDOW,
  DRAWN_FIRST_WINDOW_AFTER_A11Y_FOCUS,
  drainSeededFetchErrors,
  expectDrawnRunAround,
  expectPhase,
  focusRecordCell,
  focusReport,
  GROUP_ROW_ID_PREFIX,
  grid,
  liveRegionText,
  loadMore,
  MIN_RENDERED_ROWS,
  n,
  openBrowse,
  recordsOnly,
  rowIds,
  sortByHeader,
  status,
  statusText,
  total,
} from "./helpers"

/**
 * D1-A11Y-03, focus continuity, as four separable claims: a dataset pivot re-seats focus
 * deterministically, an append leaves it alone, a data-driven removal repairs it and says
 * so, and a failure the user did not ask for takes nothing.
 *
 * Scenario 13 walks all of these once inside one narrative over the FACET-SCOPED (flat)
 * browse. This spec is the branch that walkthrough cannot reach: the UNSCOPED browse is
 * grouped, so "the first data cell of the new result" (design §4.2) addresses a row the
 * flat view has none of — and the removal and initial-failure halves get a whole test each
 * rather than a line inside a walkthrough that has already spent its store mutations.
 */

/** The column every cell click below aims at. Not the first `[data-pretable-cell]` in the
 *  row — that is the row-select checkbox cell, whose click ticks a row and focuses a
 *  button instead of moving the grid's own cell focus. */
const FOCUS_COLUMN = "status"

/** Pretable's derived group column (grid-core `GROUP_COLUMN_ID`), mirrored rather than
 *  imported for the reason `helpers`' `groupRowId` is: a rename upstream must redden this
 *  file, not silently retarget it. `resolveEffectiveColumns` puts this column AHEAD of the
 *  declaration whenever a row grouping is active, so in the unscoped browse it is the
 *  first column that is not the row-select one — which is the column pretable's own pivot
 *  branch re-seats focus into. */
const GROUP_COLUMN_ID = "__pretable_group__"

/**
 * The address the grid's own focus flag names — the engine's focus, whether or not DOM
 * focus is currently sitting on it.
 *
 * Needed because pressing the load-more button is itself a focus move: the footer is
 * outside the viewport (design §9.2), so after the click `document.activeElement` is the
 * button, and pretable will not take DOM focus back off a node outside the grid
 * (`isFocusOursToMove`). "The append left focus where it was" is therefore a claim about
 * the engine's address.
 *
 * Located on `data-pretable-focused`, the PUBLISHED channel, rather than on the roving
 * `tabindex` — which pretable derives from the same `cellIsFocused` flag. The tabindex is
 * asserted to be on that same node instead of selected by, so this also states design
 * §9.2's single entry stop for the body: exactly one cell in it is tabbable, and it is the
 * focused one.
 */
async function rovingCell(page: Page): Promise<{ rowId: string; columnId: string }> {
  return browseRegion(page).evaluate((region) => {
    const viewport = region.querySelector("[data-pretable-scroll-viewport]")
    if (viewport === null) throw new Error("the browse grid is not in the document")
    const focused = viewport.querySelectorAll('[data-pretable-cell][data-pretable-focused="true"]')
    if (focused.length !== 1) {
      throw new Error(`the grid marks ${focused.length} cells focused, not exactly one`)
    }
    const tabbable = viewport.querySelectorAll('[data-pretable-cell][tabindex="0"]')
    if (tabbable.length !== 1 || tabbable[0] !== focused[0]) {
      throw new Error(
        `${tabbable.length} body cell(s) are tabbable and the focused one is ` +
          `${tabbable[0] === focused[0] ? "among" : "not among"} them`,
      )
    }
    const cell = focused[0] as HTMLElement
    return {
      rowId: cell.closest("[data-pretable-row-id]")?.getAttribute("data-pretable-row-id") ?? "",
      columnId: cell.getAttribute("data-pretable-column-id") ?? "",
    }
  })
}

test.describe("focus continuity", () => {
  test.setTimeout(120_000)

  test("a query reset re-seats focus at the head of the new result, never on <body>", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    const anchored = recordsOnly(await rowIds(page))[3] as string
    await focusRecordCell(page, anchored, FOCUS_COLUMN)

    // A SORT HEADER, not a funnel, and the choice is the rule's precondition rather than
    // taste. §4.2 governs a pivot that begins with DOM focus inside the grid; pretable's
    // `FilterMenu` is portaled to `<body>` and does not restore focus to its trigger on
    // Escape (design §1.1, an accepted pre-existing gap that is explicitly not a D1
    // obligation), so a funnel-driven pivot begins on `<body>` and the rule does not
    // apply to it at all. A header click leaves focus inside the viewport.
    //
    // `status` rather than `updated`: one click is DESC, and `updated` DESC is already the
    // default order, so that gesture canonicalizes to the query the page is on and pivots
    // no dataset.
    await sortByHeader(page, FOCUS_COLUMN)
    await expectPhase(page, "idle")

    const after = await rowIds(page)
    // The pivot also resets scroll, so the drawn head IS the model head — `after[0]` is
    // an address, not merely "whatever is on screen".
    const head = after[0] as string
    // The one place this lane pins a divergence from its own design, so the message says
    // what to do about it rather than leaving that in a comment the failure never prints.
    expect(
      head.startsWith(GROUP_ROW_ID_PREFIX),
      `design §4.2 and the D1-A11Y-03 traceability row say a dataset pivot seats focus on ` +
        `the first DATA cell. What ships re-seats it on \`visibleRows[0]\` and the first ` +
        `non-row-select column, and the unscoped browse is GROUPED, so both halves resolve ` +
        `to a group row's group cell. The drawn head is "${head}": if that is a record, ` +
        `pretable's re-seat has changed and §4.2 can be read literally again — amend the ` +
        `design and this test together rather than relaxing the address below`,
    ).toBe(true)
    // Without this the read below is satisfied by focus that never moved: the grid
    // re-renders the same coordinates over new rows, so "focus is on the head" and "focus
    // did not move" are the same sentence unless the two rows differ.
    expect(head).not.toBe(anchored)

    // POLLED: the re-seat happens in a layout effect and DOM focus follows it from a
    // second effect, so the phase attribute lands first. The WHOLE address, in ONE sample:
    // `columnId` is what says the focused node is a cell rather than the row wrapper or
    // the row-select control, and a second sample of the same helper for a second field
    // could straddle a commit.
    await expect
      .poll(() => focusReport(page))
      .toEqual({ rowId: head, columnId: GROUP_COLUMN_ID, inGrid: true, onBody: false })
  })

  test("an append leaves focus exactly where it was", async ({ page, consoleErrors }) => {
    void consoleErrors
    await openBrowse(page)
    const anchored = recordsOnly(await rowIds(page))[7] as string
    await focusRecordCell(page, anchored, FOCUS_COLUMN)

    // The population is READ off the page rather than transcribed — two fixture states
    // reach this file, a solo run against the pristine seed and a whole-suite run after
    // scenario 9's forget — and it is still held to those two, so a page reporting a count
    // from nowhere fails here instead of satisfying the relation below. Read BEFORE the
    // gesture, because the whole sentence is what an append owes: the loaded half advanced
    // by exactly one window and the matching half did not move at all. Asserting the
    // loaded half alone leaves a population that drifted with it unexamined.
    const rendered = await total(page).innerText()
    expect([n(BROWSE_SEED_COUNT), n(BROWSE_SEED_COUNT - 1)]).toContain(rendered)
    const matching = Number(rendered.replaceAll(",", ""))

    await loadMore(page).click()
    // The loaded count comes off the STATUS BAR — the DOM holds ~19 rows.
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, matching))
    await expectPhase(page, "idle")

    // Same datasetKey → selection, focus and measured heights are all preserved. The
    // engine's address is what "preserved" means here; DOM focus is legitimately on the
    // button the user just pressed, which sits outside the viewport.
    //
    // RETRIED rather than read once, for the reason `rowIds` gives: the rendered set can
    // still change a frame after the phase reads `idle`, and `rovingCell` THROWS on a
    // transient re-measure, which with `retries: 0` would be a hard suite failure rather
    // than a re-driven read. `toPass` and not `expect.poll`, because only the former
    // retries a callback that throws.
    await expect(async () => {
      expect(await rovingCell(page)).toEqual({ rowId: anchored, columnId: FOCUS_COLUMN })
    }).toPass({ timeout: 15_000 })
    await expect(loadMore(page)).toBeFocused()
    expect(await focusReport(page)).toEqual({
      rowId: "",
      columnId: "",
      inGrid: false,
      onBody: false,
    })

    // NOT asserted here, and deliberately: whether one Shift+Tab out of the footer lands
    // back ON that cell is design §9.2's "single entry stop" — D1-A11Y-04, the keyboard
    // TOPOLOGY, which is scenario 13's and Task 13's subject rather than this one's. It
    // does not, and the reason is a defect upstream rather than in this page:
    // @pretable/react 0.3.0 renders each row-select control as `<button role="checkbox">`
    // with no `tabIndex`, so every DRAWN row is its own tab stop. Measured, not inferred —
    // a backward walk from the footer visits "Select row" on six consecutive rows. Pinning
    // the count here would pin the defect; it is reported instead, and `rovingCell` above
    // states the half that IS correct today (one tabbable CELL).
  })

  test("a refresh that removes the focused row repairs focus and says so", async ({
    page,
    request,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // DEEP in the loaded window, and DERIVED rather than picked off the page. This test
    // performs the lane's second permanent write to the shared store, so which row it
    // removes has to be computable by every spec that runs after it: `helpers` owns that
    // choice beside scenario 9's, and publishes `DRAWN_FIRST_WINDOW_AFTER_A11Y_FOCUS` so a
    // later spec reads the store it will meet instead of transcribing a correction out of
    // this comment.
    //
    // `DRAWN_FIRST_WINDOW` — the PRISTINE projection — is the right expectation in a
    // whole-suite run too: the doomed row is the midpoint of the prefix all three
    // projections agree on, so the drawn window around it is identical before and after
    // scenario 9. This call is what turns "deep" into a checked fact: it scrolls there and
    // pins the run of rows around the row it is about to delete, so a viewport that failed
    // to move draws the head of the model and fails HERE rather than quietly deleting a
    // row four other specs assert on.
    const doomed = A11Y_FOCUS_FORGOTTEN_ID
    await expectDrawnRunAround(page, DRAWN_FIRST_WINDOW, doomed)

    await focusRecordCell(page, doomed, FOCUS_COLUMN)

    const response = await request.post(`/api/memory/${encodeURIComponent(doomed)}/forget`)
    if (!response.ok()) {
      throw new Error(`forget ${doomed}: ${response.status()} ${await response.text()}`)
    }

    // Phrased POSITIVELY: a read taken between paints answers `[]`, and `[]` satisfies
    // every "no longer contains" claim no matter what the page went on to draw.
    await expect
      .poll(
        async () => {
          const ids = await rowIds(page)
          return ids.length >= MIN_RENDERED_ROWS && !ids.includes(doomed)
        },
        { timeout: 20_000 },
      )
      .toBe(true)

    // What this write LEAVES BEHIND, checked against the live store rather than exported
    // on trust. `browseSeedRecordsAfterA11yFocus()` and `DRAWN_FIRST_WINDOW_AFTER_A11Y_FOCUS`
    // are what the specs sorting after this file compute their expectations from, and
    // nothing else reads them yet — so an error in either would first surface inside a spec
    // with no way to know where it came from. Held to the two states the fixture can be in,
    // for scenario 10's reason: a whole-suite run has lost scenario 9's record and this one,
    // a solo run re-seeds and has lost only this one. The projection is checked by its
    // LENGTH, which is the half that does not depend on which state the store is in: the
    // window backfills to `BROWSE_PAGE_SIZE` and the seed has no fourth namespace, so a
    // derivation that dropped or invented a group row is what moves this number.
    const remaining = await total(page).innerText()
    expect([n(BROWSE_SEED_COUNT - 1), n(browseSeedRecordsAfterA11yFocus().length)]).toContain(
      remaining,
    )
    expect(DRAWN_FIRST_WINDOW_AFTER_A11Y_FOCUS.length).toBe(DRAWN_FIRST_WINDOW.length)

    // Exactly one of TWO rows, and the pair is a complete statement of the rule rather
    // than a tolerance. Pretable repairs focus by clamping to the same visible INDEX
    // (grid-core `reconcileFocusAfterVisibleModelChange`: `afterRows[clamp(oldIndex, …)]`),
    // and the refreshed window backfills one record to stay at `BROWSE_PAGE_SIZE`. If that
    // record sorts below the removed row, the old index now names its successor; if above,
    // its predecessor. There is no third case. The COLUMN is not clamped — `status`
    // survives the refresh, so the repair keeps it, which is the difference between a
    // repair and the re-seat the first test asserts.
    //
    // Normalised inside ONE sample rather than asserted across two reads of a moving page,
    // and the sentinel is what a failure prints in place of the row it actually found.
    const neighbours = [
      DRAWN_FIRST_WINDOW[A11Y_FOCUS_DOOMED_DRAWN_INDEX - 1] as string,
      DRAWN_FIRST_WINDOW[A11Y_FOCUS_DOOMED_DRAWN_INDEX + 1] as string,
    ]
    const ADJACENT = "<a drawn neighbour of the removed row>"
    await expect
      .poll(
        async () => {
          const report = await focusReport(page)
          return neighbours.includes(report.rowId) ? { ...report, rowId: ADJACENT } : report
        },
        { timeout: 15_000 },
      )
      .toEqual({ rowId: ADJACENT, columnId: FOCUS_COLUMN, inGrid: true, onBody: false })

    // The inspector's own copy for `focusedRowRemovedAnnouncement`, not pretable's
    // default — asserted verbatim, because the sentence is the whole point of the
    // announcement and a substring match would pass against the results sentence the
    // same refresh also produces.
    await expect
      .poll(() => liveRegionText(page), { timeout: 15_000 })
      .toContain("The focused memory was removed.")
  })

  test("an initial failure never steals focus, and the retry control is reachable", async ({
    page,
    consoleErrors,
  }) => {
    let failing = true
    await page.route("**/api/memory/list*", async (route) => {
      if (failing) {
        await route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        return
      }
      await route.continue()
    })
    await page.goto("/memory")
    await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
    await expect(grid(page)).toHaveAttribute("data-pretable-data-phase", "error")

    // Focus stayed on `<body>` because the failure ANNOUNCED rather than grabbed. That is
    // the correct behavior for an error the user did not initiate — and the address is
    // asserted WHOLE so that focus having been thrown at some third element fails here
    // too, rather than only focus that reached the grid.
    expect(await focusReport(page)).toEqual({
      rowId: "",
      columnId: "",
      inGrid: false,
      onBody: true,
    })

    failing = false
    await page.getByTestId(TEST_IDS.retryInitial).focus()
    await expect(page.getByTestId(TEST_IDS.retryInitial)).toBeFocused()
    await page.keyboard.press("Enter")
    await expectPhase(page, "idle")

    drainSeededFetchErrors(consoleErrors, 1)
  })
})
