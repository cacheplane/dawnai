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

/** Every row id the browse grid has in the DOM, in DOM order — group header ids
 *  included, and only as many rows as the viewport fits. `asDrawn` and `expectDrawnRows`
 *  below are where those two facts are written down; this is the raw read.
 *
 *  One-shot, and deliberately not retrying: `MemoryGrid` sizes its viewport from a
 *  row-count estimate until the engine's first telemetry callback lands, so the rendered
 *  set can still change a frame after the phase reads `idle`. Callers assert through
 *  `expect.poll`/`toPass` so that settling is retried rather than raced — and phrase the
 *  claim POSITIVELY, because a read taken before the first paint answers `[]`, which
 *  satisfies every assertion of the form "does not contain" no matter what the page
 *  went on to draw. */
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

/** The setter beside that getter. Kept together deliberately: the grid virtualizes, so
 *  every claim about a row below the fold has to move the box first, and a private copy
 *  of this in one spec is a copy the next scenario writes again. */
export async function scrollGridTo(page: Page, offset: number): Promise<void> {
  await grid(page).evaluate((node, top) => {
    node.scrollTop = top
  }, offset)
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

const GROUP_ROW_ID_PREFIX = "__group__:"

/** Pretable's group row id, mirrored: `__group__:<columnId>=s:<value>` with `%`, `/`
 *  and `=` percent-escaped (grid-core `makeGroupId`/`escapeGroupKey`). */
function groupRowId(namespace: string): string {
  const escaped = namespace.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/=/g, "%3D")
  return `${GROUP_ROW_ID_PREFIX}namespace=s:${escaped}`
}

/** Group rows share the row-id channel with records, so a caller that wants the records
 *  has to drop them. Keyed off the same prefix `groupRowId` builds with, so the two
 *  cannot drift into disagreeing about what a group row looks like. */
export function recordsOnly(ids: readonly string[]): string[] {
  return ids.filter((id) => !id.startsWith(GROUP_ROW_ID_PREFIX))
}

/** Pretable orders group siblings with `Intl.Collator(undefined, { numeric: true,
 *  sensitivity: "base" })` (grid-core `sortSiblings`), ascending unless the active sort
 *  targets the grouped column — which nothing in this lane sorts by. The OPTIONS are the
 *  shipped ones. The locale is pinned rather than left to resolve, which is the one
 *  deliberate difference: the shipped comparator resolves in the PAGE, and
 *  `playwright.config` pins that to `en-US`, while a copy left `undefined` here would
 *  resolve in whatever locale the runner's machine happens to have. */
const groupCollator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" })

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
    const namespace = namespaceOf.get(id)
    // A record the fixture does not describe has no namespace to bucket it under, and
    // filing it under `undefined` would emit a `__group__:namespace=s:undefined` header
    // and surface as an unreadable row diff. Scenarios that CREATE records reach here
    // with ids the seed never had, so this is a scheduled arrival, not a hypothetical.
    if (namespace === undefined) throw new Error(`asDrawn: "${id}" is not a seeded record`)
    const bucket = buckets.get(namespace)
    if (bucket) bucket.push(id)
    else buckets.set(namespace, [id])
  }
  const out: string[] = []
  for (const [namespace, ids] of [...buckets].sort(([left], [right]) =>
    groupCollator.compare(left, right),
  )) {
    out.push(groupRowId(namespace))
    out.push(...ids)
  }
  return out
}

/** A column's cells over RECORD rows only, in DOM order. Group rows carry cells on the
 *  same `data-pretable-cell` channel — pretable marks the row itself
 *  `data-pretable-group-row`, which is what this excludes, so an assertion about a
 *  column's values is not interleaved with group headers' aggregate slots. */
export function recordCells(page: Page, columnId: string): Locator {
  return grid(page)
    .locator("[data-pretable-row-id]:not([data-pretable-group-row])")
    .locator(`[data-pretable-cell][data-pretable-column-id="${columnId}"]`)
}

/** A floor on how much of the window the virtualizer has to actually draw. Without one,
 *  `slice(0, ids.length)` lets the value under test choose its own coverage, and a
 *  regression that collapsed the grid to a single row would satisfy any prefix. Set well
 *  under whatever the capped viewport currently fits, because that count is a rendering
 *  detail and this is a floor, not a pin. */
const MIN_RENDERED_ROWS = 15

/**
 * The browse grid draws exactly the head of `expected`.
 *
 * "Head" rather than "all" because the grid VIRTUALIZES: it caps its viewport height, so
 * a 200-row window is never wholly in the document and rows past the fold are never
 * asserted here. A scenario that needs the deep window has to scroll it into view first.
 *
 * The read is retried rather than raced (see `rowIds`), with the floor INSIDE the retry
 * so that a short first snapshot settles instead of failing.
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

/** The vertical distance from one drawn row to the next, MEASURED rather than assumed.
 *  Pretable takes its row height from the theme's density and applies the same one to
 *  group headers, so a single pitch describes the whole model — but the number itself is
 *  a rendering detail, and a literal here would silently aim at the wrong row the first
 *  time that density changed. */
