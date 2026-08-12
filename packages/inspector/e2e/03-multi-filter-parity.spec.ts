import { BROWSE_PAGE_SIZE, seedIdsInDefaultOrder, seedRecordsMatching } from "../test/seed"
import { expect, test } from "./fixtures"
import {
  applySetFilter,
  applyTextFilter,
  asDrawn,
  expectDrawnRows,
  openBrowse,
  total,
} from "./helpers"

// D1-QUERY-02..07, D1-QUERY-13. Composed filters return one ordered id list.
//
// SCOPE, stated honestly: the Inspector runs SQLite only, so this spec proves the
// composed query against the fixture's own pure expectation. Cross-backend parity
// (identical ordered ids on SQLite and Postgres) is proven by the shared conformance
// suite, not here — Task 9 adds the composed-filter case there.
test.describe("scenario 3 — multi-filter parity", () => {
  test("status + kind + content compose into one ordered window", async ({
    page,
    consoleErrors,
  }) => {
    void consoleErrors
    await openBrowse(page)
    await applySetFilter(page, "status", ["candidate", "active"])
    await applySetFilter(page, "kind", ["semantic"])
    await applyTextFilter(page, "content", "contains", "threshold 1")

    const matching = seedRecordsMatching({
      status: ["candidate", "active"],
      kind: ["semantic"],
      contentContains: "threshold 1",
    })
    // Every clause has to bite, or "composed" would be proven by whichever predicate
    // happened to be narrowest. Pinned rather than assumed: a seed change that made two
    // of these redundant would leave the scenario passing while testing one filter.
    expect(matching.length).toBeGreaterThan(0)
    for (const looser of [
      seedRecordsMatching({ status: ["candidate", "active"] }),
      seedRecordsMatching({ kind: ["semantic"] }),
      seedRecordsMatching({ contentContains: "threshold 1" }),
    ]) {
      expect(matching.length).toBeLessThan(looser.length)
    }

    await expectDrawnRows(page, asDrawn(seedIdsInDefaultOrder(matching).slice(0, BROWSE_PAGE_SIZE)))
    await expect(total(page)).toHaveText(matching.length.toLocaleString("en-US"))
  })
})
