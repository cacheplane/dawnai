import type { Locator, Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"
// Types only from `@dawn-ai/memory`, so nothing here pulls `node:sqlite` into the
// Playwright process — `seed.ts` is pure data and computation, and `seed-store.ts` is
// the half that writes it.
import { browseSeedRecords } from "../test/seed"

/** The browse endpoint, mirrored from `use-memory-browse`'s fetch rather than imported:
 *  that module is `"use client"` and pulls React, so it cannot load in the runner. A
 *  rename makes the waits below time out, never pass early. */
const BROWSE_ENDPOINT = "/api/memory/list"

/** The browse surface. `list-page` keeps this subtree MOUNTED and only `hidden` across
 *  every view switch, and a search renders one more `MemoryGrid` per result group beside
 *  it — every one of them carrying the same `aria-label="Memories"`. An unscoped grid
 *  locator therefore resolves to 1 + N elements the moment a search is active: the
 *  assertions below would throw on strict mode, and `rowIds`' `evaluateAll` — which is
 *  NOT strict — would silently concatenate the hidden browse rows with the search rows
 *  and answer in DOM order. */
export function browseRegion(page: Page): Locator {
  return page.getByTestId(TEST_IDS.browseRegion)
}

/** The grid inside `scope`. Pretable puts role + aria-label + the phase attribute on the
 *  scroll viewport itself, so this one locator is also the ARIA subject. Take the search
 *  results' own section as `scope` to assert on those instead. */
export function gridIn(scope: Locator): Locator {
  return scope.locator('[data-pretable-scroll-viewport][aria-label="Memories"]')
}

/** The browse grid — the surface every helper and spec below means. */
export function grid(page: Page): Locator {
  return gridIn(browseRegion(page))
}

/** Pretable's own hydration signal. Clicking before it flips is silently dropped —
 *  the single largest source of flaky "clicked it, nothing happened" e2e failures. */
export async function openBrowse(page: Page): Promise<void> {
  await page.goto("/memory")
  await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
  await expectPhase(page, "idle")
}

export async function expectPhase(
  page: Page,
  phase: "idle" | "loading" | "stale" | "refreshing" | "loading-more" | "error",
): Promise<void> {
  await expect(grid(page)).toHaveAttribute("data-pretable-data-phase", phase)
}

/** Every row id the browse grid has in the DOM, in DOM order. Two things this cannot
 *  show: the grid VIRTUALIZES, so this is the rows that fit the viewport and not the
 *  whole loaded window; and the unscoped browse is GROUPED (`list-page` passes
 *  `groupByNamespace` whenever no namespace facet is selected), so the list is
 *  interleaved with pretable's `__group__:` header ids. A caller that wants records
 *  has to drop those, and one that wants the server's flat order has to scope to a
 *  namespace first.
 *
 *  One-shot, and deliberately not retrying: `MemoryGrid` sizes its viewport from a
 *  row-count estimate until the engine's first telemetry callback lands, so the rendered
 *  set can still change a frame after the phase reads `idle`. Callers assert through
 *  `expect.poll`/`toPass` so that settling is retried rather than raced. */
export async function rowIds(page: Page): Promise<string[]> {
  return grid(page)
    .locator("[data-pretable-row-id]")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = (node as HTMLElement).dataset.pretableRowId
        if (id === undefined) throw new Error("pretable rendered a row without a row id")
        return id
      }),
    )
}

export async function scrollTop(page: Page): Promise<number> {
  return grid(page).evaluate((node) => node.scrollTop)
}

/** The single permanent polite region, portalled to document.body. */
export async function liveRegionText(page: Page): Promise<string> {
  return page.locator("[data-pretable-live-region]").innerText()
}

export function loadMore(page: Page): Locator {
  return page.getByTestId(TEST_IDS.loadMore)
}

export function status(page: Page): Locator {
  return page.getByTestId(TEST_IDS.status)
}

/** The matching population on its own node, so a reader takes the number without
 *  parsing the sentence around it. Still locale-formatted — the runner pins `en-US`. */
export function total(page: Page): Locator {
  return page.getByTestId(TEST_IDS.total)
}

/** Pretable's group row id, mirrored: `__group__:<columnId>=s:<value>` with `%`, `/`
 *  and `=` percent-escaped (grid-core `makeGroupId`/`escapeGroupKey`). */
function groupRowId(namespace: string): string {
  const escaped = namespace.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/=/g, "%3D")
  return `__group__:namespace=s:${escaped}`
}

/** Pretable orders group siblings with these exact options (grid-core `sortSiblings`),
 *  ascending unless the active sort targets the grouped column — which nothing in this
 *  lane sorts by. Constructed the same way here so this really is the shipped
 *  comparator and not a lookalike that happens to agree on three lowercase-ASCII
 *  namespaces. */
const groupCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * A server window, projected into what the UNSCOPED browse DRAWS.
 *
 * `list-page` passes `groupByNamespace={namespace === undefined}`, so `/memory` — which
 * every scenario here opens on — groups whatever window the server returned: one
 * `__group__:` row per namespace, groups ascending by key, rows inside a group still in
 * the order the server sent them. An expectation that skipped this would be comparing
 * the server's flat order against a list the grid never renders.
 *
 * Every scenario's expectation goes through here, so each one pins BOTH the server's
 * ordered window and the grouping laid over it: a window the server chose differently,
 * or an id tie-break that had drifted, moves rows across and within these buckets.
 */
export function asDrawn(windowIds: readonly string[]): string[] {
  const namespaceOf = new Map(browseSeedRecords().map((record) => [record.id, record.namespace]))
  const buckets = new Map<string, string[]>()
  for (const id of windowIds) {
    const namespace = namespaceOf.get(id) as string
    const bucket = buckets.get(namespace)
    if (bucket) bucket.push(id)
    else buckets.set(namespace, [id])
  }
  const out: string[] = []
  for (const namespace of [...buckets.keys()].sort(groupCollator.compare)) {
    out.push(groupRowId(namespace))
    out.push(...(buckets.get(namespace) as string[]))
  }
  return out
}

