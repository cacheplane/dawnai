import type { Locator, Page } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE, browseSeedRecords, seedRecordsMatching } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  browseSeedRecordsAfterA11yFocus,
  drainSeededFetchErrors,
  expectPhase,
  grid,
  loadMore,
  n,
  openBrowse,
  sortHeader,
  status,
  statusText,
  total,
} from "./helpers"

/**
 * D1-A11Y-04, the keyboard topology, walked with NO pointer events at all — every
 * gesture below is a key press. The plan's draft reached two controls with `focus()`;
 * both were replaced with walks, because a programmatic focus proves reachability that a
 * tab order need not have, which is the one thing this file exists to check.
 *
 * Design §9.2's claim, in full: error banner (retry, when present) → header controls
 * (funnels, column menus, select-all) → grid body (single entry stop, roving tabindex) →
 * load-more footer control → rest of page; and every D1 operation — filters, sort,
 * load-more, retry, selection, bulk actions, reaching content after the grid — operable
 * by keyboard.
 *
 * Column menus are ABSENT from this build rather than unreachable: pretable renders one
 * only when `groupPanel.enabled`, which `MemoryGrid` does not pass. Nothing below looks
 * for one.
 *
 * Every walk moves in ONE direction from wherever focus actually is, forward or back.
 * Restarting a walk by re-focusing `<body>` does not work and silently costs a whole lap:
 * Chromium keeps a sequential-navigation starting point that `body.focus()` does not
 * reset, so the next Tab continues from the last real element and the "restarted" walk
 * has to cross the grid to come round again.
 *
 * TWO of §9.2's claims are false against what ships. Both are pinned INVERTED rather than
 * deleted, so the day either is fixed this file reddens and the design and the test get
 * amended together. They are named at their assertions: the body is not one tab stop (it
 * costs one per LOADED row), and the filter menu drops focus to `<body>` on Escape.
 */

/** A stop on a tab walk, resolved to the §9.2 region that owns it. Structured rather
 *  than a printed string, because the ORDER of the regions is itself one of §9.2's
 *  claims and a string blob can only be eyeballed. */
interface Stop {
  readonly tag: string
  readonly label: string
  readonly region: "header" | "body" | "load-more" | "bulk-bar" | "elsewhere"
  readonly rowSelect: boolean
}

async function activeStop(page: Page): Promise<Stop> {
  return page.evaluate(
    ({ loadMoreId, bulkBarId }) => {
      const el = document.activeElement as HTMLElement | null
      if (el === null || el === document.body) {
        return { tag: "BODY", label: "", region: "elsewhere" as const, rowSelect: false }
      }
      // The header row lives INSIDE the scroll viewport (it is sticky, not a sibling), so
      // it has to be tested before the viewport or every header control reports as body.
      const region = el.closest("[data-pretable-header-row]")
        ? ("header" as const)
        : el.closest("[data-pretable-scroll-viewport]")
          ? ("body" as const)
          : el.closest(`[data-testid="${loadMoreId}"]`)
            ? ("load-more" as const)
            : el.closest(`[data-testid="${bulkBarId}"]`)
              ? ("bulk-bar" as const)
              : ("elsewhere" as const)
      return {
        tag: el.tagName,
        label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "",
        region,
        rowSelect: el.hasAttribute("data-pretable-row-select"),
      }
    },
    { loadMoreId: TEST_IDS.loadMore, bulkBarId: TEST_IDS.bulkBar },
  )
}

/**
 * Press `key` until the predicate holds, recording every stop.
 *
 * The budget is a diagnostic ceiling, not a claim: it exists so an unreachable target
 * reports the walk it made instead of running until the test timeout — which is what a
 * budget-free version does, and it reports as a timeout with nothing in it. The default
 * is set well above what the topology costs TODAY (which is `BROWSE_PAGE_SIZE` more than
 * §9.2 describes), so a "never reached" means genuinely unreachable rather than merely
 * expensive; the COST is asserted separately, where it reads as the defect it is.
 */
