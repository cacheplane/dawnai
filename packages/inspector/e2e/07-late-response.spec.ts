import {
  BROWSE_PAGE_SIZE,
  browseSeedRecords,
  seedIdsInDefaultOrder,
  seedRecordsMatching,
} from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  asDrawn,
  expectDrawnRows,
  expectPhase,
  loadMore,
  openBrowse,
  rowIds,
  total,
} from "./helpers"

/** A row id no window of the fixture can contain, so its presence anywhere in the grid
 *  is unambiguous: query A's answer, and nothing else, put it there. */
const SENTINEL_ID = "stale-sentinel"

/** A continuation no query of this fixture issues. Present so the injected page differs
 *  from B's answer in its THIRD field as well: B's own window does not fill, so B's
 *  continuation is `null`, and a sentinel page that also carried `null` would be
 *  indistinguishable from B's on that channel — leaving one of the three things "discarded
 *  whole" names untested. */
const SENTINEL_CURSOR = "dead-revision-cursor"

/** How long query A's answer is held. Long enough that B is applied, requested and
 *  drawn while A is still outstanding — the whole point being that A lands into a page
 *  that has already moved on. */
const LATE_MS = 4_000

/** How far past A's release the watch keeps sampling. A leak would be repaired by the
 *  next poll, so this only has to outlast the release plus one poll period; the samples
 *  that matter are the ones immediately after it. */
const WATCH_TAIL_MS = 3_000

/** Sampling period. Well under `BROWSE_POLL_INTERVAL_MS` (2 s), which is the interval
 *  within which a leak would be overwritten by a fresh answer for B — a sampler slower
 *  than the repair reads the repair. */
const SAMPLE_MS = 250

/** A floor on how much of the projection each sample must have caught. Without it, a read
 *  taken between paints answers `[]`, and `[]` satisfies "does not contain the sentinel"
 *  no matter what the page went on to draw. Set well under whatever the capped viewport
 *  currently fits, because that count is a rendering detail and this is a floor. */
const MIN_SAMPLED_ROWS = 15