/** A floor on how much of the window the virtualizer has to actually draw. The grid
 *  caps its viewport height, so only ~19 of a 200-row window is ever in the document —
 *  but without a floor, `slice(0, ids.length)` lets the value under test choose its own
 *  coverage, and a regression that collapsed the grid to a single row would satisfy any
 *  prefix. Well under the ~19 the capped viewport currently fits, because that count is
 *  a rendering detail and this is a floor, not a pin. */
const MIN_RENDERED_ROWS = 15

/**
 * The browse grid draws exactly the head of `expected`.
 *
 * Two facts force "head" rather than "all". The grid VIRTUALIZES, so a 200-row window
 * is never wholly in the document; and the rendered set can still change a frame after
 * the phase reads `idle` (see `rowIds`), so the read is retried rather than raced —
 * inside the retry, so a floor over a single snapshot does not become a flake.
 *
 * When `expected` is shorter than the floor it is asserted WHOLE, which is the stronger
 * claim and the one a narrow filter earns.
 */
export async function expectDrawnRows(page: Page, expected: readonly string[]): Promise<void> {
  await expect(async () => {
    const ids = await rowIds(page)
    expect(ids.length).toBeGreaterThanOrEqual(Math.min(MIN_RENDERED_ROWS, expected.length))
    expect(ids.length).toBeLessThanOrEqual(expected.length)
    expect(ids).toEqual(expected.slice(0, ids.length))
    // Bounded well under the test timeout: a genuinely wrong window would otherwise
    // retry for the full 60 s and report as a timeout rather than as a diff.
  }).toPass({ timeout: 15_000 })
}

/** Open a column's funnel. Pretable labels both the funnel button and the popover
 *  `Filter <header>`, and renders the popover through OverlayPortal — outside the
 *  grid, so it is located from the page while its trigger is located from the grid. */
export async function openFilterMenu(page: Page, header: string): Promise<Locator> {
  await grid(page)
    .getByRole("button", { name: `Filter ${header}`, exact: true })
    .click()
  const menu = page.locator("[data-pretable-filter-menu]")
  await expect(menu).toBeVisible()
  return menu
}

/** Escape is what COMMITS a typed value, not merely what closes the panel: pretable
 *  debounces the text input by 200 ms and flushes the pending draft from the menu's
 *  unmount cleanup. A helper that closed by clicking elsewhere would race that flush. */
export async function applyTextFilter(
  page: Page,
  header: string,
  operator: string,
  value: string,
): Promise<void> {
  const menu = await openFilterMenu(page, header)
  await menu.locator("[data-pretable-filter-operator]").selectOption(operator)
  await menu.locator("[data-pretable-filter-value]").fill(value)
  await page.keyboard.press("Escape")
}

export async function applySetFilter(
  page: Page,
  header: string,
  values: readonly string[],
): Promise<void> {
  const menu = await openFilterMenu(page, header)
  for (const value of values) {
    await menu.locator("[data-pretable-filter-set]").getByRole("checkbox", { name: value }).check()
  }
  await page.keyboard.press("Escape")
}

export async function clearFilter(page: Page, header: string): Promise<void> {
  const menu = await openFilterMenu(page, header)
  await menu.locator("[data-pretable-filter-clear]").click()
  await page.keyboard.press("Escape")
}

/** A column's header cell — the sort control, and the element carrying `aria-sort`.
 *  Located by the accessible name pretable gives it, the same channel
 *  `openFilterMenu` uses for the funnel beside it. */
export function sortHeader(page: Page, header: string): Locator {
  return grid(page).locator(`[data-pretable-header-cell][aria-label="Sort ${header}"]`)
}

/** Click a header cell to advance its sort. Pretable's cycle is none → desc → asc →
 *  none, so ONE click is descending and two are ascending. */
export async function sortByHeader(page: Page, header: string): Promise<void> {
  await sortHeader(page, header).click()
}

/**
 * Time a user action from the gesture to the moment the grid ANSWERS it. This is design
 * §11's "end-to-end interaction" budget, measured rather than asserted by construction.
 *
 * `settled` is the caller's own check that the new answer is on screen, and it is a
 * parameter rather than a phase read for a reason: the grid is already `idle` when the
 * gesture lands, and the request that gesture causes is dispatched from an effect a
 * tick later — so waiting for `idle` alone can be satisfied by the state the gesture
 * was about to leave, and report a duration that timed nothing. The phase is asserted
 * after `settled` anyway, so a number is only ever returned for a fulfilled revision.
 */
export async function timeToFulfilled(
  page: Page,
  act: () => Promise<void>,
  settled: () => Promise<void>,
): Promise<number> {
  const started = Date.now()
  await act()
  await settled()
  await expectPhase(page, "idle")
  return Date.now() - started
}

/** Wait out one poll: block until a browse request that STARTED after this call has
 *  fully responded.
 *
 *  Not a sleep. A sleep has to add an invented latency margin to the 2 s cadence and
 *  hope, and a poll already in flight when the caller returns answers a question asked
 *  before whatever the caller just did — so a sleep long enough to catch that stale
 *  response reports the tick as observed. Waiting for the request first pins both ends. */
export async function waitOnePollPeriod(page: Page): Promise<void> {
  const request = await page.waitForRequest((candidate) =>
    candidate.url().includes(BROWSE_ENDPOINT),
  )
  const response = await request.response()
  if (response === null) throw new Error(`browse poll ${request.url()} produced no response`)
  await response.finished()
}
