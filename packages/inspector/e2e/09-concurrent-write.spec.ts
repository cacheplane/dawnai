import { BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  DRAWN_FIRST_WINDOW,
  DRAWN_FIRST_WINDOW_AFTER_FORGET,
  DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9,
  expectDrawnRows,
  expectDrawnRun,
  expectPhase,
  MIN_RENDERED_ROWS,
  n,
  openBrowse,
  rowIds,
  rowIdsAndTotal,
  SCENARIO_9_APPROVED_ID,
  SCENARIO_9_FORGOTTEN_ID,
  SCENARIO_9_STABLE_DRAWN_PREFIX,
  scrollGridTo,
  scrollTop,
  status,
  statusText,
  total,
} from "./helpers"

/** Far past any scrollHeight this fixture produces; the browser clamps it to the bottom.
 *  The bottom is where both mutations below are staged (see the file preamble). */
const SCROLL_TO_BOTTOM_PX = 1_000_000

// D1-DATA-04, D1-COUNT-03. Rows and total come from one transaction snapshot, and the
// head-anchored refresh converges within one poll period.
//
// THIS FILE MUTATES THE SHARED FIXTURE STORE, permanently, for every spec that runs after
// it. Two writes land: `SCENARIO_9_FORGOTTEN_ID` is forgotten and `SCENARIO_9_APPROVED_ID`
// is approved. Both ids, the store they leave behind and what a later spec has to account
// for are declared in `helpers.ts`, so that a spec written after this one COMPUTES against
// the fixture it will meet rather than transcribing corrections out of this comment.
//
// Both writes are staged at the BOTTOM of the drawn model on purpose, and
// `SCENARIO_9_STABLE_DRAWN_PREFIX` is where that intent is checked rather than hoped: it
// counts the leading drawn rows all three projections agree on, and a viewport at rest
// draws far fewer than that. Test 2 works at rest and asserts it stays inside the prefix.
// Test 3 deliberately does NOT — it parks at the bottom, which is the one place the
// mutations are visible, and seeing them there is the whole point of it.
//
// The tests are ORDERED. Test 1 performs the delete and tests 2 and 3 assert against the
// store it leaves; Playwright runs a file's tests in declaration order in one worker, and
// running one of them alone with `-g` is not a supported mode.
test.describe("scenario 9 — concurrent write", () => {
  // A poll cadence, a mutation round-trip and several 10 s `expect` budgets in sequence,
  // on a machine running other suites at the same time.
  test.setTimeout(90_000)

  test("a delete lands in the grid and the total within one poll period", async ({
    page,
    request,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await expectDrawnRows(page, DRAWN_FIRST_WINDOW)
    await expect(total(page)).toHaveText(n(BROWSE_SEED_COUNT))

    // The doomed row has to be ON SCREEN before it can be missed from it: "no longer
    // drawn" is satisfied by every read of a row that was never drawn in the first place.
    await scrollGridTo(page, SCROLL_TO_BOTTOM_PX)
    await expect.poll(() => rowIds(page), { timeout: 15_000 }).toContain(SCENARIO_9_FORGOTTEN_ID)
    expectDrawnRun(DRAWN_FIRST_WINDOW, await rowIds(page), "before the delete")

    // Convergence is counted in POLL TICKS, not in wall clock: a 15 s deadline on a
    // machine at load says nothing about whether the refresh converged in one period or
    // in seven. Counted from HERE, one line above the write, so the number below is the
    // count since the write with no subtraction to get wrong.
    let ticks = 0
    page.on("response", (response) => {
      if (response.url().includes("/api/memory/list")) ticks += 1
    })

    const response = await request.post(
      `/api/memory/${encodeURIComponent(SCENARIO_9_FORGOTTEN_ID)}/forget`,
    )
    // Read on the failure path only. `text()` consumes nothing another line needs here,
    // but as an unconditional assertion message it runs on the happy path too and reads
    // as if the body were part of the claim.
    if (!response.ok()) {
      throw new Error(
        `forget ${SCENARIO_9_FORGOTTEN_ID}: ${response.status()} ${await response.text()}`,
      )
    }

    // Sampled rather than settled, and the ROW and the TOTAL come from ONE evaluation.
    // That pairing is the scenario: a client that took its records from one snapshot and
    // its count from another would show the row gone beside 1,250, or still there beside
    // 1,249, for one tick — and any assertion that waited for the end state would read
    // past it. Two separate reads would carry a round trip between them and manufacture
    // exactly the tear this is here to detect.
    const deadline = Date.now() + 15_000
    let converged = false
    let ticksAtConvergence = -1
    while (!converged && Date.now() < deadline) {
      const { ids, total: matching } = await rowIdsAndTotal(page)
      const ticksNow = ticks
      // A floor on how much of the projection the sample caught: a read taken between
      // paints answers `[]`, and `[]` satisfies every "no longer contains" claim below no
      // matter what the page went on to draw.
      if (ids.length >= MIN_RENDERED_ROWS) {
        const stillDrawn = ids.includes(SCENARIO_9_FORGOTTEN_ID)
        expect(
          matching,
          `the row is ${stillDrawn ? "still drawn" : "gone"}, so the total must match`,
        ).toBe(stillDrawn ? n(BROWSE_SEED_COUNT) : n(BROWSE_SEED_COUNT - 1))
        if (!stillDrawn) {
          converged = true
          ticksAtConvergence = ticksNow
        }
      }
      if (!converged) await page.waitForTimeout(150)
    }
    expect(converged, "the delete never reached the grid").toBe(true)
    // Two, not one: the tick already in flight when the delete landed was snapshotted
    // before it, so it is entitled to answer the old population.
    expect(ticksAtConvergence, "poll ticks the delete took to converge").toBeLessThanOrEqual(2)

    // The window BACKFILLED — the client holds a full page again, from the same snapshot
    // that dropped a row. Without this the scenario is satisfied by a client that simply
    // shortened its list.
    await expect(status(page)).toHaveText(statusText(BROWSE_PAGE_SIZE, BROWSE_SEED_COUNT - 1))
    expectDrawnRun(DRAWN_FIRST_WINDOW_AFTER_FORGET, await rowIds(page), "after the delete")
    await expectPhase(page, "idle")
  })

  test("a no-change poll tick moves no scroll offset and replaces no rows", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // A few rows down — NOT the middle: the offset only has to be nonzero, because at
    // rest it is 0 and a before/after comparison of two zeroes moves the user's place
    // while passing. Both properties this depth needs are asserted rather than assumed
    // below: that it moved at all, and that the run it lands on is still inside the
    // prefix the previous test's delete provably did not touch.
    await scrollGridTo(page, 400)
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0)
    const offsetBefore = await scrollTop(page)
    const idsBefore = await rowIds(page)
    // The rows are the RIGHT rows, not merely stable ones — a grid stuck showing garbage
    // is perfectly stable. Asserted against the PRISTINE projection, which only holds
    // inside the stable prefix.
    const offset = expectDrawnRun(DRAWN_FIRST_WINDOW, idsBefore, "at rest")
    expect(offset + idsBefore.length).toBeLessThanOrEqual(SCENARIO_9_STABLE_DRAWN_PREFIX)

    // Ticks are COUNTED, not assumed: "a no-change poll tick changes nothing" is
    // vacuously true of a page that stopped polling, which is the one way this test can
    // pass while the feature is broken.
    let ticks = 0
    page.on("response", (response) => {
      if (response.url().includes("/api/memory/list")) ticks += 1
    })
    await page.waitForTimeout(7_000)
    expect(ticks, "poll ticks observed over three cadences").toBeGreaterThanOrEqual(2)

    expect(await scrollTop(page)).toBe(offsetBefore)
    expect(await rowIds(page)).toEqual(idsBefore)
  })

  test("a tick that hoists a row above the viewport shifts content — offset stability only", async ({
    page,
    request,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // Parked at the bottom, where the row about to be hoisted is drawn and everything it
    // is about to move above is on screen.
    await scrollGridTo(page, SCROLL_TO_BOTTOM_PX)
    await expect.poll(() => rowIds(page), { timeout: 15_000 }).toContain(SCENARIO_9_APPROVED_ID)
    const idsBefore = await rowIds(page)
    expectDrawnRun(DRAWN_FIRST_WINDOW_AFTER_FORGET, idsBefore, "before the hoist")
    const offsetBefore = await scrollTop(page)
    expect(offsetBefore).toBeGreaterThan(0)

    const response = await request.post(
      `/api/memory/${encodeURIComponent(SCENARIO_9_APPROVED_ID)}/approve`,
    )
    // Read on the failure path only, so the body is still unconsumed for the `json()`
    // below and the happy path is not quietly fetching something it never looks at.
    if (response.status() !== 200) {
      throw new Error(
        `approve ${SCENARIO_9_APPROVED_ID}: ${response.status()} ${await response.text()}`,
      )
    }
    // `activated` is the append-kind path: no identity scan, so nothing was deduped (which
    // DELETES the candidate) and nothing was superseded (which demotes a second record).
    // Without this the rest of the test cannot tell a hoist from a deletion.
    expect((await response.json()) as { action?: string }).toMatchObject({ action: "activated" })

    // Phrased POSITIVELY — with a floor on how much was caught — because the read that
    // settles this is the one every later assertion is taken against: `not.toEqual` alone
    // is satisfied by a read that landed between paints and answered `[]`.
    await expect(async () => {
      const ids = await rowIds(page)
      expect(ids.length).toBeGreaterThanOrEqual(MIN_RENDERED_ROWS)
      expect(ids).not.toContain(SCENARIO_9_APPROVED_ID)
    }).toPass({ timeout: 15_000 })

    // THE DESIGN'S ACCEPTED BEHAVIOUR (§8.1 decision 8, Flow 9): D1 has no scroll
    // anchoring. The offset is untouched; the CONTENT under it has legitimately moved.
    // Asserting content STABILITY here would be asserting a guarantee the design
    // explicitly declines to make — so the content is asserted to have moved to the right
    // place instead, which is what keeps "the offset did not change" from being a claim
    // about a page where nothing happened.
    expect(await scrollTop(page)).toBe(offsetBefore)
    const idsAfter = await rowIds(page)
    expect(idsAfter, "the hoisted row moved out of the viewport it was drawn in").not.toContain(
      SCENARIO_9_APPROVED_ID,
    )
    // Against the projection `helpers.ts` publishes for every spec that runs after this
    // file, rather than against a local reconstruction of it: this assertion is therefore
    // also the proof that the shared post-mutation view models the store the later specs
    // will meet.
    expectDrawnRun(DRAWN_FIRST_WINDOW_AFTER_SCENARIO_9, idsAfter, "after the hoist")
    // The population is untouched: an approval moves a record, it does not add or remove
    // one. This is the independent witness that the append path — not the dedupe that
    // deletes — is what ran.
    await expect(total(page)).toHaveText(n(BROWSE_SEED_COUNT - 1))
    await expectPhase(page, "idle")
  })
})