async function walkUntil(
  page: Page,
  predicate: () => Promise<boolean>,
  { key = "Tab", budget = 400 }: { key?: "Tab" | "Shift+Tab"; budget?: number } = {},
): Promise<Stop[]> {
  const walked: Stop[] = []
  for (let step = 0; step < budget; step += 1) {
    if (await predicate()) return walked
    await page.keyboard.press(key)
    walked.push(await activeStop(page))
  }
  throw new Error(
    `never reached the target in ${budget} ${key} stops; walked: ` +
      walked.map((stop) => `${stop.region}:${stop.tag}|${stop.label}`).join(" -> "),
  )
}

/** Consecutive duplicates collapsed — the walk's shape, which is what §9.2 states. */
function regionOrder(walk: readonly Stop[]): string[] {
  return walk.map((stop) => stop.region).filter((region, i, all) => region !== all[i - 1])
}

function hasFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => node === document.activeElement)
}

/** Where DOM focus is, as a cell address — the read that answers for a GROUP row too.
 *  `rovingCell` below is the stronger claim and cannot serve here: the group row's cells
 *  are rendered by a component of their own, so a walk that stops on the head of a
 *  grouped model has no `[data-pretable-focused]` cell to find. */
async function focusedCell(
  page: Page,
): Promise<{ isCell: boolean; rowId: string; columnId: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return {
      isCell: el?.hasAttribute("data-pretable-cell") ?? false,
      rowId: el?.closest("[data-pretable-row-id]")?.getAttribute("data-pretable-row-id") ?? "",
      columnId: el?.getAttribute("data-pretable-column-id") ?? "",
    }
  })
}

/**
 * The engine's roving cell: the one cell marked focused, and the one cell that is
 * tabbable. Asserting they are the SAME node is what "roving tabindex" means, and it is
 * the half of §9.2's body clause that HOLDS.
 *
 * THROWS rather than returning a sentinel when either count is wrong, so callers wrap it
 * in `toPass` (which retries a throwing callback) rather than `expect.poll` (which does
 * not) — the rendered set can still change a frame after the phase reads `idle`.
 */
async function rovingCell(page: Page): Promise<{ rowId: string; columnId: string }> {
  return grid(page).evaluate((viewport) => {
    const focused = viewport.querySelectorAll('[data-pretable-cell][data-pretable-focused="true"]')
    if (focused.length !== 1) {
      throw new Error(`the grid marks ${focused.length} cells focused, not exactly one`)
    }
    const tabbable = viewport.querySelectorAll('[data-pretable-cell][tabindex="0"]')
    if (tabbable.length !== 1 || tabbable[0] !== focused[0]) {
      throw new Error(
        `${tabbable.length} body cell(s) are tabbable and they are not the focused one`,
      )
    }
    const cell = focused[0] as HTMLElement
    return {
      rowId: cell.closest("[data-pretable-row-id]")?.getAttribute("data-pretable-row-id") ?? "",
      columnId: cell.getAttribute("data-pretable-column-id") ?? "",
    }
  })
}

/** The `status: active` population, in the two fixture states this file can meet: a solo
 *  run re-seeds and meets the pristine store, a whole-suite run arrives after scenario 9's
 *  two writes and `a11y-focus`'s removal. Derived, not transcribed — the point of holding
 *  the page to a PAIR is that a page reporting a count from nowhere still fails. */
const ACTIVE_POPULATIONS = [
  seedRecordsMatching({ status: ["active"] }, browseSeedRecords()).length,
  seedRecordsMatching({ status: ["active"] }, browseSeedRecordsAfterA11yFocus()).length,
]

