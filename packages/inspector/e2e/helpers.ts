import type { Locator, Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { TEST_IDS } from "../src/components/memory/test-ids"

/** The browse grid. Pretable puts role + aria-label + the phase attribute on the
 *  scroll viewport itself, so this one locator is also the ARIA subject. */
export function grid(page: Page): Locator {
  return page.locator('[data-pretable-scroll-viewport][aria-label="Memories"]')
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

/** Every row id the grid has in the DOM, in DOM order. Two things this cannot show:
 *  the grid VIRTUALIZES, so this is the rows that fit the viewport and not the whole
 *  loaded window; and the unscoped browse is GROUPED (`list-page` passes
 *  `groupByNamespace` whenever no namespace facet is selected), so the list is
 *  interleaved with pretable's `__group__:` header ids. A caller that wants records
 *  has to drop those, and one that wants the server's flat order has to scope to a
 *  namespace first. */
export async function rowIds(page: Page): Promise<string[]> {
  return grid(page)
    .locator("[data-pretable-row-id]")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.pretableRowId ?? ""))
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

/** Wait out one full poll period plus response latency. The cadence is 2 s. */
export async function waitOnePollPeriod(page: Page): Promise<void> {
  await page.waitForTimeout(2_600)
}
