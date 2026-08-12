import type { Page } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  browseRegion,
  expectPhase,
  grid,
  loadedText,
  loadMore,
  MIN_RENDERED_ROWS,
  openBrowse,
  recordsOnly,
  rowIds,
  scrollGridTo,
  sortByHeader,
  status,
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

/** What the browser logs for the browse response the last test refuses. Mirrors
 *  `13-accessibility.spec.ts`: the ENDPOINT is half the match, because Chromium's message
 *  text names only the status. */
function isSeededBrowseFailure(line: string): boolean {
  return /Failed to load resource: .*status of 500/.test(line) && line.includes("/api/memory/list")
}

/** Account for the console errors this spec CAUSED and leave everything else for the
 *  fixture's own teardown gate. `expected` is a floor, not a formality: a fault injection
 *  that silently stopped matching would log nothing, and a drain that merely filtered
 *  would let that pass while proving nothing about the path it claims to walk. */
function drainSeededFetchErrors(consoleErrors: string[], expected: number): void {
  const seeded = consoleErrors.filter(isSeededBrowseFailure)
  const unexpected = consoleErrors.filter((line) => !isSeededBrowseFailure(line))
  consoleErrors.length = 0
  expect(unexpected, "console errors this spec did not inject").toEqual([])
  expect(seeded.length, "seeded 500s the browser logged").toBeGreaterThanOrEqual(expected)
}

interface FocusReport {
  /** `""` when DOM focus is not on a row — on `<body>`, or on the viewport itself. */
  readonly rowId: string
  /** Read off the active element ITSELF, so a non-empty value already means the focused
   *  node IS a cell rather than something inside one. */
  readonly columnId: string
  readonly inGrid: boolean
  readonly onBody: boolean
}

/** Where DOM focus is, relative to the browse grid — one page evaluation, so every field
 *  answers for the same instant. Two locator reads would carry a driver round trip between
 *  them and could straddle a commit. */
async function focusReport(page: Page): Promise<FocusReport> {
  return browseRegion(page).evaluate((region) => {
    const active = document.activeElement as HTMLElement | null
    const viewport = region.querySelector("[data-pretable-scroll-viewport]")
    return {
      rowId: active?.closest("[data-pretable-row-id]")?.getAttribute("data-pretable-row-id") ?? "",
      columnId: active?.getAttribute("data-pretable-column-id") ?? "",
      inGrid: viewport?.contains(active ?? null) ?? false,
      onBody: active === document.body,
    }
  })
}

/**
 * The address the grid's ROVING TABINDEX names — the engine's focus, whether or not DOM
 * focus is currently sitting on it.
 *
 * Needed because pressing the load-more button is itself a focus move: the footer is
 * outside the viewport (design §9.2), so after the click `document.activeElement` is the
 * button, and pretable will not take DOM focus back off a node outside the grid
 * (`isFocusOursToMove`). "The append left focus where it was" is therefore a claim about
 * the engine's address, and `tabindex="0"` is where that address is observable.
 */
async function rovingCell(page: Page): Promise<{ rowId: string; columnId: string }> {
  return browseRegion(page).evaluate((region) => {
    const viewport = region.querySelector("[data-pretable-scroll-viewport]")
    if (viewport === null) throw new Error("the browse grid is not in the document")
    const cells = viewport.querySelectorAll('[data-pretable-cell][tabindex="0"]')
    if (cells.length !== 1) {
      throw new Error(`the grid has ${cells.length} cells at tabindex 0, not exactly one`)
    }
    const cell = cells[0] as HTMLElement
    return {
      rowId: cell.closest("[data-pretable-row-id]")?.getAttribute("data-pretable-row-id") ?? "",
      columnId: cell.getAttribute("data-pretable-column-id") ?? "",
    }
  })
}

/** The drawn RECORD rows with the position each one publishes, sampled together. Group
 *  headers are excluded: they share the row-id channel, and a cell click on one is not the
 *  gesture any of these tests mean. */
