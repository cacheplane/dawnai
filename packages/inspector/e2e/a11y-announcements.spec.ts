import type { Page } from "@playwright/test"
import { BROWSE_PAGE_SIZE } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  drainSeededFetchErrors,
  expectPhase,
  liveRegionText,
  loadMore,
  openBrowse,
  status,
} from "./helpers"

/**
 * D1-A11Y-02, the announcement half. Shipped semantics, read out of `@pretable/react`
 * 0.3.0 rather than assumed: one permanent polite region (`[data-pretable-live-region]`,
 * portalled to `document.body`); the body-state block carries no live-region role;
 * `scheduleAnnouncement` ranks `error` > pending `user` > pending `lifecycle` with
 * last-wins between equals; and a resolved `refreshing` speaks only when the sentence it
 * would say has CHANGED — which is what keeps a 2 s poll from becoming a metronome.
 *
 * Every announcement here is debounced by `ANNOUNCE_DEBOUNCE_MS` (500 ms in 0.3.0) and
 * fired from a phase effect, so the region trails every DOM signal a test can settle on:
 * the status bar, the phase attribute and the drawn rows all land first. Every read of it
 * below is therefore POLLED, and any claim made of two halves of one sentence is made
 * against ONE sample — two successive polls can each be satisfied by a different sentence
 * and jointly prove nothing about either.
 */

/**
 * Every live region in the document, each reduced to WHO owns it.
 *
 * The query pierces open shadow roots — Playwright's CSS engine does that by default, and
 * here it must: the one region this page does not render lives inside one. Owners are
 * named rather than counted so that the assertion is over the whole population: a bare
 * count is satisfied by a banner appearing while another disappears, and it cannot say
 * which of the two survivors is which.
 *
 * An owner this function does not recognise is reported as its own selector rather than
 * dropped, so a new `role="alert"` anywhere in the app fails the comparison BY NAME.
 */
async function liveRegionOwners(page: Page): Promise<{ owner: string; text: string }[]> {
  return page.locator('[aria-live], [role="status"], [role="alert"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement
      const root = element.getRootNode()
      const host = root instanceof ShadowRoot ? root.host.tagName.toLowerCase() : null
      const text = element.textContent ?? ""
      if (element.hasAttribute("data-pretable-live-region")) return { owner: "pretable", text }
      // Next's App Router appends `<next-route-announcer>` to `<body>` and puts an
      // assertive region in its OPEN shadow root. It is framework-owned, it is not in the
      // Inspector's tree, and it speaks only on a client-side route change — so on a
      // document load it is present and empty, which the caller asserts rather than
      // assumes. There is no product change that removes it; excluding it silently is
      // what would be dishonest, so it is named.
      if (host === "next-route-announcer" && element.id === "__next-route-announcer__") {
        return { owner: "next-route-announcer", text }
      }
      const role = element.getAttribute("role") ?? element.getAttribute("aria-live")
      return {
        owner: `${host === null ? "" : `${host}::`}${element.tagName.toLowerCase()}[${role}]`,
        text,
      }
    }),
  )
}

