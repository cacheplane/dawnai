import type { Locator, Page } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_RESIDENT_CAP,
  browseSeedRecords,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  browseSeedRecordsAfterA11yFocus,
  drainSeededFetchErrors,
  expectPhase,
  focusReport,
  grid,
  loadMore,
  n,
  openBrowse,
  rovingCell,
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
 * has to cross the grid to come round again. A walk that means to describe the page's
 * order therefore starts where the load left focus and lets `walkUntil` press first, so
 * that stop #1 is IN the record rather than consumed ahead of it.
 *
 * TWO of §9.2's claims are false against what ships. Both are pinned INVERTED rather than
 * deleted, so the day either is fixed this file reddens and the design and the test get
 * amended together. They are named at their assertions: the body is not one tab stop (it
 * costs one per LOADED row), and the filter menu drops focus to `<body>` on Escape.
 */

/** A stop on a tab walk, resolved to the §9.2 region that owns it. Structured rather
 *  than a printed string, because the ORDER of the regions is itself one of §9.2's
 *  claims and a string blob can only be eyeballed.
 *
 *  `tag` is `"BODY"` or `"NONE"` for the two focus-less states, which are different page
 *  states and are kept apart for that reason: `<body>` is where a portaled popover drops
 *  focus when it closes, while a null active element means the document has no focus owner
 *  at all. An assertion that meant one of them would be satisfied by the other if this
 *  collapsed them. */
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
        return {
          tag: el === null ? "NONE" : "BODY",
          label: "",
          region: "elsewhere" as const,
          rowSelect: false,
        }
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
 * budget-free version does, and it reports as a timeout with nothing in it.
 *
 * DERIVED rather than chosen, because a literal is a silent coupling to the page size.
 * Today the body costs one stop per LOADED row (see DIVERGENCE 2), so a walk that crosses
 * it after a single load-more already costs `BROWSE_PAGE_SIZE * 2` — and a ceiling picked
 * against today's one-window crossing would report a merely EXPENSIVE walk as an
 * unreachable control, which is the one thing this must never do. `BROWSE_RESIDENT_CAP` is
 * the most rows the client will ever hold at once, so this bounds the worst crossing the
 * page can produce, plus room for the chrome on either side of it. The COST is asserted
 * separately, where it reads as the defect it is.
 */
async function walkUntil(
  page: Page,
  predicate: () => Promise<boolean>,
  {
    key = "Tab",
    budget = BROWSE_RESIDENT_CAP + 40,
  }: { key?: "Tab" | "Shift+Tab"; budget?: number } = {},
): Promise<Stop[]> {
  const walked: Stop[] = []
  for (let step = 0; step < budget; step += 1) {
    if (await predicate()) return walked
    await page.keyboard.press(key)
    walked.push(await activeStop(page))
  }
  // SUMMARISED, not dumped: the budget admits ~1,000 stops, and printing each one buries
  // the two things a reader needs — the shape of the walk, and where it ended up.
  throw new Error(
    `never reached the target in ${budget} ${key} stops; regions: ` +
      `${regionOrder(walked).join(" -> ")}; last stops: ` +
      walked
        .slice(-20)
        .map((stop) => `${stop.region}:${stop.tag}|${stop.label}`)
        .join(" -> "),
  )
}

/** Consecutive duplicates collapsed — the walk's shape, which is what §9.2 states. */
function regionOrder(walk: readonly Stop[]): string[] {
  return walk.map((stop) => stop.region).filter((region, i, all) => region !== all[i - 1])
}

function hasFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => node === document.activeElement)
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
    //
    // The walk starts from where the load left focus and `walkUntil` presses before it
    // records, so its first entry IS the page's first tab stop.
    expect((await activeStop(page)).tag).toBe("BODY")
    // SCOPED to the browse grid, like `openFilterMenu`'s identical query: `list-page`
    // keeps this subtree mounted across every view switch and a search renders one more
    // `MemoryGrid` per result group, so an unscoped funnel query resolves to 1 + N — and
    // `hasFocus` goes through `locator.evaluate`, which is strict, so a later walk over a
    // search-bearing page would throw rather than quietly miss.
    const statusFunnel = grid(page).getByRole("button", { name: "Filter status", exact: true })
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
    // states the shared fixture can be in, so a page reporting a count from nowhere fails.
    //
    // RETRIED, and phrased as the ANSWER rather than as two gates in front of it: both
    // gates are satisfiable while the unfiltered total is still on screen. Pretable renders
    // `data-pretable-filter-active` off its own client filter model, and the `idle` above
    // can be the state the gesture was about to leave — the request it causes is dispatched
    // from an effect a tick later.
    await expect(statusFunnel).toHaveAttribute("data-pretable-filter-active", "true")
    await expect(total(page)).toHaveText(new RegExp(`^(${ACTIVE_POPULATIONS.map(n).join("|")})$`))
    const matching = Number((await total(page).innerText()).replaceAll(",", ""))
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, matching))

    // DIVERGENCE 1 — design §1.1, which records it as a pre-existing pretable gap and
    // explicitly NOT a D1 obligation: `FilterMenu` does not restore focus on Escape (the
    // column ⋮ menu does). So a keyboard user who applies a filter is returned to
    // `<body>` and re-enters the page from the top. Pinned rather than asserted away: if
    // pretable ever restores the trigger this reddens, and the fix is to amend §1.1 and
    // turn this into `await expect(statusFunnel).toBeFocused()`.
    expect(
      (await activeStop(page)).tag,
      "design §1.1 records that pretable's FilterMenu does not restore focus on Escape; it " +
        "drops focus to <body>",
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
    const selectAll = grid(page).locator("[data-pretable-row-select-all]")
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
    // "content after the grid" — reaching it is D1-A11Y-04's no-keyboard-trap clause.
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
    // The user cost IS the number: the load-more control is `BROWSE_PAGE_SIZE` key presses
    // away at the first window. By the same mechanism it WOULD be `BROWSE_RESIDENT_CAP`
    // once the client is holding its cap — an extrapolation from the rule this assertion
    // pins, not a second measurement; nothing in this file pages past two windows. The fix
    // is upstream in pretable, not in this page — the Inspector cannot decline the
    // row-select column without dropping the bulk actions D1 requires. When it lands, these
    // two become `toBe(0)` / `toBe(1)`.
    expect(
      bodyStops.filter((stop) => stop.rowSelect).length,
      "design §9.2 says the grid body is a single tab stop; @pretable/react 0.3.0 adds " +
        "one native stop per loaded row through the row-select <button>",
    ).toBe(BROWSE_PAGE_SIZE)
    expect(bodyStops.length).toBe(BROWSE_PAGE_SIZE + 1)

    // BULK ACTIONS are OPERABLE by key, not merely reachable — §9.2 asks for both, and a
    // walk that only lands on the control proves the weaker half. Enter runs the handler,
    // which asks `window.confirm` BEFORE it writes: the confirm's own text is therefore
    // proof the handler fired with the whole selection, and dismissing it is what keeps
    // this walkthrough a pure reader. Activating for real would forget `BROWSE_PAGE_SIZE`
    // records out of the store every spec in this lane shares.
    let confirmed = "<no dialog>"
    page.once("dialog", (dialog) => {
      confirmed = `${dialog.type()}|${dialog.message()}`
      void dialog.dismiss()
    })
    await page.keyboard.press("Enter")
    await expect
      .poll(() => confirmed)
      .toBe(`confirm|Permanently forget ${BROWSE_PAGE_SIZE} selected memor(ies)?`)
    // Dismissed means nothing was written: no bulk error, the selection intact, the
    // population untouched — and the control kept focus, so step 5 continues from here.
    await expect(page.getByTestId(TEST_IDS.bulkError)).toHaveCount(0)
    await expect(page.getByTestId(TEST_IDS.bulkBar)).toContainText(`${BROWSE_PAGE_SIZE} selected`)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, matching))
    await expect(forget).toBeFocused()

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
    expect((await activeStop(page)).tag).toBe("BODY")
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
    //
    // `focusReport` and not `rovingCell` until the arrows have run: at the entry stop the
    // grid has marked NO cell, so `rovingCell` throws there by design. A non-empty ROW id
    // is what says the focused node is a cell in the body — the header row's cells carry
    // `data-pretable-column-id` too, but no row id — and it answers for the head of this
    // grouped model, which is a GROUP row, exactly as it does for a record.
    await page.keyboard.press("ArrowDown")
    await expect(async () => {
      const seated = await focusReport(page)
      expect(seated.rowId).not.toBe("")
      expect(seated.columnId).not.toBe("")
      expect(seated.inGrid).toBe(true)
    }).toPass({ timeout: 15_000 })
    const first = await focusReport(page)

    // Roving: another arrow moves the engine's focus to a different row and DOM focus
    // follows it, without leaving the viewport.
    await page.keyboard.press("ArrowDown")
    await expect(async () => {
      const moved = await focusReport(page)
      expect(moved.rowId).not.toBe(first.rowId)
      expect(moved.rowId).not.toBe("")
      expect(moved.inGrid).toBe(true)
    }).toPass({ timeout: 15_000 })

    // Now the stronger half of §9.2's body clause is checkable: the roving tabindex.
    // Exactly one cell is marked focused, exactly one is tabbable, they are the same node
    // — AND that node is where DOM focus actually is, which is the half a perfectly
    // self-consistent engine could satisfy while the browser's focus sat somewhere else.
    //
    // Both reads inside ONE retry, so a commit landing between them is re-driven rather
    // than reported as a mismatch; `rovingCell` throws on a transient re-measure, which
    // with `retries: 0` would be a hard suite failure rather than a re-driven read.
    await expect(async () => {
      const roving = await rovingCell(page)
      expect(roving.rowId).not.toBe("")
      const dom = await focusReport(page)
      expect({ rowId: dom.rowId, columnId: dom.columnId }).toEqual(roving)
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
    // Subsumes the `data-pretable-hydrated` gate every sibling spec takes before its first
    // key press: `useHydrated` is a `useSyncExternalStore` that answers false on the server
    // and renders on the same node as the phase, so an `error` phase is only producible by
    // the hydrated client's own failed fetch.
    await expect(grid(page)).toHaveAttribute("data-pretable-data-phase", "error")

    expect((await activeStop(page)).tag).toBe("BODY")
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
