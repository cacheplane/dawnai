import type { Locator, Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"

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