test.describe("keyboard-only walkthrough", () => {
  test.setTimeout(150_000)

  test("filter, sort, select-all, bulk, load-more and the page beyond, by key press only", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // 1. FILTERS. Walk to the funnel, open it, tick a value, commit — all by key.
    await page.locator("body").press("Tab")
    const statusFunnel = page.getByRole("button", { name: "Filter status", exact: true })
    await walkUntil(page, () => hasFocus(statusFunnel))
    await page.keyboard.press("Enter")
    const menu = page.locator("[data-pretable-filter-menu]")
    await expect(menu).toBeVisible()
    // The menu takes focus on open (pretable seats it on the operator control), which is
    // what makes the set below reachable without a pointer.
    await expect(menu.locator("[data-pretable-filter-operator]")).toBeFocused()
    const activeBox = menu
      .locator("[data-pretable-filter-set]")
      // `exact`: the accessible name of each box is the option's own value, so substring
      // matching would turn any value that prefixes another into a strict-mode violation.
      .getByRole("checkbox", { name: "active", exact: true })
    await walkUntil(page, () => hasFocus(activeBox), { budget: 20 })
    await page.keyboard.press("Space")
    await expect(activeBox).toBeChecked()
    // Escape COMMITS as well as closes — pretable flushes the pending draft from the
    // menu's unmount cleanup.
    await page.keyboard.press("Escape")
    await expectPhase(page, "idle")

    // The gesture reached the SERVER, not merely the funnel's own display state: the
    // matching population is now the active one. Read off the page and held to the two
    // states the shared fixture can be in.
    await expect(statusFunnel).toHaveAttribute("data-pretable-filter-active", "true")
    const rendered = await total(page).innerText()
    expect(ACTIVE_POPULATIONS.map(n)).toContain(rendered)
    const matching = Number(rendered.replaceAll(",", ""))
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, matching))

    // DIVERGENCE 1 — design §1.1, which records it as a pre-existing pretable gap and
    // explicitly NOT a D1 obligation: `FilterMenu` does not restore focus on Escape (the
    // column ⋮ menu does). So a keyboard user who applies a filter is returned to
    // `<body>` and re-enters the page from the top. Pinned rather than asserted away: if
    // pretable ever restores the trigger this reddens, and the fix is to amend §1.1 and
    // turn this into `await expect(statusFunnel).toBeFocused()`.
    expect(
      (await activeStop(page)).tag,
      "design §1.1 records that pretable's FilterMenu does not restore focus on Escape",
    ).toBe("BODY")

    // 2. SORT, from the header cell — which pretable renders as a real <button>, so it is
    // in the tab order and Enter activates it. One activation is DESCENDING (the cycle is
    // none → desc → asc → none).
    //
    // Located by attribute, through `sortHeader`, and NOT by `getByRole("button")`: the
    // element is a `<button>` carrying `role="columnheader"`, and the explicit role is
    // what ARIA queries see. A role query finds nothing here and reports as a timeout
    // rather than as "this control is not a button".
    const confidenceHeader = sortHeader(page, "confidence")
    await walkUntil(page, () => hasFocus(confidenceHeader))
    await page.keyboard.press("Enter")
    await expectPhase(page, "idle")
    await expect(confidenceHeader).toHaveAttribute("aria-sort", "descending")
    // Still the same population — a sort re-ranks, it does not re-select.
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, matching))

    // 3. SELECTION, from the header checkbox — BACKWARDS, because the select-all sits at
    // the head of the header row and the sort left focus in the middle of it. A sort
    // pivots the datasetKey and clears selection (§9.3), so this cannot be done first.
    const selectAll = page.locator("[data-pretable-row-select-all]")
    const back = await walkUntil(page, () => hasFocus(selectAll), {
      key: "Shift+Tab",
      budget: 30,
    })
    // Backwards out of the header reaches the select-all without dropping into the body
    // or off the grid — the header is a contiguous run in both directions.
    expect(regionOrder(back)).toEqual(["header"])
    await page.keyboard.press("Space")
    await expect(page.getByTestId(TEST_IDS.bulkBar)).toContainText(`${BROWSE_PAGE_SIZE} selected`)

    // 4. ONE forward walk, from the header to the far side of the page, and every §9.2
    // claim about the ORDER read off it. Walked once rather than once per target because
    // each crossing of the body costs `BROWSE_PAGE_SIZE` key presses (see below).
    const forget = page
      .getByTestId(TEST_IDS.bulkBar)
      .getByRole("button", { name: `Forget ${BROWSE_PAGE_SIZE}`, exact: true })
    const walk = await walkUntil(page, () => hasFocus(forget))

    // The order design §9.2 states, as the walk actually ran it: header controls, then
    // the body, then the load-more footer, then the rest of the page. The bulk bar IS
    // "content after the grid" — reaching it is D1-A11Y-04's no-keyboard-trap clause, and
    // BULK ACTIONS are keyboard-operable exactly because this walk ends on one.
    expect(regionOrder(walk)).toEqual(["header", "body", "load-more", "bulk-bar"])

    const bodyStops = walk.filter((stop) => stop.region === "body")
    // The body is ENTERED at its entry, not at a row control. Phrased as "not a row
    // select" rather than as an identity because pretable's auto-seat is racy (see the
    // second test): the entry stop is the scroll-content box when the seat loses and the
    // head cell when it wins, and this claim is the one that holds either way. The roving
    // tabindex itself is the second test's subject.
    expect(bodyStops[0]?.rowSelect).toBe(false)

    // DIVERGENCE 2 — design §9.2 / D1-A11Y-04: "grid body (single entry stop, roving
    // tabindex)". It is not one stop. @pretable/react 0.3.0 renders every row's select
    // control as `<button aria-label="Select row">` with no `tabIndex`, so each is its own
    // native stop; tabbing to a row below the fold scrolls it in and the virtualizer draws
    // the next, so the walk crosses the whole LOADED window rather than the ~19 rows on
    // screen. Measured as an exact count so a partial fix is visible: one stop per loaded
    // data row (group headers render no select control and cost nothing), plus the entry.
    //
    // The user cost IS the number: the load-more control is 200 key presses away at the
    // first window and 1,000 at BROWSE_RESIDENT_CAP. The fix is upstream in pretable, not
    // in this page — the Inspector cannot decline the row-select column without dropping
    // the bulk actions D1 requires. When it lands, these two become `toBe(0)`/`toBe(1)`.
    expect(
      bodyStops.filter((stop) => stop.rowSelect).length,
      "design §9.2 says the grid body is a single tab stop; @pretable/react 0.3.0 adds " +
        "one native stop per loaded row through the row-select <button>",
    ).toBe(BROWSE_PAGE_SIZE)
    expect(bodyStops.length).toBe(BROWSE_PAGE_SIZE + 1)

    // 5. LOAD-MORE is the stop immediately before the bulk bar, so one Shift+Tab is the
    // whole distance back to it — and it is operable by key.
    await page.keyboard.press("Shift+Tab")
    await expect(loadMore(page)).toBeFocused()
    await page.keyboard.press("Enter")
    // The loaded count comes off the STATUS BAR — the DOM holds ~19 rows however many the
    // client is holding — and the WHOLE sentence is asserted, so a loaded count that
    // advanced while the population silently followed it still fails.
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, matching))
    await expectPhase(page, "idle")
    // It stays mounted and focused across the append, so focus never drops to `<body>` at
    // the moment the user finished paging (design §9.2).
    await expect(loadMore(page)).toBeFocused()
  })

  test("the grid body is entered once and roves, and a Tab out of it does not leave", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // Entered by KEY from the top of the page — the entry stop is only reachable if every
    // control before it is. The predicate is the REGION and not "inside the grid": the
    // header row is a descendant of the scroll viewport, so a containment test is
    // satisfied by the first header button and would never reach the body at all.
    await page.locator("body").press("Tab")
    const entry = await walkUntil(page, async () => (await activeStop(page)).region === "body", {
      budget: 120,
    })
    // Nothing in the body precedes it — the entry is the FIRST thing the body offers.
    expect(entry.filter((stop) => stop.region === "body")).toHaveLength(1)
    expect(entry[entry.length - 1]?.rowSelect).toBe(false)

    // Arrows drive the roving focus from the entry stop — the path that is always there.
    // Pretable ALSO tries to seat focus on the head cell when the Tab came from a header
    // control, and that attempt is RACY: it records the origin in the viewport's Tab
    // keydown and clears it from a `queueMicrotask`, a checkpoint that can run before the
    // browser has performed the focus move the seat is waiting for. Measured both ways in
    // this lane — entering straight out of the header row seats the head cell, entering
    // after the longer walk above leaves DOM focus on the scroll-content box — so nothing
    // here is allowed to depend on which happened.
    await page.keyboard.press("ArrowDown")
    await expect(async () => {
      const seated = await focusedCell(page)
      expect(seated.isCell).toBe(true)
      expect(seated.rowId).not.toBe("")
    }).toPass({ timeout: 15_000 })
    const first = await focusedCell(page)
    expect((await activeStop(page)).region).toBe("body")

    // Roving: another arrow moves the engine's focus to a different row and DOM focus
    // follows it, without leaving the viewport.
    await page.keyboard.press("ArrowDown")
    await expect(async () => {
      expect((await focusedCell(page)).rowId).not.toBe(first.rowId)
    }).toPass({ timeout: 15_000 })
    expect((await activeStop(page)).region).toBe("body")

    // Now that the arrows have moved off the head — which in the unscoped browse is a
    // GROUP row, rendered by a component of its own — the stronger half of §9.2's body
    // clause is checkable: the roving tabindex. Exactly one cell is marked focused,
    // exactly one is tabbable, and they are the same node.
    await expect(async () => {
      expect((await rovingCell(page)).rowId).not.toBe("")
    }).toPass({ timeout: 15_000 })

    // DIVERGENCE 2, at the exact point design §9.2 makes the claim. `tabBehavior="exit"`
    // hands Tab back to the browser rather than wrapping it inside the grid — which is
    // the right half — and the browser then finds the next row's select <button>, still
    // inside the viewport. A body that were one tab stop would put focus outside it here.
    await page.keyboard.press("Tab")
    const afterTab = await activeStop(page)
    expect(
      { region: afterTab.region, rowSelect: afterTab.rowSelect },
      "design §9.2 says one further Tab leaves the grid body; @pretable/react 0.3.0 lands " +
        "on the next row's row-select button instead",
    ).toEqual({ region: "body", rowSelect: true })
  })

  test("the initial failure's retry is reachable and operable by key, and costs one stop", async ({
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
    await expect(grid(page)).toHaveAttribute("data-pretable-data-phase", "error")

    await page.locator("body").press("Tab")
    const retry = page.getByTestId(TEST_IDS.retryInitial)
    const walk = await walkUntil(page, () => hasFocus(retry), { budget: 60 })

    // NOT "before anything else": §9.2 orders the error banner's retry ahead of the header
    // controls, and the control this scenario reaches is not that one. §6.4 supplies the
    // INITIAL failure's retry "through the body-state slot, not a second banner" so that
    // exactly one retry is ever on screen — and the measured order below is what that
    // decision costs: page chrome, then the grid's header controls, then the body's entry
    // stop, then the retry, which pretable renders OUTSIDE the scroll viewport. (§9.2's
    // ordering and Flow 7's "retry button above the grid" both describe a placement §6.4
    // rejects; the shipped code follows §6.4. The banner retry, `TEST_IDS.bannerRetry`, is
    // the control §9.2 means, and it appears only for a refresh or load-more failure.)
    //
    // The body clause §9.2 does govern holds here exactly, and for the reason that makes
    // it worth stating: with no rows to walk, the grid body costs ONE tab stop.
    expect(regionOrder(walk)).toEqual(["elsewhere", "header", "body", "elsewhere"])
    expect(walk.filter((stop) => stop.region === "body")).toHaveLength(1)

    failing = false
    await page.keyboard.press("Enter")
    await expectPhase(page, "idle")

    drainSeededFetchErrors(consoleErrors, 1)
  })
})