async function drawnRecords(page: Page): Promise<{ id: string; rowIndex: number }[]> {
  return browseRegion(page).evaluate((region) => {
    const viewport = region.querySelector("[data-pretable-scroll-viewport]")
    if (viewport === null) throw new Error("the browse grid is not in the document")
    return Array.from(
      viewport.querySelectorAll("[data-pretable-row-id]:not([data-pretable-group-row])"),
    ).map((node) => ({
      id: (node as HTMLElement).dataset.pretableRowId ?? "",
      rowIndex: Number(node.getAttribute("aria-rowindex")),
    }))
  })
}

/** The column every cell click below aims at. Not the first `[data-pretable-cell]` in the
 *  row — that is the row-select checkbox cell, whose click ticks a row and focuses a
 *  button instead of moving the grid's own cell focus. */
const FOCUS_COLUMN = "status"

/**
 * Put DOM focus on one record's `status` cell and confirm it landed.
 *
 * The Escape is not incidental. Pretable routes a data-cell click to `onRowActivate` and
 * this page opens the detail sheet from it, so every cell click here also opens a sheet
 * that would otherwise own focus for the rest of the test. The sheet restores focus to its
 * opener from an unmount layout effect, which is why the read after it is POLLED: a
 * one-shot read in the same tick as `toHaveCount(0)` sees `<body>`.
 */