async function rowPitchPx(page: Page): Promise<number> {
  const tops = await grid(page)
    .locator("[data-pretable-row-id]")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).getBoundingClientRect().top))
  const [first, second] = tops
  if (first === undefined || second === undefined) {
    throw new Error(`cannot measure a row pitch from ${tops.length} drawn row(s)`)
  }
  const pitch = second - first
  if (pitch <= 0) throw new Error(`measured a non-positive row pitch (${pitch}px)`)
  return pitch
}

/**
 * The browse grid draws a contiguous run of `expected` with `anchorId` INSIDE it.
 *
 * The complement of `expectDrawnRows`, which compares against the HEAD of `expected` and
 * so can only ever settle claims about the top of the model. Anything about a JOIN —
 * that a second server window continues the first rather than replacing it — is
 * invisible there: the viewport draws ~19 rows, and two projections that differ deep in
 * the model still share a long prefix, so the head read passes against either one.
 *
 * Three separable claims, and the scenario needs all three: the drawn ids are a run of
 * `expected` (so the ORDER is the expected one), the run reaches `anchorId` (so the rows
 * under test are genuinely in the model — an anchor the model lacks cannot be drawn),
 * and the run extends on BOTH sides of it (so a seam is bracketed rather than merely
 * touched, which is what "around" is claiming). `anchorId` must therefore be an interior
 * row; the head and the tail are `expectDrawnRows`' and a scroll-to-bottom's business.
 *
 * The scroll sits INSIDE the retry so a read taken before the virtualizer settled is
 * re-driven rather than re-read at a position it has already left.
 */
export async function expectDrawnRunAround(
  page: Page,
  expected: readonly string[],
  anchorId: string,
): Promise<void> {
  const index = expected.indexOf(anchorId)
  expect(index, `"${anchorId}" is not in the expected projection`).toBeGreaterThan(0)
  expect(index, `"${anchorId}" is the last expected row, so nothing follows it`).toBeLessThan(
    expected.length - 1,
  )
  await expect(async () => {
    await scrollGridTo(page, index * (await rowPitchPx(page)))
    const ids = await rowIds(page)
    expect(ids.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
    const head = ids[0]
    const offset = head === undefined ? -1 : expected.indexOf(head)
    expect(offset, `drawn row "${head}" is not in the expected projection`).toBeGreaterThanOrEqual(
      0,
    )
    expect(ids).toEqual(expected.slice(offset, offset + ids.length))
    expect(offset).toBeLessThan(index)
    expect(offset + ids.length).toBeGreaterThan(index + 1)
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
    // `exact`, matching the sibling lookup in `openFilterMenu`: the accessible name of
    // each box is the option's own value (`opt.label ?? opt.value`, and the browse
    // columns declare no labels), so substring matching would turn any value that
    // prefixes another into a strict-mode violation rather than a miss.
    await menu
      .locator("[data-pretable-filter-set]")
      .getByRole("checkbox", { name: value, exact: true })
      .check()
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
 * Wall-clock time, on the RUNNER's clock, from the first step of a gesture to the moment
 * the grid has drawn the answer to it.
 *
 * What this is NOT: design §11's "end-to-end interaction" instrument. Three costs the
 * user never pays sit inside the number. `act` is driven over CDP, so a multi-step
 * gesture pays a round-trip per step — `applyTextFilter` is four. `settled` is a
 * Playwright retry, so any duration is rounded up to its polling grid. And the clock runs
 * outside the page, so it also carries the driver's own latency. It is a loose upper
 * bound: enough to catch a regression of KIND — a client round-trip storm — and not
 * enough to state a p95 with. Tasks 18 and 21 have to measure the budget from inside the
 * page; reusing this helper there would report the harness.
 *
 * `settled` is the caller's own check that the new answer is on screen, and it is a
 * parameter rather than a phase read for a reason: the grid is already `idle` when the
 * gesture lands, and the request that gesture causes is dispatched from an effect a
 * tick later — so waiting for `idle` alone can be satisfied by the state the gesture
 * was about to leave, and report a duration that timed nothing.
 *
 * The phase is asserted only AFTER the clock stops, so a number is still only ever
 * returned for a fulfilled revision, without charging the gesture for a background poll
 * (`BROWSE_POLL_INTERVAL_MS`, unconditional at 2 s while live and visible) that happened
 * to be in flight when the rows settled.
 */
export async function timeToFulfilled(
  page: Page,
  act: () => Promise<void>,
  settled: () => Promise<void>,
): Promise<number> {
  const started = Date.now()
  await act()
  await settled()
  const elapsed = Date.now() - started
  await expectPhase(page, "idle")
  return elapsed
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
