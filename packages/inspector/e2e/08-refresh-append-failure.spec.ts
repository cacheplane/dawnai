import { TEST_IDS } from "../src/components/memory/test-ids"
import { BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT, seedIdsInDefaultOrder } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  asDrawn,
  browseRegion,
  DRAWN_FIRST_WINDOW,
  drainSeededFetchErrors,
  expectDrawnRows,
  expectPhase,
  grid,
  loadMore,
  openBrowse,
  rowIds,
  status,
  statusText,
  waitOnePollPeriod,
} from "./helpers"

// Every test below injects a browse failure deliberately, so `drainSeededFetchErrors`
// accounts for the console lines this spec CAUSED — they are its subject rather than the
// defect the `consoleErrors` fixture exists to catch.

// D1-DATA-06, D1-UX-01, D1-UX-03. A failed refresh or append never discards fulfilled
// records, the failure is visible in its OWN banner slot, and retry is safe.
test.describe("scenario 8 — refresh/append failure and retry", () => {
  // Each test waits on at least one 2 s poll cadence and several 10 s `expect` budgets in
  // sequence, on a machine that runs other suites at the same time. Nothing here retries
  // for a duration, so a genuine failure still reports as a diff rather than a timeout.
  test.setTimeout(90_000)

  test("a failed poll tick keeps the rows, banners itself, and clears on the next success", async ({
    page,
    consoleErrors,
  }) => {
    await openBrowse(page)
    // Settled BEFORE the sample is taken, not after: `rowIds` deliberately does not
    // retry, and the rendered set can still change a frame after the phase reads `idle`,
    // so a `before` captured first is a `before` of a page mid-paint — and it is compared
    // for EXACT equality below.
    await expectDrawnRows(page, DRAWN_FIRST_WINDOW)
    const before = await rowIds(page)

    // The refresh tick is the cursorless request that follows a fulfilled load: the
    // initial one already landed inside `openBrowse`, above this route.
    let failing = true
    let cursorlessRequests = 0
    await page.route("**/api/memory/list*", async (route) => {
      const params = new URL(route.request().url()).searchParams
      if (params.has("cursor")) {
        await route.continue()
        return
      }
      cursorlessRequests += 1
      if (failing) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "seeded refresh failure" }),
        })
        return
      }
      await route.continue()
    })

    await expect(page.getByTestId(TEST_IDS.bannerRefresh)).toBeVisible({ timeout: 15_000 })
    // The slot says WHICH kind failed and quotes the store's own words. A banner that
    // merely appeared would satisfy a page that puts every failure in one slot, which is
    // the arrangement D1-UX-03 exists to rule out.
    await expect(page.getByTestId(TEST_IDS.bannerRefresh)).toHaveText(
      "Refresh failed: seeded refresh failure",
    )
    // …and only that kind's slot: nothing was appended, so the other one must be empty.
    await expect(page.getByTestId(TEST_IDS.bannerLoadMore)).toHaveCount(0)

    // Rows survive, and the counts beside them still describe the revision that IS
    // fulfilled — a failed background tick invalidates nothing.
    expect(await rowIds(page)).toEqual(before)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))
    // Phase returns to the settled idle: a background failure is not an error PHASE,
    // because something IS fulfilled for the desired revision. Read through the grid's
    // own body-state channel too — the error PRESENTATION (the block that replaces the
    // rows) must not be on screen while there are rows to show.
    await expectPhase(page, "idle")
    await expect(browseRegion(page).locator("[data-pretable-body-state]")).toHaveCount(0)

    // The fault is HELD until here rather than lifted after one tick, so every assertion
    // above ran with no deadline on it. Lifted after the first failure they would instead
    // share a single 2 s poll period, and an overrun would clear the banner before
    // `atFailure` was read — reporting as `expect(2).toBeGreaterThan(2)`, which names
    // neither the banner nor the timing that actually caused it.
    const atFailure = cursorlessRequests
    failing = false

    // A succeeding tick clears the refresh slot by itself — no user gesture. The
    // requests counter is what makes that "by itself": the banner going away without a
    // further tick would be the reducer forgetting rather than a success clearing.
    await expect(page.getByTestId(TEST_IDS.bannerRefresh)).toHaveCount(0, { timeout: 15_000 })
    expect(cursorlessRequests).toBeGreaterThan(atFailure)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))

    drainSeededFetchErrors(consoleErrors, 1)
  })

  test("a failed append leaves the loaded rows intact and retry appends exactly once", async ({
    page,
    consoleErrors,
  }) => {
    await openBrowse(page)
    const order = seedIdsInDefaultOrder()
    // Settled before sampled, for the same reason as the test above: `before` is compared
    // for exact equality once the append has failed.
    await expectDrawnRows(page, DRAWN_FIRST_WINDOW)
    const before = await rowIds(page)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))

    let failAppend = true
    await page.route("**/api/memory/list*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("cursor") && failAppend) {
        failAppend = false
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "seeded append failure" }),
        })
        return
      }
      await route.continue()
    })

    await loadMore(page).click()
    await expect(page.getByTestId(TEST_IDS.bannerLoadMore)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(TEST_IDS.bannerLoadMore)).toHaveText(
      "Loading more failed: seeded append failure",
    )
    await expect(page.getByTestId(TEST_IDS.bannerRefresh)).toHaveCount(0)

    // Nothing was discarded and nothing was half-added: the window the client already
    // held is exactly the window it still holds.
    expect(await rowIds(page)).toEqual(before)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))
    await expectPhase(page, "idle")

    // A refresh tick's SUCCESS must not clear the load-more slot — the slots are
    // per-kind. `waitOnePollPeriod` pins both ends of a real tick (a sleep would report a
    // response to a question asked before the failure).
    await waitOnePollPeriod(page)
    await expect(page.getByTestId(TEST_IDS.bannerLoadMore)).toBeVisible()

    // Clicked immediately after that tick settled, which is the widest quiet window this
    // cadence offers: `retry` is dropped outright while anything is in flight, and a
    // dropped click would surface below as a count that never reached 400.
    await page.getByTestId(TEST_IDS.bannerRetry).click()

    // The loaded count comes off the STATUS BAR, never off a `rowIds` length: the grid
    // virtualizes, so the DOM holds ~19 rows however much is resident. It is also where a
    // DOUBLE append would show — as 600.
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, BROWSE_SEED_COUNT))
    await expect(page.getByTestId(TEST_IDS.bannerLoadMore)).toHaveCount(0)
    await expectPhase(page, "idle")
    // What it HOLDS, not only what it counted — and held ACROSS a further tick, so an
    // append that a subsequent refresh then re-appended is caught rather than sampled
    // before it happened.
    await expectDrawnRows(page, asDrawn(order.slice(0, BROWSE_PAGE_SIZE * 2)))
    await waitOnePollPeriod(page)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE * 2, BROWSE_SEED_COUNT))

    drainSeededFetchErrors(consoleErrors, 1)
  })

  test("an initial failure renders the error block, suspends polling, and retry recovers", async ({
    page,
    consoleErrors,
  }) => {
    let requests = 0
    let failing = true
    await page.route("**/api/memory/list*", async (route) => {
      requests += 1
      if (failing) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "seeded initial failure" }),
        })
        return
      }
      await route.continue()
    })

    await page.goto("/memory")
    // Pretable's hydration signal, before any click: an SSR'd control is painted and
    // inert, and a retry press that lands before this flips is silently dropped.
    await expect(grid(page)).toHaveAttribute("data-pretable-hydrated", "true")
    await expectPhase(page, "error")
    const errorBlock = browseRegion(page).locator('[data-pretable-body-state="error"]')
    await expect(errorBlock).toBeVisible()
    await expect(errorBlock).toContainText("seeded initial failure")
    // The error block carries NO live-region role — the failure reaches AT through the
    // surface's single polite region instead (verified in a11y-announcements.spec).
    await expect(
      browseRegion(page).locator('[data-pretable-body-state="error"][role]'),
    ).toHaveCount(0)

    // Polling is suspended while nothing is fulfilled, so the error presentation does not
    // flicker on a 2 s cadence. Two ticks' worth of wall clock with no request.
    const atFailure = requests
    expect(atFailure).toBeGreaterThan(0)
    await page.waitForTimeout(5_000)
    expect(requests).toBe(atFailure)

    failing = false
    await page.getByTestId(TEST_IDS.retryInitial).click()
    await expectPhase(page, "idle")
    await expectDrawnRows(page, DRAWN_FIRST_WINDOW)
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT))
    // Polling RESUMES: a further request arrives with no second click.
    const afterRetry = requests
    await expect.poll(() => requests, { timeout: 15_000 }).toBeGreaterThan(afterRetry)

    drainSeededFetchErrors(consoleErrors, 1)
  })
})