async function focusRecordCell(page: Page, rowId: string): Promise<void> {
  await grid(page)
    .locator(`[data-pretable-row-id="${rowId}"]`)
    .locator(`[data-pretable-cell][data-pretable-column-id="${FOCUS_COLUMN}"]`)
    .click()
  await page.keyboard.press("Escape")
  await expect(page.getByLabel("Close detail")).toHaveCount(0)
  await expect
    .poll(() => focusReport(page))
    .toEqual({ rowId, columnId: FOCUS_COLUMN, inGrid: true, onBody: false })
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
    await focusRecordCell(page, anchored)

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
    // Stated rather than incidental: the unscoped browse is GROUPED, so the head of the
    // new result is a `__group__:` header and not a record. §4.2 says "the first data
    // cell"; what ships is `visibleRows[0]`, and under grouping those differ. The rule's
    // actual promise — deterministic, never `<body>` — is kept either way, and this line
    // is what makes the resolution visible instead of hidden inside `after[0]`.
    expect(head.startsWith("__group__:"), `the drawn head "${head}" is a group row`).toBe(true)
    // Without this the read below is satisfied by focus that never moved: the grid
    // re-renders the same coordinates over new rows, so "focus is on the head" and "focus
    // did not move" are the same sentence unless the two rows differ.
    expect(head).not.toBe(anchored)

    // POLLED: the re-seat happens in a layout effect and DOM focus follows it from a
    // second effect, so the phase attribute lands first.
    await expect.poll(() => focusReport(page)).toMatchObject({ rowId: head, inGrid: true })
    expect(await focusReport(page)).toMatchObject({ onBody: false })
  })

  test("an append leaves focus exactly where it was", async ({ page, consoleErrors }) => {
    void consoleErrors
    await openBrowse(page)
    const anchored = recordsOnly(await rowIds(page))[7] as string
    await focusRecordCell(page, anchored)

    await loadMore(page).click()
    // The loaded count comes off the STATUS BAR — the DOM holds ~19 rows. The LOADED half
    // alone rather than the whole sentence: the matching population differs between a solo
    // run of this file and a whole-suite run, where scenario 9 has already removed one.
    await expect(status(page)).toContainText(loadedText(BROWSE_PAGE_SIZE * 2))
    await expectPhase(page, "idle")

    // Same datasetKey → selection, focus and measured heights are all preserved. The
    // engine's address is what "preserved" means here; DOM focus is legitimately on the
    // button the user just pressed, which sits outside the viewport.
    expect(await rovingCell(page)).toEqual({ rowId: anchored, columnId: FOCUS_COLUMN })
    expect(await focusReport(page)).toMatchObject({ inGrid: false, onBody: false })

    // NOT asserted here, and deliberately: whether one Shift+Tab out of the footer lands
    // back ON that cell is design §9.2's "single entry stop" — D1-A11Y-04, the keyboard
    // TOPOLOGY, which is scenario 13's and Task 13's subject rather than this one's. It
    // does not, and the reason is upstream: @pretable/react 0.3.0 renders each row-select
    // control as `<button role="checkbox">` with no `tabIndex`, so every DRAWN row is its
    // own tab stop. Measured, not inferred — a backward walk from the footer visits
    // "Select row" on six consecutive rows.
  })

  test("a refresh that removes the focused row repairs focus and says so", async ({
    page,
    request,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // DEEP in the loaded window, and chosen off the page rather than transcribed. Two
    // reasons, both structural. (1) This test performs the lane's second permanent write
    // to the shared store — see helpers' scenario-9 note — so the row it removes must sit
    // where no other spec's head assertions can see it; the tail of the drawn projection
    // is exactly that place, and it is the one scenario 9 already chose for the same
    // reason. (2) The drawn projection differs between a solo run of this file (a pristine
    // seed) and a whole-suite run (scenario 9 has mutated it), so a transcribed id would
    // be right in one mode and wrong in the other.
    //
    // `1e7` is a number no content height reaches, so the browser CLAMPS to the end and no
    // row pitch is assumed.
    await scrollGridTo(page, 1e7)
    // The floor is INSIDE the retry, so a read taken before the virtualizer settled at
    // the new offset is re-driven rather than believed.
    let drawn: { id: string; rowIndex: number }[] = []
    await expect(async () => {
      drawn = await drawnRecords(page)
      expect(drawn.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    }).toPass({ timeout: 15_000 })
    // Mid-viewport rather than the last row, so the repair has a neighbour on both sides
    // and "moved to a nearby row" is not satisfied by the only remaining direction.
    const doomed = drawn[Math.floor(drawn.length / 2)] as { id: string; rowIndex: number }
    // The floor makes "deep" a checked fact rather than an intention: a viewport that had
    // failed to scroll would hand back the head of the model and this test would quietly
    // delete a row four other specs assert on.
    expect(doomed.rowIndex, "the doomed row's published position").toBeGreaterThan(120)

    await focusRecordCell(page, doomed.id)

    const response = await request.post(`/api/memory/${encodeURIComponent(doomed.id)}/forget`)
    if (!response.ok()) {
      throw new Error(`forget ${doomed.id}: ${response.status()} ${await response.text()}`)
    }

    // Phrased POSITIVELY: a read taken between paints answers `[]`, and `[]` satisfies
    // every "no longer contains" claim no matter what the page went on to draw.
    await expect
      .poll(
        async () => {
          const ids = await rowIds(page)
          return ids.length >= MIN_RENDERED_ROWS && !ids.includes(doomed.id)
        },
        { timeout: 20_000 },
      )
      .toBe(true)

    const repaired = await focusReport(page)
    expect(repaired.inGrid).toBe(true)
    expect(repaired.onBody).toBe(false)
    expect(repaired.rowId).not.toBe(doomed.id)
    expect(repaired.rowId).not.toBe("")

    // The inspector's own copy for `focusedRowRemovedAnnouncement`, not pretable's
    // default — asserted verbatim, because the sentence is the whole point of the
    // announcement and a substring match would pass against the results sentence the
    // same refresh also produces.
    await expect
      .poll(() => page.locator("[data-pretable-live-region]").innerText(), { timeout: 15_000 })
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
    // the correct behavior for an error the user did not initiate — and `onBody` is
    // asserted beside `inGrid` so that focus having been thrown at some third element
    // fails here too.
    expect(await focusReport(page)).toMatchObject({ inGrid: false, onBody: true })

    failing = false
    await page.getByTestId(TEST_IDS.retryInitial).focus()
    await expect(page.getByTestId(TEST_IDS.retryInitial)).toBeFocused()
    await page.keyboard.press("Enter")
    await expectPhase(page, "idle")

    drainSeededFetchErrors(consoleErrors, 1)
  })
})