test.describe("announcement channels", () => {
  test.setTimeout(120_000)

  test("there is exactly one live region and the body-state block is not one", async ({
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
    await expect(page.locator('[data-pretable-body-state="error"]')).toBeVisible()

    // One region belonging to this page, and it is the surface's own. Compared as the
    // whole owner list: the framework's announcer is present because Next puts it there,
    // and it is EMPTY, so the failure below cannot be reaching AT through it.
    expect(await liveRegionOwners(page)).toEqual(
      expect.arrayContaining([{ owner: "next-route-announcer", text: "" }]),
    )
    expect((await liveRegionOwners(page)).map((region) => region.owner).sort()).toEqual([
      "next-route-announcer",
      "pretable",
    ])

    // The block that RENDERS the failure is not a second channel. It repeats the error
    // sentence in the grid body, so a live-region role on it would say the same thing
    // twice; §4.5 keeps it silent and lets the region below be the only speaker.
    const bodyStateAttributes = await page
      .locator("[data-pretable-body-state]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttributeNames().sort().join(",")))
    expect(bodyStateAttributes).toEqual(["data-pretable-body-state,style"])

    // …and the failure does reach AT through that one region, so the silence above is a
    // single channel rather than none.
    await expect.poll(() => liveRegionText(page)).toMatch(/could not|error|fail/i)

    // Stop the fault and prove the window is SHUT before draining, or a 500 logged
    // between the drain and teardown fails the gate this spec is otherwise protected by.
    // A reload rather than a wait: the error phase is terminal — an initial failure stops
    // the 2 s poll, so `idle` never arrives on its own — and rather than reach for the
    // retry control (13-accessibility's subject, not this file's), the cheapest proof that
    // no request can still 500 is one whole successful load after the switch.
    failing = false
    await page.reload()
    await expectPhase(page, "idle")
    drainSeededFetchErrors(consoleErrors, 1)
  })

  test("a no-change poll tick is silent", async ({ page, consoleErrors }) => {
    void consoleErrors
    await openBrowse(page)
    await expect.poll(() => liveRegionText(page)).toContain(String(BROWSE_PAGE_SIZE))
    const settled = await liveRegionText(page)

    // Ticks over an unchanged dataset. Repeating the same sentence IS the metronome the
    // design forbids.
    const ticks: string[] = []
    page.on("response", (response) => {
      if (response.url().includes("/api/memory/list")) ticks.push(response.url())
    })
    const seen: string[] = []
    const stop = Date.now() + 7_000
    while (Date.now() < stop) {
      seen.push(await liveRegionText(page))
      await page.waitForTimeout(250)
    }
    expect(new Set(seen)).toEqual(new Set([settled]))

    // The metronome actually RAN. Without this the silence above is equally the silence of
    // a page that stopped polling, and a regression that killed the 2 s tick would read as
    // this test's strongest pass. A floor rather than the cadence: 7 s at 2 s admits three
    // or four ticks (measured: 4 responses over 28 samples), and a loaded machine delays
    // the interval it does not skip — so the floor keeps two ticks of headroom.
    expect(ticks.length, "browse polls during the silent window").toBeGreaterThanOrEqual(2)
  })

  test("stale is announced once, and its own resolution supersedes it", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await page.route("**/api/memory/list*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("filters")) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
      await route.continue()
    })
    await applySetFilter(page, "status", ["active"])
    await expect.poll(() => liveRegionText(page)).toContain("Updating")
    await expectPhase(page, "idle")
    // The results announcement replaced it — the stale sentence does not linger as the
    // last thing a screen reader said about a settled grid. Phrased POSITIVELY first
    // (helpers.ts): "does not contain" is satisfied by an empty read, and by a region that
    // was cleared rather than superseded, which is a different and worse outcome.
    //
    // The SHAPE of `memory-grid.tsx`'s `resultsAnnouncement`, anchored at both ends, not
    // pretable's default sentence — the Inspector replaces that copy so the spoken line
    // mirrors `BrowseStatusBar`. Neither number is pinned: the loaded half is the page
    // size and the matching half is the `status=active` population, which scenario 9 moves
    // by one when the whole suite runs.
    await expect
      .poll(() => liveRegionText(page))
      .toMatch(/^\d[\d,]* loaded of \d[\d,]* matching\.$/)
    expect(await liveRegionText(page)).not.toContain("Updating")
  })

  test("an append announces the delta, not just the new population", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await loadMore(page).click()
    // CORRECTED (preamble 9): the loaded count comes off the STATUS BAR, never off
    // `rowIds` — the DOM holds ~19 rows however many the client is holding.
    await expect(status(page)).toContainText((BROWSE_PAGE_SIZE * 2).toLocaleString("en-US"))

    // Both halves of ONE sentence, sampled together. The status bar above lands inside the
    // announcement's 500 ms debounce, so the region still holds the previous sentence when
    // it settles — and two successive polls, one per number, would be satisfiable by two
    // DIFFERENT sentences: "Showing 200 of 1,250" carries the first and a later "Showing
    // 400 of 1,250" carries the second, so the pair would pass over a page that never
    // announced a delta at all. Raw digits rather than `toLocaleString`, because this
    // sentence is pretable's and it does not format.
    await expect
      .poll(() =>
        liveRegionText(page).then((text) => ({
          text,
          delta: text.includes(String(BROWSE_PAGE_SIZE)),
          loaded: text.includes(String(BROWSE_PAGE_SIZE * 2)),
        })),
      )
      .toMatchObject({ delta: true, loaded: true })
  })
})
