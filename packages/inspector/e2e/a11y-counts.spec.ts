import type { Locator, Page } from "@playwright/test"
import {
  BROWSE_PAGE_SIZE,
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  seedIdsInDefaultOrder,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  browseSeedRecordsAfterScenario9,
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
 * of that downgrades to the loaded-model count, and a population that cannot be stated as
 * an integer at all downgrades to `-1` — ARIA's "the count is unknown".
 *
 * Pretable resolves those conditions as ORDERED guards (`resolveAriaRowCount`):
 * engine-side processing, then GROUPING, then a total that is not `exact`, then a
 * non-integer count, then a count below the loaded rows. The order is why each test below
 * has to pin which branch it is standing in and not merely which number it wanted — every
 * earlier guard answers with the same downgraded count for a different reason, so a test
 * that names only the number passes just as readily on the branch it did not mean.
 *
 * The first guard is the only one the browse grid cannot reach: `memory-grid.tsx` passes
 * `SERVER_PROCESSING` — a module constant — for every browse render. (The search-result
 * grids omit `processing` entirely and are handed no `resultMeta` to downgrade; a
 * different surface, and not this file's subject.)
 *
 * The other four are all reachable HERE, the two the plan called impossible included:
 *   - an `unknown` total, because `useMemoryBrowse` publishes `UNKNOWN_TOTAL_META` for as
 *     long as nothing is fulfilled — every render before the first response lands, and
 *     every render after an initial one failed;
 *   - a non-integer count, because `isBrowsePage` admits any `typeof page.total ===
 *     "number"` and a fraction is one. That boundary gap is a PRODUCT defect rather than
 *     a fixture convenience: a fractional total from the store reaches ARIA with nothing
 *     but pretable's own downgrade between it and the user, and the test below pins that
 *     second line of defence precisely because the first one is missing.
 *
 * GROUPING is one of §4.5's conditions and the unscoped browse is grouped
 * (`list-page.tsx`: `groupByNamespace={namespace === undefined}`), so the population branch
 * is reachable only under a FACET and the unscoped view IS the grouped-downgrade branch.
 * This file is the one place both are asserted side by side.
 *
 * §4.5's `aria-busy` prohibition is over PHASES rather than branches, and the last two
 * tests split `browse-machine.ts`'s six between them — three that need no fault and three
 * that do.
 */

/** The facet this file scopes to. Chosen because it survives the shared fixture: scenario
 *  9's two writes both land in `route=/notes-archive` (see the derivation block in
 *  `helpers.ts`), so this namespace holds the same 667 records in the same default order
 *  whether this file runs alone against a freshly seeded store or after every mutating
 *  scenario. Nothing here needs `browseSeedRecordsAfterScenario9()` for that reason, and
 *  nothing here depends on where this file sorts in a whole-suite run. */
const SCOPED = seedRecordsMatching({ namespace: "route=/notes" })
const SCOPED_ORDER = seedIdsInDefaultOrder(SCOPED)

/** The lie the undercount test makes the server tell: a full window of records under a
 *  total far below it. 200 loaded records cannot be a contiguous prefix of a 5-row
 *  population, which is the contract `PretableResultMeta` states and §4.5 downgrades on. */
const UNDERCOUNTED_TOTAL = 5

/** A total that is a number and is not an integer — and is ABOVE the loaded window, so the
 *  undercount guard cannot be what moves the count. The Inspector's own boundary lets this
 *  through (see the header); pretable is what refuses to publish it. */
const FRACTIONAL_TOTAL = BROWSE_PAGE_SIZE * 2 + 0.5

/** A total the BOUNDARY rejects rather than one pretable downgrades: `isBrowsePage`
 *  requires `typeof total === "number"`, so the page the store formatted arrives as an
 *  ordinary request failure and nothing is ever fulfilled. A 500 would put the machine in
 *  the same state, but it also makes the browser log a failed subresource — and the
 *  `consoleErrors` fixture is the gate every spec here leans on, so a test that injected
 *  one would have to drain the gate it depends on. This lie is silent. */
const REJECTED_TOTAL = n(BROWSE_SEED_COUNT)

/** Serve every browse window from the head of the seed under a `total` of the caller's
 *  choosing. `continuation: null`, so the client cannot walk past the claim and discover
 *  it. */
async function lieAboutTotal(page: Page, claimed: unknown): Promise<void> {
  await page.route("**/api/memory/list*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        records: browseSeedRecords().slice(0, BROWSE_PAGE_SIZE),
        total: claimed,
        continuation: null,
      }),
    })
  })
}

/** The facet button, located by the count the rail publishes beside it, so a fixture that
 *  drifted fails at the click rather than downstream of it. The rail's counts come from
 *  `/api/memory/stats`, a different endpoint from the one every lie above intercepts —
 *  so this finds the same button under all of them, and under a browse that never
 *  answered at all. */