// D1-DATA-02 for the rows, D1-DATA-01 for the numbers beside them. A response for a dead
// revision never reaches the grid: not as a replacement, not as an append, and not as a
// total or a continuation quoted over somebody else's rows.
//
// WHICH MECHANISM THIS SEES. The design gives the client two, in order (§6.1): a new
// desired revision aborts what is in flight, and any response that survives to settle is
// discarded whole unless its revision is still the desired one.
//
// The abort is NOT the reducer's `abort:` flag, which reads as the obvious candidate and
// is inert on this path. On a query change React runs the effect cleanup in
// `use-memory-browse` first — it aborts the controller and nulls it, and it nulls
// `inFlight` on the state ref too — so by the time that same effect's body dispatches
// `query-changed`, `browseReduce` computes `abort: state.inFlight !== null` as false and
// the hook's own `controllerRef.current !== null` guard is false as well. The cleanup is
// what cancels; the flag covers a `query-changed` arriving by some other route.
//
// The consequence for this spec: on shipped code the sentinel below never reaches the
// page's JavaScript at all, so there is no network fault it can inject that lets a
// superseded response reach the reducer. What the watch proves is the OUTCOME, over both
// mechanisms together — remove either one alone and the grid is still never wrong (with
// no abort the reducer discards it; with no gate the abort means it is never delivered),
// and only removing BOTH puts the sentinel on screen, for about one poll period. That is
// why the loop below SAMPLES rather than settles. The revision gate is pinned on its own,
// without a network, by `test/components/browse-machine.test.ts` "flow 6: a stale response
// completing after a query change".
test.describe("scenario 7 — late response", () => {
  // The fault injection alone costs `LATE_MS + WATCH_TAIL_MS` of wall clock that no
  // assertion can shorten, on top of the gestures and the settle — so the suite's 60 s
  // leaves too little headroom on a machine running several suites at once. Nothing here
  // retries for a duration, so a genuine failure still reports as a diff, not a timeout.
  test.setTimeout(90_000)

  test("a response for a superseded query never reaches the grid", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)

    // The abort, observed rather than assumed — this is the mechanism the preamble says
    // fires first, and reading it off the network is what turns that claim into an
    // observation instead of a comment.
    const abortedForDeadRevision: string[] = []
    page.on("requestfailed", (request) => {
      if (!request.url().includes("/api/memory/list")) return
      const filters = new URL(request.url()).searchParams.get("filters") ?? ""
      if (filters.includes("superseded") && !filters.includes("episodic")) {
        abortedForDeadRevision.push(request.failure()?.errorText ?? "unknown")
      }
    })

    // A real fixture record wearing the sentinel id, so the body is a page the client
    // would accept: `fetchBrowsePage` rejects anything that is not one, and a hand-rolled
    // row shape would have this test proving the response VALIDATOR instead of the
    // revision it belongs to.
    const [seedTemplate] = browseSeedRecords()
    if (seedTemplate === undefined) throw new Error("the browse fixture is empty")

    // Query A (status=superseded) is answered LATE, with an unmistakable sentinel page.
    //
    // The predicate has to exclude B as well as select A. Filters COMPOSE: once the kind
    // funnel is added, B's params — and every 2 s poll B goes on to make — still carry
    // "superseded", so a predicate keyed on that word alone would hold and
    // sentinel-answer the very query whose rows this test is watching.
    let heldForDeadRevisionAt: number | null = null
    let deliveredForDeadRevision = 0
    await page.route("**/api/memory/list*", async (route) => {
      const filters = new URL(route.request().url()).searchParams.get("filters") ?? ""
      if (filters.includes("superseded") && !filters.includes("episodic")) {
        heldForDeadRevisionAt ??= Date.now()
        await new Promise((resolve) => setTimeout(resolve, LATE_MS))
        // Not wrapped, and the delivery is COUNTED rather than asserted by a comment: the
        // page has cancelled this request by now, and a Playwright that ever stopped
        // fulfilling a cancelled one would leave the loop below watching a page whose
        // fault was never delivered — the one way this scenario can pass while proving
        // nothing. A throw here surfaces as an unhandled rejection with no line to blame
        // (route handlers are invoked unawaited), so the counter is what reddens.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            records: [
              { ...seedTemplate, id: SENTINEL_ID, content: "this belongs to a dead revision" },
            ],
            total: 1,
            continuation: SENTINEL_CURSOR,
          }),
        })
        deliveredForDeadRevision += 1
        return
      }
      await route.continue()
    })

    await applySetFilter(page, "status", ["superseded"])
    await expectPhase(page, "stale")

    // Supersede it with query B before A can answer.
    await applySetFilter(page, "kind", ["episodic"])

    const matching = seedRecordsMatching({ status: ["superseded"], kind: ["episodic"] })
    // B has to be a real, non-empty narrowing of A, or "B's rows are still B's" would be a
    // claim about an empty grid — which the sentinel would visibly break anyway, but for
    // the wrong reason.
    expect(matching.length).toBeGreaterThan(0)
    expect(matching.length).toBeLessThan(seedRecordsMatching({ status: ["superseded"] }).length)
    const projection = asDrawn(seedIdsInDefaultOrder(matching).slice(0, BROWSE_PAGE_SIZE))
    // B's window does not fill, so its walk is exhausted and its two counts agree. Both
    // strings are derived here rather than repeated below, because each is a claim about
    // one of the three fields the sentinel page carries.
    const population = matching.length.toLocaleString("en-US")
    const walkLabel = `All ${population} loaded`
    await expectDrawnRows(page, projection)

    // The fault was injected. Asserted BEFORE the watch, not after: a filter param this
    // route stopped recognising would leave every sample below watching a page nobody
    // ever attacked, and the watch's own deadline is anchored on this instant.
    const heldAt = heldForDeadRevisionAt
    if (heldAt === null) throw new Error("the route never matched query A: nothing was injected")

    // Watch across the window in which A's answer is released — anchored on when the hold
    // STARTED, so however long B took to settle, the release is still inside it.
    //
    // Every read is ONE-SHOT and every sample is a single observation, because a leak here
    // is TRANSIENT by construction: the reducer would take the sentinel page whole and the
    // next poll tick would overwrite it with a fresh answer for B. Anything that waited —
    // a retrying `expectDrawnRows`, an auto-retrying locator assertion, or
    // `waitOnePollPeriod`, which returns just as the repair lands — would be reading the
    // repair and reporting it as the absence of damage. The negative is asserted on the
    // same read as the positives beside it for the same reason `rowIds` warns about: a
    // read that caught the grid between paints answers `[]`.
    const deadline = heldAt + LATE_MS + WATCH_TAIL_MS
    let lastSampleAt = 0
    for (let sample = 0; lastSampleAt < deadline; sample += 1) {
      lastSampleAt = Date.now()
      const at = `sample ${sample}`
      const ids = await rowIds(page)
      const drawnTotal = await total(page).innerText()
      const drawnWalk = await loadMore(page).innerText()

      expect(ids, at).not.toContain(SENTINEL_ID)
      expect(ids.length, at).toBeGreaterThanOrEqual(MIN_SAMPLED_ROWS)
      expect(ids, at).toEqual(projection.slice(0, ids.length))
      // The records are one third of a page. An APPENDED sentinel is invisible in the rows
      // — it lands past the ~19 the viewport draws — and a total or a continuation taken
      // from a dead revision is invisible there by construction. The footer's label
      // carries both remaining fields: the loaded count, which an append moves, and the
      // walk, since `All N loaded` is the shape only an exhausted continuation produces.
      expect(drawnWalk, at).toBe(walkLabel)
      expect(drawnTotal, at).toBe(population)

      await page.waitForTimeout(SAMPLE_MS)
    }

    // The watch was still running when A came back. A time-bounded loop whose deadline had
    // already passed — B taking longer to settle than the hold, on a loaded machine —
    // samples nothing and passes having asserted nothing, which is the one failure a fixed
    // tick count does not have and this one does.
    expect(lastSampleAt, "the watch never sampled after A's answer was released").toBeGreaterThan(
      heldAt + LATE_MS,
    )
    // The held response was actually handed back, rather than the fulfil failing silently
    // on a request the page had already cancelled.
    expect(deliveredForDeadRevision).toBeGreaterThan(0)
    // …and the client stopped paying for the dead revision rather than merely ignoring its
    // answer. §6.1 specifies both halves; this is the one that is observable from outside
    // the page. Pinned to the abort rather than to "some failure", or a connection reset
    // would satisfy the only evidence this spec offers for the cancellation.
    expect(abortedForDeadRevision).toContain("net::ERR_ABORTED")
  })
})
