import {
  BROWSE_PAGE_SIZE,
  BROWSE_SEED_COUNT,
  browseSeedRecords,
  seedIdsInDefaultOrder,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  asDrawn,
  expectDrawnRows,
  expectPhase,
  openBrowse,
  rowIds,
  scrollGridTo,
  scrollTop,
  status,
  total,
} from "./helpers"

/** The page formats every count through `toLocaleString`; `playwright.config` pins the
 *  runner to `en-US`. `String(1250)` would look right and never match "1,250". */
function n(value: number): string {
  return value.toLocaleString("en-US")
}

/** A floor on how much of the projection a sample caught. Without one, a read taken
 *  between paints answers `[]` — and `[]` satisfies every "no longer contains" assertion
 *  no matter what the page went on to draw. */
const MIN_DRAWN_ROWS = 15

/** Far past any scrollHeight this fixture produces; the browser clamps it to the bottom.
 *  The bottom is where both mutations below are staged (see the file preamble). */
const SCROLL_TO_BOTTOM_PX = 1_000_000

const order = seedIdsInDefaultOrder()
const firstWindow = order.slice(0, BROWSE_PAGE_SIZE)
/** The pristine projection — what the browse draws before this file has written
 *  anything. */
const projection = asDrawn(firstWindow)

/**
 * The record test 1 deletes: the LAST row the first window draws.
 *
 * Chosen for where its removal is INVISIBLE, not for where it is convenient. The unscoped
 * browse groups by namespace, so the drawn projection is `route=/chat`, then
 * `route=/notes`, then `route=/notes-archive` — and the last row is the tail of the last
 * group. `STABLE_PREFIX` below turns that into a checked fact rather than a claim.
 */
const DOOMED_ID = projection[projection.length - 1] as string

const windowAfterDelete = order.filter((id) => id !== DOOMED_ID).slice(0, BROWSE_PAGE_SIZE)
const projectionAfterDelete = asDrawn(windowAfterDelete)

/**
 * The record test 3 approves, which hoists it: `approve` stamps `updatedAt = now`, and the
 * default order is `updatedAt DESC`, so it lands at position 0 of the whole set.
 *
 * EPISODIC AND A CANDIDATE, and both halves are load-bearing rather than descriptive.
 * `approveWithReconcile` takes an append-kind candidate (episodic, reflection) straight to
 * a plain activation with no identity scan. A SEMANTIC candidate instead reaches
 * `classifyWrite`, where this fixture's uniformly empty `data` makes every active record
 * of the same namespace and kind an identity match with identical data — classified
 * `update`, which DELETES the candidate and returns 200. A procedural one throws inside
 * `writePolicyFor` and returns 409. Picking the row off the screen, as the eye would,
 * therefore has a one-in-four chance of silently deleting a record instead of hoisting one
 * and a one-in-four chance of mutating nothing at all — and this spec would pass either
 * way, having tested neither.
 *
 * The LAST such record in the projection, so that hoisting it moves a row from the bottom
 * of the drawn model to the top of its group: a change strictly ABOVE a viewport parked at
 * the bottom, which is what the scenario is about.
 */
const HOISTED_ID = (() => {
  const byId = new Map(browseSeedRecords().map((record) => [record.id, record]))
  const eligible = projectionAfterDelete.filter((id) => {
    const record = byId.get(id)
    return record?.kind === "episodic" && record.status === "candidate"
  })
  const last = eligible[eligible.length - 1]
  if (last === undefined) throw new Error("the fixture has no episodic candidate to hoist")
  return last
})()

const projectionAfterHoist = asDrawn([
  HOISTED_ID,
  ...windowAfterDelete.filter((id) => id !== HOISTED_ID),
])

/** How much of the drawn projection BOTH mutations in this file leave untouched — derived
 *  from the three projections rather than asserted about them. Everything a spec that only
 *  looks at the head can see lives inside this prefix, which is what makes the shared
 *  fixture survive this file. */
const STABLE_PREFIX = (() => {
  let index = 0
  while (
    index < projection.length &&
    projection[index] === projectionAfterDelete[index] &&
    projection[index] === projectionAfterHoist[index]
  ) {
    index += 1
  }
  return index
})()

/**
 * The drawn rows are a contiguous run of `expected`, and returns where the run starts.
 *
 * The grid virtualizes: at most ~19 of a 203-row projection are ever in the document, so
 * every claim about WHICH rows are drawn is a claim about a window into the model, and the
 * window's position is not known ahead of the read.
 */
function expectDrawnRun(
  expected: readonly string[],
  drawn: readonly string[],
  label: string,
): number {
  expect(drawn.length, `${label}: rows drawn`).toBeGreaterThanOrEqual(MIN_DRAWN_ROWS)
  const head = drawn[0] as string
  const offset = expected.indexOf(head)
  expect(
    offset,
    `${label}: drawn row "${head}" is not in the expected projection`,
  ).toBeGreaterThanOrEqual(0)
  expect(drawn, label).toEqual(expected.slice(offset, offset + drawn.length))
  return offset
}

