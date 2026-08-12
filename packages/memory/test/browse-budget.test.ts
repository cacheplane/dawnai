import { describe, expect, it } from "vitest"
import {
  checkBrowseBudgets,
  POSTGRES_BROWSE_BUDGETS_MS,
  percentileMs,
  SQLITE_BROWSE_BUDGETS_MS,
} from "../src/browse-budget.js"

describe("browse budget checker", () => {
  it("takes the p95 by nearest-rank, so a 20-sample run reports the 19th", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(percentileMs(samples, 0.95)).toBe(19)
    expect(percentileMs([], 0.95)).toBe(Number.NaN)
    expect(percentileMs([5], 0.95)).toBe(5)
  })

  it("ranks by value, not by arrival", () => {
    // The bench hands over timings in the order they happened. Unsorted, rank 5 of these
    // would be the fifth CALL (4) rather than the fifth slowest (50).
    expect(percentileMs([50, 1, 2, 3, 4], 0.95)).toBe(50)
  })

  it("rounds the rank up, and never below the first sample", () => {
    // 0.95 * 10 = 9.5: rounding down would report the 9th and quietly discard two samples
    // instead of one. The clamp covers fraction <= 0, where the rank would be index -1.
    expect(
      percentileMs(
        Array.from({ length: 10 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(10)
    expect(percentileMs([7, 8], 0)).toBe(7)
  })

  it("passes when every measured p95 is under its ceiling", () => {
    const report = checkBrowseBudgets(
      {
        "windowed-fetch": [1, 1, 2],
        "filtered-count": [4, 5, 6],
        "head-refresh": [10, 11, 12],
        "non-default-sort": [12, 13, 14],
        "content-contains": [40, 44, 46],
      },
      SQLITE_BROWSE_BUDGETS_MS,
    )
    expect(report.ok).toBe(true)
    expect(report.rows.every((row) => row.status === "pass")).toBe(true)
  })

  it("counts a p95 landing exactly on the ceiling as a pass", () => {
    const report = checkBrowseBudgets({ "windowed-fetch": [1, 1, 10] }, SQLITE_BROWSE_BUDGETS_MS)
    expect(report.rows[0]?.p95Ms).toBe(10)
    expect(report.rows[0]?.status).toBe("pass")
  })

  it("fails the whole report when one shape is over", () => {
    const report = checkBrowseBudgets({ "windowed-fetch": [50, 60, 70] }, SQLITE_BROWSE_BUDGETS_MS)
    expect(report.ok).toBe(false)
    expect(report.rows[0]?.status).toBe("fail")
    expect(report.rows[0]?.budgetMs).toBe(10)
  })

  it("marks a shape with no approved ceiling UNBUDGETED rather than passing it", () => {
    // Design §11 approves only two Postgres numbers. Reporting the other three as
    // "pass" would manufacture approval nobody gave.
    const report = checkBrowseBudgets(
      { "windowed-fetch": [1], "filtered-count": [2], "content-contains": [900] },
      POSTGRES_BROWSE_BUDGETS_MS,
    )
    expect(report.rows.find((row) => row.id === "content-contains")?.status).toBe("unbudgeted")
    expect(report.ok).toBe(true)
  })

  it("reports an approved ceiling nobody measured, and refuses to call the run ok", () => {
    // The mirror of UNBUDGETED: a partial run must not certify the four shapes it skipped.
    const report = checkBrowseBudgets({ "windowed-fetch": [1, 1, 2] }, SQLITE_BROWSE_BUDGETS_MS)
    expect(report.rows.map((row) => row.status)).toEqual([
      "pass",
      "unmeasured",
      "unmeasured",
      "unmeasured",
      "unmeasured",
    ])
    expect(report.rows[1]?.p95Ms).toBe(null)
    expect(report.ok).toBe(false)
  })

  it("fails a measured shape that produced no samples", () => {
    // A shape present with zero timings is a broken run, not an absent one.
    const report = checkBrowseBudgets({ "content-contains": [] }, SQLITE_BROWSE_BUDGETS_MS)
    expect(report.rows[0]?.status).toBe("fail")
    expect(report.ok).toBe(false)
  })
})