function facet(page: Page): Locator {
  return page.getByRole("button", { name: `route=/notes ${SCOPED.length}`, exact: true })
}

/**
 * Scope to `route=/notes`, and assert the precondition the population branch needs.
 *
 * `role` is the assertion, not decoration: pretable publishes `treegrid` exactly while it
 * is grouping and `grid` otherwise, and grouping is §4.5's first REACHABLE downgrade — it
 * is checked before the total is even read. Without this line a run in which the facet
 * silently failed to turn grouping off would reach the `aria-rowcount` assertions below as
 * a grouped grid, and they would be about the wrong branch.
 */
async function scopeToNotes(page: Page): Promise<void> {
  await facet(page).click()
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

/**
 * A response hold: the promise a route handler awaits, and the switch that frees it.
 *
 * Both phase tests below hold a response open to make a phase observable and release it
 * once they have read it, and neither takes a TIMEOUT to release itself with. An assertion
 * failing between those two lines does leave a handler awaiting forever, but Playwright
 * tears the context down without waiting on it and reports the assertion — checked by
 * failing a test on purpose between a hold and its release, which ended the run in the same
 * few seconds a passing one takes. A ceiling would buy nothing against that and would add
 * one way to fail: a loaded machine releasing a hold the test still needed, which reads as
 * the phase never having occurred.
 */
function hold(): { held: Promise<void>; release: () => void } {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held, release: () => release() }
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

    // The drawn prefix all three fixture states agree on (see `helpers.ts`): this file may
    // run after the mutating scenarios or against the pristine seed on its own. The slice
    // is a CEILING rather than the mechanism — `expectDrawnRows` compares only as many rows
    // as the viewport actually drew, ~19 against a stable prefix of 163, so today it never
    // binds; it is what keeps this expectation honest if that viewport ever grows past the
    // prefix.
    await expectDrawnRows(page, DRAWN_FIRST_WINDOW.slice(0, SCENARIO_9_STABLE_DRAWN_PREFIX))
    // The rowcount is the whole projection, which is deeper than any drawn prefix — so what
    // makes it safe under either fixture state is this checked equality, not the slice
    // above.
    expect(DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9.length).toBe(DRAWN_FIRST_WINDOW.length)
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(DRAWN_FIRST_WINDOW.length + 1))

    // The population, read off the page — held to the two values the shared fixture can be
    // in, both DERIVED from the seed module rather than transcribed, so a page reporting a
    // count from nowhere fails here rather than being adopted as the expectation.
    const rendered = await total(page).innerText()
    expect([n(BROWSE_SEED_COUNT), n(browseSeedRecordsAfterScenario9().length)]).toContain(rendered)
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
    await lieAboutTotal(page, UNDERCOUNTED_TOTAL)
    await openBrowse(page)
    // SCOPED, and that is what makes this test about the undercount at all: grouping is
    // checked first and would downgrade the rowcount on its own, so the unscoped view
    // cannot distinguish this branch from the previous test's. Under the facet the grid is
    // ungrouped and the total is the only thing left that can move the count.
    await scopeToNotes(page)

    // Polled rather than read once: `MemoryGrid` sizes its viewport from an estimate until
    // the engine's first telemetry lands, so the rendered set can still change a frame
    // after the phase reads `idle`.
    await expect
      .poll(() => grid(page).locator("[data-pretable-row-id]").count())
      .toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(BROWSE_PAGE_SIZE + 1))
  })

  test("a NON-INTEGER total downgrades to the loaded-model count", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    // The branch the plan called unreachable. It is reachable because the Inspector's own
    // boundary check admits it (header); this test therefore stands one layer downstream of
    // where the rejection belongs, and says so.
    await lieAboutTotal(page, FRACTIONAL_TOTAL)
    await openBrowse(page)
    await scopeToNotes(page)

    // Which guard fired, checked rather than asserted by the number: a fractional total
    // BELOW the loaded window would be downgraded by the undercount guard first, and this
    // test would then be a duplicate of the one above wearing a decimal point.
    expect(FRACTIONAL_TOTAL).toBeGreaterThan(BROWSE_PAGE_SIZE)
    await expect
      .poll(() => grid(page).locator("[data-pretable-row-id]").count())
      .toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    await expect(grid(page)).toHaveAttribute("aria-rowcount", String(BROWSE_PAGE_SIZE + 1))
    // The page still reports the population it was told, in the chrome where an inexact
    // number is allowed to be prose: the downgrade is about what ARIA may claim as a
    // POSITION space, not about hiding the server's answer.
    await expect(total(page)).toHaveText(n(FRACTIONAL_TOTAL))
  })

  test("an UNKNOWN total publishes -1, not the rows that happen to be loaded", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    // The second branch the plan called unreachable. Every window is refused at the
    // boundary, so `useMemoryBrowse` never fulfills and its `resultMeta` stays
    // `{total:{kind:"unknown"}}` for the whole test.
    await lieAboutTotal(page, REJECTED_TOTAL)
    await page.goto("/memory")
    // Pretable's hydration signal before the facet click below: an SSR'd control is painted
    // and inert, and a click landing before it flips is silently dropped.
    await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
    await expectPhase(page, "error")

    // Unscoped, so GROUPING answers first and the unknown total is never consulted: the
    // empty loaded model publishes 1. Asserted so the -1 below is attributable to the
    // scoping and not to the failure.
    await expect(grid(page)).toHaveAttribute("role", "treegrid")
    await expect(grid(page)).toHaveAttribute("aria-rowcount", "1")

    // Ungrouped, and now the total is the only thing left to answer with — and there is no
    // total. `-1` is ARIA's "unknown", which is the honest answer; the loaded-model count
    // would be a grid claiming to know it has none.
    await facet(page).click()
    await expect(grid(page)).toHaveAttribute("role", "grid")
    await expectPhase(page, "error")
    await expect(grid(page)).toHaveAttribute("aria-rowcount", "-1")
  })

  test("no aria-busy while LOADING, idle or appending", async ({ page, consoleErrors }) => {
    void consoleErrors
    // Hold the initial request open so `loading` is observable, and hold the FIRST cursored
    // request so `loading-more` is too. Both are latches rather than predicates: the browse
    // re-polls every 2 s, and holding every tick would leave the page permanently
    // mid-flight.
    const initial = hold()
    const append = hold()
    let heldInitial = false
    let heldAppend = false
    await page.route("**/api/memory/list*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("cursor")) {
        if (!heldAppend) {
          heldAppend = true
          await append.held
        }
      } else if (!heldInitial) {
        heldInitial = true
        await initial.held
      }
      await route.continue()
    })

    await page.goto("/memory")
    await expectPhase(page, "loading")
    await expectNoAriaBusy(page)
    initial.release()

    await expectPhase(page, "idle")
    await expectNoAriaBusy(page)

    // Pretable's hydration signal before the click: an SSR'd control is painted and inert,
    // and a click landing before it flips is silently dropped.
    await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
    await loadMore(page).click()
    await expectPhase(page, "loading-more")
    await expectNoAriaBusy(page)
    append.release()

    await expect(status(page)).toContainText(`${n(BROWSE_PAGE_SIZE * 2)} loaded`)
    await expectPhase(page, "idle")
    await expectNoAriaBusy(page)

    // Both faults were actually injected. Without this the claims above are made about a
    // page that was never held, and a param this route stopped recognising would take them
    // with it, silently.
    expect({ heldInitial, heldAppend }).toEqual({ heldInitial: true, heldAppend: true })
  })

  test("no aria-busy while REFRESHING, stale or failed", async ({ page, consoleErrors }) => {
    void consoleErrors
    // The other three of `browse-machine.ts`'s six phases. Each needs a fault the previous
    // test does not: a tick held open, a query change held open over the rows it is
    // replacing, and that same request refused.
    await openBrowse(page)

    const tick = hold()
    const scoped = hold()
    let heldTick = false
    let heldScoped = false
    await page.route("**/api/memory/list*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("namespace")) {
        if (!heldScoped) {
          heldScoped = true
          await scoped.held
        }
        // Refused at the BOUNDARY rather than with a 500, for the reason `REJECTED_TOTAL`
        // states: a status the browser logs would make this test drain the console gate it
        // is otherwise protected by.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ records: [], total: REJECTED_TOTAL, continuation: null }),
        })
        return
      }
      if (!heldTick) {
        heldTick = true
        await tick.held
      }
      await route.continue()
    })

    // REFRESHING: the desired revision is fulfilled and a poll tick is in flight over it.
    await expectPhase(page, "refreshing")
    await expectNoAriaBusy(page)
    tick.release()
    await expectPhase(page, "idle")

    // STALE: the facet bumps the desired revision while the previous revision's rows are
    // still on screen — the one phase in which the grid is showing an answer to a question
    // the user has already moved on from, and the strongest case for a busy flag.
    await facet(page).click()
    await expectPhase(page, "stale")
    await expectNoAriaBusy(page)
    scoped.release()

    // ERROR: nothing is fulfilled for the desired revision, so the phase holds rather than
    // flickering on the poll cadence, and the prohibition has to hold with it.
    await expectPhase(page, "error")
    await expectNoAriaBusy(page)

    expect({ heldTick, heldScoped }).toEqual({ heldTick: true, heldScoped: true })
  })
})