// D1-DATA-04, D1-COUNT-03. Rows and total come from one transaction snapshot, and the
// head-anchored refresh converges within one poll period.
//
// THIS FILE MUTATES THE SHARED FIXTURE STORE, permanently, for every spec that runs after
// it — `playwright.config` runs one worker over one seeded store and re-seeds only at
// `serve.ts`. Two writes land: one record is forgotten (so the matching population is
// `BROWSE_SEED_COUNT - 1` from here on) and one candidate is approved (so it is `active`,
// and it sorts first). Both are staged at the BOTTOM of the drawn model on purpose, and
// `STABLE_PREFIX` is where that intent is checked rather than hoped: the assertions in
// tests 2 and 3 are confined to it, and it covers every row a spec reading the head of the
// browse can reach.
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
    await expectDrawnRows(page, projection)
    await expect(total(page)).toHaveText(n(BROWSE_SEED_COUNT))

    // The doomed row has to be ON SCREEN before it can be missed from it: "no longer
    // drawn" is satisfied by every read of a row that was never drawn in the first place.
    await scrollGridTo(page, SCROLL_TO_BOTTOM_PX)
    await expect.poll(() => rowIds(page), { timeout: 15_000 }).toContain(DOOMED_ID)
    expectDrawnRun(projection, await rowIds(page), "before the delete")

    // Convergence is counted in POLL TICKS, not in wall clock: a 15 s deadline on a
    // machine at load says nothing about whether the refresh converged in one period or
    // in seven. The tick already in flight when the delete lands was snapshotted before
    // it, so it is allowed to answer the old population — hence two, not one.
    const browseResponses: number[] = []
    page.on("response", (response) => {
      if (response.url().includes("/api/memory/list")) browseResponses.push(Date.now())
    })
    const ticksAtWrite = browseResponses.length

    const response = await request.post(`/api/memory/${encodeURIComponent(DOOMED_ID)}/forget`)
    expect(response.ok(), await response.text()).toBe(true)

    // Sampled rather than settled, and the ROW and the TOTAL are read together on every
    // sample. That pairing is the scenario: a client that took its records from one
    // snapshot and its count from another would show the row gone beside 1,250, or still
    // there beside 1,249, for one tick — and any assertion that waited for the end state
    // would read past it.
    const deadline = Date.now() + 15_000
    let converged = false
    let ticksAtConvergence = -1
    while (!converged && Date.now() < deadline) {
      const ids = await rowIds(page)
      const ticks = browseResponses.length
      const matching = await total(page).innerText()
      if (ids.length >= MIN_DRAWN_ROWS) {
        expect(
          matching,
          `the row is ${ids.includes(DOOMED_ID) ? "still drawn" : "gone"}, so the total must match`,
        ).toBe(ids.includes(DOOMED_ID) ? n(BROWSE_SEED_COUNT) : n(BROWSE_SEED_COUNT - 1))
        if (!ids.includes(DOOMED_ID)) {
          converged = true
          ticksAtConvergence = ticks
        }
      }
      if (!converged) await page.waitForTimeout(150)
    }
    expect(converged, "the delete never reached the grid").toBe(true)
    expect(
      ticksAtConvergence - ticksAtWrite,
      "poll ticks the delete took to converge",
    ).toBeLessThanOrEqual(2)

    // The window BACKFILLED — the client holds a full page again, from the same snapshot
    // that dropped a row. Without this the scenario is satisfied by a client that simply
    // shortened its list.
    await expect(status(page)).toHaveText(
      `${n(BROWSE_PAGE_SIZE)} loaded of ${n(BROWSE_SEED_COUNT - 1)} matching`,
    )
    expectDrawnRun(projectionAfterDelete, await rowIds(page), "after the delete")
    await expectPhase(page, "idle")
  })

  test("a no-change poll tick moves no scroll offset and replaces no rows", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // Into the middle of the loaded window, so a reset to the top would be measurable —
    // at rest the offset is 0, and a before/after comparison of two zeroes moves the
    // user's place while passing.
    await scrollGridTo(page, 400)
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0)
    const offsetBefore = await scrollTop(page)
    const idsBefore = await rowIds(page)
    // The rows are the RIGHT rows, not merely stable ones — a grid stuck showing garbage
    // is perfectly stable. Asserted against the PRISTINE projection and confined to the
    // prefix the previous test's delete provably did not touch.
    const offset = expectDrawnRun(projection, idsBefore, "at rest")
    expect(offset + idsBefore.length).toBeLessThanOrEqual(STABLE_PREFIX)

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
    await expect.poll(() => rowIds(page), { timeout: 15_000 }).toContain(HOISTED_ID)
    const idsBefore = await rowIds(page)
    expectDrawnRun(projectionAfterDelete, idsBefore, "before the hoist")
    const offsetBefore = await scrollTop(page)
    expect(offsetBefore).toBeGreaterThan(0)

    const response = await request.post(`/api/memory/${encodeURIComponent(HOISTED_ID)}/approve`)
    expect(response.status(), await response.text()).toBe(200)
    // `activated` is the append-kind path: no identity scan, so nothing was deduped (which
    // DELETES the candidate) and nothing was superseded (which demotes a second record).
    // Without this the rest of the test cannot tell a hoist from a deletion.
    expect((await response.json()) as { action?: string }).toMatchObject({ action: "activated" })

    // Phrased POSITIVELY — with a floor on how much was caught — because the read that
    // settles this is the one every later assertion is taken against: `not.toEqual` alone
    // is satisfied by a read that landed between paints and answered `[]`.
    await expect(async () => {
      const ids = await rowIds(page)
      expect(ids.length).toBeGreaterThanOrEqual(MIN_DRAWN_ROWS)
      expect(ids).not.toContain(HOISTED_ID)
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
      HOISTED_ID,
    )
    expectDrawnRun(projectionAfterHoist, idsAfter, "after the hoist")
    // The population is untouched: an approval moves a record, it does not add or remove
    // one. This is the independent witness that the append path — not the dedupe that
    // deletes — is what ran.
    await expect(total(page)).toHaveText(n(BROWSE_SEED_COUNT - 1))
    await expectPhase(page, "idle")
  })
})
